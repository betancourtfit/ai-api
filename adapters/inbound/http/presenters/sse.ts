// adapters/inbound/http/presenters/sse.ts — Server-Sent Events framing for the streaming route.
// The use case yields StreamChunk objects; this presenter owns every byte of wire format.
//
// CR-03: the terminating `data: [DONE]\n\n` sentinel is emitted UNCONDITIONALLY — after a clean
// stream, after a mid-stream upstream error, and even if the producer terminates early — so a
// client never hangs waiting for it.
import type { StreamChunk } from '../../../../domain/types';

export async function* toSseStream(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<string> {
    try {
        for await (const chunk of chunks) {
            yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
    } finally {
        yield 'data: [DONE]\n\n';
    }
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
