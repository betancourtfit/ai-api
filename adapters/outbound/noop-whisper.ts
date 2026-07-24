// adapters/outbound/noop-whisper.ts — TranscriptionPort no-op implementation.
// Production default until WHISPER_MODEL_ALIAS is set. No config import.
import type { AudioTranscriptionResult } from '../../domain/types';
import type { TranscriptionPort } from '../../application/ports/transcription';

export class NoopWhisperService implements TranscriptionPort {
    async transcribe(_file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        throw new Error('WhisperService not configured. Set WHISPER_HOST and WHISPER_MODEL_ALIAS.');
    }

    async health(): Promise<boolean> {
        return false;
    }
}
