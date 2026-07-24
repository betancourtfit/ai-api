// domain/types.ts — pure DTO contracts for the proxy (Phase 8, HEX-04)
// No imports. No vendor SDK types, no HTTP transport types.
// ProviderAdapter is NOT here — it is a port and lives in application/ports/chat-provider.ts.

export type ProviderId = "cerebras" | "groq";

export interface CompletionParams {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    temperature?: number | null;
    top_p?: number | null;
    max_completion_tokens: number; // always present after default injection (D-04)
    stop?: string | string[] | null;
    seed?: number | null;
}

export interface ChatCompletionResult {
    id: string;
    object: "chat.completion";
    created: number;
    model: string; // adapter returns upstream id; domain/normalization.ts rewrites to logical alias
    choices: Array<{
        index: number;
        message: { role: "assistant"; content: string };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    system_fingerprint?: string;
}

// V-04 closed: headers cross the port as a flattened, lowercase-keyed record, never as a
// WHATWG Headers. Adapters flatten with toHeaderRecord() at their edge.
export interface CompletionOutcome {
    result: ChatCompletionResult;
    headers: Record<string, string>;
}

export interface StreamChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string | null;
        };
        finish_reason: string | null;
    }>;
}

// AUDIO-06: OpenAI json transcription response shape
export interface AudioTranscriptionResult {
    text: string;
}

// Per-provider routing state. Declared here (not in application/ports) because domain modules
// may not import from application/; the port file re-exports this same type.
export interface ProviderState {
    provider: ProviderId;
    enabled: boolean;
    configured: boolean;
    healthy: boolean;
    cooldownUntil: number | null;
    lastSelectedAt: number | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    lastStatusCode: number | null;
    consecutiveFailures: number;
    rateLimitSnapshot?: Record<string, string>;
}

// Provider-agnostic view of a failed upstream call. Produced at the adapter edge by
// adapters/outbound/sdk-error-mapper.ts so routing policy never sees a vendor error class.
export interface UpstreamFailure {
    status: number | undefined;
    message: string | undefined;
    headers: Record<string, string> | undefined;
}
