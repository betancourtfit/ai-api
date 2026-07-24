// adapters/inbound/http/middleware/request-id.ts — OBS-01.
// The id is generated at the very top of the request and attached to every response.

export function newRequestId(): string {
    return crypto.randomUUID();
}

// OBS-01: rebuild response with X-Request-ID header on every non-streaming return.
// Streaming responses set the header at construction time instead (see presenters/sse.ts).
export function withRequestId(response: Response, requestId: string): Response {
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', requestId);
    return new Response(response.body, { status: response.status, headers });
}
