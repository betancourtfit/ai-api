// domain/errors.ts — domain error types (Phase 8, HEX-04)
// Declarations only: plan 08-03 wires use cases to throw/return these and maps them to
// the existing OpenAI/Gemini error bodies. They carry a status and a human message only —
// never a provider name, an upstream URL, or key material (T-08-02-05).
// No imports.

export class UpstreamRejectedError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "UpstreamRejectedError";
        this.status = status;
    }
}

export class NoProviderAvailableError extends Error {
    constructor(message = "No eligible provider available for the requested model.") {
        super(message);
        this.name = "NoProviderAvailableError";
    }
}

export class TranscriptionUnavailableError extends Error {
    constructor(message = "Transcription service is unavailable.") {
        super(message);
        this.name = "TranscriptionUnavailableError";
    }
}
