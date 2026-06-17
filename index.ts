// index.ts — Bun.serve() router with auth + validation + alias resolve + completion
// Phase 3: createServer factory (D-02), X-Request-ID (OBS-01), structured logs (OBS-02..04), NORM-10, D-07
import { timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { isKnownAlias, resolveUpstreamModel, listAliases, rewriteUpstreamModelIds } from './model-registry';
import { validateAudioFileSize, validateAudioTranscription } from './audio-schema';
import { validateChatCompletion } from './request-schema';
import { calcCooldownMs, classifyError, parseCerebrasHeaders, parseGroqHeaders } from './routing/cooldown-manager';
import { advanceCursor, chooseEligibleProviders, getStateSnapshot, isEligible, setCooldown, setRateLimitSnapshot, recordSuccess, recordFailure } from './routing/provider-state';
import type { Provider } from './routing/provider-state';
import { cerebrasAdapter } from './services/cerebras';
import { groqAdapter } from './services/groq';
import { normalizeChunk, normalizeResponse } from './response-normalizer';
import { HttpWhisperService, NoopWhisperService } from './whisper-service';
import type { WhisperService } from './whisper-service';
import type { AudioTranscriptionResult, CompletionParams, ProviderAdapter, StreamChunk } from './types';
import type { HeaderSource } from './routing/cooldown-manager';

// OBS-02: log level numeric map — error:0, warn:1, info:2
const LOG_LEVEL_MAP: Record<string, number> = { error: 0, warn: 1, info: 2 };
const configuredLogLevel = LOG_LEVEL_MAP[config.logLevel] ?? 2;

// OBS-02: structured logger with LOG_LEVEL gating
function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
    const entryLevel = LOG_LEVEL_MAP[level] ?? 2;
    if (entryLevel <= configuredLogLevel) {
        console.log(JSON.stringify({ level, ...data }));
    }
}

// OpenAI-style error shape (D-05 + spec §14) — used for ALL error paths
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}

// D-12 (Phase 7): Gemini error shape — { error: { code, message, status } }, NO `type` field.
// Distinct from openaiError above; used for EVERY error path on the /v1beta/.../:generateContent route
// so a migrating n8n Gemini node sees Gemini-shaped errors, never OpenAI leakage (GEM-09, GEM-12).
// `code` is the HTTP status (int); `status` is the Gemini UPPER_SNAKE_CASE token
// (401→UNAUTHENTICATED, 400→INVALID_ARGUMENT, 503→UNAVAILABLE).
function geminiError(code: number, message: string, status: string): Response {
    return new Response(
        JSON.stringify({ error: { code, message, status } }),
        { status: code, headers: { 'Content-Type': 'application/json' } }
    );
}

// AUTH-01..04: extract Bearer token — never log or echo value
function extractBearerToken(request: Request): string | null {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7);
}

// AUTH-03: constant-time comparison — pad both buffers to maxLen so timingSafeEqual always runs.
// The prior length pre-check leaked the key's byte length as a timing oracle (CR-01).
function verifyToken(token: string, expected: string): boolean {
    const enc = new TextEncoder();
    const a = enc.encode(token);
    const b = enc.encode(expected);
    const maxLen = Math.max(a.length, b.length);
    const paddedA = new Uint8Array(maxLen);
    const paddedB = new Uint8Array(maxLen);
    paddedA.set(a);
    paddedB.set(b);
    // timingSafeEqual always runs — no length oracle
    return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function authNotConfiguredError(): Response {
    return openaiError(
        'Proxy authentication is not configured.',
        'server_error',
        'proxy_not_configured',
        null,
        503
    );
}

function parseRateLimitHeaders(provider: Provider, headers: HeaderSource) {
    return provider === 'cerebras'
        ? parseCerebrasHeaders(headers)
        : parseGroqHeaders(headers);
}

function toRateLimitSnapshot(parsed: Record<string, number | undefined>): Record<string, string> {
    const snapshot: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) {
            snapshot[key] = String(value);
        }
    }

    return snapshot;
}

function hasVisibleChunkData(chunk: StreamChunk): boolean {
    return chunk.choices.some((choice) => (
        choice.finish_reason !== null
        || choice.delta.role !== undefined
        || choice.delta.content !== undefined
    ));
}

