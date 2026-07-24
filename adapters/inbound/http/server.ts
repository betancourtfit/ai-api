// adapters/inbound/http/server.ts — the Bun.serve() delivery adapter.
// Dependencies come from the composition root; this module wires use cases to routes and owns
// nothing but transport. Signature and defaults are identical to the pre-refactor factory, plus
// an optional 5th `deps` parameter so a test can inject its own store or providers.
import { config } from '../../../config';
import { buildContainer, getDefaultContainer } from '../../../composition/container';
import { transcribeAudio } from '../../../application/use-cases/transcribe-audio';
import { createChatCompletion } from '../../../application/use-cases/create-chat-completion';
import { streamChatCompletion } from '../../../application/use-cases/stream-chat-completion';
import { getReadiness } from '../../../application/use-cases/get-readiness';
import { listModels } from '../../../application/use-cases/list-models';
import { getProviderStatus } from '../../../application/use-cases/get-provider-status';
import { toUpstreamFailure } from '../../outbound/sdk-error-mapper';
import { newRequestId, withRequestId } from './middleware/request-id';
import { routeRequest } from './router';
import type { Container } from '../../../composition/container';
import type { ChatUseCaseDeps } from '../../../application/use-cases/chat-deps';
import type { ProviderId } from '../../../domain/types';
import type { ChatProviderPort } from '../../../application/ports/chat-provider';
import type { TranscriptionPort } from '../../../application/ports/transcription';
import type { RouteContext, ServerDeps } from './context';

// D-02: exported factory — importing this module does NOT bind a port
export function createServer(
    adapters?: Record<ProviderId, ChatProviderPort>,
    port: number = config.port,
    whisperService?: TranscriptionPort,
    audioMaxFileBytes: number = config.audioMaxFileBytes,
    deps?: Partial<Container>
): ReturnType<typeof Bun.serve> {
    // Without injected deps every server shares the one default container, so all of them
    // observe the same provider-state store. With deps, the caller gets its own graph.
    const container = deps ? buildContainer(config, deps) : getDefaultContainer(config);

    // Explicit positional arguments win over the container — they are how every existing
    // test injects mock adapters and a mock whisper service.
    const chatProviders = adapters ?? container.chatProviders;
    const transcription = whisperService ?? container.transcription;
    const { logger, clock, registry, store } = container;

    // toFailure is injected so the application layer never imports the vendor-aware mapper.
    const chatDeps: ChatUseCaseDeps = {
        providers: chatProviders,
        store,
        registry,
        logger,
        clock,
        maxAttempts: config.maxProviderAttemptsPerRequest,
        defaultCooldownSeconds: config.defaultCooldownSeconds,
        toFailure: toUpstreamFailure,
    };

    const serverDeps: ServerDeps = {
        logger,
        audioMaxFileBytes,
        maxRequestBodyBytes: config.maxRequestBodyBytes,
        exposeProviderHeader: config.exposeProviderHeader,
        enableInternalStatusEndpoint: config.enableInternalStatusEndpoint,
        // Read LIVE per request, not captured at createServer() time: `config` is not frozen at
        // runtime and tests/integration/server.test.ts mutates config.defaultModelAlias around
        // individual cases and restores it afterwards.
        get defaultModelAlias() { return config.defaultModelAlias; },
        defaultMaxCompletionTokens: config.defaultMaxCompletionTokens,
        isKnownAlias: registry.isKnownAlias,
        transcribeAudio: transcribeAudio({ transcription, logger }),
        createChatCompletion: createChatCompletion(chatDeps),
        streamChatCompletion: streamChatCompletion(chatDeps),
        getReadiness: getReadiness({
            store,
            transcription,
            listAliases: registry.listAliases,
            proxyKeyConfigured: Boolean(config.personalProxyApiKey),
        }),
        listModels: listModels({
            listAliases: registry.listAliases,
            whisperModelAlias: config.whisperModelAlias,
        }),
        getProviderStatus: getProviderStatus({ store }),
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

            const ctx: RouteContext = { request, url, requestId, requestStart, server, deps: serverDeps };

            const response = await routeRequest(ctx, config.personalProxyApiKey);

            // OBS-01: streaming responses set X-Request-ID at construction time (presenters/sse.ts)
            // and must not be rebuilt; every other response gets the header attached here.
            return response.headers.has('X-Request-ID')
                ? response
                : withRequestId(response, requestId);
        },
    });
}
