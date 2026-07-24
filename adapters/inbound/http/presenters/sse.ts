// adapters/inbound/http/presenters/sse.ts — Server-Sent Events framing for the streaming route.
// The use case yields StreamChunk objects; this presenter owns every byte of wire format.
//
// CR-03: the terminating `data: [DONE]\n\n` sentinel is emitted on BOTH completion paths — after a
// clean stream and after a mid-stream producer error — so a client never hangs waiting for it.
//
// Deliberately NOT emitted from a `finally` block: `finally` also runs when the consumer calls
// .return() on the generator (client disconnect / stream cancellation), and yielding while a
// generator is being closed resumes it instead of completing it, leaving it suspended. The
// pre-refactor inline generator emitted the sentinel from `try` and `catch` only; this reproduces
// that exactly, so an aborted request closes promptly rather than writing to a dead socket.
import type { StreamChunk } from '../../../../domain/types';

export async function* toSseStream(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<string> {
    try {
        for await (const chunk of chunks) {
            yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
    } catch {
        // The use case already logged the failure; still close the stream cleanly.
        yield 'data: [DONE]\n\n';
        return;
    }

    yield 'data: [DONE]\n\n';
}

export function sseHeaders(opts: {
    requestId: string;
    provider: string;
    exposeProvider: boolean;
}): Record<string, string> {
    // OBS-01: X-Request-ID in streaming headers at construction time (not via the wrapper)
    // OBS-05: X-LLM-Provider conditional on config.exposeProviderHeader
    return {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-ID': opts.requestId,
        ...(opts.exposeProvider ? { 'X-LLM-Provider': opts.provider } : {}),
    };
}
