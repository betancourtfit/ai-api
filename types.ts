// types.ts — shared interface contracts for the proxy
// ProviderAdapter yields upstream model IDs; response-normalizer.ts rewrites them to the logical alias.

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
    model: string; // adapter returns upstream id; response-normalizer.ts rewrites to logical alias
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

export interface CompletionOutcome {
    result: ChatCompletionResult;
    headers: Headers;
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

export interface ProviderAdapter {
    name: string;
    complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome>;
    stream(upstreamModelId: string, params: CompletionParams, signal: AbortSignal): Promise<AsyncIterable<StreamChunk>>;
}

// AUDIO-06: OpenAI json transcription response shape
export interface AudioTranscriptionResult {
    text: string;
}
