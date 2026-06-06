// services/groq.ts — Groq non-streaming adapter (D-01 second adapter)
// Implements ProviderAdapter for both non-streaming and streaming completions.
// groq-sdk v1.2.1: import Groq default; stream:false uses ChatCompletionCreateParamsNonStreaming overload
import Groq from 'groq-sdk';
import type { ChatCompletionChunk } from 'groq-sdk/resources/chat/completions';
import { config } from '../config';
import type { ProviderAdapter, ChatCompletionResult, CompletionOutcome, CompletionParams, StreamChunk } from '../types';

let groq: Groq | null = null;

function getGroqClient(): Groq {
    if (!config.groqApiKey) {
        throw new Error('Groq provider is not configured.');
    }

    if (!groq) {
        groq = new Groq({ apiKey: config.groqApiKey, maxRetries: 0 });
    }

    return groq;
}

export const groqAdapter: ProviderAdapter = {
    name: 'groq',
    async complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome> {
        const client = getGroqClient();
        // stream:false resolves to ChatCompletionCreateParamsNonStreaming overload
        const { data, response } = await client.chat.completions.create({
            model: upstreamModelId,
            messages: params.messages,
            temperature: params.temperature === 0 ? 1e-8 : (params.temperature ?? undefined), // WR-03: Groq rejects temperature=0; convert to 1e-8 per CLAUDE.md §11
            top_p: params.top_p ?? undefined,
            max_completion_tokens: params.max_completion_tokens,
            stop: params.stop ?? undefined,
            seed: params.seed ?? undefined,
            stream: false,
        }).withResponse();

        // Build result field-by-field — do NOT spread response (Pitfall 5).
        // Groq-specific fields (internal metadata, hardware cache stats, tier) are
        // structurally excluded by only copying the standard OpenAI-compatible fields.
        // response-normalizer.ts owns field stripping and model rewrite.
        const result: ChatCompletionResult = {
            id: data.id,
            object: 'chat.completion',
            created: data.created,
            model: data.model,
            choices: data.choices.map((c, i) => ({
                index: i,
                message: { role: 'assistant', content: c.message.content ?? '' },
                finish_reason: c.finish_reason ?? null,
            })),
            usage: data.usage ? {
                prompt_tokens: data.usage.prompt_tokens ?? 0,
                completion_tokens: data.usage.completion_tokens ?? 0,
                total_tokens: data.usage.total_tokens ?? 0,
            } : undefined,
            system_fingerprint: data.system_fingerprint ?? undefined,
        };

        return { result, headers: response.headers };
    },
    async stream(
        upstreamModelId: string,
        params: CompletionParams,
        signal: AbortSignal
    ): Promise<AsyncIterable<StreamChunk>> {
        const client = getGroqClient();
        const sdkStream = await client.chat.completions.create({
            model: upstreamModelId,
            messages: params.messages,
            temperature: params.temperature === 0 ? 1e-8 : (params.temperature ?? undefined), // WR-03: Groq rejects temperature=0; convert to 1e-8 per CLAUDE.md §11
            top_p: params.top_p ?? undefined,
            max_completion_tokens: params.max_completion_tokens,
            stop: params.stop ?? undefined,
            seed: params.seed ?? undefined,
            stream: true,
        }, { signal });

        return (async function* (): AsyncIterable<StreamChunk> {
            for await (const raw of sdkStream) {
                const chunk = raw as ChatCompletionChunk;

                yield {
                    id: chunk.id,
                    object: 'chat.completion.chunk',
                    created: chunk.created,
                    model: chunk.model,
                    choices: chunk.choices.map((choice) => {
                        const delta: StreamChunk['choices'][number]['delta'] = {};
                        if (choice.delta.role !== undefined) {
                            delta.role = choice.delta.role;
                        }
                        if ('content' in choice.delta) {
                            delta.content = choice.delta.content ?? null;
                        }

                        return {
                            index: choice.index,
                            delta,
                            finish_reason: choice.finish_reason ?? null,
                        };
                    }),
                };
            }
        })();
    },
};
