// adapters/outbound/groq-chat-provider.ts — Groq ChatProviderPort implementation.
// groq-sdk v1.2.1: import Groq default; stream:false uses the ChatCompletionCreateParamsNonStreaming overload.
// The SDK client is created inside the factory closure, lazily on first use — never at import time (V-06).
import Groq from 'groq-sdk';
import type { ChatCompletionChunk } from 'groq-sdk/resources/chat/completions';
import { toHeaderRecord } from './sdk-error-mapper';
import type { ChatProviderPort } from '../../application/ports/chat-provider';
import type { ChatCompletionResult, CompletionOutcome, CompletionParams, StreamChunk } from '../../domain/types';

export interface GroqProviderConfig {
    apiKey: string | null;
}

export function createGroqChatProvider(cfg: GroqProviderConfig): ChatProviderPort {
    let client: Groq | null = null;

    function getGroqClient(): Groq {
        if (!cfg.apiKey) {
            throw new Error('Groq provider is not configured.');
        }

        if (!client) {
            client = new Groq({ apiKey: cfg.apiKey, maxRetries: 0 });
        }

        return client;
    }

    return {
        name: 'groq',
        async complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome> {
            const sdk = getGroqClient();
            // stream:false resolves to ChatCompletionCreateParamsNonStreaming overload
            const { data, response } = await sdk.chat.completions.create({
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
            // domain/normalization.ts owns field stripping and model rewrite.
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

            return { result, headers: toHeaderRecord(response.headers) ?? {} };
        },
        async stream(
            upstreamModelId: string,
            params: CompletionParams,
            signal: AbortSignal
        ): Promise<AsyncIterable<StreamChunk>> {
            const sdk = getGroqClient();
            const sdkStream = await sdk.chat.completions.create({
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
}
