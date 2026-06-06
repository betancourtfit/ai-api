// tests/integration/server.test.ts — 12-case integration suite (TEST-01..12)
// Boots a real Bun.serve() instance via createServer(mockAdapters, 0).
// All assertions made through real fetch() — no real API keys, no network calls.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { APIError as CerebrasAPIError } from '@cerebras/cerebras_cloud_sdk';
import { APIError as GroqAPIError } from 'groq-sdk';
import { createServer } from '../../index';
import { resetForTesting } from '../../routing/provider-state';
import { makeMockAdapter, resetMockAdapter } from './mock-adapters';
import type { MockAdapter } from './mock-adapters';

// Read proxy key from .env.test (loaded by bun test) — never hardcode
const PROXY_KEY = process.env['PERSONAL_PROXY_API_KEY']!;

let server: ReturnType<typeof createServer>;
let mockCerebras: MockAdapter;
let mockGroq: MockAdapter;

beforeAll(() => {
    mockCerebras = makeMockAdapter('cerebras');
    mockGroq = makeMockAdapter('groq');
    // port 0 = OS-assigned free port; read back via server.port
    server = createServer({ cerebras: mockCerebras, groq: mockGroq }, 0);
});

afterAll(() => {
    server.stop(true);
});

beforeEach(() => {
    // TEST-12: state isolation — reset routing cursor and cooldowns
    resetForTesting();
    // Restore default mock implementations after TEST-05's persistent overrides
    resetMockAdapter(mockCerebras);
    resetMockAdapter(mockGroq);
});

afterEach(() => {
    // Guard against TEST-03 fake-clock leakage even on test failure
    setSystemTime();
});

// Helpers — use 127.0.0.1 (not 0.0.0.0) for client fetch; port read from server object
function url(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
}

async function post(body: object, extraHeaders?: Record<string, string>): Promise<Response> {
    return fetch(url('/v1/chat/completions'), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PROXY_KEY}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });
}

const validBody = {
    model: 'gpt-oss-120b-balanced',
    messages: [{ role: 'user', content: 'hi' }],
};

