// services/cerebras.ts — Cerebras non-streaming adapter (D-01 first adapter)
// Implements ProviderAdapter; no streaming in Phase 1 (D-02)
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { ChatCompletionCreateParamsNonStreaming } from '@cerebras/cerebras_cloud_sdk';
import { config } from '../config';
import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from '../types';

// SDK singleton initialized with maxRetries:0 (INFRA-03) — proxy handles retries/failover
const cerebras = new Cerebras({ apiKey: config.cerebrasApiKey, maxRetries: 0 });

export const cerebrasAdapter: ProviderAdapter = {
    name: 'cerebras',
    async complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult> {
        const response = await cerebras.chat.completions.create(
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
        );

        // Build result field-by-field — do NOT spread response (Pitfall 4):
        //   response.time_info: stripped (spec §15 — not forwarded downstream)
        //   response.choices[*].message.reasoning: stripped (spec §12 — never expose)
        return {
            id: response.id,
            object: 'chat.completion',
            created: response.created,
            model: response.model, // caller (index.ts) rewrites to logical alias
            choices: response.choices.map((c, i) => ({
                index: i,
                message: { role: 'assistant', content: c.message.content ?? '' },
                finish_reason: c.finish_reason ?? null,
            })),
            usage: {
                prompt_tokens: response.usage?.prompt_tokens ?? 0,
                completion_tokens: response.usage?.completion_tokens ?? 0,
                total_tokens: response.usage?.total_tokens ?? 0,
            },
            system_fingerprint: response.system_fingerprint ?? undefined,
        };
    },
};
