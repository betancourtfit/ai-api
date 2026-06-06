# Phase 5: Transcription Route + Auth + Tests — Research

**Researched:** 2026-06-06
**Domain:** Bun multipart/form-data parsing, WhisperService interface design, test injection pattern, auth reuse, structured logging for audio
**Confidence:** HIGH

---

## Summary

Phase 5 wires the `POST /v1/audio/transcriptions` route into the existing `createServer()` factory. All foundational pieces exist: `audio-schema.ts` (validators), `config.ts` (whisper/audio fields), `types.ts` (`AudioTranscriptionResult`). The route handler is the only missing piece.

The auth gate is already inline in `index.ts` at line 152. The `withRequestId()` closure and `log()` function are already scoped inside the `fetch()` handler. The route handler for audio transcriptions fits directly into the same `fetch()` block as `POST /v1/chat/completions` — it does not need a separate module. The existing pattern (check method + pathname, run auth, call validator, call service, return response) applies verbatim.

The key architectural decision for Phase 5 is the `WhisperService` interface. It must be injectable for tests — `createServer()` needs a second parameter (or an extended adapters record) carrying an optional `WhisperService`. Tests pass a mock; production boots with a stub (real HTTP fetch is Phase 6 scope). The 503 path is exercised by having the mock throw a typed error or return a rejected promise.

There are no new npm packages. `request.formData()` is a Bun built-in that returns `Promise<FormData>`, and `FormData.get(name)` returns `File | string | null` (typed as `Bun.FormDataEntryValue | null`). This is verified in `node_modules/bun-types/globals.d.ts` lines 1470 and 1672.

**Primary recommendation:** Add `WhisperService` as an injectable interface. Extend `createServer()` to accept it alongside the existing provider adapters. Wire the audio route inline in `index.ts` using the existing auth gate, `withRequestId()`, and `log()` helpers. Write 7 integration tests in `tests/integration/server.test.ts` using a `mockWhisperService` passed to `createServer()`.

---

## Project Constraints (from CLAUDE.md)

- Runtime: Bun only — `Bun.serve()`, no Express; `bun test` for tests
- No new npm packages — zero additional dependencies
- Flat root-level structure — no src/; files at root or under tests/
- `verbatimModuleSyntax: true` — `import type` required for type-only imports
- Zod v4 for validation — `z.strictObject()`, `z.instanceof(File)` already in `audio-schema.ts`
- All process.env reads in `config.ts` only; other modules import from config
- Never log audio content, filenames, or transcribed text
- `bun test` must stay green with no whisper binary installed
- `createServer()` factory pattern required for test injection
- Missing secrets must not crash server

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EP2-01 | User can POST multipart/form-data to `/v1/audio/transcriptions` with `file` and `model` fields | `request.formData()` is a Bun built-in returning `Promise<FormData>`; `.get('file')` returns `File \| string \| null` |
| AUTH2-01 | POST /v1/audio/transcriptions requires valid Bearer token; returns 401 if missing or invalid | Existing inline auth gate in `index.ts` lines 152–165 is reusable as-is; audio route placed after auth block |
| AUTH2-02 | Proxy never logs audio file content, filenames, or transcribed text | `log()` function in `index.ts` only logs metadata fields; audio route logs `fileSize` (number), `modelAlias` (string), `status` (number) — no filename or content |
| OBS2-01 | Every transcription response carries `X-Request-ID` header | `withRequestId()` closure already in scope inside `fetch()` handler; wrap all audio responses the same way as chat responses |
| OBS2-02 | Structured log per transcription: requestId, latencyMs, fileSize, modelAlias, status | `log()` function in `index.ts` accepts arbitrary key/value data; add audio-specific fields, omit filename and text |
| TEST2-01 | 401 returned on missing or invalid auth token | Integration test: POST to `/v1/audio/transcriptions` with no Authorization header; assert 401 + error shape |
| TEST2-02 | 400 returned when `file` field is absent | Integration test: POST multipart body with only `model` field; `validateAudioTranscription` returns `success:false, param:'file'` |
| TEST2-03 | 400 returned when `model` is an unknown alias | Integration test: valid file, unknown model string; alias check returns 400 + `model_not_found` |
| TEST2-04 | 413 returned when file exceeds 25 MB | Integration test: POST with a File whose `.size` exceeds `config.audioMaxFileBytes`; `validateAudioFileSize` returns `ok:false` |
| TEST2-05 | 400 returned when request contains unknown fields | Integration test: POST with `language` field in multipart; `validateAudioTranscription` returns `success:false` |
| TEST2-06 | 200 with `{ text: "..." }` returned when mock whisper service returns a transcript | Integration test: mock WhisperService resolves with `{ text: "hello" }`; assert status 200 and exact body |
| TEST2-07 | 503 returned when whisper service reports unavailable | Integration test: mock WhisperService throws; assert 503 + OpenAI-shaped error body |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bearer token auth for audio route | HTTP handler (`index.ts`) | — | Auth gate is already inline in `fetch()` at line 152; audio route sits after that block — no duplication needed |
| multipart/form-data parsing | HTTP handler (`index.ts`) | — | `request.formData()` is a Bun built-in; called once per audio request inside the route handler |
| Audio request schema validation | Validation layer (`audio-schema.ts`) | — | Already built in Phase 4; handler calls `validateAudioTranscription()` and `validateAudioFileSize()` |
| Whisper alias validation | HTTP handler (`index.ts`) | — | Post-schema check: `config.whisperModelAlias !== null && model === config.whisperModelAlias`; mirrors the `isKnownAlias()` call for chat |
| WhisperService transcription call | `WhisperService` interface + injected impl | — | Injectable for testing; stub implementation in Phase 5 (real HTTP in Phase 6) |
| X-Request-ID on audio responses | HTTP handler (`index.ts`) | — | `withRequestId()` closure is already in scope; wrap all audio returns exactly like chat returns |
| Structured audio request logging | HTTP handler (`index.ts`) | — | `log()` is already in scope; add `fileSize`, `modelAlias`, `status` fields; never log filename or text |
| Audio response body normalization | HTTP handler (`index.ts`) | — | Response is `{ text: string }` — no strip/rewrite needed; just `JSON.stringify(whisperResult)` |
| Test-time mock WhisperService | Test layer (`tests/integration/`) | — | `createServer()` accepts optional `WhisperService`; tests pass a mock via `mock()` from `bun:test` |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun (runtime) | 1.3.11 (local) | `request.formData()`, `FormData.get()`, `File` global | Built-in Web API; confirmed in `bun-types/globals.d.ts` line 1470 |
| `bun:test` | built-in | Integration tests, `mock()` for WhisperService | Already used for all 79 tests |
| `zod` | 4.4.3 (installed) | `validateAudioTranscription`, `validateAudioFileSize` — already in `audio-schema.ts` | Already built in Phase 4 |

