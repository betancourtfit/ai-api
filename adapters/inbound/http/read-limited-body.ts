// adapters/inbound/http/read-limited-body.ts
// Read raw body via ReadableStream — the Content-Length header cannot be trusted.
// request.text() honors the declared Content-Length and may deliver fewer bytes than the actual
// wire payload when the header is understated (UAT-04-05). A streaming read with a running byte
// counter measures ACTUAL wire bytes independently of any Content-Length value, and cancels the
// reader as soon as the limit is exceeded (T-08-03-03).

export type ReadLimitedBodyResult =
    | { ok: true; text: string }
    | { ok: false; reason: 'too_large' | 'unreadable' };

export async function readLimitedBody(
    request: Request,
    maxBytes: number
): Promise<ReadLimitedBodyResult> {
    try {
        if (!request.body) {
            return { ok: false, reason: 'unreadable' };
        }
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let runningTotal = 0;
        let limitExceeded = false;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                runningTotal += value.byteLength;
                if (runningTotal > maxBytes) {
                    limitExceeded = true;
                    await reader.cancel();
                    break;
                }
                chunks.push(value);
            }
        } catch {
            return { ok: false, reason: 'unreadable' };
        }

        if (limitExceeded) {
            return { ok: false, reason: 'too_large' };
        }

        // Combine accumulated Uint8Array chunks into a single buffer and decode
        const combined = new Uint8Array(runningTotal);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { ok: true, text: new TextDecoder().decode(combined) };
    } catch {
        return { ok: false, reason: 'unreadable' };
    }
}