describe('Integration: contract tests', () => {

    test('TEST-06: invalid auth returns 401 with error shape and X-Request-ID', async () => {
        // Missing Authorization header
        const resNoAuth = await fetch(url('/v1/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        expect(resNoAuth.status).toBe(401);
        expect(resNoAuth.headers.get('X-Request-ID')).toBeTruthy();
        const bodyNoAuth = await resNoAuth.json() as { error?: { message?: string; type?: string; code?: string } };
        expect(bodyNoAuth.error).toBeDefined();
        expect(typeof bodyNoAuth.error!.message).toBe('string');
        expect(typeof bodyNoAuth.error!.type).toBe('string');
        expect(bodyNoAuth.error!.code).toBeDefined();

        // Wrong key
        const resWrongKey = await fetch(url('/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer wrong-key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(validBody),
        });
        expect(resWrongKey.status).toBe(401);
        expect(resWrongKey.headers.get('X-Request-ID')).toBeTruthy();
    });

    test('TEST-07: unknown model alias returns 400 with model_not_found and X-Request-ID', async () => {
        const res = await post({ model: 'does-not-exist', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(400);
        expect(res.headers.get('X-Request-ID')).toBeTruthy();
        const body = await res.json() as { error?: { code?: string } };
        expect(body.error?.code).toBe('model_not_found');
    });

    test('TEST-08: unsupported fields return 400', async () => {
        // logprobs: true
        const res1 = await post({ ...validBody, logprobs: true });
        expect(res1.status).toBe(400);
        const body1 = await res1.json() as { error?: object };
        expect(body1.error).toBeDefined();

        // n: 2
        const res2 = await post({ ...validBody, n: 2 });
        expect(res2.status).toBe(400);
        const body2 = await res2.json() as { error?: object };
        expect(body2.error).toBeDefined();

        // messages[].name
        const res3 = await post({
            model: 'gpt-oss-120b-balanced',
            messages: [{ role: 'user', content: 'hi', name: 'x' }],
        });
        expect(res3.status).toBe(400);
        const body3 = await res3.json() as { error?: object };
        expect(body3.error).toBeDefined();
    });

    test('TEST-09: valid non-streaming response has correct OpenAI shape', async () => {
        const res = await post(validBody);
        expect(res.status).toBe(200);

        // OBS-01: X-Request-ID on every response
        expect(res.headers.get('X-Request-ID')).toBeTruthy();
        // OBS-05: X-LLM-Provider absent by default (EXPOSE_PROVIDER_HEADER=false)
        expect(res.headers.get('X-LLM-Provider')).toBeNull();

        const body = await res.json() as {
            id?: string;
            object?: string;
            created?: number;
            model?: string;
            choices?: Array<{ message?: { content?: unknown } }>;
            usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
            time_info?: unknown;
            x_groq?: unknown;
            usage_breakdown?: unknown;
        };

        // NORM-09: exact object literal
        expect(body.object).toBe('chat.completion');
        // NORM-08: usage always present
        expect(body.usage).toBeDefined();
        expect(typeof body.usage!.prompt_tokens).toBe('number');
        expect(typeof body.usage!.completion_tokens).toBe('number');
        expect(typeof body.usage!.total_tokens).toBe('number');
        // id and created present
        expect(body.id).toBeDefined();
        expect(body.created).toBeDefined();
        // choices content is a string
        expect(typeof body.choices?.[0]?.message?.content).toBe('string');
        // NORM-03..07: provider-specific fields absent
        expect(body.time_info).toBeUndefined();
        expect(body.x_groq).toBeUndefined();
        expect(body.usage_breakdown).toBeUndefined();
        const choice = body.choices?.[0] as Record<string, unknown> | undefined;
        expect((choice?.['message'] as Record<string, unknown> | undefined)?.['reasoning']).toBeUndefined();
    });

    test('TEST-11: response.model is logical alias not upstream model ID', async () => {
        const res = await post(validBody);
        expect(res.status).toBe(200);
        const body = await res.json() as { model?: string };
        // NORM-01: model rewritten from upstream ID ('gpt-oss-120b') to logical alias
        expect(body.model).toBe('gpt-oss-120b-balanced');
    });

    test('TEST-12a: after beforeEach reset, first request goes to cerebras', async () => {
        // cursor resets to 0 → cerebras first
        await post(validBody);
        expect(mockCerebras.completeMock.mock.calls.length).toBe(1);
        expect(mockGroq.completeMock.mock.calls.length).toBe(0);
    });

    test('TEST-12b: determinism proof — second test also starts from cerebras (no cursor leak)', async () => {
        // Identical assertion in a separate test proves resetForTesting() works
        await post(validBody);
        expect(mockCerebras.completeMock.mock.calls.length).toBe(1);
        expect(mockGroq.completeMock.mock.calls.length).toBe(0);
    });

});

describe('Integration: routing and streaming tests', () => {

    test('TEST-01: consecutive requests alternate providers (round-robin)', async () => {
        // Request 1 → cerebras (cursor at 0)
        const res1 = await post(validBody);
        expect(res1.status).toBe(200);
        const body1 = await res1.json() as { choices?: Array<{ message?: { content?: string } }> };
        expect(body1.choices?.[0]?.message?.content).toBe('cerebras');

        // Request 2 → groq (cursor advanced)
        const res2 = await post(validBody);
        expect(res2.status).toBe(200);
        const body2 = await res2.json() as { choices?: Array<{ message?: { content?: string } }> };
        expect(body2.choices?.[0]?.message?.content).toBe('groq');

        // Verify call counts: cerebras 1, groq 1
        expect(mockCerebras.completeMock.mock.calls.length).toBe(1);
        expect(mockGroq.completeMock.mock.calls.length).toBe(1);
    });

    test('TEST-02: 429 cooldown — cerebras cooled down, subsequent goes to groq', async () => {
        // Make cerebras throw 429 on the first attempt
        mockCerebras.completeMock.mockImplementationOnce(async () => {
            throw new CerebrasAPIError(
                429,
                undefined,
                'rate limited',
                new Headers({ 'retry-after': '30' }) as ConstructorParameters<typeof CerebrasAPIError>[3]
            );
        });

        // Request 1 → cerebras throws 429, failover to groq (max(30, 60) = 60s cooldown)
        const res1 = await post(validBody);
        expect(res1.status).toBe(200);
        const body1 = await res1.json() as { choices?: Array<{ message?: { content?: string } }> };
        expect(body1.choices?.[0]?.message?.content).toBe('groq');

        // Request 2 → cerebras still in cooldown, routes to groq again
        const res2 = await post(validBody);
        expect(res2.status).toBe(200);
        const body2 = await res2.json() as { choices?: Array<{ message?: { content?: string } }> };
        expect(body2.choices?.[0]?.message?.content).toBe('groq');

        // Cerebras completeMock called exactly once (the initial 429 attempt)
        expect(mockCerebras.completeMock.mock.calls.length).toBe(1);
    });

    test('TEST-03: provider recovers after cooldown expiry (D-03: setSystemTime)', async () => {
        const before = Date.now();

        // Trigger cerebras 429 cooldown
        mockCerebras.completeMock.mockImplementationOnce(async () => {
            throw new CerebrasAPIError(
                429,
                undefined,
                'rate limited',
                new Headers({ 'retry-after': '30' }) as ConstructorParameters<typeof CerebrasAPIError>[3]
            );
        });

        // First request: cerebras throws 429, failover to groq; cooldownUntil = now + max(30,60)s = 60s
        const res1 = await post(validBody);
        expect(res1.status).toBe(200);
        const body1 = await res1.json() as { choices?: Array<{ message?: { content?: string } }> };
        expect(body1.choices?.[0]?.message?.content).toBe('groq');

        // Advance clock past the cooldown (max(30, 60)=60s → advance 61s).
        // Do NOT call resetForTesting() here — that wipes the cooldown and makes
        // the assertion vacuous (cerebras would be selected even without clock advance).
        // Only reset the mock implementations so subsequent calls succeed.
        setSystemTime(new Date(before + 61_000));
        resetMockAdapter(mockCerebras);
        resetMockAdapter(mockGroq);

        // After request 1, cursor advanced to 1 (groq). Request 2 starts at groq.
        // We need two more requests to cycle back to cerebras (cursor 1→groq, 2→cerebras).
        const res2 = await post(validBody); // cursor=1: groq serves it, advances to 2 (wraps→0)
        expect(res2.status).toBe(200);

        const res3 = await post(validBody); // cursor=0: cerebras eligible again, serves it
        expect(res3.status).toBe(200);
        // cerebras must have been called in res3 — proves isEligible() cleared cooldown correctly
        expect(mockCerebras.completeMock.mock.calls.length).toBeGreaterThan(0);
        // Real time is restored by the harness afterEach setSystemTime() call
    });

    test('TEST-04: 500 from cerebras triggers failover to groq, client sees 200', async () => {
        mockCerebras.completeMock.mockImplementationOnce(async () => {
            throw new CerebrasAPIError(500, undefined, 'Internal Server Error', undefined);
        });

        const res = await post(validBody);
        expect(res.status).toBe(200);

        const body = await res.json() as { model?: string; choices?: Array<{ message?: { content?: string } }> };
        // Client sees logical alias (NORM-01)
        expect(body.model).toBe('gpt-oss-120b-balanced');
        // Served by groq (cerebras threw)
        expect(body.choices?.[0]?.message?.content).toBe('groq');
    });

    test('TEST-05: both providers exhausted → 503 no_provider_available', async () => {
        // Persistent overrides — both always throw 500
        mockCerebras.completeMock.mockImplementation(async () => {
            throw new CerebrasAPIError(500, undefined, 'down', undefined);
        });
        mockGroq.completeMock.mockImplementation(async () => {
            throw new GroqAPIError(500, undefined, 'down', undefined);
        });

        const res = await post(validBody);
        expect(res.status).toBe(503);
        expect(res.headers.get('X-Request-ID')).toBeTruthy();

        const body = await res.json() as { error?: { message?: string; type?: string; code?: string; param?: unknown } };
        expect(body.error).toBeDefined();
        expect(body.error!.code).toBe('no_provider_available');
        expect(typeof body.error!.message).toBe('string');
        expect(typeof body.error!.type).toBe('string');
        // param key must be present (NORM-10 shape requires all four keys)
        expect('param' in body.error!).toBe(true);
        // resetMockAdapter in beforeEach restores defaults for subsequent tests
    });

    test('TEST-10: streaming SSE format validated, [DONE] sentinel present, chunk shape correct', async () => {
        const res = await post({ ...validBody, stream: true });
        expect(res.status).toBe(200);

        // OBS-01: X-Request-ID present on streaming response
        expect(res.headers.get('X-Request-ID')).toBeTruthy();
        // Streaming content-type
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');

        // Buffer full SSE body — acceptable in tests (Pattern 7: res.text() is fine for shape validation)
        const text = await res.text();
        const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));

        // Last data line must be exactly 'data: [DONE]'
        const lastLine = dataLines[dataLines.length - 1];
        expect(lastLine).toBe('data: [DONE]');

        // At least one JSON chunk before [DONE]
        const jsonLines = dataLines.filter((l) => l !== 'data: [DONE]');
        expect(jsonLines.length).toBeGreaterThan(0);

        // Parse first JSON chunk — validate shape
        const firstChunkRaw = jsonLines[0]!.slice('data: '.length);
        const firstChunk = JSON.parse(firstChunkRaw) as {
            object?: string;
            model?: string;
            choices?: Array<{ delta?: { reasoning?: unknown } }>;
        };

        // NORM-09: streaming object literal
        expect(firstChunk.object).toBe('chat.completion.chunk');
        // NORM-02: model rewritten to logical alias in streaming chunks
        expect(firstChunk.model).toBe('gpt-oss-120b-balanced');
        // NORM-06: delta.reasoning absent
        expect(firstChunk.choices?.[0]?.delta?.['reasoning' as keyof typeof firstChunk.choices[0]['delta']]).toBeUndefined();
    });

    // TEST-13..15: CR-01 regression tests — body gate must use actual bytes, not client-supplied header

    test('TEST-13: chunked body >1 MiB (no Content-Length) returns 413', async () => {
        // Simulate chunked-encoding client: omit Content-Length header entirely
        // Bun's fetch still sends the actual bytes — gate must use Buffer.byteLength(raw)
        const oversizedBody = JSON.stringify({
            model: 'gpt-oss-120b-balanced',
            messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }],
        });
        const res = await fetch(url('/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PROXY_KEY}`,
                'Content-Type': 'application/json',
                // Intentionally no Content-Length — simulates chunked-encoding client
            },
            body: oversizedBody,
        });
        expect(res.status).toBe(413);
        const body = await res.json() as { error?: { code?: string } };
        expect(body.error?.code).toBe('request_too_large');
    });

    test('TEST-14: malformed Content-Length (NaN) with >1 MiB body is rejected', async () => {
        // Content-Length: abc → Bun's HTTP stack rejects the malformed header with 431 before reaching
        // the app handler. The security property still holds: the request is rejected regardless.
        // Note: Bun returns 431 (Request Header Fields Too Large) for malformed Content-Length values
        // before the request reaches application code — the bypass path described in CR-01 does not
        // materialize in practice because Bun validates headers at the transport layer.
        const oversizedBody = JSON.stringify({
            model: 'gpt-oss-120b-balanced',
            messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }],
        });
        const res = await fetch(url('/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PROXY_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': 'abc',
            },
            body: oversizedBody,
        });
        // Bun rejects malformed Content-Length with 431 at the transport layer;
        // app layer Buffer.byteLength gate handles the 413 case for numeric-but-understated headers
        expect([413, 431]).toContain(res.status);
    });

    test('TEST-15: understated Content-Length with >1 MiB body is rejected', async () => {
        // Content-Length: 1 — header says tiny, actual body is oversized.
        // After the streaming-read fix (04-03), the app layer reads actual wire bytes via
        // ReadableStream and counts them independently of the Content-Length header.
        // The running byte counter exceeds maxRequestBodyBytes before the stream is done,
        // so the app returns 413 request_too_large before JSON.parse is attempted.
        // Bun's HTTP stack may reject a Content-Length/body mismatch at transport layer (431)
        // before the app body reader can count bytes (413). Accept both.
        const oversizedBody = JSON.stringify({
            model: 'gpt-oss-120b-balanced',
            messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }],
        });
        const res = await fetch(url('/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PROXY_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': '1',
            },
            body: oversizedBody,
        });
        expect([413, 431]).toContain(res.status);
        if (res.status === 413) {
            expect((await res.json() as any).error?.code).toBe('request_too_large');
        }
    });

});