**No new packages.** Zero `bun install` calls in Phase 5.

---

## Package Legitimacy Audit

No new packages are installed in this phase.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
Downstream client
       |
       | POST multipart/form-data   Authorization: Bearer KEY
       v
createServer(adapters, whisperService?, port)
       |
       | [existing routes: /health, /ready, auth gate, /v1/models, /v1/chat/completions]
       |
       | POST /v1/audio/transcriptions  <-- NEW Phase 5
       v
  [auth gate] (line 152 -- already wired, audio route placed after it)
       |
  request.formData()
       |
  validateAudioFileSize(file, config.audioMaxFileBytes) -- 413 if exceeded
       |
  validateAudioTranscription({ model, file, ... })  -- 400 if invalid
       |
  whisper alias check (config.whisperModelAlias) -- 400 model_not_found if no match
       |
  whisperService.transcribe(file, modelAlias) -- 503 if throws
       |
  log(info, { requestId, latencyMs, fileSize, modelAlias, status })  -- AUTH2-02: no filename, no text
       |
  withRequestId(Response({ text: result.text }))  -- 200
```

### Recommended Project Structure

No new directories. Phase 5 modifies existing root files and adds audio integration tests:

```
(root)/
├── index.ts             # MODIFIED — add audio route handler + WhisperService param to createServer()
├── whisper-service.ts   # NEW — WhisperService interface + NoopWhisperService stub
└── tests/
    └── integration/
        ├── server.test.ts          # MODIFIED — add TEST2-01..07 audio describe block
        └── mock-adapters.ts        # UNMODIFIED — mock WhisperService lives inline in server.test.ts
```

### Pattern 1: WhisperService Interface Design

**What:** A minimal injectable interface with a single `transcribe()` method. The interface lives in `whisper-service.ts` alongside a `NoopWhisperService` that always throws "not configured" — used as the production default until Phase 6 wires real HTTP.

**Why this shape:** The route handler needs to call the service and catch errors. The 503 path is triggered by any thrown error from `transcribe()`. The success path expects `AudioTranscriptionResult`. This is intentionally narrower than the `ProviderAdapter` interface — no streaming, no `params` object, just file + alias.

```typescript
// whisper-service.ts — NEW

import type { AudioTranscriptionResult } from './types';

export interface WhisperService {
    transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>;
}

// Default stub used in production until Phase 6 wires real HTTP fetch.
// Always throws — route handler catches and returns 503.
export class NoopWhisperService implements WhisperService {
    async transcribe(_file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        throw new Error('WhisperService not configured. Set WHISPER_HOST and WHISPER_MODEL_ALIAS.');
    }
}
```

**Key design decisions:**
- `transcribe()` receives a `File` (Web API type, available in Bun globally) — not a buffer or path
- The method signature takes `modelAlias` (the logical alias string) — Phase 6 implementation will use `config.whisperModelAlias` to map it to a model string for the sidecar
- Any thrown error from `transcribe()` produces a 503 — no special error typing needed in Phase 5
- `NoopWhisperService` lets Phase 5 tests verify the 503 path without any sidecar binary

[VERIFIED: `bun-types/globals.d.ts` line 333 — `interface File extends Blob` confirms `File` is a Bun global type]

### Pattern 2: createServer() Signature Extension

**What:** Add an optional `whisperService` parameter to `createServer()`. Default to `new NoopWhisperService()`. Tests pass a mock. Production entrypoint boots with the default.

```typescript
// index.ts — modified createServer() signature
import { NoopWhisperService } from './whisper-service';
import type { WhisperService } from './whisper-service';

