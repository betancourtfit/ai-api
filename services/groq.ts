// services/groq.ts — Groq non-streaming adapter (D-01 second adapter)
// Implements ProviderAdapter; no streaming in Phase 1 (D-02)
// groq-sdk v1.2.1: import Groq default; stream:false uses ChatCompletionCreateParamsNonStreaming overload
import Groq from 'groq-sdk';
import { config } from '../config';
import type { ProviderAdapter, ChatCompletionResult, CompletionOutcome, CompletionParams } from '../types';

// SDK singleton initialized with maxRetries:0 (INFRA-03) — proxy handles retries/failover
const groq = new Groq({ apiKey: config.groqApiKey, maxRetries: 0 });

export const groqAdapter: ProviderAdapter = {
    name: 'groq',
    async complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome> {
        // stream:false resolves to ChatCompletionCreateParamsNonStreaming overload
        const { data, response } = await groq.chat.completions.create({
            model: upstreamModelId,
            messages: params.messages,
            temperature: params.temperature ?? undefined,
            top_p: params.top_p ?? undefined,
            max_completion_tokens: params.max_completion_tokens,
            stop: params.stop ?? undefined,
            seed: params.seed ?? undefined,
            stream: false,
        }).withResponse();

        // Build result field-by-field — do NOT spread response (Pitfall 5).
        // Groq-specific fields (internal metadata, hardware cache stats, tier) are
        // structurally excluded by only copying the standard OpenAI-compatible fields.
        const result: ChatCompletionResult = {
            id: data.id,
            object: 'chat.completion',
            created: data.created,
            model: data.model, // caller (index.ts) rewrites to logical alias
            choices: data.choices.map((c, i) => ({
                index: i,
                message: { role: 'assistant', content: c.message.content ?? '' },
                finish_reason: c.finish_reason ?? null,
            })),
            usage: {
                prompt_tokens: data.usage?.prompt_tokens ?? 0,
                completion_tokens: data.usage?.completion_tokens ?? 0,
                total_tokens: data.usage?.total_tokens ?? 0,
            },
            system_fingerprint: data.system_fingerprint ?? undefined,
        };

        return { result, headers: response.headers };
    },
};
