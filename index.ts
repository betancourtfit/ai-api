// index.ts — Bun.serve() router with auth + validation + alias resolve + completion
// Phase 1: non-streaming path only (D-02); round-robin is Phase 2 (D-01 discretion)
import { timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { isKnownAlias, resolveUpstreamModel, listAliases } from './model-registry';
import { validateChatCompletion } from './request-schema';
import { calcCooldownMs, classifyError, parseCerebrasHeaders, parseGroqHeaders } from './routing/cooldown-manager';
import { advanceCursor, chooseEligibleProviders, getStateSnapshot, isEligible, setCooldown, setRateLimitSnapshot, recordSuccess, recordFailure } from './routing/provider-state';
import type { Provider } from './routing/provider-state';
import { cerebrasAdapter } from './services/cerebras';
import { groqAdapter } from './services/groq';
import { normalizeChunk, normalizeResponse } from './response-normalizer';
import type { CompletionParams, ProviderAdapter, StreamChunk } from './types';
import type { HeaderSource } from './routing/cooldown-manager';

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
        async fetch(request, server) {
            const { pathname } = new URL(request.url);

            // EP-04: GET /health — no auth required (healthcheck para EasyPanel / reverse proxies)
            if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
                return new Response('ok', { status: 200 });
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

                return new Response(
                    JSON.stringify({ ready, mode, eligibleProviders, unavailableProviders }),
                    {
                        status: ready ? 200 : 503,
                        headers: { 'Content-Type': 'application/json' },
                    }
                );
            }

            // --- Auth gate — all routes below require Bearer PERSONAL_PROXY_API_KEY ---
            if (!config.personalProxyApiKey) {
                return authNotConfiguredError();
            }

            const token = extractBearerToken(request);
            if (!token || !verifyToken(token, config.personalProxyApiKey)) {
                return openaiError(
                    'No authorization provided or invalid credentials.',
                    'invalid_request_error',
                    'missing_auth',
                    null,
                    401
                );
            }

            if (request.method === 'GET' && pathname === '/internal/providers/status') {
                if (!config.enableInternalStatusEndpoint) {
                    return new Response('Not found', { status: 404 });
                }

                return new Response(
                    JSON.stringify({ providers: Object.values(getStateSnapshot()) }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // GET /v1/models — list logical proxy aliases only (REG-04; EP-03)
            if (request.method === 'GET' && pathname === '/v1/models') {
                return new Response(
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
                );
            }

            // POST /v1/chat/completions — main non-streaming completion endpoint
            if (request.method === 'POST' && pathname === '/v1/chat/completions') {
                // Parse JSON body
                let body: unknown;
                try {
                    body = await request.json();
                } catch {
                    return openaiError('Request body must be valid JSON.', 'invalid_request_error', 'invalid_request_error', null, 400);
                }

                // VALID-01/02: validate against strict Zod schema (first-error, D-05)
                const validation = validateChatCompletion(body);
                if (!validation.success) {
                    return openaiError(
                        validation.message,
                        'invalid_request_error',
                        'invalid_request_error',
                        validation.param,
                        400
                    );
                }

                const input = validation.data;

                // VALID-01: unknown model alias — reject before any upstream call
                if (!isKnownAlias(input.model)) {
                    return openaiError(
                        `Unknown model '${input.model}'.`,
                        'invalid_request_error',
                        'model_not_found',
                        'model',
                        400
                    );
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
                    return openaiError(
                        'No eligible provider available for the requested model.',
                        'server_error',
                        'no_provider_available',
                        'model',
                        503
                    );
                }

                if (input.stream === true) {
                    const controller = new AbortController();
                    request.signal.addEventListener('abort', () => controller.abort(), { once: true });

                    let chosenProvider: Provider | null = null;
                    let sdkStream: AsyncIterable<import('./types').StreamChunk> | null = null;

                    for (const provider of candidates.slice(0, config.maxProviderAttemptsPerRequest)) {
                        const upstreamModelId = resolveUpstreamModel(input.model, provider);
                        if (!upstreamModelId) continue;
                        const adapter = adapters[provider];

                        try {
                            sdkStream = await adapter.stream(upstreamModelId, params, controller.signal);
                            chosenProvider = provider;
                            break;
                        } catch (err) {
                            const classified = classifyError(err);
                            recordFailure(provider, classified.status ?? 0);

                            if (!classified.shouldFailover) {
                                return openaiError(
                                    'Upstream provider rejected the request.',
                                    'invalid_request_error',
                                    'upstream_error',
                                    null,
                                    classified.status ?? 502
                                );
                            }

                            if ((classified.status === 429 || classified.status === 498) && classified.headers) {
                                const parsed = parseRateLimitHeaders(provider, classified.headers);
                                const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);
                                const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
                                const cooldownUntil = Date.now() + cooldownMs;

                                setCooldown(provider, cooldownUntil, snapshot);
                                console.log(JSON.stringify({
                                    event: 'provider_cooldown',
                                    provider,
                                    status: classified.status,
                                    cooldownUntil: new Date(cooldownUntil).toISOString(),
                                }));
                                continue;
                            }

                            console.log(JSON.stringify({
                                event: 'provider_failover',
                                provider,
                                status: classified.status,
                            }));
                        }
                    }

                    if (!sdkStream || !chosenProvider) {
                        return openaiError(
                            'No eligible provider available for the requested model.',
                            'server_error',
                            'no_provider_available',
                            'model',
                            503
                        );
                    }

                    recordSuccess(chosenProvider, 200);
                    server.timeout(request, 0);

                    const body = (async function* () {
                        let firstChunkSent = false;

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
                        } catch (err) {
                            if (!firstChunkSent) {
                                const classified = classifyError(err);
                                console.log(JSON.stringify({
                                    event: 'stream_error_before_first_chunk',
                                    provider: chosenProvider,
                                    status: classified.status,
                                }));
                            }
                        }
                    })();

                    return new Response(body, {
                        status: 200,
                        headers: {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive',
                        },
                    });
                }

                for (const provider of candidates.slice(0, config.maxProviderAttemptsPerRequest)) {
                    const upstreamModelId = resolveUpstreamModel(input.model, provider);
                    if (!upstreamModelId) continue;
                    const adapter = adapters[provider];

                    try {
                        const { result, headers } = await adapter.complete(upstreamModelId, params);
                        const parsed = parseRateLimitHeaders(provider, headers);
                        const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);

                        setRateLimitSnapshot(provider, snapshot);
                        recordSuccess(provider, 200);

                        const normalized = normalizeResponse(result, input.model);

                        return new Response(
                            JSON.stringify(normalized),
                            { status: 200, headers: { 'Content-Type': 'application/json' } }
                        );
                    } catch (err) {
                        const classified = classifyError(err);
                        recordFailure(provider, classified.status ?? 0);

                        if (!classified.shouldFailover) {
                            return openaiError(
                                'Upstream provider rejected the request.',
                                'invalid_request_error',
                                'upstream_error',
                                null,
                                classified.status ?? 502
                            );
                        }

                        if ((classified.status === 429 || classified.status === 498) && classified.headers) {
                            const parsed = parseRateLimitHeaders(provider, classified.headers);
                            const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);
                            const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
                            const cooldownUntil = Date.now() + cooldownMs;

                            setCooldown(provider, cooldownUntil, snapshot);
                            console.log(JSON.stringify({
                                event: 'provider_cooldown',
                                provider,
                                status: classified.status,
                                cooldownUntil: new Date(cooldownUntil).toISOString(),
                            }));
                            continue;
                        }

                        console.log(JSON.stringify({
                            event: 'provider_failover',
                            provider,
                            status: classified.status,
                        }));
                    }
                }

                return openaiError(
                    'No eligible provider available for the requested model.',
                    'server_error',
                    'no_provider_available',
                    'model',
                    503
                );
            }

            return new Response('Not found', { status: 404 });
        },
    });
}

// Entrypoint guard — bun index.ts boots the server; import { createServer } from './index' does not
if (import.meta.main) {
    const server = createServer({ cerebras: cerebrasAdapter, groq: groqAdapter });
    console.log(`Server is running on ${server.url}`);
}
