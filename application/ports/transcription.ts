// application/ports/transcription.ts — outbound port for audio transcription (HEX-07, HEX-08)
// Interface only. File/Blob are allowed port primitives (ARCHITECTURE.md §3); FormData is not.
import type { AudioTranscriptionResult } from '../../domain/types';

export interface TranscriptionPort {
    transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>;
    health(): Promise<boolean>;
}