export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port,
    whisperService: WhisperService = new NoopWhisperService()
): ReturnType<typeof Bun.serve> {
    // ... existing body
}
```

**Why a third parameter:** Keeps backward compatibility — all 79 existing tests call `createServer(mockAdapters, 0)` and continue to compile and pass. The new parameter is optional with a default.

**Why not a second adapters-like object:** The `WhisperService` is not a `ProviderAdapter`; it has a different interface. Mixing them would require type union tricks. A third parameter is explicit, simple, and readable.

[ASSUMED: TypeScript's optional parameter with default value at position 3 compiles cleanly with `verbatimModuleSyntax:true` — no known reason this would not work, but verify during implementation]

### Pattern 3: multipart/form-data Parsing in Bun

**What:** `request.formData()` is a Bun built-in that returns `Promise<FormData>`. `FormData.get(name)` returns `Bun.FormDataEntryValue | null` which is `File | string | null`. The `file` field from a multipart upload is returned as a `File` instance (extends `Blob`). The `model` field is returned as a `string`.

```typescript
// Inside POST /v1/audio/transcriptions handler:
let formData: FormData;
try {
    formData = await request.formData();
} catch {
    return withRequestId(openaiError(
        'Failed to parse multipart form data.',
        'invalid_request_error',
        'invalid_request_error',
        null,
        400
    ));
}

// Build plain object for Zod validation (FormData is not a plain object)
const rawInput = {
    model: formData.get('model'),
    file: formData.get('file'),
    // response_format only if present (avoid injecting undefined into strictObject)
    ...(formData.has('response_format') ? { response_format: formData.get('response_format') } : {}),
};

// Zod z.strictObject() does NOT accept FormData directly — must extract fields first
const validation = validateAudioTranscription(rawInput);
```

**Critical detail — unknown fields and strictObject:** `z.strictObject()` rejects keys not in the schema. When building `rawInput` from FormData, the handler must iterate ALL fields from the formData to build the full object (so unknown fields like `language` are included and rejected by Zod). Use `formData.entries()` or build a plain object from known + unknown keys.

**Better approach for unknown field detection:**

```typescript
// Convert FormData to plain object — include ALL fields so z.strictObject() catches unknowns
const rawInput: Record<string, unknown> = {};
for (const [key, value] of formData.entries()) {
    rawInput[key] = value;
}
const validation = validateAudioTranscription(rawInput);
```

This approach works because `File` instances pass through the iteration and `z.instanceof(File)` validates them correctly.

[VERIFIED: `bun-types/globals.d.ts` lines 1664-1686 — `FormData` interface with `.get()` returning `Bun.FormDataEntryValue | null`, `.entries()` iterable. `Bun.FormDataEntryValue = File | string` confirmed in `bun-types/bun.d.ts` line 38]

### Pattern 4: Whisper Alias Validation (AUDIO-02 / TEST2-03)

**What:** After schema validation, check that `input.model` matches the configured whisper alias. This mirrors the `isKnownAlias()` check for chat completions.

```typescript
// After validateAudioTranscription passes:
const isKnownWhisperAlias = config.whisperModelAlias !== null
    && input.model === config.whisperModelAlias;

