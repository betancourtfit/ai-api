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
import type { CompletionParams, ProviderAdapter, StreamChunk } from './types';
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
            const { pathname } = new URL(request.url);

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

                // VALID-01: unknown model alias — reject before any upstream call
                if (!isKnownAlias(input.model)) {
                    return withRequestId(openaiError(
                        `Unknown model '${input.model}'.`,
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

                const candidates = chooseEligibleProviders(input.model);
                // WR-02: do NOT advance cursor unconditionally here — cursor is advanced after
                // each failed provider attempt so that on recovery the next request starts from
                // the provider after the one that last failed, not from a stale pre-eligibility-check position.

                if (candidates.length === 0) {
                    log('info', {
                        event: 'request_complete',
                        requestId,
                        timestamp: new Date(requestStart).toISOString(),
                        route: `${request.method} ${pathname}`,
                        logicalAlias: input.model,
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
                        const upstreamModelId = resolveUpstreamModel(input.model, provider);
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
                            logicalAlias: input.model,
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

                                const normalized = normalizeChunk(chunk, input.model);
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
                                logicalAlias: input.model,
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
                                logicalAlias: input.model,
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
                    const upstreamModelId = resolveUpstreamModel(input.model, provider);
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

                        const normalized = normalizeResponse(result, input.model);

                        // OBS-02: request-completion log for non-streaming success
                        log('info', {
                            event: 'request_complete',
                            requestId,
                            timestamp: new Date(requestStart).toISOString(),
                            route: `${request.method} ${pathname}`,
                            logicalAlias: input.model,
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
                    logicalAlias: input.model,
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
