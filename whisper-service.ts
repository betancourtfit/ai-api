// whisper-service.ts — injectable Whisper transcription contract (Phase 5–6)
// NoopWhisperService is the production default until WHISPER_MODEL_ALIAS is set.
import type { AudioTranscriptionResult } from './types';
import { config } from './config';

export interface WhisperService {
    transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>;
    health(): Promise<boolean>;
}

export class NoopWhisperService implements WhisperService {
    async transcribe(_file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        throw new Error('WhisperService not configured. Set WHISPER_HOST and WHISPER_MODEL_ALIAS.');
    }

    async health(): Promise<boolean> {
        return false;
    }
}

// Constructor overrides for tests — production uses config defaults
interface HttpWhisperOptions {
    host?: string;
    port?: number;
    inferencePath?: string;
    timeoutMs?: number;
    healthTimeoutMs?: number;
}

// HTTP client for whisper.cpp sidecar (POST /inference, GET /health)
export class HttpWhisperService implements WhisperService {
    private readonly baseUrl: string;
    private readonly inferencePath: string;
    private readonly timeoutMs: number;
    private readonly healthTimeoutMs: number;

    constructor(opts: HttpWhisperOptions = {}) {
        const host = opts.host ?? config.whisperHost;
        const port = opts.port ?? config.whisperPort;
        this.baseUrl = `http://${host}:${port}`;
        this.inferencePath = opts.inferencePath ?? '/inference';
        this.timeoutMs = opts.timeoutMs ?? config.whisperTimeoutMs;
        this.healthTimeoutMs = opts.healthTimeoutMs ?? 2000;
    }

    async transcribe(file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        const form = new FormData();
        form.append('file', file, 'audio');
        form.append('response_format', 'json');

        const res = await fetch(`${this.baseUrl}${this.inferencePath}`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
            throw new Error(`whisper-server responded ${res.status}`);
        }

        const body = await res.json() as { text?: string };
        return { text: body.text ?? '' };
    }

    async health(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/health`, {
                signal: AbortSignal.timeout(this.healthTimeoutMs),
            });
            return res.ok;
        } catch {
            return false;
        }
    }
}
