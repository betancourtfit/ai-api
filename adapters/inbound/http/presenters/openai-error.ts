// adapters/inbound/http/presenters/openai-error.ts — OpenAI wire error shape (D-05 + spec §14).
// Used for ALL error paths except the Gemini route, which has its own presenter.

export function openaiError(
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

export function authNotConfiguredError(): Response {
    return openaiError(
        'Proxy authentication is not configured.',
        'server_error',
        'proxy_not_configured',
        null,
        503
    );
}
