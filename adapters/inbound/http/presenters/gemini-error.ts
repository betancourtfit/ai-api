// adapters/inbound/http/presenters/gemini-error.ts
// D-12 (Phase 7): Gemini error shape — { error: { code, message, status } }, NO `type` field.
// Distinct from openaiError; used for EVERY error path on the /v1beta/.../:generateContent route
// so a migrating n8n Gemini node sees Gemini-shaped errors, never OpenAI leakage (GEM-09, GEM-12).
// `code` is the HTTP status (int); `status` is the Gemini UPPER_SNAKE_CASE token
// (401→UNAUTHENTICATED, 400→INVALID_ARGUMENT, 503→UNAVAILABLE).

export function geminiError(code: number, message: string, status: string): Response {
    return new Response(
        JSON.stringify({ error: { code, message, status } }),
        { status: code, headers: { 'Content-Type': 'application/json' } }
    );
}
