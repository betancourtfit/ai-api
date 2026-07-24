// adapters/inbound/http/context.ts — the per-request context every route handler receives.
// `deps` is assembled once in server.ts; nothing here is rebuilt per request except the id,
// the parsed URL, and the start timestamp.
import type { Logger } from '../../../application/ports/logger';
import type { transcribeAudio } from '../../../application/use-cases/transcribe-audio';

export interface ServerDeps {
    logger: Logger;
    audioMaxFileBytes: number;
    transcribeAudio: ReturnType<typeof transcribeAudio>;
}

export interface RouteContext {
    request: Request;
    url: URL;
    requestId: string;
    requestStart: number;
    deps: ServerDeps;
}
