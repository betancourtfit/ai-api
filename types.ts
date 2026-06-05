// types.ts — shared interface contracts for the proxy
// ProviderAdapter: non-streaming completion interface (D-02: streaming deferred to Phase 2)

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
    model: string; // adapter returns upstream id; index.ts rewrites to logical alias
    choices: Array<{
        index: number;
        message: { role: "assistant"; content: string };
        finish_reason: string | null;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    system_fingerprint?: string;
}

export interface ProviderAdapter {
    name: string;
    complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult>;
    // stream() deferred to Phase 2 (D-02)
}
