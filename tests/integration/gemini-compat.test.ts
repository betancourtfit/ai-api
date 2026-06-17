// gemini-compat.test.ts — Can n8n Gemini transcription nodes migrate to this proxy by URL swap only?
//
// Context: many n8n workflows call Google's
//   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-002:generateContent?key=KEY
// for audio transcription, and we want to know if swapping ONLY the URL to our proxy works.
//
// Gemini generateContent wire shape:
//   auth:    ?key=API_KEY query param (or x-goog-api-key header)
//   body:    application/json { contents: [{ parts: [ {text}, {inline_data:{mime_type,data(base64)}} ] }] }
//   result:  { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {...} }
//
// Our proxy /v1/audio/transcriptions (OpenAI shape):
//   auth:    Authorization: Bearer KEY
//   body:    multipart/form-data with binary `file` field
//   result:  { text: "..." }
//
// These tests ASSERT the incompatibility, so they double as the spec for any future
// Gemini-compat shim. If a shim is ever built, the assertions here will flip and must be updated.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createServer } from '../../index';
import type { WhisperService } from '../../whisper-service';
import type { AudioTranscriptionResult } from '../../types';

const PROXY_KEY = process.env.PERSONAL_PROXY_API_KEY ?? 'test-proxy-key';

let server: ReturnType<typeof createServer>;

const mockWhisper: WhisperService = {
    transcribe: mock(async (_f: File, _a: string): Promise<AudioTranscriptionResult> => ({ text: 'hello world' })),
    health: mock(async () => true),
};

