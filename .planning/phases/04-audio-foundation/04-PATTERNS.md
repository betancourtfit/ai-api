# Phase 4: Audio Foundation - Pattern Map

**Mapped:** 2026-06-06
**Files analyzed:** 5 (4 modified, 1 new)
**Analogs found:** 5 / 5

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `config.ts` | config | — | `config.ts` (self — additive extension) | exact |
| `types.ts` | model | — | `types.ts` (self — additive extension) | exact |
| `audio-schema.ts` | utility / validator | request-response | `request-schema.ts` | exact |
| `index.ts` | controller | request-response | `index.ts` (self — targeted modification) | exact |
| `tests/unit/audio-schema.test.ts` | test | — | `request-schema.test.ts` | exact |

---

## Pattern Assignments

### `config.ts` (config — additive extension)

**Analog:** `config.ts` lines 1–28 (self)

**Existing pattern to extend** (lines 1–28):
```typescript
// All process.env reads happen here; all other modules import from this file.
// Bun auto-loads .env and .env.local — do NOT add dotenv.

function optional(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
}

export const config = {
    port: Number(process.env["PORT"] ?? 3000),
    hostname: process.env["HOSTNAME"] ?? "0.0.0.0",
    personalProxyApiKey: optional("PERSONAL_PROXY_API_KEY"),
    // ... (existing fields remain unchanged)
} as const;
```

**Fields to add** — append inside the `config` object before `} as const`:
```typescript
    // WHSP-04: whisper sidecar connection
    whisperHost: process.env["WHISPER_HOST"] ?? "127.0.0.1",
    whisperPort: Number(process.env["WHISPER_PORT"] ?? 8080),
    whisperTimeoutMs: Number(process.env["WHISPER_TIMEOUT_MS"] ?? 30_000),
    // optional() returns null when unset — must NOT crash server (requirement: WHISPER_MODEL_ALIAS missing is non-fatal)
    whisperModelAlias: optional("WHISPER_MODEL_ALIAS"),

    // AUDIO-03 + WHSP-05: file and body size limits
    audioMaxFileBytes: Number(process.env["AUDIO_MAX_FILE_BYTES"] ?? 26_214_400),   // 25 MiB
    maxRequestBodyBytes: Number(process.env["MAX_REQUEST_BODY_BYTES"] ?? 1_048_576), // 1 MiB for chat JSON
```

**Key rules from analog:**
- `optional()` helper (line 5–8) already exists — reuse it for `WHISPER_MODEL_ALIAS`; do not add a second helper
- `Number(process.env["VAR"] ?? default)` pattern (lines 11, 20–21) for numeric fields
- `process.env["VAR"] ?? "string-default"` pattern (lines 12, 16–18) for string fields
- `as const` at end of object (line 28) — do not remove it

---

### `types.ts` (model — additive extension)

**Analog:** `types.ts` lines 13–29 (`ChatCompletionResult` interface as shape reference)

**Existing interface to mirror** (lines 13–29):
```typescript
export interface ChatCompletionResult {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: { role: "assistant"; content: string };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    system_fingerprint?: string;
}
```

**Type to add** — append after the last interface in the file:
```typescript
// AUDIO-06: OpenAI json transcription response shape
export interface AudioTranscriptionResult {
    text: string;
}
```

**Key rules from analog:**
- `export interface` keyword (not `type` alias) for object shapes — matches all existing definitions in file
- No imports needed — `AudioTranscriptionResult` has no dependencies on other types
- `AudioTranscriptionInput` is NOT added here; it is `z.infer<typeof audioTranscriptionSchema>` exported from `audio-schema.ts` directly (see RESEARCH.md Pattern 4 note)

---

### `audio-schema.ts` (utility / validator, request-response) — NEW FILE

**Analog:** `request-schema.ts` lines 1–59 (exact structural mirror)

**Imports pattern** — copy from `request-schema.ts` line 3:
```typescript
import * as z from 'zod';
```

**Schema pattern** — copy structure from `request-schema.ts` lines 6–27, simplified to 3 fields:
```typescript
// request-schema.ts lines 12–27 (chatCompletionSchema) — reference for z.strictObject() shape
export const chatCompletionSchema = z.strictObject({
    model: z.string(),
    messages: z.array(messageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    // ...
    n: z.literal(1).optional(),
});
```

