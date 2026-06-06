// whisper-service.ts — injectable Whisper transcription contract (Phase 5)
// NoopWhisperService is the production default until Phase 6 wires the HTTP sidecar.
import type { AudioTranscriptionResult } from './types';

export interface WhisperService {
    transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>;
}

export class NoopWhisperService implements WhisperService {
    async transcribe(_file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        throw new Error('WhisperService not configured. Set WHISPER_HOST and WHISPER_MODEL_ALIAS.');
    }
}
