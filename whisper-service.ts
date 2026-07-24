// Phase 8 compatibility shim — removed in plan 08-04.
// Port: application/ports/transcription.ts · Adapters: adapters/outbound/{http,noop}-whisper.ts
import type { TranscriptionPort } from './application/ports/transcription';

export type WhisperService = TranscriptionPort;
export { NoopWhisperService } from './adapters/outbound/noop-whisper';
export { HttpWhisperService } from './adapters/outbound/http-whisper';
export type { HttpWhisperOptions } from './adapters/outbound/http-whisper';
