// tests/integration/mock-adapters.ts — Scriptable ProviderAdapter mocks for integration tests.
// Default implementations return upstream model IDs (proving NORM-01/TEST-11 end-to-end).
// Per-test scriptability via completeMock.mockImplementationOnce / streamMock.mockImplementationOnce.

import { mock } from 'bun:test';
import type { CompletionOutcome, ProviderAdapter, StreamChunk } from '../../types';

// Upstream model IDs returned by mocks — matching the registry defaults:
//   gpt-oss-120b-balanced -> cerebras: 'gpt-oss-120b', groq: 'openai/gpt-oss-120b'
const UPSTREAM_MODEL_ID: Record<'cerebras' | 'groq', string> = {
    cerebras: 'gpt-oss-120b',
    groq: 'openai/gpt-oss-120b',
};

export type MockAdapter = ProviderAdapter & {
    completeMock: ReturnType<typeof mock>;
    streamMock: ReturnType<typeof mock>;
};

function makeDefaultComplete(name: 'cerebras' | 'groq'): () => Promise<CompletionOutcome> {
    return async () => ({
        result: {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            // Return UPSTREAM model ID — normalizer must rewrite to logical alias (TEST-11)
            model: UPSTREAM_MODEL_ID[name]!,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: name },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        headers: {},
    });
}

function makeDefaultStream(name: 'cerebras' | 'groq'): () => Promise<AsyncIterable<StreamChunk>> {
    return async () => (async function* () {
        // Chunk 1: role delta
        yield {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: UPSTREAM_MODEL_ID[name]!,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        };
        // Chunk 2: content delta carrying the adapter name (assertable from test)
        yield {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: UPSTREAM_MODEL_ID[name]!,
            choices: [{ index: 0, delta: { content: name }, finish_reason: null }],
        };
        // Chunk 3: finish chunk
        yield {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: UPSTREAM_MODEL_ID[name]!,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
    })();
}

export function makeMockAdapter(name: 'cerebras' | 'groq'): MockAdapter {
    const completeMock = mock(makeDefaultComplete(name));
    const streamMock = mock(makeDefaultStream(name));

    return {
        name,
        complete: completeMock,
        stream: streamMock,
        completeMock,
        streamMock,
    };
}

// Reset a mock adapter back to its default implementations.
// Call this in beforeEach alongside resetForTesting() to prevent TEST-05's persistent
// mockImplementation overrides from leaking into subsequent tests.
export function resetMockAdapter(adapter: MockAdapter): void {
    adapter.completeMock.mockReset();
    adapter.completeMock.mockImplementation(makeDefaultComplete(adapter.name as 'cerebras' | 'groq'));
    adapter.streamMock.mockReset();
    adapter.streamMock.mockImplementation(makeDefaultStream(adapter.name as 'cerebras' | 'groq'));
}
