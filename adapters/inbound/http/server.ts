// adapters/inbound/http/server.ts — the Bun.serve() delivery adapter and the composition of
// ports into use cases. Signature and defaults are identical to the pre-refactor index.ts factory.
import { config } from '../../../config';
import { systemClock } from '../../outbound/system-clock';
import { toUpstreamFailure } from '../../outbound/sdk-error-mapper';
import { createConsoleLogger } from '../../outbound/console-logger';
import { isKnownAlias, listAliases, resolveUpstreamModel, rewriteUpstreamModelIds } from '../../../model-registry';
import {
    advanceCursor,
    chooseEligibleProviders,
    getStateSnapshot,
    isEligible,
    recordFailure,
    recordSuccess,
    resetForTesting,
    setCooldown,
    setRateLimitSnapshot,
} from '../../../routing/provider-state';
import { NoopWhisperService } from '../../outbound/noop-whisper';
import { transcribeAudio } from '../../../application/use-cases/transcribe-audio';
import { createChatCompletion } from '../../../application/use-cases/create-chat-completion';
import { streamChatCompletion } from '../../../application/use-cases/stream-chat-completion';
import { getReadiness } from '../../../application/use-cases/get-readiness';
import { listModels } from '../../../application/use-cases/list-models';
import { getProviderStatus } from '../../../application/use-cases/get-provider-status';
import { newRequestId, withRequestId } from './middleware/request-id';
import { routeRequest } from './router';
import type { ChatUseCaseDeps } from '../../../application/use-cases/chat-deps';
import type { ModelRegistry } from '../../../domain/model-registry';
import type { ProviderId } from '../../../domain/types';
import type { ChatProviderPort } from '../../../application/ports/chat-provider';
import type { ProviderStateStore } from '../../../application/ports/provider-state-store';
import type { TranscriptionPort } from '../../../application/ports/transcription';
import type { RouteContext, ServerDeps } from './context';

// OBS-02: structured logger with LOG_LEVEL gating — the Logger port adapter
const logger = createConsoleLogger(config.logLevel);

// The routing/provider-state shim exposes free functions bound to ONE module-level store instance,
// matching today's lifetime exactly. Wrapping them as the port lets the use cases depend on an
// interface rather than a module. Plan 08-04 replaces this with composition/container.ts.
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

// D-02: exported factory — importing this module does NOT bind a port
export function createServer(
    adapters: Record<ProviderId, ChatProviderPort>,
    port: number = config.port,
    whisperService: TranscriptionPort = new NoopWhisperService(),
    audioMaxFileBytes: number = config.audioMaxFileBytes
): ReturnType<typeof Bun.serve> {
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

    const deps: ServerDeps = {
        logger,
        audioMaxFileBytes,
        maxRequestBodyBytes: config.maxRequestBodyBytes,
        exposeProviderHeader: config.exposeProviderHeader,
        enableInternalStatusEndpoint: config.enableInternalStatusEndpoint,
        // Read LIVE per request, not captured at createServer() time: `config` is typed
        // `as const` but is not frozen at runtime, and tests/integration/server.test.ts mutates
        // config.defaultModelAlias around individual cases and restores it afterwards.
        get defaultModelAlias() { return config.defaultModelAlias; },
        defaultMaxCompletionTokens: config.defaultMaxCompletionTokens,
        isKnownAlias: modelRegistry.isKnownAlias,
        transcribeAudio: transcribeAudio({ transcription: whisperService, logger }),
        createChatCompletion: createChatCompletion(chatDeps),
        streamChatCompletion: streamChatCompletion(chatDeps),
        getReadiness: getReadiness({
            store: providerStore,
            transcription: whisperService,
            listAliases: modelRegistry.listAliases,
            proxyKeyConfigured: Boolean(config.personalProxyApiKey),
        }),
        listModels: listModels({
            listAliases: modelRegistry.listAliases,
            whisperModelAlias: config.whisperModelAlias,
        }),
        getProviderStatus: getProviderStatus({ store: providerStore }),
    };

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

            const ctx: RouteContext = { request, url, requestId, requestStart, server, deps };

            const response = await routeRequest(ctx, config.personalProxyApiKey);

            // OBS-01: streaming responses set X-Request-ID at construction time (presenters/sse.ts)
            // and must not be rebuilt; every other response gets the header attached here.
            return response.headers.has('X-Request-ID')
                ? response
                : withRequestId(response, requestId);
        },
    });
}
