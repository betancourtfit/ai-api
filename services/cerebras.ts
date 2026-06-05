// services/cerebras.ts — Cerebras non-streaming adapter (D-01 first adapter)
// Implements ProviderAdapter for both non-streaming and streaming completions.
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming } from '@cerebras/cerebras_cloud_sdk/resources/chat';
import { config } from '../config';
import type { ProviderAdapter, ChatCompletionResult, CompletionOutcome, CompletionParams, StreamChunk } from '../types';

let cerebras: Cerebras | null = null;

function getCerebrasClient(): Cerebras {
    if (!config.cerebrasApiKey) {
        throw new Error('Cerebras provider is not configured.');
    }

    if (!cerebras) {
        cerebras = new Cerebras({ apiKey: config.cerebrasApiKey, maxRetries: 0 });
    }

    return cerebras;
}

export const cerebrasAdapter: ProviderAdapter = {
    name: 'cerebras',
    async complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome> {
        const client = getCerebrasClient();
        // Cast create() params to NonStreaming overload; cast response to ChatCompletionResponse
        // (the union ChatCompletion includes chunk types; we know this path returns the full response)
        const { data, response } = await client.chat.completions.create(
            {
                model: upstreamModelId,
                messages: params.messages,
                temperature: params.temperature ?? undefined,
                top_p: params.top_p ?? undefined,
                max_completion_tokens: params.max_completion_tokens,
                stop: params.stop ?? undefined,
                seed: params.seed ?? undefined,
                stream: false,
            } as ChatCompletionCreateParamsNonStreaming,
            {
                headers: {
                    'X-Cerebras-Version-Patch': config.cerebrasVersionPatch,
                },
            }
        ).withResponse();
        const completion = data as ChatCompletion.ChatCompletionResponse;

        // Build result field-by-field — do NOT spread response (Pitfall 4).
        // response-normalizer.ts owns field stripping (time_info, reasoning, etc.) and model rewrite.
        const result: ChatCompletionResult = {
            id: completion.id,
            object: 'chat.completion',
            created: completion.created,
            model: completion.model,
            choices: completion.choices.map((c, i) => ({
                index: i,
                message: { role: 'assistant', content: c.message.content ?? '' },
                finish_reason: c.finish_reason ?? null,
            })),
            usage: completion.usage ? {
                prompt_tokens: completion.usage.prompt_tokens ?? 0,
                completion_tokens: completion.usage.completion_tokens ?? 0,
                total_tokens: completion.usage.total_tokens ?? 0,
            } : undefined,
            system_fingerprint: completion.system_fingerprint ?? undefined,
        };

        return { result, headers: response.headers };
    },
    async stream(
        upstreamModelId: string,
        params: CompletionParams,
        signal: AbortSignal
    ): Promise<AsyncIterable<StreamChunk>> {
        const client = getCerebrasClient();
        const sdkStream = await client.chat.completions.create(
            {
                model: upstreamModelId,
                messages: params.messages,
                temperature: params.temperature ?? undefined,
                top_p: params.top_p ?? undefined,
                max_completion_tokens: params.max_completion_tokens,
                stop: params.stop ?? undefined,
                seed: params.seed ?? undefined,
                stream: true,
            } as ChatCompletionCreateParamsStreaming,
            {
                headers: {
                    'X-Cerebras-Version-Patch': config.cerebrasVersionPatch,
                },
                signal,
            }
        );

        return (async function* (): AsyncIterable<StreamChunk> {
            for await (const raw of sdkStream) {
                const chunk = raw as ChatCompletion.ChatChunkResponse;

                yield {
                    id: chunk.id,
                    object: 'chat.completion.chunk',
                    created: chunk.created,
                    model: chunk.model,
                    choices: (chunk.choices ?? []).map((choice) => {
                        const delta: StreamChunk['choices'][number]['delta'] = {};
                        if (choice.delta?.role !== undefined && choice.delta.role !== null) {
                            delta.role = choice.delta.role;
                        }
                        if (choice.delta && 'content' in choice.delta) {
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
