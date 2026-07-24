// domain/normalization.ts — Central allowlist-rebuild normalizer (D-05, D-06)
// Owns field stripping and model rewrite for both response paths.
// Uses allowlist-rebuild (never spread raw input, never delete) — NORM-01..09.
import type { ChatCompletionResult, StreamChunk } from './types';

// Zero-usage sentinel synthesized when upstream omits usage (NORM-08 / D-08)
const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } as const;

/**
 * Normalize a non-streaming ChatCompletionResult before sending to downstream client.
 *
 * Guarantees (NORM-01..09, T-03-01, T-03-02):
 *   - model is rewritten to logicalAlias (NORM-01)
 *   - object is always the literal "chat.completion" (NORM-09)
 *   - Only allowlisted top-level fields are present — time_info, x_groq, usage_breakdown
 *     and any other provider-specific field is excluded by construction (NORM-03,04,05,07)
 *   - choices[].message only contains role and content — reasoning is excluded (NORM-03)
 *   - choices[] only contains index, message, and finish_reason — reasoning_logprobs excluded (NORM-04)
 *   - usage is synthesized as zero-object when upstream omits it (NORM-08)
 *   - system_fingerprint is included only when present in raw (key absent, not undefined)
 */
export function normalizeResponse(raw: ChatCompletionResult, logicalAlias: string): ChatCompletionResult {
    const fingerprint = raw.system_fingerprint;

    return {
        id: raw.id,
        object: 'chat.completion',
        created: raw.created,
        model: logicalAlias,
        choices: raw.choices.map((c) => ({
            index: c.index,
            message: {
                role: 'assistant' as const,
                content: c.message.content,
            },
            finish_reason: c.finish_reason,
        })),
        usage: raw.usage ?? ZERO_USAGE,
        ...(fingerprint !== undefined ? { system_fingerprint: fingerprint } : {}),
    };
}

/**
 * Normalize a streaming StreamChunk before forwarding to downstream client.
 *
 * Guarantees (NORM-02,06,09, T-03-01, T-03-02):
 *   - model is rewritten to logicalAlias (NORM-02)
 *   - object is always the literal "chat.completion.chunk" (NORM-09)
 *   - delta.role is included only when defined in raw delta (NORM-06)
 *   - delta.content is included (including explicit null) only when "content" is a key in raw delta (NORM-06)
 *   - delta.reasoning and any other provider-specific delta field are excluded by construction (NORM-06)
 */
export function normalizeChunk(raw: StreamChunk, logicalAlias: string): StreamChunk {
    return {
        id: raw.id,
        object: 'chat.completion.chunk',
        created: raw.created,
        model: logicalAlias,
        choices: raw.choices.map((c) => {
            // Build delta conditionally — only include keys that were present in raw
            const delta: StreamChunk['choices'][number]['delta'] = {};

            if (c.delta.role !== undefined) {
                delta.role = c.delta.role;
            }

            if ('content' in c.delta) {
                delta.content = c.delta.content ?? null;
            }

            return {
                index: c.index,
                delta,
                finish_reason: c.finish_reason,
            };
        }),
    };
}
