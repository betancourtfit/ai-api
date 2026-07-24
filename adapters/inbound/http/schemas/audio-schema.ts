// audio-schema.ts — Zod v4 strict allowlist validation for audio transcription (AUDIO-01..06)
// Structural mirror of request-schema.ts.
import * as z from 'zod';
import { getUnrecognizedKey } from './schema-utils.ts';
import { checkAudioFileSize } from '../../../../domain/audio-limits';

// Strict 3-field allowlist per AUDIO-01..05:
//   model: required string (AUDIO-02)
//   file: must be File instance, not string (AUDIO-01)
//   response_format: only 'json' accepted; all other values rejected (AUDIO-04/05)
// Unknown keys are rejected by the strict schema (AUDIO-05).
export const audioTranscriptionSchema = z.strictObject({
    model: z.string(),                             // AUDIO-02: model field required
    file: z.instanceof(File),                      // AUDIO-01: file field required, must be File instance
    response_format: z.literal('json').optional(), // AUDIO-04: only 'json' accepted; AUDIO-05: other values rejected
});

export type AudioTranscriptionInput = z.infer<typeof audioTranscriptionSchema>;

// D-05: return first offending field only — stop at first violation
export function validateAudioTranscription(input: unknown):
    { success: true; data: AudioTranscriptionInput } |
    { success: false; param: string | null; message: string }
{
    const result = audioTranscriptionSchema.safeParse(input);
    if (result.success) return { success: true, data: result.data };

    const firstIssue = result.error.issues[0];
    if (!firstIssue) return { success: false, param: null, message: 'Invalid request body' };

    // path is [] for unrecognized top-level keys (unrecognized_keys issue)
    // path is ['file'] for file field errors (missing/invalid type)
    // path is ['model'] for model field errors (missing)
    let param: string | null;
    if (firstIssue.path.length > 0) {
        // Named path: use path[0] (covers 'file', 'model', 'response_format', etc.)
        param = String(firstIssue.path[0]);
    } else if (firstIssue.code === 'unrecognized_keys') {
        param = getUnrecognizedKey(firstIssue);
    } else {
        param = null;
    }

    return { success: false, param, message: firstIssue.message };
}

// AUDIO-03: explicit pre-Zod size check — the unit-testable 413 path.
// Do NOT use z.file().max() for this: Zod size violations produce 400-shaped ZodErrors, not 413.
// Caller passes config.audioMaxFileBytes so tests do not depend on env state.
export function validateAudioFileSize(
    file: File,
    maxBytes: number
): { ok: true } | { ok: false; message: string } {
    return checkAudioFileSize(file.size, maxBytes);
}
