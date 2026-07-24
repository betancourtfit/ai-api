// domain/audio-limits.ts — the pure audio size rule (AUDIO-03).
// Lives in domain/ so the transcribe-audio use case can enforce it without importing the
// delivery-layer Zod module. adapters/inbound/http/schemas/audio-schema.ts re-uses this same
// implementation, so the 413 message exists exactly once.
// No imports.

export function checkAudioFileSize(
    sizeBytes: number,
    maxBytes: number
): { ok: true } | { ok: false; message: string } {
    if (sizeBytes > maxBytes) {
        return {
            ok: false,
            message: `File too large. Maximum allowed size is ${maxBytes} bytes.`,
        };
    }
    return { ok: true };
}