// D-02: exported factory — importing index.ts does NOT bind a port
export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port,
    whisperService: WhisperService = new NoopWhisperService(),
    audioMaxFileBytes: number = config.audioMaxFileBytes
): ReturnType<typeof Bun.serve> {
    return Bun.serve({
        hostname: config.hostname,
        port,
        // WHSP-05: transport gate = max(audio ceiling, chat ceiling); per-route limits enforced in handlers
        maxRequestBodySize: Math.max(config.audioMaxFileBytes, config.maxRequestBodyBytes),
        async fetch(request, server) {
            // OBS-01: generate request ID at the very top — attached to every response
            const requestId = crypto.randomUUID();
            const requestStart = Date.now();
            const url = new URL(request.url);
            const { pathname } = url;

            // OBS-01: rebuild response with X-Request-ID header on every non-streaming return
            function withRequestId(response: Response): Response {
                const headers = new Headers(response.headers);
                headers.set('X-Request-ID', requestId);
                return new Response(response.body, { status: response.status, headers });
            }

            // EP-04: GET /health — no auth required (healthcheck para EasyPanel / reverse proxies)
            if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
                return withRequestId(new Response('ok', { status: 200 }));
            }

            if (request.method === 'GET' && pathname === '/ready') {
                const logicalModel = listAliases()[0] ?? '';
                const proxyKeyConfigured = Boolean(config.personalProxyApiKey);
                const eligibleProviders = (['cerebras', 'groq'] as Provider[]).filter((provider) => (
                    isEligible(provider, logicalModel)
                ));
                const unavailableProviders = (['cerebras', 'groq'] as Provider[]).filter((provider) => (
                    !eligibleProviders.includes(provider)
                ));
                const ready = proxyKeyConfigured && eligibleProviders.length > 0;
                const mode = !proxyKeyConfigured
                    ? 'not_configured'
                    : unavailableProviders.length === 0 ? 'ok' : 'degraded';
                const whisperAvailable = await whisperService.health();

                return withRequestId(new Response(
                    JSON.stringify({ ready, mode, eligibleProviders, unavailableProviders, whisperAvailable }),
                    {
                        status: ready ? 200 : 503,
                        headers: { 'Content-Type': 'application/json' },
                    }
                ));
            }

            // POST /v1beta/models/{model}:generateContent — Gemini-wire-compatible transcription shim (Phase 7).
            // Placed BEFORE the global Bearer gate (D-01): Gemini auth is ?key= / x-goog-api-key, not Bearer.
            // OUT OF SCOPE (GEM-15): :streamGenerateContent (Gemini SSE — falls through to the 404 handler),
            //   file_data Files-API URIs (rejected as 400 below), and multi-candidate responses
            //   (always a single candidate at index 0). Do not implement here.
            if (
                request.method === 'POST'
                && pathname.startsWith('/v1beta/models/')
                && pathname.endsWith(':generateContent')
            ) {
                const model = pathname.slice(
                    '/v1beta/models/'.length,
                    pathname.length - ':generateContent'.length
                );

                // 1. Auth (D-03/D-04, GEM-02/09): x-goog-api-key header first, then ?key= query param.
                //    Missing config OR missing/invalid key → Gemini-shaped 401 (NOT openaiError).
                const apiKey = request.headers.get('x-goog-api-key')
                    ?? url.searchParams.get('key');
                if (
                    !config.personalProxyApiKey
                    || !apiKey
                    || !verifyToken(apiKey, config.personalProxyApiKey)
                ) {
                    return withRequestId(geminiError(
                        401,
                        'API key not valid. Please pass a valid API key.',
                        'UNAUTHENTICATED'
                    ));
                }

                // IN-02: sanity-bound the echoed model segment (post-auth so we don't reveal
                // anything to unauthenticated callers). It is echoed into modelVersion and logs;
                // reject path-injecting or absurdly long values before doing any work.
                if (model.length === 0 || model.includes('/') || model.length > 200) {
                    return withRequestId(geminiError(
                        400,
                        'Invalid model identifier.',
                        'INVALID_ARGUMENT'
                    ));
                }

                // 2. Parse JSON body (D-07 step 2).
                let body: unknown;
                try {
                    body = await request.json();
                } catch {
                    return withRequestId(geminiError(
                        400,
                        'Invalid JSON request body.',
                        'INVALID_ARGUMENT'
                    ));
                }

                // 3. Scan parts (D-05/D-07): file_data anywhere → out-of-scope 400 (GEM-04);
                //    else capture the FIRST inline_data part with both data and mime_type.
                //    WR-02: typed narrowing on `unknown` instead of `any` so strict-mode /
                //    noUncheckedIndexedAccess guarantees still apply to every property access.
                const rawContents = (body as { contents?: unknown } | null | undefined)?.contents;
                const contents: unknown[] = Array.isArray(rawContents) ? rawContents : [];
                let inlineData: { data: string; mime_type: string } | null = null;
                for (const content of contents) {
                    const rawParts = (content as { parts?: unknown } | null | undefined)?.parts;
                    const parts: unknown[] = Array.isArray(rawParts) ? rawParts : [];
                    for (const part of parts) {
                        const partObj = part as { file_data?: unknown; inline_data?: unknown } | null | undefined;
                        // WR-04: reject only when file_data is truthy — a `{ file_data: null }`
                        // part that also carries valid inline_data must not be falsely rejected.
                        if (partObj && partObj.file_data) {
                            return withRequestId(geminiError(
                                400,
                                'file_data (Files API) input is not supported by this proxy.',
                                'INVALID_ARGUMENT'
                            ));
                        }
                        const id = partObj?.inline_data as { data?: unknown; mime_type?: unknown } | null | undefined;
                        if (!inlineData && id
                            && typeof id.data === 'string' && id.data
                            && typeof id.mime_type === 'string' && id.mime_type) {
                            inlineData = { data: id.data, mime_type: id.mime_type };
                        }
                    }
                }

                // 4. No inline audio part found → Gemini-shaped 400 (GEM-10).
                if (!inlineData) {
                    return withRequestId(geminiError(
                        400,
                        'No inline audio data found in request.',
                        'INVALID_ARGUMENT'
                    ));
                }

                // 5. Decode base64 → File using native Buffer + File only (D-06, GEM-13).
                //    Filename is the literal 'audio' — never derived from untrusted input.
                //    WR-01: bound the *encoded* length before allocating the decoded buffer.
                //    base64 length * 3/4 ≈ decoded byte count, a safe upper-bound proxy, so an
                //    oversize payload is rejected before the ~18 MiB decode allocation (DoS).
                const approxBytes = Math.floor(inlineData.data.length * 3 / 4);
                if (approxBytes > audioMaxFileBytes) {
                    return withRequestId(geminiError(
                        400,
                        `File too large. Maximum allowed size is ${audioMaxFileBytes} bytes.`,
                        'INVALID_ARGUMENT'
                    ));
                }
                const bytes = Buffer.from(inlineData.data, 'base64');
                // HG-01: reject empty/zero-length decoded audio. Buffer.from(..., 'base64') is
                // lenient (never throws, silently drops non-alphabet chars), so garbage or
                // whitespace-only input can decode to 0 bytes and otherwise reach the sidecar.
                if (bytes.length === 0) {
                    return withRequestId(geminiError(
                        400,
                        'Inline audio data is empty or not valid base64.',
                        'INVALID_ARGUMENT'
                    ));
                }
                const file = new File([bytes], 'audio', { type: inlineData.mime_type });

                // 6. Size check (D-07/GEM-11) — reuse validateAudioFileSize.
                const sizeCheck = validateAudioFileSize(file, audioMaxFileBytes);
                if (!sizeCheck.ok) {
                    return withRequestId(geminiError(
                        400,
                        sizeCheck.message,
                        'INVALID_ARGUMENT'
                    ));
                }

                // 7. Transcribe (D-08/D-13). Do NOT require model === whisperModelAlias.
                let result: AudioTranscriptionResult;
                try {
                    result = await whisperService.transcribe(file, config.whisperModelAlias ?? model);
                } catch {
                    log('warn', {
                        event: 'gemini_transcription_failed',
                        requestId,
                        route: `${request.method} ${pathname}`,
                        modelAlias: model,
                        fileSize: file.size,
                        status: 503,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(geminiError(
                        503,
                        'Transcription service is unavailable.',
                        'UNAVAILABLE'
                    ));
                }

                // 8. Success body (D-09/D-10/D-11). Estimated token counts; echo model in modelVersion.
                const estTokens = Math.ceil(result.text.length / 4);
                log('info', {
                    event: 'gemini_transcription_complete',
                    requestId,
                    timestamp: new Date(requestStart).toISOString(),
                    route: `${request.method} ${pathname}`,
                    modelAlias: model,
                    fileSize: file.size,
                    status: 200,
                    latencyMs: Date.now() - requestStart,
                });
                return withRequestId(new Response(
                    JSON.stringify({
                        candidates: [
                            {
                                content: { role: 'model', parts: [{ text: result.text }] },
                                finishReason: 'STOP',
                                index: 0,
                            },
                        ],
                        usageMetadata: {
                            promptTokenCount: 0,
                            candidatesTokenCount: estTokens,
                            totalTokenCount: estTokens,
                        },
                        modelVersion: model,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                ));
            }

            // --- Auth gate — all routes below require Bearer PERSONAL_PROXY_API_KEY ---
            if (!config.personalProxyApiKey) {
                return withRequestId(authNotConfiguredError());
            }

            const token = extractBearerToken(request);
            if (!token || !verifyToken(token, config.personalProxyApiKey)) {
                return withRequestId(openaiError(
                    'No authorization provided or invalid credentials.',
                    'invalid_request_error',
                    'missing_auth',
                    null,
                    401
                ));
            }

            // POST /v1/audio/transcriptions — multipart transcription endpoint (EP2-01)
            if (request.method === 'POST' && pathname === '/v1/audio/transcriptions') {
                let formData: FormData;
                try {
                    formData = await request.formData();
                } catch {
                    return withRequestId(openaiError(
                        'Failed to parse multipart form data.',
                        'invalid_request_error',
                        'invalid_request_error',
                        null,
                        400
                    ));
                }

                const rawInput: Record<string, unknown> = {};
                for (const [key, value] of formData.entries()) {
                    rawInput[key] = value;
                }

                const validation = validateAudioTranscription(rawInput);
                if (!validation.success) {
                    return withRequestId(openaiError(
                        validation.message,
                        'invalid_request_error',
                        'invalid_request_error',
                        validation.param,
                        400
                    ));
                }

                const input = validation.data;

                const sizeCheck = validateAudioFileSize(input.file, audioMaxFileBytes);
                if (!sizeCheck.ok) {
                    return withRequestId(openaiError(
                        sizeCheck.message,
                        'invalid_request_error',
                        'request_too_large',
                        'file',
                        413
                    ));
                }

                const isKnownWhisperAlias = config.whisperModelAlias !== null
                    && input.model === config.whisperModelAlias;
                if (!isKnownWhisperAlias) {
                    return withRequestId(openaiError(
                        `Unknown model '${input.model}'.`,
                        'invalid_request_error',
                        'model_not_found',
                        'model',
                        400
                    ));
                }

                try {
                    const result = await whisperService.transcribe(input.file, input.model);
                    log('info', {
                        event: 'transcription_complete',
                        requestId,
                        timestamp: new Date(requestStart).toISOString(),
                        route: `${request.method} ${pathname}`,
                        modelAlias: input.model,
                        fileSize: input.file.size,
                        status: 200,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(new Response(JSON.stringify(result), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }));
                } catch {
                    log('warn', {
                        event: 'transcription_failed',
                        requestId,
                        modelAlias: input.model,
                        fileSize: input.file.size,
                        status: 503,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(openaiError(
                        'Transcription service is unavailable.',
                        'server_error',
                        'service_unavailable',
                        null,
                        503
                    ));
                }
            }

            if (request.method === 'GET' && pathname === '/internal/providers/status') {
                if (!config.enableInternalStatusEndpoint) {
                    // NORM-10: OpenAI error shape for disabled internal endpoint
                    return withRequestId(openaiError('The requested endpoint does not exist.', 'invalid_request_error', 'not_found', null, 404));
                }

                return withRequestId(new Response(
                    JSON.stringify({ providers: Object.values(getStateSnapshot()) }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                ));
            }

            // GET /v1/models — list logical proxy aliases only (REG-04; EP-03; EP2-02)
            if (request.method === 'GET' && pathname === '/v1/models') {
                const data = listAliases().map((id) => ({
                    id,
                    object: 'model',
                    created: 0,
                    owned_by: 'personal-proxy',
                }));
                if (config.whisperModelAlias !== null) {
                    data.push({
                        id: config.whisperModelAlias,
                        object: 'model',
                        created: 0,
                        owned_by: 'personal-proxy',
                    });
                }
                return withRequestId(new Response(
                    JSON.stringify({ object: 'list', data }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                ));
            }

            // POST /v1/chat/completions — main non-streaming completion endpoint
            if (request.method === 'POST' && pathname === '/v1/chat/completions') {
                // WHSP-05: enforce 1 MiB chat limit on actual buffered bytes — header not trusted
                // Optional fast-fail on clearly valid numeric headers to avoid buffering obviously-large requests
                const declaredLength = Number(request.headers.get('content-length'));
                if (Number.isFinite(declaredLength) && declaredLength > config.maxRequestBodyBytes) {
                    return withRequestId(openaiError(
                        `Request body too large. Maximum is ${config.maxRequestBodyBytes} bytes.`,
                        'invalid_request_error',
                        'request_too_large',
                        null,
                        413
                    ));
                }

                // Read raw body via ReadableStream — Content-Length header cannot be trusted.
                // request.text() honors the declared Content-Length and may deliver fewer bytes
                // than the actual wire payload when the header is understated (UAT-04-05).
                // A streaming read with a running byte counter measures actual wire bytes
                // independently of any Content-Length value.
                let raw: string;
                try {
                    if (!request.body) {
                        return withRequestId(openaiError('Failed to read request body.', 'invalid_request_error', 'invalid_request_error', null, 400));
                    }
                    const reader = request.body.getReader();
                    const chunks: Uint8Array[] = [];
                    let runningTotal = 0;
                    let limitExceeded = false;

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            runningTotal += value.byteLength;
                            if (runningTotal > config.maxRequestBodyBytes) {
                                limitExceeded = true;
                                await reader.cancel();
                                break;
                            }
                            chunks.push(value);
                        }
                    } catch {
                        return withRequestId(openaiError('Failed to read request body.', 'invalid_request_error', 'invalid_request_error', null, 400));
                    }

                    if (limitExceeded) {
                        return withRequestId(openaiError(
                            `Request body too large. Maximum is ${config.maxRequestBodyBytes} bytes.`,
                            'invalid_request_error',
                            'request_too_large',
                            null,
                            413
                        ));
                    }

                    // Combine accumulated Uint8Array chunks into a single buffer and decode
                    const combined = new Uint8Array(runningTotal);
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    raw = new TextDecoder().decode(combined);
                } catch {
                    return withRequestId(openaiError('Failed to read request body.', 'invalid_request_error', 'invalid_request_error', null, 400));
                }

                // Parse JSON body from already-buffered raw string
                let body: unknown;
                try {
                    body = JSON.parse(raw);
                } catch {
                    return withRequestId(openaiError('Request body must be valid JSON.', 'invalid_request_error', 'invalid_request_error', null, 400));
                }

                // VALID-01/02: validate against strict Zod schema (first-error, D-05)
                const validation = validateChatCompletion(body);
                if (!validation.success) {
                    return withRequestId(openaiError(
                        validation.message,
                        'invalid_request_error',
                        'invalid_request_error',
                        validation.param,
                        400
                    ));
                }

                const input = validation.data;

                // OPT-IN default alias: client may omit `model`; fall back to DEFAULT_MODEL_ALIAS.
                // When neither is present, reject before any upstream call.
                const requestedModel = input.model ?? config.defaultModelAlias ?? undefined;
                if (requestedModel === undefined) {
                    return withRequestId(openaiError(
                        'Missing required parameter: model (and no DEFAULT_MODEL_ALIAS configured).',
                        'invalid_request_error',
                        'invalid_request_error',
                        'model',
                        400
                    ));
                }

                // VALID-01: unknown model alias — reject before any upstream call
                if (!isKnownAlias(requestedModel)) {
                    return withRequestId(openaiError(
                        `Unknown model '${requestedModel}'.`,
                        'invalid_request_error',
                        'model_not_found',
                        'model',
                        400
                    ));
                }

                // D-04: inject default max_completion_tokens if client omitted it
                const max_completion_tokens = input.max_completion_tokens ?? config.defaultMaxCompletionTokens;

                const params: CompletionParams = {
                    messages: input.messages,
                    temperature: input.temperature ?? null,
                    top_p: input.top_p ?? null,
                    max_completion_tokens,
                    stop: input.stop ?? null,
                    seed: input.seed ?? null,
                };

                const candidates = chooseEligibleProviders(requestedModel);
                // WR-02: do NOT advance cursor unconditionally here — cursor is advanced after
                // each failed provider attempt so that on recovery the next request starts from
                // the provider after the one that last failed, not from a stale pre-eligibility-check position.

                if (candidates.length === 0) {
                    log('info', {
                        event: 'request_complete',
                        requestId,
                        timestamp: new Date(requestStart).toISOString(),
                        route: `${request.method} ${pathname}`,
                        logicalAlias: requestedModel,
                        provider: null,
                        upstreamModelId: null,
                        attempt: 0,
                        streaming: input.stream === true,
                        statusCode: 503,
                        latencyMs: Date.now() - requestStart,
                        failoverReason: null,
                        usage: null,
                    });
                    return withRequestId(openaiError(
                        'No eligible provider available for the requested model.',
                        'server_error',
                        'no_provider_available',
                        'model',
                        503
                    ));
                }

                if (input.stream === true) {
                    const controller = new AbortController();
                    request.signal.addEventListener('abort', () => controller.abort(), { once: true });

                    let chosenProvider: Provider | null = null;
                    let chosenUpstreamModelId: string | null = null;
                    let sdkStream: AsyncIterable<import('./types').StreamChunk> | null = null;
                    let attemptCount = 0;
                    let failoverReason: string | null = null;

                    for (const provider of candidates.slice(0, config.maxProviderAttemptsPerRequest)) {
                        const upstreamModelId = resolveUpstreamModel(requestedModel, provider);
                        if (!upstreamModelId) continue;
                        const adapter = adapters[provider];
                        attemptCount++;

                        try {
                            sdkStream = await adapter.stream(upstreamModelId, params, controller.signal);
                            chosenProvider = provider;
                            chosenUpstreamModelId = upstreamModelId;
                            advanceCursor(); // WR-02: advance after successful selection for next request's round-robin
                            break;
                        } catch (err) {
                            const classified = classifyError(err);
                            recordFailure(provider, classified.status ?? 0);
                            // WR-02: advance cursor after each failed attempt so the next request
                            // does not restart from the same failing provider.
                            advanceCursor();

                            if (!classified.shouldFailover) {
                                // D-07: pass upstream error message through with model-ID de-leaking
                                return withRequestId(openaiError(
                                    rewriteUpstreamModelIds(classified.message ?? 'Upstream provider rejected the request.'),
                                    'invalid_request_error',
                                    'upstream_error',
                                    null,
                                    classified.status ?? 502
                                ));
                            }

                            if (classified.status === 429 || classified.status === 498) {
                                // CR-02: always apply cooldown — use DEFAULT_COOLDOWN_SECONDS
                                // when headers are absent (CLAUDE.md §13.3)
                                const parsed = classified.headers
                                    ? parseRateLimitHeaders(provider, classified.headers)
                                    : {};
                                const snapshot = classified.headers
                                    ? toRateLimitSnapshot(parsed as Record<string, number | undefined>)
                                    : {};
                                const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
                                const cooldownUntil = Date.now() + cooldownMs;

                                setCooldown(provider, cooldownUntil,
                                    Object.keys(snapshot).length > 0 ? snapshot : undefined);
                                failoverReason = `status_${classified.status}`;
                                log('warn', {
                                    event: 'provider_cooldown',
                                    requestId,
                                    provider,
                                    status: classified.status,
                                    cooldownUntil: new Date(cooldownUntil).toISOString(),
                                });
                                continue;
                            }

                            failoverReason = `status_${classified.status ?? 'unknown'}`;
                            log('warn', {
                                event: 'provider_failover',
                                requestId,
                                provider,
                                status: classified.status,
                            });
                        }
                    }

                    if (!sdkStream || !chosenProvider || !chosenUpstreamModelId) {
                        log('info', {
                            event: 'request_complete',
                            requestId,
                            timestamp: new Date(requestStart).toISOString(),
                            route: `${request.method} ${pathname}`,
                            logicalAlias: requestedModel,
                            provider: null,
                            upstreamModelId: null,
                            attempt: attemptCount,
                            streaming: true,
                            statusCode: 503,
                            latencyMs: Date.now() - requestStart,
                            failoverReason,
                            usage: null,
                        });
                        return withRequestId(openaiError(
                            'No eligible provider available for the requested model.',
                            'server_error',
                            'no_provider_available',
                            'model',
                            503
                        ));
                    }

                    server.timeout(request, 0);

                    // Capture for closure (TypeScript narrowing)
                    const finalProvider = chosenProvider;
                    const finalUpstreamModelId = chosenUpstreamModelId;
                    const finalAttemptCount = attemptCount;
                    const finalFailoverReason = failoverReason;

                    const body = (async function* () {
                        let firstChunkSent = false;
                        let streamUsage: unknown = null;

                        try {
                            for await (const chunk of sdkStream) {
                                // WR-02: capture usage from terminal chunk (choices:[], usage:{...})
                                // before the hasVisibleChunkData check discards it.
                                const rawChunk = chunk as Record<string, unknown>;
                                if (rawChunk['usage'] &&
                                        Array.isArray(rawChunk['choices']) &&
                                        (rawChunk['choices'] as unknown[]).length === 0) {
                                    streamUsage = rawChunk['usage'];
                                    continue; // terminal usage chunk — not forwarded downstream
                                }

                                const normalized = normalizeChunk(chunk, requestedModel);
                                if (!hasVisibleChunkData(normalized)) {
                                    continue;
                                }
                                if (!firstChunkSent) {
                                    // WR-01: record success only after first real data is received —
                                    // adapter.stream() resolves without consuming bytes, so a
                                    // stream-open failure would commit a false success record.
                                    recordSuccess(finalProvider, 200);
                                    firstChunkSent = true;
                                }
                                yield `data: ${JSON.stringify(normalized)}\n\n`;
                            }

                            // WR-01: if stream completed without any visible chunks, still mark success
                            if (!firstChunkSent) {
                                recordSuccess(finalProvider, 200);
                            }

                            yield 'data: [DONE]\n\n';

                            // OBS-02: emit request-completion log after [DONE] — total stream duration
                            log('info', {
                                event: 'request_complete',
                                requestId,
                                timestamp: new Date(requestStart).toISOString(),
                                route: `${request.method} ${pathname}`,
                                logicalAlias: requestedModel,
                                provider: finalProvider,
                                upstreamModelId: finalUpstreamModelId,
                                attempt: finalAttemptCount,
                                streaming: true,
                                statusCode: 200,
                                latencyMs: Date.now() - requestStart,
                                failoverReason: finalFailoverReason,
                                usage: streamUsage,
                            });
                        } catch (err) {
                            // CR-03: log and emit [DONE] unconditionally regardless of firstChunkSent.
                            // When firstChunkSent=true, a mid-stream error must still close the SSE
                            // stream gracefully so clients don't hang waiting for the sentinel.
                            const classified = classifyError(err);
                            log('warn', {
                                event: firstChunkSent
                                    ? 'stream_error_after_first_chunk'
                                    : 'stream_error_before_first_chunk',
                                requestId,
                                provider: finalProvider,
                                status: classified.status,
                            });

                            // OBS-02: emit request-complete log for all stream error paths
                            log('info', {
                                event: 'request_complete',
                                requestId,
                                timestamp: new Date(requestStart).toISOString(),
                                route: `${request.method} ${pathname}`,
                                logicalAlias: requestedModel,
                                provider: finalProvider,
                                upstreamModelId: finalUpstreamModelId,
                                attempt: finalAttemptCount,
                                streaming: true,
                                statusCode: classified.status ?? 500,
                                latencyMs: Date.now() - requestStart,
                                failoverReason: finalFailoverReason,
                                usage: streamUsage,
                            });

                            // Always emit [DONE] — SSE protocol requires the sentinel even on error
                            yield 'data: [DONE]\n\n';
                        }
                    })();

                    // OBS-01: X-Request-ID in streaming headers at construction time (not via wrapper)
                    // OBS-05: X-LLM-Provider conditional on config.exposeProviderHeader
                    const streamHeaders: Record<string, string> = {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Request-ID': requestId,
                        ...(config.exposeProviderHeader ? { 'X-LLM-Provider': chosenProvider } : {}),
                    };

                    return new Response(body, {
                        status: 200,
                        headers: streamHeaders,
                    });
                }

                // Non-streaming path
                let attempt = 0;
                let failoverReason: string | null = null;

                for (const provider of candidates.slice(0, config.maxProviderAttemptsPerRequest)) {
                    const upstreamModelId = resolveUpstreamModel(requestedModel, provider);
                    if (!upstreamModelId) continue;
                    const adapter = adapters[provider];
                    attempt++;

                    try {
                        const { result, headers } = await adapter.complete(upstreamModelId, params);
                        const parsed = parseRateLimitHeaders(provider, headers);
                        const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);

                        setRateLimitSnapshot(provider, snapshot);
                        recordSuccess(provider, 200);
                        advanceCursor(); // WR-02: advance after successful selection for next request's round-robin

                        // D-08: warn when upstream omits usage
                        if (result.usage === undefined) {
                            log('warn', { event: 'usage_missing', provider, requestId });
                        }

                        const normalized = normalizeResponse(result, requestedModel);

                        // OBS-02: request-completion log for non-streaming success
                        log('info', {
                            event: 'request_complete',
                            requestId,
                            timestamp: new Date(requestStart).toISOString(),
                            route: `${request.method} ${pathname}`,
                            logicalAlias: requestedModel,
                            provider,
                            upstreamModelId,
                            attempt,
                            streaming: false,
                            statusCode: 200,
                            latencyMs: Date.now() - requestStart,
                            failoverReason,
                            usage: normalized.usage,
                        });

                        // OBS-05: X-LLM-Provider conditional on config.exposeProviderHeader
                        const responseHeaders: Record<string, string> = {
                            'Content-Type': 'application/json',
                            ...(config.exposeProviderHeader ? { 'X-LLM-Provider': provider } : {}),
                        };

                        return withRequestId(new Response(
                            JSON.stringify(normalized),
                            { status: 200, headers: responseHeaders }
                        ));
                    } catch (err) {
                        const classified = classifyError(err);
                        recordFailure(provider, classified.status ?? 0);
                        // WR-02: advance cursor after each failed attempt so the next request
                        // does not restart from the same failing provider.
                        advanceCursor();

                        if (!classified.shouldFailover) {
                            // D-07: pass upstream error message through with model-ID de-leaking
                            return withRequestId(openaiError(
                                rewriteUpstreamModelIds(classified.message ?? 'Upstream provider rejected the request.'),
                                'invalid_request_error',
                                'upstream_error',
                                null,
                                classified.status ?? 502
                            ));
                        }

                        if (classified.status === 429 || classified.status === 498) {
                            // CR-02: always apply cooldown — use DEFAULT_COOLDOWN_SECONDS
                            // when headers are absent (CLAUDE.md §13.3)
                            const parsed = classified.headers
                                ? parseRateLimitHeaders(provider, classified.headers)
                                : {};
                            const snapshot = classified.headers
                                ? toRateLimitSnapshot(parsed as Record<string, number | undefined>)
                                : {};
                            const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
                            const cooldownUntil = Date.now() + cooldownMs;

                            setCooldown(provider, cooldownUntil,
                                Object.keys(snapshot).length > 0 ? snapshot : undefined);
                            failoverReason = `status_${classified.status}`;
                            log('warn', {
                                event: 'provider_cooldown',
                                requestId,
                                provider,
                                status: classified.status,
                                cooldownUntil: new Date(cooldownUntil).toISOString(),
                            });
                            continue;
                        }

                        failoverReason = `status_${classified.status ?? 'unknown'}`;
                        log('warn', {
                            event: 'provider_failover',
                            requestId,
                            provider,
                            status: classified.status,
                        });
                    }
                }

                // OBS-02: request-completion log for exhaustion path
                log('info', {
                    event: 'request_complete',
                    requestId,
                    timestamp: new Date(requestStart).toISOString(),
                    route: `${request.method} ${pathname}`,
                    logicalAlias: requestedModel,
                    provider: null,
                    upstreamModelId: null,
                    attempt,
                    streaming: false,
                    statusCode: 503,
                    latencyMs: Date.now() - requestStart,
                    failoverReason,
                    usage: null,
                });

                return withRequestId(openaiError(
                    'No eligible provider available for the requested model.',
                    'server_error',
                    'no_provider_available',
                    'model',
                    503
                ));
            }

            // NORM-10: OpenAI error shape for 404 catch-all
            return withRequestId(openaiError('The requested endpoint does not exist.', 'invalid_request_error', 'not_found', null, 404));
        },
    });
}

// Entrypoint guard — bun index.ts boots the server; import { createServer } from './index' does not
if (import.meta.main) {
    const whisperService = config.whisperModelAlias !== null
        ? new HttpWhisperService()
        : new NoopWhisperService();
    const server = createServer(
        { cerebras: cerebrasAdapter, groq: groqAdapter },
        config.port,
        whisperService
    );
    console.log(`Server is running on ${server.url}`);
}
