// index.ts — Bun.serve() router with auth + validation + alias resolve + completion
// Phase 1: non-streaming path only (D-02); round-robin is Phase 2 (D-01 discretion)
import { timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { isKnownAlias, resolveUpstreamModel, listAliases } from './model-registry';
import { validateChatCompletion } from './request-schema';
import type { CompletionParams } from './types';
import { cerebrasAdapter } from './services/cerebras';

// Map provider names to adapters (Phase 2 will replace with round-robin router)
const adapterMap = {
    cerebras: cerebrasAdapter,
} as const;

// OpenAI-style error shape (D-05 + spec §14) — used for ALL error paths
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}

// AUTH-01..04: extract Bearer token — never log or echo value
function extractBearerToken(request: Request): string | null {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7);
}

// AUTH-03: constant-time comparison — length pre-check prevents timingSafeEqual throw (Pitfall 6)
function verifyToken(token: string, expected: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(request) {
        const { pathname } = new URL(request.url);

        // EP-04: GET /health — no auth required (healthcheck para EasyPanel / reverse proxies)
        if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
            return new Response('ok', { status: 200 });
        }

        // --- Auth gate — all routes below require Bearer PERSONAL_PROXY_API_KEY ---
        const token = extractBearerToken(request);
        if (!token || !verifyToken(token, config.personalProxyApiKey)) {
            return openaiError(
                'No authorization provided or invalid credentials.',
                'invalid_request_error',
                'missing_auth',
                null,
                401
            );
        }

        // GET /v1/models — list logical proxy aliases only (REG-04; EP-03)
        if (request.method === 'GET' && pathname === '/v1/models') {
            return new Response(
                JSON.stringify({
                    object: 'list',
                    data: listAliases().map((id) => ({
                        id,
                        object: 'model',
                        created: 0,
                        owned_by: 'personal-proxy',
                    })),
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // POST /v1/chat/completions — main non-streaming completion endpoint
        if (request.method === 'POST' && pathname === '/v1/chat/completions') {
            // Parse JSON body
            let body: unknown;
            try {
                body = await request.json();
            } catch {
                return openaiError('Request body must be valid JSON.', 'invalid_request_error', 'invalid_request_error', null, 400);
            }

            // VALID-01/02: validate against strict Zod schema (first-error, D-05)
            const validation = validateChatCompletion(body);
            if (!validation.success) {
                return openaiError(
                    validation.message,
                    'invalid_request_error',
                    'invalid_request_error',
                    validation.param,
                    400
                );
            }

            const input = validation.data;

            // VALID-01: unknown model alias — reject before any upstream call
            if (!isKnownAlias(input.model)) {
                return openaiError(
                    `Unknown model '${input.model}'.`,
                    'invalid_request_error',
                    'model_not_found',
                    'model',
                    400
                );
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

            // Phase 1: pick first eligible provider in PROVIDER_ORDER (round-robin is Phase 2)
            let chosenAlias: string | null = null;
            let completionResult = null;
            for (const provider of config.providerOrder) {
                const upstreamModelId = resolveUpstreamModel(input.model, provider);
                if (!upstreamModelId) continue;
                const adapter = adapterMap[provider as keyof typeof adapterMap];
                if (!adapter) continue;
                completionResult = await adapter.complete(upstreamModelId, params);
                chosenAlias = input.model;
                break;
            }

            if (!completionResult || !chosenAlias) {
                return openaiError(
                    'No eligible provider available for the requested model.',
                    'server_error',
                    'no_provider_available',
                    'model',
                    503
                );
            }

            // Normalize: rewrite upstream model ID to logical alias (spec §15)
            completionResult.model = chosenAlias;

            return new Response(
                JSON.stringify(completionResult),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response('Not found', { status: 404 });
    },
});

console.log(`Server is running on ${server.url}`);
