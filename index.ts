// index.ts — Bun.serve() entrypoint and createServer factory.
// Composition layer: assembles ports into use cases and delegates HTTP handling to adapters.
import { config } from './config';
import { openaiError, authNotConfiguredError } from './adapters/inbound/http/presenters/openai-error';
import { newRequestId, withRequestId as attachRequestId } from './adapters/inbound/http/middleware/request-id';
import { extractBearerToken, verifyToken } from './adapters/inbound/http/middleware/bearer-auth';
import { toSseStream, sseHeaders } from './adapters/inbound/http/presenters/sse';
import { createConsoleLogger } from './adapters/outbound/console-logger';
import { systemClock } from './adapters/outbound/system-clock';
import { toUpstreamFailure } from './adapters/outbound/sdk-error-mapper';
import { matchTranscriptions, handleTranscriptions } from './adapters/inbound/http/routes/transcriptions';
import { matchGeminiGenerateContent, handleGeminiGenerateContent } from './adapters/inbound/http/routes/gemini-generate-content';
import { transcribeAudio } from './application/use-cases/transcribe-audio';
import { createChatCompletion } from './application/use-cases/create-chat-completion';
import { streamChatCompletion } from './application/use-cases/stream-chat-completion';
import type { ChatUseCaseDeps } from './application/use-cases/chat-deps';
import type { RouteContext, ServerDeps } from './adapters/inbound/http/context';
import type { ModelRegistry } from './domain/model-registry';
import type { ProviderStateStore } from './application/ports/provider-state-store';
import { isKnownAlias, resolveUpstreamModel, listAliases, rewriteUpstreamModelIds } from './model-registry';
import { validateChatCompletion } from './request-schema';
import { advanceCursor, chooseEligibleProviders, getStateSnapshot, isEligible, setCooldown, setRateLimitSnapshot, recordSuccess, recordFailure, resetForTesting } from './routing/provider-state';
import type { Provider } from './routing/provider-state';
import { cerebrasAdapter } from './services/cerebras';
import { groqAdapter } from './services/groq';
import { HttpWhisperService, NoopWhisperService } from './whisper-service';
import type { WhisperService } from './whisper-service';
import type { CompletionParams, ProviderAdapter } from './types';

// OBS-02: structured logger with LOG_LEVEL gating — the Logger port adapter
const logger = createConsoleLogger(config.logLevel);

// The provider-state shim exposes free functions bound to one module-level store instance.
// Wrap them as the ProviderStateStore port so the use cases see a port, not a module.
// Plan 08-04 replaces this with composition/container.ts.
const providerStore: ProviderStateStore = {
    isEligible,
    chooseEligibleProviders,
    advanceCursor,
    setCooldown,
    setRateLimitSnapshot,
    recordSuccess,
    recordFailure,
    getSnapshot: getStateSnapshot,
    reset: resetForTesting,
};

const modelRegistry: ModelRegistry = {
    resolveUpstreamModel,
    isKnownAlias,
    listAliases,
    rewriteUpstreamModelIds,
};


// D-02: exported factory — importing index.ts does NOT bind a port
export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port,
    whisperService: WhisperService = new NoopWhisperService(),
    audioMaxFileBytes: number = config.audioMaxFileBytes
): ReturnType<typeof Bun.serve> {
    const serverDeps: ServerDeps = {
        logger,
        audioMaxFileBytes,
        transcribeAudio: transcribeAudio({ transcription: whisperService, logger }),
    };

    // toFailure is injected so the application layer never imports the vendor-aware mapper.
    const chatDeps: ChatUseCaseDeps = {
        providers: adapters,
        store: providerStore,
        registry: modelRegistry,
        logger,
        clock: systemClock,
        maxAttempts: config.maxProviderAttemptsPerRequest,
        defaultCooldownSeconds: config.defaultCooldownSeconds,
        toFailure: toUpstreamFailure,
    };
    const runCreateChatCompletion = createChatCompletion(chatDeps);
    const runStreamChatCompletion = streamChatCompletion(chatDeps);

    return Bun.serve({
        hostname: config.hostname,
        port,
        // WHSP-05: transport gate = max(audio ceiling, chat ceiling); per-route limits enforced in handlers
        maxRequestBodySize: Math.max(config.audioMaxFileBytes, config.maxRequestBodyBytes),
        async fetch(request, server) {
            // OBS-01: generate request ID at the very top — attached to every response
            const requestId = newRequestId();
            const requestStart = Date.now();
            const url = new URL(request.url);
            const { pathname } = url;

            // OBS-01: rebuild response with X-Request-ID header on every non-streaming return
            function withRequestId(response: Response): Response {
                return attachRequestId(response, requestId);
            }

            const routeCtx = (): RouteContext => ({
                request,
                url,
                requestId,
                requestStart,
                deps: serverDeps,
            });

            // EP-04: GET /health — no auth required (healthcheck para EasyPanel / reverse proxies)
            // BUILD_VERSION (git SHA, baked at image build) lets you confirm WHICH build is live.
            if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
                return withRequestId(new Response(`ok ${process.env["BUILD_VERSION"] ?? "dev"}`, { status: 200 }));
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

            // POST /v1beta/models/{model}:generateContent — Gemini-wire-compatible transcription shim.
            // Placed BEFORE the global Bearer gate (D-01): Gemini auth is ?key= / x-goog-api-key, not Bearer.
            if (matchGeminiGenerateContent(request.method, pathname)) {
                return withRequestId(await handleGeminiGenerateContent(routeCtx()));
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
            if (matchTranscriptions(request.method, pathname)) {
                return withRequestId(await handleTranscriptions(routeCtx()));
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

                const useCaseInput = {
                    logicalAlias: requestedModel,
                    params,
                    requestId,
                    route: `${request.method} ${pathname}`,
                    requestStart,
                };

                if (input.stream === true) {
                    const controller = new AbortController();
                    request.signal.addEventListener('abort', () => controller.abort(), { once: true });

                    const streamed = await runStreamChatCompletion(useCaseInput, controller.signal);

                    if (!streamed.ok) {
                        if (streamed.kind === 'upstream_rejected') {
                            return withRequestId(openaiError(
                                streamed.message,
                                'invalid_request_error',
                                'upstream_error',
                                null,
                                streamed.status
                            ));
                        }
                        return withRequestId(openaiError(
                            'No eligible provider available for the requested model.',
                            'server_error',
                            'no_provider_available',
                            'model',
                            503
                        ));
                    }

                    server.timeout(request, 0);

                    return new Response(toSseStream(streamed.chunks), {
                        status: 200,
                        headers: sseHeaders({
                            requestId,
                            provider: streamed.provider,
                            exposeProvider: config.exposeProviderHeader,
                        }),
                    });
                }

                // Non-streaming path
                const completed = await runCreateChatCompletion(useCaseInput);

                if (!completed.ok) {
                    if (completed.kind === 'upstream_rejected') {
                        return withRequestId(openaiError(
                            completed.message,
                            'invalid_request_error',
                            'upstream_error',
                            null,
                            completed.status
                        ));
                    }
                    return withRequestId(openaiError(
                        'No eligible provider available for the requested model.',
                        'server_error',
                        'no_provider_available',
                        'model',
                        503
                    ));
                }

                // OBS-05: X-LLM-Provider conditional on config.exposeProviderHeader
                const responseHeaders: Record<string, string> = {
                    'Content-Type': 'application/json',
                    ...(config.exposeProviderHeader ? { 'X-LLM-Provider': completed.provider } : {}),
                };

                return withRequestId(new Response(
                    JSON.stringify(completed.response),
                    { status: 200, headers: responseHeaders }
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