beforeAll(() => {
    server = createServer(
        { cerebras: { name: 'cerebras' } as any, groq: { name: 'groq' } as any },
        0,
        mockWhisper,
    );
});
afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}`;

// A real Gemini generateContent transcription request body, as n8n sends it.
const geminiBody = {
    contents: [
        {
            role: 'user',
            parts: [
                { text: 'Transcribe this audio' },
                { inline_data: { mime_type: 'audio/mpeg', data: 'AAAA' } }, // base64 audio
            ],
        },
    ],
};

describe('Gemini generateContent → proxy compatibility (URL-swap migration check)', () => {
    test('Gemini request (path + ?key= auth) is now ACCEPTED by the proxy (Phase 7 shim, 200)', async () => {
        const res = await fetch(
            `${base()}/v1beta/models/gemini-1.5-pro-002:generateContent?key=${PROXY_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiBody),
            },
        );
        // COMPATIBLE as of Phase 7: the :generateContent shim sits before the global Bearer
        // gate and authenticates via ?key=, so a real Gemini-shaped request now succeeds.
        // (Assertion flipped from the original 401/404 incompatibility expectation — see the
        // file header note: "the assertions here will flip and must be updated.")
        expect(res.status).toBe(200);
    });

    test('Gemini ?key= query auth is not accepted — proxy requires Bearer header (401)', async () => {
        // Hit the real audio route but authenticate the Gemini way (query param, no Bearer).
        const res = await fetch(`${base()}/v1/audio/transcriptions?key=${PROXY_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody),
        });
        expect(res.status).toBe(401);
    });

    test('Gemini JSON body is rejected — proxy needs multipart `file`, not contents[].inline_data (4xx)', async () => {
        const res = await fetch(`${base()}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PROXY_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(geminiBody),
        });
        // INCOMPATIBLE: no `file` form field → validation failure, never reaches whisper.
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });

    test('Proxy success shape is { text } — NOT Gemini candidates[].content.parts[].text', async () => {
        // Send a correct OpenAI-shaped multipart request to get a 200, then inspect the shape
        // an n8n node expecting Gemini output would try to parse.
        const form = new FormData();
        form.append('file', new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' }));
        form.append('model', process.env.WHISPER_MODEL_ALIAS ?? 'whisper-1');

        const res = await fetch(`${base()}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PROXY_KEY}` },
            body: form,
        });

        // This may be 200 (whisper alias configured) or 4xx (alias unset in this env).
        // Either way, the body is OpenAI-shaped and never Gemini-shaped.
        const json: any = await res.json();
        expect(json).not.toHaveProperty('candidates');
        if (res.status === 200) {
            expect(json).toHaveProperty('text');
            // An n8n node reading `candidates[0].content.parts[0].text` gets undefined.
            expect(json?.candidates?.[0]?.content?.parts?.[0]?.text).toBeUndefined();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 TARGET SPEC — Gemini-compatible transcription shim (TDD red → green)
//
// Goal: a new route POST /v1beta/models/:model:generateContent that is wire-compatible
// with Google's generateContent for audio transcription. The ONLY differences a migrating
// n8n node should see are the base URL and the API key value — body, auth mechanism
// (?key= / x-goog-api-key), response shape, and error shape must all match Gemini.
//
// These tests are .skip until Phase 7 is implemented. Un-skip them at the start of
// execution and build until all are green. Mock whisper returns 'hello world'.
//
// Out of scope (explicit): :streamGenerateContent, file_data Files-API URIs, multi-candidate.
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 7 TARGET: Gemini-compatible :generateContent shim', () => {
    const geminiUrl = (key?: string) =>
        `${base()}/v1beta/models/gemini-1.5-pro-002:generateContent${key ? `?key=${key}` : ''}`;

    const audioBody = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: 'Transcribe this audio' },
                    { inline_data: { mime_type: 'audio/mpeg', data: 'AAECAwQF' } },
                ],
            },
        ],
    };

    test('GEM-01/03/05/06: valid request with ?key= returns Gemini-shaped candidates', async () => {
        const res = await fetch(geminiUrl(PROXY_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(audioBody),
        });
        expect(res.status).toBe(200);
        const json: any = await res.json();
        expect(json.candidates[0].content.parts[0].text).toBe('hello world');
        expect(json.candidates[0].content.role).toBe('model');
        expect(json.candidates[0].finishReason).toBe('STOP');
        expect(json.candidates[0].index).toBe(0);
    });

    test('GEM-02: x-goog-api-key header auth also works', async () => {
        const res = await fetch(geminiUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': PROXY_KEY },
            body: JSON.stringify(audioBody),
        });
        expect(res.status).toBe(200);
    });

    test('GEM-07/08: response carries usageMetadata and modelVersion', async () => {
        const res = await fetch(geminiUrl(PROXY_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(audioBody),
        });
        const json: any = await res.json();
        expect(json.usageMetadata).toHaveProperty('totalTokenCount');
        expect(json.modelVersion).toContain('gemini-1.5-pro-002');
        // Pure Gemini shape — no OpenAI leakage.
        expect(json).not.toHaveProperty('text');
        expect(json).not.toHaveProperty('choices');
    });

    test('GEM-09: bad key returns Gemini error shape {error:{code,message,status}}, not OpenAI', async () => {
        const res = await fetch(geminiUrl('wrong-key'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(audioBody),
        });
        expect(res.status).toBe(401);
        const json: any = await res.json();
        expect(json.error).toMatchObject({
            code: expect.any(Number),
            message: expect.any(String),
            status: expect.any(String),
        });
        expect(json.error).not.toHaveProperty('type'); // OpenAI field absent
    });

    test('GEM-10: missing inline_data audio part → Gemini-shaped 400', async () => {
        const res = await fetch(geminiUrl(PROXY_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'no audio here' }] }] }),
        });
        expect(res.status).toBe(400);
        const json: any = await res.json();
        expect(json.error).toHaveProperty('status');
    });

    test('GEM-04: file_data Files-API URI is rejected as out-of-scope (Gemini-shaped 400)', async () => {
        const res = await fetch(geminiUrl(PROXY_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ file_data: { mime_type: 'audio/mpeg', file_uri: 'files/x' } }] }],
            }),
        });
        expect(res.status).toBe(400);
        const json: any = await res.json();
        expect(json.error).toHaveProperty('status');
    });
});