Audio schema mirrors this with its 3-field allowlist (AUDIO-01 through AUDIO-05):
```typescript
export const audioTranscriptionSchema = z.strictObject({
    model: z.string(),                               // AUDIO-02: model field required
    file: z.instanceof(File),                        // AUDIO-01: file field required, must be File instance
    response_format: z.literal('json').optional(),   // AUDIO-04: only 'json' accepted; AUDIO-05: other values rejected
});

export type AudioTranscriptionInput = z.infer<typeof audioTranscriptionSchema>;
```

**Validator function pattern** — copy exactly from `request-schema.ts` lines 32–59 (`validateChatCompletion`):
```typescript
// request-schema.ts lines 32–59 — copy this error-extraction logic verbatim
export function validateChatCompletion(body: unknown):
    { success: true; data: ChatCompletionInput } |
    { success: false; param: string | null; message: string }
{
    const result = chatCompletionSchema.safeParse(body);
    if (result.success) return { success: true, data: result.data };

    const firstIssue = result.error.issues[0];
    if (!firstIssue) return { success: false, param: null, message: 'Invalid request body' };

    let param: string | null;
    if (firstIssue.path.length > 0) {
        param = String(firstIssue.path[0]);
    } else if (firstIssue.code === 'unrecognized_keys' && 'keys' in firstIssue) {
        const keys = (firstIssue as { keys?: string[] }).keys;
        param = (keys && keys[0]) ? keys[0] : null;
    } else {
        param = null;
    }

    return { success: false, param, message: firstIssue.message };
}
```

Rename `validateChatCompletion` → `validateAudioTranscription`, `chatCompletionSchema` → `audioTranscriptionSchema`, `ChatCompletionInput` → `AudioTranscriptionInput`. The error-extraction body is identical.

**`verbatimModuleSyntax` rule:** `AudioTranscriptionInput` is a type alias (`z.infer<>`). Any file that imports it must use `import type { AudioTranscriptionInput }`. Within `audio-schema.ts` itself, the `export type` comes from `z.infer<>` — no `import type` needed inside the file.

---

### `index.ts` (controller, request-response — targeted modification)

**Analog:** `index.ts` lines 94–101 (`createServer` signature and `Bun.serve` options object)

**Bun.serve options to modify** (lines 98–101) — add `maxRequestBodySize`:
```typescript
// index.ts lines 94–101 — createServer signature stays UNCHANGED (Pitfall 3 from RESEARCH.md)
export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port
): ReturnType<typeof Bun.serve> {
    return Bun.serve({
        hostname: config.hostname,
        port,
        // ADD this line — WHSP-05: raises global gate to audio limit; chat limit enforced in handler
        maxRequestBodySize: config.audioMaxFileBytes,
        async fetch(request, server) {
```

**Content-length pre-check pattern** — insert into the chat completions handler. Copy the `openaiError` call pattern from lines 192–194 and 198–205, placing the new check before `request.json()`:

```typescript
// index.ts lines 187–194 — existing chat completions route entry (reference)
if (request.method === 'POST' && pathname === '/v1/chat/completions') {
    // ADD: WHSP-05 — enforce 1 MiB chat limit explicitly (maxRequestBodySize now set to audio limit)
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (contentLength > config.maxRequestBodyBytes) {
        return withRequestId(openaiError(
            `Request body too large. Maximum is ${config.maxRequestBodyBytes} bytes.`,
            'invalid_request_error',
            'request_too_large',
            null,
            413
        ));
    }

    // existing: parse JSON body (lines 189–194, unchanged)
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return withRequestId(openaiError('Request body must be valid JSON.', 'invalid_request_error', 'invalid_request_error', null, 400));
    }
```

**`openaiError` helper** (lines 29–40) — already exists, no change needed. All error responses in Phase 4 use this function:
```typescript
// index.ts lines 29–40 — reuse as-is for the 413 response above
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}
```

**No new imports required** — `config.audioMaxFileBytes` and `config.maxRequestBodyBytes` come from the already-imported `config` object (line 4).

---

### `tests/unit/audio-schema.test.ts` (test) — NEW FILE

**Analog:** `request-schema.test.ts` lines 1–39 (unit test structure and `describe`/`test`/`expect` pattern)

**Imports pattern** — copy from `request-schema.test.ts` lines 1–6, adapted:
```typescript
// request-schema.test.ts lines 1–6 (reference)
import { test, expect, describe } from "bun:test";
import { validateChatCompletion } from "./request-schema";
```

For audio tests:
```typescript
import { test, expect, describe } from "bun:test";
import { validateAudioTranscription } from "../../audio-schema";
```

