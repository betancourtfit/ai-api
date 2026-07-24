// adapters/inbound/http/context.ts — the per-request context every route handler receives.
// `deps` is assembled once in server.ts; nothing here is rebuilt per request except the id,
// the parsed URL, the start timestamp, and the Bun server handle.
import type { Logger } from '../../../application/ports/logger';
import type { transcribeAudio } from '../../../application/use-cases/transcribe-audio';
import type { createChatCompletion } from '../../../application/use-cases/create-chat-completion';
import type { streamChatCompletion } from '../../../application/use-cases/stream-chat-completion';
import type { getReadiness } from '../../../application/use-cases/get-readiness';
import type { listModels } from '../../../application/use-cases/list-models';
import type { getProviderStatus } from '../../../application/use-cases/get-provider-status';

export interface ServerDeps {
    logger: Logger;
    audioMaxFileBytes: number;
    maxRequestBodyBytes: number;
    exposeProviderHeader: boolean;
    enableInternalStatusEndpoint: boolean;
    defaultModelAlias: string | null;
    defaultMaxCompletionTokens: number;
    isKnownAlias(alias: string): boolean;
    transcribeAudio: ReturnType<typeof transcribeAudio>;
    createChatCompletion: ReturnType<typeof createChatCompletion>;
    streamChatCompletion: ReturnType<typeof streamChatCompletion>;
    getReadiness: ReturnType<typeof getReadiness>;
    listModels: ReturnType<typeof listModels>;
    getProviderStatus: ReturnType<typeof getProviderStatus>;
}

export interface RouteContext {
    request: Request;
    url: URL;
    requestId: string;
    requestStart: number;
    server: { timeout(request: Request, seconds: number): void };
    deps: ServerDeps;
}
