// index.ts — Bun.serve() router with auth + validation + alias resolve + completion
// Phase 3: createServer factory (D-02), X-Request-ID (OBS-01), structured logs (OBS-02..04), NORM-10, D-07
import { timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { isKnownAlias, resolveUpstreamModel, listAliases, rewriteUpstreamModelIds } from './model-registry';
import { validateChatCompletion } from './request-schema';
import { calcCooldownMs, classifyError, parseCerebrasHeaders, parseGroqHeaders } from './routing/cooldown-manager';
import { advanceCursor, chooseEligibleProviders, getStateSnapshot, isEligible, setCooldown, setRateLimitSnapshot, recordSuccess, recordFailure } from './routing/provider-state';
import type { Provider } from './routing/provider-state';
import { cerebrasAdapter } from './services/cerebras';
import { groqAdapter } from './services/groq';
import { normalizeChunk, normalizeResponse } from './response-normalizer';
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

// AUTH-01..04: extract Bearer token — never log or echo value
function extractBearerToken(request: Request): string | null {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7);
}

// AUTH-03: constant-time comparison — length pre-check prevents timingSafeEqual throw (Pitfall 6)
function verifyToken(token: string, expected: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
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
    port: number = config.port
): ReturnType<typeof Bun.serve> {
    return Bun.serve({
        hostname: config.hostname,
        port,
        // WHSP-05: raise global body gate to audio ceiling (25 MiB); chat 1 MiB limit enforced in handler
        maxRequestBodySize: config.audioMaxFileBytes,
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

                return withRequestId(new Response(
                    JSON.stringify({ ready, mode, eligibleProviders, unavailableProviders }),
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

            // GET /v1/models — list logical proxy aliases only (REG-04; EP-03)
            if (request.method === 'GET' && pathname === '/v1/models') {
                return withRequestId(new Response(
                    JSON.stringify({
                        object: 'list',
                        data: listAliases().map((id) => ({
                            id,
                            object: 'model',
                            created: 0,
                            owned_by: 'personal-proxy',
                        })),
                    }),
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

                // Read raw body and enforce actual byte length — prevents chunked/NaN/understated bypass
                let raw: string;
                try {
                    raw = await request.text();
                } catch {
                    return withRequestId(openaiError('Failed to read request body.', 'invalid_request_error', 'invalid_request_error', null, 400));
                }
                if (Buffer.byteLength(raw) > config.maxRequestBodyBytes) {
                    return withRequestId(openaiError(
                        `Request body too large. Maximum is ${config.maxRequestBodyBytes} bytes.`,
                        'invalid_request_error',
                        'request_too_large',
                        null,
                        413
                    ));
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
                advanceCursor();

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
                            break;
                        } catch (err) {
                            const classified = classifyError(err);
                            recordFailure(provider, classified.status ?? 0);

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

                            if ((classified.status === 429 || classified.status === 498) && classified.headers) {
                                const parsed = parseRateLimitHeaders(provider, classified.headers);
                                const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);
                                const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
                                const cooldownUntil = Date.now() + cooldownMs;

                                setCooldown(provider, cooldownUntil, snapshot);
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

                    recordSuccess(chosenProvider, 200);
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
                                const normalized = normalizeChunk(chunk, input.model);
                                if (!hasVisibleChunkData(normalized)) {
                                    continue;
                                }
                                firstChunkSent = true;
                                yield `data: ${JSON.stringify(normalized)}\n\n`;
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
                            if (!firstChunkSent) {
                                const classified = classifyError(err);
                                log('warn', {
                                    event: 'stream_error_before_first_chunk',
                                    requestId,
                                    provider: finalProvider,
                                    status: classified.status,
                                });

                                // OBS-02: emit error log for stream errors before first chunk
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
                            }
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

                        if ((classified.status === 429 || classified.status === 498) && classified.headers) {
                            const parsed = parseRateLimitHeaders(provider, classified.headers);
                            const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);
                            const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
                            const cooldownUntil = Date.now() + cooldownMs;

                            setCooldown(provider, cooldownUntil, snapshot);
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
    const server = createServer({ cerebras: cerebrasAdapter, groq: groqAdapter });
    console.log(`Server is running on ${server.url}`);
}
