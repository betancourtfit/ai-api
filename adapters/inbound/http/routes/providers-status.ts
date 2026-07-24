// adapters/inbound/http/routes/providers-status.ts
// GET /internal/providers/status — optional protected diagnostics endpoint.
// Returns a NORM-10 OpenAI-shaped 404 when the endpoint is disabled, so a disabled endpoint is
// indistinguishable from a nonexistent one.
import { openaiError } from '../presenters/openai-error';
import type { RouteContext } from '../context';

export function matchProvidersStatus(method: string, pathname: string): boolean {
    return method === 'GET' && pathname === '/internal/providers/status';
}

export function handleProvidersStatus(ctx: RouteContext): Response {
    if (!ctx.deps.enableInternalStatusEndpoint) {
        // NORM-10: OpenAI error shape for disabled internal endpoint
        return openaiError(
            'The requested endpoint does not exist.',
            'invalid_request_error',
            'not_found',
            null,
            404
        );
    }

    return new Response(
        JSON.stringify({ providers: ctx.deps.getProviderStatus() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}
