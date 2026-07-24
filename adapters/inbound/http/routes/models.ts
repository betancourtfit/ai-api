// adapters/inbound/http/routes/models.ts
// GET /v1/models — list logical proxy aliases only (REG-04; EP-03; EP2-02).
// The use case owns which ids are advertised; this route owns the OpenAI list envelope.
import type { RouteContext } from '../context';

export function matchModels(method: string, pathname: string): boolean {
    return method === 'GET' && pathname === '/v1/models';
}

export function handleModels(ctx: RouteContext): Response {
    const data = ctx.deps.listModels().map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'personal-proxy',
    }));

    return new Response(
        JSON.stringify({ object: 'list', data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}