if (!isKnownWhisperAlias) {
    return withRequestId(openaiError(
        `Unknown model '${input.model}'.`,
        'invalid_request_error',
        'model_not_found',
        'model',
        400
    ));
}
```

**Why not in Zod schema:** The alias is a runtime configuration value (`config.whisperModelAlias`). Zod schemas are static — they cannot reference `config` without coupling schema to environment. The chat route uses the same post-schema pattern (`isKnownAlias()` called after `validateChatCompletion()` passes).

**When whisperModelAlias is null:** `config.whisperModelAlias` is `null` when `WHISPER_MODEL_ALIAS` is unset. In that case every alias is unknown and every audio request returns 400 `model_not_found`. This is the correct behavior — the proxy cannot serve transcriptions without knowing which model alias to accept.

[VERIFIED: `config.ts` line 66 — `whisperModelAlias: optional("WHISPER_MODEL_ALIAS")` returns `null` when unset]

### Pattern 5: Audio Route Handler Structure (EP2-01 full flow)

**What:** The complete audio route, inline in the `fetch()` handler following the existing block structure.

```typescript
// POST /v1/audio/transcriptions — EP2-01
if (request.method === 'POST' && pathname === '/v1/audio/transcriptions') {
    // 1. Parse multipart body
    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return withRequestId(openaiError(
            'Failed to parse multipart form data.',
            'invalid_request_error',
            'invalid_request_error',
            null,
            400
        ));
    }

    // 2. Build plain object from ALL FormData entries (catches unknown fields via z.strictObject)
    const rawInput: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
        rawInput[key] = value;
    }

    // 3. Zod schema validation (AUDIO-01, 02, 04, 05)
    const validation = validateAudioTranscription(rawInput);
    if (!validation.success) {
        return withRequestId(openaiError(
            validation.message,
            'invalid_request_error',
            'invalid_request_error',
            validation.param,
            400
        ));
    }

    const input = validation.data;

    // 4. File size check — must return 413, not 400 (AUDIO-03)
    const sizeCheck = validateAudioFileSize(input.file, config.audioMaxFileBytes);
    if (!sizeCheck.ok) {
        return withRequestId(openaiError(
            sizeCheck.message,
            'invalid_request_error',
            'request_too_large',
            'file',
            413
        ));
    }

    // 5. Alias check — AUDIO-02 (post-schema, mirrors isKnownAlias() pattern)
    const isKnownWhisperAlias = config.whisperModelAlias !== null
        && input.model === config.whisperModelAlias;
    if (!isKnownWhisperAlias) {
        return withRequestId(openaiError(
            `Unknown model '${input.model}'.`,
            'invalid_request_error',
            'model_not_found',
            'model',
            400
        ));
    }

    // 6. Call WhisperService (injectable — mock in tests, NoopWhisperService in production)
    try {
        const result = await whisperService.transcribe(input.file, input.model);

        // OBS2-02: log without filename or text (AUTH2-02)
        log('info', {
            event: 'transcription_complete',
            requestId,
            timestamp: new Date(requestStart).toISOString(),
            route: `${request.method} ${pathname}`,
            modelAlias: input.model,
            fileSize: input.file.size,
            status: 200,
            latencyMs: Date.now() - requestStart,
        });

        // AUDIO-06: exactly { "text": "..." }
        return withRequestId(new Response(
            JSON.stringify(result),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
    } catch {
        // OBS2-02: log 503 path
        log('warn', {
            event: 'transcription_failed',
            requestId,
            modelAlias: input.model,
            fileSize: input.file.size,
            status: 503,
            latencyMs: Date.now() - requestStart,
        });

        return withRequestId(openaiError(
            'Transcription service is unavailable.',
            'server_error',
            'service_unavailable',
            null,
            503
        ));
    }
}
```

**Order of checks matters:** Zod validation runs before file size. This means a request with both a missing file AND an oversized file returns 400 (missing file), not 413. The order matches OpenAI's actual behavior for the transcription endpoint. The size check uses `input.file` (already validated as a `File` instance by Zod) so no type assertion is needed.

[ASSUMED: order of validation (schema before size) matches OpenAI's behavior — not verified against OpenAI docs for edge cases where both errors are present simultaneously]

### Pattern 6: Mock WhisperService in Integration Tests

**What:** A scriptable mock built with `mock()` from `bun:test`, following the same pattern as `MockAdapter` in `mock-adapters.ts`. Lives inline in `server.test.ts` or in a new `mock-whisper.ts` file.

```typescript
// tests/integration/server.test.ts additions:
import type { WhisperService } from '../../whisper-service';

// Minimal mock — transcribeMock is scriptable via mockImplementationOnce
function makeMockWhisperService(): WhisperService & { transcribeMock: ReturnType<typeof mock> } {
    const transcribeMock = mock(async (_file: File, _alias: string) => ({
        text: 'mock transcript',
    }));
    return {
        transcribe: transcribeMock,
        transcribeMock,
    };
}

// In beforeAll:
const mockWhisper = makeMockWhisperService();
server = createServer({ cerebras: mockCerebras, groq: mockGroq }, 0, mockWhisper);

// TEST2-07 — sidecar down:
mockWhisper.transcribeMock.mockImplementationOnce(async () => {
    throw new Error('connection refused');
});
```

**Why not a separate mock file:** The mock is small (one method). Keeping it inline avoids creating a file for a single test helper. If it grows, extract to `tests/integration/mock-whisper.ts` following the `mock-adapters.ts` pattern.

### Pattern 7: Integration Test Structure (7 TEST2-xx cases)

**What:** A new `describe` block in `tests/integration/server.test.ts`. The server is started once in `beforeAll` with the mock whisper service. Tests use a real `FormData` multipart request.

```typescript
// Helper for audio tests:
async function postAudio(fields: Record<string, string | File>, extraHeaders?: Record<string, string>): Promise<Response> {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        formData.append(key, value);
    }
    return fetch(url('/v1/audio/transcriptions'), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PROXY_KEY}`,
            ...extraHeaders,
        },
        body: formData,
        // No explicit Content-Type — browser/Bun sets multipart/form-data with boundary automatically
    });
}

// TEST2-01: auth gate
const resNoAuth = await fetch(url('/v1/audio/transcriptions'), {
    method: 'POST',
    body: new FormData(),
});
expect(resNoAuth.status).toBe(401);

// TEST2-02: missing file
const res = await postAudio({ model: 'whisper-1' });
expect(res.status).toBe(400);

// TEST2-03: unknown alias (model not matching config.whisperModelAlias)
const res = await postAudio({ model: 'unknown-model', file: new File(['x'], 't.mp3') });
expect(res.status).toBe(400);
const body = await res.json() as { error?: { code?: string } };
expect(body.error?.code).toBe('model_not_found');

// TEST2-04: oversized file (file.size > config.audioMaxFileBytes)
// Note: creating a real 25 MiB File in-memory is expensive in tests.
// Use a tiny audioMaxFileBytes override via a separate createServer() call, OR
// create a File with size > config.audioMaxFileBytes using a Uint8Array.
// Preferred: use a separate server instance with a tiny limit for this test only.
// Alternative: configure audioMaxFileBytes to 100 bytes in .env.test for testing.

// TEST2-06: success path
const file = new File(['hello audio'], 'test.mp3', { type: 'audio/mpeg' });
mockWhisper.transcribeMock.mockImplementationOnce(async () => ({ text: 'hello world' }));
const res = await postAudio({ model: config.whisperModelAlias, file });
expect(res.status).toBe(200);
const body = await res.json() as { text?: string };
expect(body.text).toBe('hello world');
expect(Object.keys(body)).toEqual(['text']); // exactly { "text": "..." } — no extra fields

// TEST2-07: sidecar down
mockWhisper.transcribeMock.mockImplementationOnce(async () => { throw new Error('down'); });
const res = await postAudio({ model: config.whisperModelAlias, file });
expect(res.status).toBe(503);
```

**TEST2-04 challenge — oversized file:** Creating a 25 MiB+ `File` in memory during a test is wasteful and slow. Two approaches:

1. **Recommended:** Create a second `createServer()` instance in `beforeAll` with a tiny audio limit (e.g., 100 bytes) and use it only for TEST2-04. This avoids allocating 25 MiB in tests.
2. **Alternative:** Set `AUDIO_MAX_FILE_BYTES=100` in `.env.test` — but this changes the limit for all tests, which may interfere with TEST2-06.

Recommended: a dedicated small-limit server instance for TEST2-04.

**TEST2-06 `model` field value:** Tests need to know the configured `whisperModelAlias`. Either read `config.whisperModelAlias` in the test (import from `../../config`) or set `WHISPER_MODEL_ALIAS` explicitly in `.env.test`. Since `config.whisperModelAlias` is `null` when unset, the test suite must configure a known alias for TEST2-03, TEST2-06, and TEST2-07 to work correctly.

[ASSUMED: `.env.test` is the Bun test environment file used by all existing tests — verify that this is the correct file for setting test-time env vars for audio tests]

### Anti-Patterns to Avoid

- **Buffering formData before sending to validation:** `formData.entries()` is synchronous once `await request.formData()` resolves — do not buffer to an array first.
- **Logging `input.file.name` or `result.text`:** AUTH2-02 explicitly prohibits logging filenames and transcribed text. Log only `fileSize` (number), `modelAlias` (string), `status` (number).
- **Throwing from the audio route for all errors:** Only `whisperService.transcribe()` errors produce 503. Validation errors must return before the try/catch block.
- **Placing the audio route before the auth gate:** The auth gate is at line 152. Audio route must be placed after it, inside the "authenticated" zone — exactly like the `/internal/providers/status` and `/v1/models` routes.
- **Changing createServer() port parameter position:** The existing signature is `createServer(adapters, port)`. Adding `whisperService` as a third parameter preserves backward compat. Do not reorder parameters.
- **Using `content-type` check to detect multipart:** Bun's `request.formData()` handles boundary detection internally. Do not manually parse the `Content-Type` header.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| multipart/form-data parsing | Manual boundary splitting | `request.formData()` | Bun built-in; handles boundary, encoding, file extraction |
| Unknown field detection | Manual key loop | `z.strictObject()` in `audioTranscriptionSchema` | Already built; rejects any key not in the allowlist |
| File size enforcement | Re-read File bytes | `validateAudioFileSize(file, config.audioMaxFileBytes)` | Already built in Phase 4; returns structured result |
| Constant-time token comparison | String equality | `verifyToken()` in `index.ts` (lines 51-62) | Already built; timing-safe with padding |

---

## Key Research Questions — Answered

### Q1: How should WhisperService be designed?
Single `transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>` method. No error type convention needed — any thrown error produces 503. `NoopWhisperService` always throws as the production default until Phase 6.

### Q2: How does `request.formData()` work in Bun?
`request.formData()` is a Bun built-in returning `Promise<FormData>`. `FormData.get('file')` returns `File | string | null` (`Bun.FormDataEntryValue | null`). File fields from multipart uploads are returned as `File` instances (which extend `Blob`). `formData.entries()` iterates all fields as `[key, File | string]` pairs.

[VERIFIED: `bun-types/globals.d.ts` line 1470 — `formData(): Promise<FormData>`; line 1672 — `get(name: string): Bun.FormDataEntryValue | null`; `bun-types/bun.d.ts` line 38 — `type FormDataEntryValue = File | string`]

### Q3: How should audio transcription tests be structured?
Integration tests using `createServer(mockAdapters, 0, mockWhisperService)`. Real `fetch()` calls with multipart `FormData` bodies. No unit test for the route handler itself — integration tests cover all 7 cases end-to-end. The `formData.entries()` iteration approach for unknown fields ensures TEST2-05 works correctly.

### Q4: How does the existing auth gate work? Is it reusable?
The auth gate is inline in `index.ts` lines 152–165. It checks `config.personalProxyApiKey` and calls `verifyToken()`. It runs for every route that appears after it in the `fetch()` handler. The audio route placed after the auth block inherits the gate automatically — zero code duplication needed.

### Q5: What needs to change in createServer() to accept a WhisperService?
Add a third optional parameter `whisperService: WhisperService = new NoopWhisperService()`. All existing tests call `createServer(adapters, 0)` — they continue to compile and pass. The new server instance in audio tests calls `createServer(adapters, 0, mockWhisper)`.

### Q6: How does X-Request-ID work — is it request-level?
`withRequestId()` is a closure defined inside `fetch()` per request. It captures the `requestId` UUID generated at the top of `fetch()`. It wraps any `Response` by adding the `X-Request-ID` header. The audio route calls `withRequestId()` the same way chat does — no changes needed to the mechanism.

### Q7: What does the 503 "sidecar-down" path look like?
`whisperService.transcribe()` throws. The route handler catches it in a try/catch and returns `withRequestId(openaiError('Transcription service is unavailable.', 'server_error', 'service_unavailable', null, 503))`. The test uses `mockImplementationOnce(async () => { throw new Error('down'); })`.

### Q8: Can the audio route be a standalone module?
Yes, but it is simpler to keep it inline in `index.ts` following the existing pattern. All the helpers (`log`, `withRequestId`, `openaiError`, `config`) are already in scope in `fetch()`. A standalone module would require passing all these helpers as parameters or re-importing them, adding complexity for no benefit. The existing chat completions handler is ~250 lines inline — audio (~60 lines) is proportionally much smaller.

---

## Common Pitfalls

### Pitfall 1: FormData entries() missing for unknown field detection
**What goes wrong:** Building `rawInput` with only known field names (`model`, `file`, `response_format`) — unknown fields like `language` never reach Zod and TEST2-05 passes even without `z.strictObject()` working.
**Why it happens:** Natural instinct is to extract only the fields you know about.
**How to avoid:** Use `for (const [key, value] of formData.entries())` to build `rawInput` — ALL fields land in the object, so `z.strictObject()` sees and rejects unknown keys.
**Warning signs:** TEST2-05 passes for wrong reasons — the unknown field is silently ignored.

### Pitfall 2: File size check order relative to schema validation
**What goes wrong:** Running `validateAudioFileSize` before `validateAudioTranscription` — a request with no `file` field at all would crash at `input.file.size` because `input.file` is undefined.
**Why it happens:** Logical intuition to check size "early"; forgetting that `file` must be a `File` instance first.
**How to avoid:** Always run `validateAudioTranscription` first (it verifies `file` is a `File` instance), then call `validateAudioFileSize(input.file, ...)` with the already-typed `input.file`.
**Warning signs:** TEST2-02 (missing file) throws a runtime error instead of returning 400.

### Pitfall 3: TEST2-04 in-memory file size
**What goes wrong:** Allocating a `new Uint8Array(26_214_401)` (25 MiB + 1 byte) in the test process to create an oversized File for TEST2-04.
**Why it happens:** Following the Phase 4 unit test pattern (which used a 101-byte array against a 100-byte limit) without adapting to the real limit.
**How to avoid:** Create a second server instance with a tiny limit (e.g., 100 bytes) for TEST2-04, or set `AUDIO_MAX_FILE_BYTES=100` in `.env.test`. Do not allocate 25 MiB per test run.
**Warning signs:** Test suite is noticeably slow (25 MiB allocation) or OOM in CI.

### Pitfall 4: whisperModelAlias is null in test environment
**What goes wrong:** `config.whisperModelAlias` is null because `WHISPER_MODEL_ALIAS` is not set in `.env.test`. TEST2-03 ("unknown alias returns 400") appears to pass — but so does TEST2-06 ("known alias returns 200") for wrong reasons, because every alias is rejected.
**Why it happens:** `optional()` returns null for unset env vars — the alias check becomes `false` for every model string.
**How to avoid:** Set `WHISPER_MODEL_ALIAS=whisper-1` (or any value) in `.env.test`. Use that same value in TEST2-06 and TEST2-07 requests. Use a different value in TEST2-03 to prove the mismatch path.
**Warning signs:** TEST2-06 returns 400 `model_not_found` instead of 200.

### Pitfall 5: No Content-Type header in multipart fetch
**What goes wrong:** Manually setting `'Content-Type': 'multipart/form-data'` without the boundary — Bun's `request.formData()` throws because the boundary is missing.
**Why it happens:** Developers familiar with JSON APIs always set Content-Type manually.
**How to avoid:** Do NOT set `Content-Type` when passing a `FormData` body to `fetch()`. Bun/the browser sets `multipart/form-data; boundary=...` automatically with the correct boundary.
**Warning signs:** `request.formData()` throws in the handler; test receives 400 "Failed to parse multipart form data".

### Pitfall 6: verbatimModuleSyntax violation in whisper-service.ts
**What goes wrong:** `import { AudioTranscriptionResult } from './types'` in `whisper-service.ts` — TypeScript errors because `AudioTranscriptionResult` is a type-only import.
**Why it happens:** `verbatimModuleSyntax: true` in `tsconfig.json` requires `import type` for type-only imports.
**How to avoid:** `import type { AudioTranscriptionResult } from './types'` in `whisper-service.ts`.
**Warning signs:** TypeScript compile error: "This import is never used as a value and must use 'import type' because 'verbatimModuleSyntax' is enabled."

---

## Code Examples

### createServer() signature (Pattern 2)

```typescript
// Source: index.ts lines 101-103 (existing signature to extend)
// Modified signature:
import { NoopWhisperService } from './whisper-service';
import type { WhisperService } from './whisper-service';

export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port,
    whisperService: WhisperService = new NoopWhisperService()
): ReturnType<typeof Bun.serve> {
```

### FormData to plain object (Pattern 3)

```typescript
// Source: bun-types/globals.d.ts — FormData.entries() confirmed iterable
// Inside the audio route handler:
const rawInput: Record<string, unknown> = {};
for (const [key, value] of formData.entries()) {
    rawInput[key] = value;
}
const validation = validateAudioTranscription(rawInput);
```

### Mock WhisperService for tests (Pattern 6)

```typescript
// Source: tests/integration/mock-adapters.ts — MockAdapter pattern to mirror
import { mock } from 'bun:test';
import type { WhisperService } from '../../whisper-service';
import type { AudioTranscriptionResult } from '../../types';

type MockWhisperService = WhisperService & { transcribeMock: ReturnType<typeof mock> };

function makeMockWhisperService(): MockWhisperService {
    const transcribeMock = mock(async (_file: File, _alias: string): Promise<AudioTranscriptionResult> => ({
        text: 'mock transcript',
    }));
    return { transcribe: transcribeMock, transcribeMock };
}
```

### postAudio helper for integration tests (Pattern 7)

```typescript
// Source: tests/integration/server.test.ts — post() helper pattern to mirror
async function postAudio(
    fields: Record<string, string | File>,
    extraHeaders?: Record<string, string>
): Promise<Response> {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        formData.append(key, value as string | Blob);
    }
    return fetch(url('/v1/audio/transcriptions'), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PROXY_KEY}`,
            ...extraHeaders,
        },
        body: formData,
        // No Content-Type — let Bun set multipart/form-data with boundary
    });
}
```

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun runtime | `request.formData()`, all tests | ✓ | 1.3.11 | — |
| `bun:test` mock() | mock WhisperService | ✓ | built-in | — |
| whisper-server binary | Phase 5 tests | Not required | — | `NoopWhisperService` stub + mock in tests |
| `WHISPER_MODEL_ALIAS` env var | TEST2-03, TEST2-06, TEST2-07 | Must be set in `.env.test` | — | Tests return wrong status codes if missing |

**Missing dependencies with no fallback:**
- `WHISPER_MODEL_ALIAS` must be set in `.env.test` for the audio test suite to exercise the correct code paths. If missing, every alias is "unknown" and TEST2-06 returns 400.

**Missing dependencies with fallback:**
- whisper-server binary: `NoopWhisperService` throws immediately — TEST2-07 exercises this path with a mock.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (built-in) |
| Config file | none — `bun test` discovers `*.test.ts` automatically |
| Quick run command | `bun test tests/integration/server.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EP2-01 | POST multipart to /v1/audio/transcriptions | integration | `bun test tests/integration/server.test.ts` | ✅ (adding to existing file) |
| AUTH2-01 | 401 on missing/invalid token for audio route | integration (TEST2-01) | `bun test tests/integration/server.test.ts` | ✅ |
| AUTH2-02 | No filename or text in logs | manual verification | inspect log output during TEST2-06 | manual |
| OBS2-01 | X-Request-ID on all audio responses | integration | TEST2-06 asserts `res.headers.get('X-Request-ID')` | ✅ |
| OBS2-02 | Structured log with fileSize, modelAlias, status | manual verification | inspect log output | manual |
| TEST2-01 | 401 on missing/invalid auth | integration | `bun test` | ❌ Wave 0 |
| TEST2-02 | 400 on missing file | integration | `bun test` | ❌ Wave 0 |
| TEST2-03 | 400 on unknown alias | integration | `bun test` | ❌ Wave 0 |
| TEST2-04 | 413 on oversized file | integration | `bun test` | ❌ Wave 0 |
| TEST2-05 | 400 on unknown field | integration | `bun test` | ❌ Wave 0 |
| TEST2-06 | 200 + `{text:"..."}` on mock success | integration | `bun test` | ❌ Wave 0 |
| TEST2-07 | 503 on mock throw | integration | `bun test` | ❌ Wave 0 |

