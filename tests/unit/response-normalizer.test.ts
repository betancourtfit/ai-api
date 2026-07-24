// tests/unit/response-normalizer.test.ts — Unit coverage for response-normalizer.ts
// Tests: model rewrite, object literals, provider-field stripping by construction,
//        usage synthesis, system_fingerprint conditional, delta rebuild (NORM-01..09)
import { describe, expect, test } from 'bun:test';
import { normalizeResponse, normalizeChunk } from '../../domain/normalization';
import type { ChatCompletionResult, StreamChunk } from '../../domain/types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_RESULT: ChatCompletionResult = {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    created: 1769729480,
    model: 'upstream-model-id',
    choices: [
        {
            index: 0,
            message: { role: 'assistant', content: 'Hello world.' },
            finish_reason: 'stop',
        },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
};

const BASE_CHUNK: StreamChunk = {
    id: 'chatcmpl-chunk-001',
    object: 'chat.completion.chunk',
    created: 1769729480,
    model: 'upstream-chunk-model',
    choices: [
        {
            index: 0,
            delta: { role: 'assistant', content: 'partial' },
            finish_reason: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// normalizeResponse
// ---------------------------------------------------------------------------

describe('normalizeResponse', () => {
    test('NORM-01: rewrites model to the logical alias', () => {
        const result = normalizeResponse(BASE_RESULT, 'gpt-oss-120b-balanced');
        expect(result.model).toBe('gpt-oss-120b-balanced');
    });

    test('NORM-09: output object is exactly "chat.completion"', () => {
        // Even if raw somehow has a different value (cast to test), output is correct literal
        const raw = { ...BASE_RESULT, object: 'some.other.type' } as unknown as ChatCompletionResult;
        const result = normalizeResponse(raw, 'gpt-oss-120b-balanced');
        expect(result.object).toBe('chat.completion');
    });

    test('preserves id, created, choices, finish_reason, and message content', () => {
        const result = normalizeResponse(BASE_RESULT, 'gpt-oss-120b-balanced');
        expect(result.id).toBe('chatcmpl-abc123');
        expect(result.created).toBe(1769729480);
        expect(result.choices).toHaveLength(1);
        expect(result.choices[0]?.message.role).toBe('assistant');
        expect(result.choices[0]?.message.content).toBe('Hello world.');
        expect(result.choices[0]?.finish_reason).toBe('stop');
        expect(result.choices[0]?.index).toBe(0);
    });

    test('NORM-08: preserves usage verbatim when present', () => {
        const result = normalizeResponse(BASE_RESULT, 'gpt-oss-120b-balanced');
        expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    });

    test('NORM-08: synthesizes zero usage when raw.usage is undefined', () => {
        const raw = { ...BASE_RESULT, usage: undefined } as unknown as ChatCompletionResult;
        const result = normalizeResponse(raw, 'gpt-oss-120b-balanced');
        expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    });

    test('system_fingerprint is preserved when present in raw', () => {
        const raw = { ...BASE_RESULT, system_fingerprint: 'fp_abc123' };
        const result = normalizeResponse(raw, 'gpt-oss-120b-balanced');
        expect(result.system_fingerprint).toBe('fp_abc123');
        expect(Object.hasOwn(result, 'system_fingerprint')).toBe(true);
    });

    test('system_fingerprint key is absent (not merely undefined) when missing in raw', () => {
        const raw = { ...BASE_RESULT };
        delete (raw as Partial<ChatCompletionResult>).system_fingerprint;
        const result = normalizeResponse(raw as ChatCompletionResult, 'gpt-oss-120b-balanced');
        expect(Object.hasOwn(result, 'system_fingerprint')).toBe(false);
    });

    test('NORM-03/04/05/07: provider-specific fields are absent from output by construction', () => {
        // Inject Cerebras and Groq provider-specific fields via cast
        const rawWithExtras = {
            ...BASE_RESULT,
            time_info: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.05, total_time: 0.061 },
            x_groq: { id: 'groq-req-id' },
            usage_breakdown: { some: 'data' },
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant' as const,
                        content: 'Hello world.',
                        reasoning: 'internal chain of thought',
                    },
                    reasoning_logprobs: [{ token: 'x', logprob: -0.5 }],
                    finish_reason: 'stop',
                },
            ],
        } as unknown as ChatCompletionResult;

        const result = normalizeResponse(rawWithExtras, 'gpt-oss-120b-balanced');

        // Top-level provider fields must not appear
        expect((result as Record<string, unknown>)['time_info']).toBeUndefined();
        expect((result as Record<string, unknown>)['x_groq']).toBeUndefined();
        expect((result as Record<string, unknown>)['usage_breakdown']).toBeUndefined();

        // Per-choice provider fields must not appear
        const choice = result.choices[0] as Record<string, unknown>;
        expect(choice['reasoning_logprobs']).toBeUndefined();
        const message = result.choices[0]?.message as Record<string, unknown>;
        expect(message['reasoning']).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// normalizeChunk
// ---------------------------------------------------------------------------

describe('normalizeChunk', () => {
    test('NORM-02: rewrites model to the logical alias in chunks', () => {
        const result = normalizeChunk(BASE_CHUNK, 'gpt-oss-120b-balanced');
        expect(result.model).toBe('gpt-oss-120b-balanced');
    });

    test('NORM-09: output object is exactly "chat.completion.chunk"', () => {
        const raw = { ...BASE_CHUNK, object: 'some.type' } as unknown as StreamChunk;
        const result = normalizeChunk(raw, 'gpt-oss-120b-balanced');
        expect(result.object).toBe('chat.completion.chunk');
    });

    test('preserves id, created, index, and finish_reason', () => {
        const chunk: StreamChunk = {
            ...BASE_CHUNK,
            choices: [{ index: 2, delta: { content: 'x' }, finish_reason: 'stop' }],
        };
        const result = normalizeChunk(chunk, 'gpt-oss-120b-balanced');
        expect(result.id).toBe('chatcmpl-chunk-001');
        expect(result.created).toBe(1769729480);
        expect(result.choices[0]?.index).toBe(2);
        expect(result.choices[0]?.finish_reason).toBe('stop');
    });

    test('NORM-06: delta.role is included only when present in raw delta', () => {
        const withRole = normalizeChunk(BASE_CHUNK, 'gpt-oss-120b-balanced');
        expect(withRole.choices[0]?.delta.role).toBe('assistant');

        const chunk: StreamChunk = {
            ...BASE_CHUNK,
            choices: [{ index: 0, delta: { content: 'text' }, finish_reason: null }],
        };
        const withoutRole = normalizeChunk(chunk, 'gpt-oss-120b-balanced');
        expect(Object.hasOwn(withoutRole.choices[0]?.delta ?? {}, 'role')).toBe(false);
    });

    test('NORM-06: delta.content is included (even when null) only when key exists in raw delta', () => {
        // content present with value
        const withContent = normalizeChunk(BASE_CHUNK, 'gpt-oss-120b-balanced');
        expect(withContent.choices[0]?.delta.content).toBe('partial');

        // content present as null (explicit null must pass through)
        const chunkNullContent: StreamChunk = {
            ...BASE_CHUNK,
            choices: [{ index: 0, delta: { content: null }, finish_reason: null }],
        };
        const withNull = normalizeChunk(chunkNullContent, 'gpt-oss-120b-balanced');
        expect(Object.hasOwn(withNull.choices[0]?.delta ?? {}, 'content')).toBe(true);
        expect(withNull.choices[0]?.delta.content).toBeNull();

        // content key absent — must not appear in output
        const chunkNoContent: StreamChunk = {
            ...BASE_CHUNK,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
        };
        const withoutContent = normalizeChunk(chunkNoContent, 'gpt-oss-120b-balanced');
        expect(Object.hasOwn(withoutContent.choices[0]?.delta ?? {}, 'content')).toBe(false);
    });

    test('NORM-06: delta.reasoning injected via cast never appears in output', () => {
        const rawChunk = {
            ...BASE_CHUNK,
            choices: [
                {
                    index: 0,
                    delta: { role: 'assistant', content: 'hi', reasoning: 'thinking...' },
                    finish_reason: null,
                },
            ],
        } as unknown as StreamChunk;

        const result = normalizeChunk(rawChunk, 'gpt-oss-120b-balanced');
        expect((result.choices[0]?.delta as Record<string, unknown>)['reasoning']).toBeUndefined();
    });
});
