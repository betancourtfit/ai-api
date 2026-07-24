// adapters/inbound/http/routes/ready.ts — GET /ready, no auth required.
// The eligibility computation lives in application/use-cases/get-readiness.ts; this route
// only chooses the status code and serialises the body.
import type { RouteContext } from '../context';

export function matchReady(method: string, pathname: string): boolean {
    return method === 'GET' && pathname === '/ready';
}

export async function handleReady(ctx: RouteContext): Promise<Response> {
    const readiness = await ctx.deps.getReadiness();

    return new Response(
        JSON.stringify(readiness),
        {
            status: readiness.ready ? 200 : 503,
            headers: { 'Content-Type': 'application/json' },
        }
    );
}