### Sampling Rate
- Per task commit: `bun test` (79 existing + new audio tests must all pass)
- Per wave merge: `bun test` (full suite)
- Phase gate: Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/integration/server.test.ts` — add `describe('Integration: audio transcription tests', ...)` block with TEST2-01..07
- [ ] `whisper-service.ts` — new file: `WhisperService` interface + `NoopWhisperService`
- [ ] `index.ts` — extend `createServer()` with `whisperService` parameter; add audio route handler
- [ ] `.env.test` — verify `WHISPER_MODEL_ALIAS` is set; add if missing

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Existing `verifyToken()` + `extractBearerToken()` — reused verbatim |
| V3 Session Management | No | Stateless HTTP |
| V4 Access Control | Yes | Audio route inside auth gate — same access control as /v1/chat/completions |
| V5 Input Validation | Yes | `validateAudioTranscription()` + `validateAudioFileSize()` — already built |
| V6 Cryptography | No | No new crypto; existing `timingSafeEqual` handles token comparison |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Unauthenticated audio upload | Spoofing | Existing auth gate at line 152 covers audio route automatically |
| Oversized upload DoS | DoS | `maxRequestBodySize` at Bun.serve level (25 MiB ceiling) + `validateAudioFileSize()` 413 |
| Filename injection in logs | Info disclosure | Never log `input.file.name` or `result.text` — log only `fileSize` (number) |
| Transcribed text in logs | Info disclosure | Same as above — `result.text` is never passed to `log()` |
| Unknown fields bypassing validation | Tampering | `formData.entries()` loop + `z.strictObject()` |
| Model alias spoofing | Spoofing | Post-schema alias check against `config.whisperModelAlias` |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | TypeScript optional parameter with default value at position 3 in `createServer()` compiles without issues under `verbatimModuleSyntax: true` | Pattern 2 | If TypeScript rejects the syntax, refactor to an options object: `createServer(adapters, port?, { whisperService? })` — adds one level of wrapping |
| A2 | `formData.entries()` in Bun correctly returns `File` instances for binary file fields in multipart requests | Pattern 3 | If `File` instances are not returned (e.g., returned as `Blob`), `z.instanceof(File)` would fail; workaround: use `z.instanceof(Blob)` or check `value instanceof File \|\| value instanceof Blob` |
| A3 | TEST2-04 oversized file test can use a second `createServer()` instance with a small limit | Pattern 7 | If `createServer()` with port 0 allocates a second port that conflicts, use a different port or configure via `.env.test`; no known Bun limitation |
| A4 | Setting `WHISPER_MODEL_ALIAS` in `.env.test` is picked up by `bun test` automatically | Pattern 7 | If `.env.test` is not loaded by `bun test`, set the var in a `beforeAll` via `process.env` mutation — verify against existing test setup |
| A5 | Not setting `Content-Type` header in `fetch(body: FormData)` causes Bun to set `multipart/form-data; boundary=...` automatically | Pattern 5 / Pitfall 5 | Standard Web API behavior; confirmed by MDN and general Bun compatibility, but not directly verified in `bun-types` |

**If A5 is wrong:** The test multipart request will be parsed as an opaque body and `request.formData()` will throw. Workaround: generate the boundary manually and set `Content-Type` explicitly. Low-risk assumption.

---

## Open Questions

1. **Is `.env.test` loaded by `bun test`?**
   - What we know: `bun test` loads `.env` and `.env.local` automatically per Bun docs. `.env.test` is a convention from Jest/Vitest — Bun may or may not load it.
   - What's unclear: The existing test suite uses `process.env['PERSONAL_PROXY_API_KEY']` successfully — meaning some `.env.*` file IS being loaded.
   - Recommendation: Verify with `grep -r 'PERSONAL_PROXY_API_KEY' .env* 2>/dev/null` before Phase 5 plan execution. If `.env.test` is not loaded, add `WHISPER_MODEL_ALIAS` to `.env.local` or `.env`.

2. **Should `NoopWhisperService` be the default, or should `whisperService` be optional (undefined) and the route return 503 when absent?**
   - What we know: Phase 5 success criterion 4 says "A successful mock response returns exactly `{ text: '...' }` with HTTP 200". The stub/noop approach keeps production safe without requiring Phase 6 config.
   - What's unclear: Whether returning 503 for every audio request in production (until Phase 6) is the desired UX vs. a 501 Not Implemented.
   - Recommendation: Use `NoopWhisperService` as the default — it produces 503 with an OpenAI-shaped error body. This is consistent with the existing "no eligible provider" 503 pattern. Change to 501 if desired, but 503 is already tested.

---

## Sources

### Primary (HIGH confidence)
- `node_modules/bun-types/globals.d.ts` lines 1470, 1664-1686 — `request.formData()`, `FormData.get()`, `FormData.entries()` type signatures
- `node_modules/bun-types/bun.d.ts` line 38 — `type FormDataEntryValue = File | string`
- `node_modules/bun-types/globals.d.ts` line 333 — `interface File extends Blob` (File is a Bun global type)
- `index.ts` lines 101-687 — full `createServer()` factory, auth gate, `withRequestId()`, `log()`, route handler patterns
- `audio-schema.ts` — `validateAudioTranscription()`, `validateAudioFileSize()` (Phase 4 output)
- `config.ts` lines 62-70 — whisper/audio config fields
- `types.ts` lines 57-60 — `AudioTranscriptionResult { text: string }`
- `tests/integration/server.test.ts` + `mock-adapters.ts` — existing integration test patterns

### Secondary (MEDIUM confidence)
- Phase 4 RESEARCH.md — FormData parsing patterns, `z.instanceof(File)` validation, Pitfall 5 (FormData.get returns union type)
- Phase 4 VERIFICATION.md — confirmed 79 tests pass; confirmed `validateAudioFileSize` exported

---

## Metadata

**Confidence breakdown:**
- Auth reuse: HIGH — code inspected directly; auth gate is inline and automatically covers any route placed after line 152
- FormData parsing: HIGH — type signatures verified in `bun-types`; pattern confirmed via Phase 4 research
- WhisperService interface: HIGH — design is minimal and follows established ProviderAdapter pattern
- createServer() extension: HIGH — TypeScript optional parameter with default is standard; existing tests use `createServer(adapters, 0)` which remains compatible
- Test structure: HIGH — integration test pattern is identical to existing 79 tests; only new helper is `postAudio()`
- TEST2-04 oversized file: MEDIUM — small-limit server instance approach is correct but env loading interaction not fully verified

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (stable stack; Bun and Zod APIs change infrequently)