**Test structure pattern** — copy `describe`/`test` block shape from `request-schema.test.ts` lines 7–39:
```typescript
// request-schema.test.ts lines 7–38 — basic validity, missing-field, and optional-field cases
describe("validateChatCompletion", () => {
    test("valid body returns success:true with parsed data", () => {
        const result = validateChatCompletion({ model: "...", messages: [...] });
        expect(result.success).toBe(true);
        if (result.success) { expect(result.data.model).toBe("..."); }
    });

    test("missing messages returns success:false with param='messages'", () => {
        const result = validateChatCompletion({ model: "x" });
        expect(result.success).toBe(false);
        if (!result.success) { expect(result.param).toBe("messages"); }
    });
});
```

Audio test file covers: valid input (success), missing `file` (param='file'), missing `model` (param='model'), unknown field rejection (success:false), valid `response_format:'json'`, invalid `response_format:'text'` (rejected by `z.literal('json')`), oversized file check (separate explicit check — not Zod).

**`new File()` pattern** — available as a global in Bun runtime, no import needed:
```typescript
const file = new File(["audio data"], "test.mp3", { type: "audio/mpeg" });
```

**Hardening test pattern** — copy from `request-schema.test.ts` lines 41–131 (`describe("validateChatCompletion — hardened allowlist")`):
```typescript
// request-schema.test.ts lines 41–51 — unknown field rejection pattern
describe("validateAudioTranscription — hardened allowlist", () => {
    test("unknown field returns success:false", () => {
        const file = new File(["data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "x", file, language: "en" });
        expect(result.success).toBe(false);
    });
});
```

---

## Shared Patterns

### `openaiError()` shape
**Source:** `index.ts` lines 29–40
**Apply to:** The 413 content-length check added to `index.ts`; any future audio route handler errors
```typescript
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}
```

### `optional()` config helper
**Source:** `config.ts` lines 5–8
**Apply to:** `WHISPER_MODEL_ALIAS` in the config additions (missing must not crash)
```typescript
function optional(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
}
```

### `safeParse` + first-issue error extraction
**Source:** `request-schema.ts` lines 36–58
**Apply to:** `validateAudioTranscription()` in `audio-schema.ts` — copy verbatim, rename identifiers
```typescript
const result = schema.safeParse(input);
if (result.success) return { success: true, data: result.data };

const firstIssue = result.error.issues[0];
if (!firstIssue) return { success: false, param: null, message: 'Invalid request body' };

let param: string | null;
if (firstIssue.path.length > 0) {
    param = String(firstIssue.path[0]);
} else if (firstIssue.code === 'unrecognized_keys' && 'keys' in firstIssue) {
    const keys = (firstIssue as { keys?: string[] }).keys;
    param = (keys && keys[0]) ? keys[0] : null;
} else {
    param = null;
}
return { success: false, param, message: firstIssue.message };
```

### `withRequestId` response wrapper
**Source:** `index.ts` lines 108–112
**Apply to:** All new `return` statements added inside `createServer()`'s `fetch()` handler
```typescript
function withRequestId(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', requestId);
    return new Response(response.body, { status: response.status, headers });
}
```

---

## No Analog Found

No files in Phase 4 lack a codebase analog. All 5 files either directly extend an existing file or mirror an established pattern in `request-schema.ts` / `request-schema.test.ts`.

---

## Critical Anti-Patterns (from RESEARCH.md)

| Anti-Pattern | Why Forbidden | Correct Pattern |
|---|---|---|
| `z.object().strict()` | Zod v3 API — does not exist in v4 | `z.strictObject()` — already used in `request-schema.ts` line 6 |
| `z.file().max(bytes)` for 413 path | Produces `ZodError` (400), not HTTP 413 | Explicit `file.size > config.audioMaxFileBytes` pre-check before Zod |
| `schema.safeParse(formData)` | FormData is not a plain object | Extract fields with `.get()`, build plain object, then `safeParse` |
| Adding `maxRequestBodySize` as `createServer()` parameter | Breaks existing integration test signatures (Pitfall 3) | Read `config.audioMaxFileBytes` inside `createServer()` — no signature change |
| `import { AudioTranscriptionInput }` (value import) | `verbatimModuleSyntax: true` forbids value imports of types | `import type { AudioTranscriptionInput }` |

---

## Metadata

**Analog search scope:** All `.ts` files at root and `tests/` (16 files total)
**Files scanned:** `config.ts`, `types.ts`, `request-schema.ts`, `index.ts`, `request-schema.test.ts`
**Pattern extraction date:** 2026-06-06
