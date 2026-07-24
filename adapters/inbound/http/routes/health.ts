// adapters/inbound/http/routes/health.ts
// EP-04: GET / and GET /health — no auth required (healthcheck para EasyPanel / reverse proxies).
// BUILD_VERSION (git SHA, baked at image build) lets you confirm WHICH build is live.
// Reading process.env here is legal: this is an adapter, not domain or application code.
import type { RouteContext } from '../context';

export function matchHealth(method: string, pathname: string): boolean {
    return method === 'GET' && (pathname === '/' || pathname === '/health');
}

export function handleHealth(_ctx: RouteContext): Response {
    return new Response(`ok ${process.env["BUILD_VERSION"] ?? "dev"}`, { status: 200 });
}
