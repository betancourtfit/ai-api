// adapters/inbound/http/router.ts — the ordered dispatch table (V-11 closed).
//
// ⚠ THE PRE-AUTH SEGMENT IS LOAD-BEARING. ⚠
// PRE_AUTH_ROUTES is walked BEFORE requireBearer runs. /health and /ready must stay
// unauthenticated for container healthchecks, and the Gemini route authenticates with
// `x-goog-api-key` / `?key=` rather than a Bearer token — routing it after the Bearer gate would
// return an OpenAI-shaped 401 to a Gemini client. tests/integration/gemini-compat.test.ts asserts
// the Gemini-shaped 401, and tests/integration/server.test.ts asserts a 401 on every /v1/* route
// without a token, so moving a route between the two segments fails the suite in one direction
// or the other. Do not reorder without changing those tests deliberately.
import { requireBearer } from './middleware/bearer-auth';
import { matchHealth, handleHealth } from './routes/health';
import { matchReady, handleReady } from './routes/ready';
import { matchGeminiGenerateContent, handleGeminiGenerateContent } from './routes/gemini-generate-content';
import { matchTranscriptions, handleTranscriptions } from './routes/transcriptions';
import { matchProvidersStatus, handleProvidersStatus } from './routes/providers-status';
import { matchModels, handleModels } from './routes/models';
import { matchChatCompletions, handleChatCompletions } from './routes/chat-completions';
import { openaiError } from './presenters/openai-error';
import type { RouteContext } from './context';

export interface Route {
    name: string;
    match(method: string, pathname: string): boolean;
    handle(ctx: RouteContext): Response | Promise<Response>;
}

// Walked BEFORE the Bearer gate. Order within the segment is preserved as written.
export const PRE_AUTH_ROUTES: Route[] = [
    { name: 'health', match: matchHealth, handle: handleHealth },                                    // GET / and GET /health
    { name: 'ready', match: matchReady, handle: handleReady },                                       // GET /ready
    { name: 'geminiGenerateContent', match: matchGeminiGenerateContent, handle: handleGeminiGenerateContent }, // POST /v1beta/models/{model}:generateContent
];

// Walked AFTER the Bearer gate. Every route here requires Authorization: Bearer.
export const POST_AUTH_ROUTES: Route[] = [
    { name: 'transcriptions', match: matchTranscriptions, handle: handleTranscriptions },   // POST /v1/audio/transcriptions
    { name: 'providersStatus', match: matchProvidersStatus, handle: handleProvidersStatus }, // GET /internal/providers/status
    { name: 'models', match: matchModels, handle: handleModels },                            // GET /v1/models
    { name: 'chatCompletions', match: matchChatCompletions, handle: handleChatCompletions },  // POST /v1/chat/completions
];

export async function routeRequest(
    ctx: RouteContext,
    expectedProxyKey: string | null
): Promise<Response> {
    const method = ctx.request.method;
    const { pathname } = ctx.url;

    for (const route of PRE_AUTH_ROUTES) {
        if (route.match(method, pathname)) {
            return await route.handle(ctx);
        }
    }

    // --- Auth gate — all routes below require Bearer PERSONAL_PROXY_API_KEY ---
    const auth = requireBearer(ctx.request, expectedProxyKey);
    if (!auth.ok) {
        return auth.response;
    }

    for (const route of POST_AUTH_ROUTES) {
        if (route.match(method, pathname)) {
            return await route.handle(ctx);
        }
    }

    // NORM-10: OpenAI error shape for 404 catch-all
    return openaiError(
        'The requested endpoint does not exist.',
        'invalid_request_error',
        'not_found',
        null,
        404
    );
}
