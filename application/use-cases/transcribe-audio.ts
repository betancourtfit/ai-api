// application/use-cases/transcribe-audio.ts — the single transcription use case (HEX-09, HEX-10).
// Backs BOTH POST /v1/audio/transcriptions and POST /v1beta/models/{model}:generateContent.
// Transport-free: builds no HTTP response, knows neither the OpenAI nor the Gemini wire shape.
// Never logs a filename or transcript text (T-08-03-06).
import { checkAudioFileSize } from '../../domain/audio-limits';
import type { TranscriptionPort } from '../ports/transcription';
import type { Logger } from '../ports/logger';

export interface TranscribeAudioDeps {
    transcription: TranscriptionPort;
    logger: Logger;
}

export interface TranscribeAudioInput {
    file: File;
    modelAlias: string;
    maxBytes: number;
}

export type TranscribeAudioResult =
    | { ok: true; text: string }
    | { ok: false; reason: 'too_large' | 'unavailable'; message: string };

export function transcribeAudio(deps: TranscribeAudioDeps) {
    return async function run(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
        const sizeCheck = checkAudioFileSize(input.file.size, input.maxBytes);
        if (!sizeCheck.ok) {
            return { ok: false, reason: 'too_large', message: sizeCheck.message };
        }

        try {
            const result = await deps.transcription.transcribe(input.file, input.modelAlias);
            return { ok: true, text: result.text };
        } catch {
            return {
                ok: false,
                reason: 'unavailable',
                message: 'Transcription service is unavailable.',
            };
        }
    };
}
