# Phase 4: Audio Foundation - Research

**Researched:** 2026-06-06
**Domain:** Bun.serve configuration, Zod v4 file validation, multipart/form-data parsing, TypeScript config types
**Confidence:** HIGH

---

## Summary

Phase 4 is a purely additive, no-binary-required foundation: new env vars in `config.ts`, new types in `types.ts`, a new `audio-schema.ts` validator module, and a `maxRequestBodySize` fix in `index.ts`. No route handler is wired — the transcription endpoint does not exist yet. The success gate is schema unit tests passing with no whisper binary installed.

The codebase is fully established. `config.ts` already follows a single-read-from-env pattern with `optional()` helper and an exported `const config`. `request-schema.ts` already uses `z.strictObject()` for the chat allowlist. Both patterns transfer directly to the audio side: add whisper config fields to `config.ts`, create `audio-schema.ts` with a `z.strictObject()` validator that mirrors the existing chat-validation pattern, and add an `AudioTranscriptionInput` type to `types.ts`.

The one non-trivial concern is `maxRequestBodySize`. Bun's default is 128 MB (confirmed via `bun-types`), not 1 MiB. The CLAUDE.md spec says `MAX_REQUEST_BODY_BYTES=1048576` for chat completions. The STATE.md decision is: "maxRequestBodySize raised to audio limit in Bun.serve(); chat-completion 1 MiB limit enforced at validation layer." Phase 4 must set `maxRequestBodySize` to `config.audioMaxFileBytes` (default 26,214,400 — 25 MiB) in `createServer()`, and add a content-length pre-check in the JSON body path to enforce the 1 MiB chat limit without relying on Bun's global gate.

**Primary recommendation:** Follow the established pattern exactly — mirror `chatCompletionSchema`/`validateChatCompletion` with an `audioTranscriptionSchema`/`validateAudioTranscription` pair. Keep config additions additive and non-breaking. Add `maxRequestBodySize` to `Bun.serve()` options in `createServer()`. Write unit tests for the new schema validator that run without any sidecar process.

---

## Project Constraints (from CLAUDE.md)

- Runtime: Bun only — `Bun.serve()`, no Express; `bun test` for tests
- No new npm packages — zero additional dependencies
- Flat root-level structure (no src/); files at root level; subdirectories for routes/, middleware/ etc.
- `verbatimModuleSyntax: true` — `import type` required for type-only imports
- Zod v4 for validation — `z.strictObject()` rejects unknown keys (not `.strict()` method)
- Missing secrets must not crash server — surface via `/ready` only
- All process.env reads in `config.ts` only; other modules import from config
- Never log audio content, filenames, or transcribed text
- `bun test` must stay green with no whisper binary installed

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUDIO-01 | Proxy validates `file` field is present in multipart body; returns OpenAI-shaped 400 if missing | `z.file()` in Zod v4; missing field detected at schema validation before any handler logic |
| AUDIO-02 | Proxy validates `model` matches a known whisper alias; returns OpenAI-shaped 400 if unknown | `z.string()` on model field + post-schema alias lookup mirrors existing `isKnownAlias()` pattern |
| AUDIO-03 | Proxy enforces 25 MB file size limit; returns OpenAI-shaped 413 if exceeded | `z.file().max(config.audioMaxFileBytes)` or explicit size check on the `File`/`Blob`; `maxRequestBodySize` at serve level |
| AUDIO-04 | Proxy accepts `response_format` field in request (v2.0 always returns json) | `z.literal('json').optional()` in `audioTranscriptionSchema` |
| AUDIO-05 | Proxy rejects unknown/unsupported request fields with OpenAI-shaped 400 | `z.strictObject()` already rejects unrecognized keys |
| AUDIO-06 | Successful response body is `{ "text": "..." }` — OpenAI json transcription shape | Type `AudioTranscriptionResult` in `types.ts`; no handler yet in Phase 4 |
| WHSP-04 | `WHISPER_PORT`, `WHISPER_HOST`, `WHISPER_TIMEOUT_MS`, `AUDIO_MAX_FILE_BYTES` env vars respected by config | Additive fields to `config.ts`; `optional()` pattern for `WHISPER_MODEL_ALIAS` |
| WHSP-05 | `maxRequestBodySize` in Bun.serve raised to accommodate audio files separate from 1 MiB chat limit | `maxRequestBodySize: config.audioMaxFileBytes` in `createServer()`; chat 1 MiB enforced in validation layer |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Env config for whisper | Config layer (`config.ts`) | — | All env reads centralized per CLAUDE.md working rule 2 |
| Audio request schema | Validation layer (`audio-schema.ts`) | — | Mirrors `request-schema.ts` for chat; one module per domain |
| File size enforcement | Validation layer (explicit check) | Bun.serve gate | `maxRequestBodySize` is a network-level gate; 413 logic must be explicit in validation to return OpenAI error shape |
| Body size gate for chat | Validation layer (content-length check) | — | Chat 1 MiB limit must not rely on Bun global gate (which is now set to audio limit) |
| Response type for transcription | Types layer (`types.ts`) | — | `AudioTranscriptionResult` goes alongside existing `ChatCompletionResult` |
| `maxRequestBodySize` config | `createServer()` in `index.ts` | `config.ts` | The value comes from config; it is set in Bun.serve options |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | 4.4.3 (installed) | Audio request schema validation | Already the project validator; `z.file()` is native to v4 |
| bun (runtime) | 1.3.11 (local) | `request.formData()`, `maxRequestBodySize` | Built-in; no additional packages needed |

[VERIFIED: npm registry — `zod@4.4.3` confirmed installed in project `node_modules`]
[VERIFIED: bun-types — `maxRequestBodySize?: number` confirmed in `node_modules/bun-types/serve.d.ts`]

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` | built-in | Already used for `timingSafeEqual` | No change needed |
| `bun:test` | built-in | Schema unit tests | Already used for all 66 existing tests |

**No new packages required.** Zero new `npm install` calls in this phase.

---

## Package Legitimacy Audit

No new packages are installed in this phase. All dependencies are already present in `node_modules/`.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
Downstream client
       |
       | POST multipart/form-data
       v
createServer() — Bun.serve({ maxRequestBodySize: config.audioMaxFileBytes })
       |
       | [Phase 5 will add route handler here]
       | [Phase 4 only validates schema, no route wired]
       v
validateAudioTranscription(formData)   <-- audio-schema.ts (NEW Phase 4)
       |
   ┌───┴──────────────────────────┐
   | Validation failures          | Valid
   v                              v
openaiError(400/413)         [ready for Phase 5 handler]
```

```
POST /v1/chat/completions
       |
       | request.json() — body parsed
       v
Content-Length check (NEW Phase 4) — > 1 MiB → openaiError(413)
       |
       v
validateChatCompletion(body)   <-- existing request-schema.ts (unchanged)
```

### Recommended Project Structure

No new directories needed. Files are added to the existing flat root structure:

```
(root)/
├── config.ts          # MODIFIED — add whisper + audio config fields
├── types.ts           # MODIFIED — add AudioTranscriptionInput, AudioTranscriptionResult
├── audio-schema.ts    # NEW — Zod schema + validateAudioTranscription()
├── index.ts           # MODIFIED — maxRequestBodySize, chat body size pre-check
└── tests/
    └── unit/
        └── audio-schema.test.ts  # NEW — schema unit tests (no binary required)
```

### Pattern 1: Config Extension (WHSP-04)

**What:** Add whisper/audio env vars to `config.ts` following the existing `optional()` / default-coalesce pattern.

**When to use:** All env reads go in `config.ts` only. Missing optional vars must not crash.

```typescript
// Source: config.ts (existing pattern)

// Existing pattern to follow:
// optional() returns null when env var is missing — no crash
function optional(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
}

// New fields to add:
export const config = {
    // ... existing fields ...

    // WHSP-04: whisper sidecar config
    whisperHost: process.env["WHISPER_HOST"] ?? "127.0.0.1",
    whisperPort: Number(process.env["WHISPER_PORT"] ?? 8080),
    whisperTimeoutMs: Number(process.env["WHISPER_TIMEOUT_MS"] ?? 30000),
    // WHISPER_MODEL_ALIAS missing must NOT crash — use optional()
    whisperModelAlias: optional("WHISPER_MODEL_ALIAS"),

    // AUDIO-03 + WHSP-05: 25 MiB default audio limit
    audioMaxFileBytes: Number(process.env["AUDIO_MAX_FILE_BYTES"] ?? 26_214_400), // 25 MiB

    // WHSP-05: 1 MiB limit for chat completions JSON bodies (enforced at validation layer)
    maxRequestBodyBytes: Number(process.env["MAX_REQUEST_BODY_BYTES"] ?? 1_048_576), // 1 MiB
} as const;
```

### Pattern 2: Audio Schema (AUDIO-01 through AUDIO-05)

**What:** `z.strictObject()` for multipart fields, mirroring `chatCompletionSchema` in `request-schema.ts`. The schema validates an already-parsed `FormData` object (not raw JSON), so validation is done manually against extracted fields — not via `schema.safeParse(formData)`.

**When to use:** Called from the audio route handler (Phase 5) and directly in unit tests.

```typescript
// Source: request-schema.ts (existing z.strictObject pattern)
// audio-schema.ts — NEW file

import * as z from 'zod';

// OpenAI transcription request fields — strict allowlist (AUDIO-05)
// model and response_format are strings extracted from FormData
// file is a File/Blob extracted from FormData
const audioTranscriptionSchema = z.strictObject({
    model: z.string(),
    file: z.instanceof(File),                          // AUDIO-01
    response_format: z.literal('json').optional(),     // AUDIO-04
});

export type AudioTranscriptionInput = z.infer<typeof audioTranscriptionSchema>;

// Validate a plain object built from FormData fields
// Returns success/failure in the same shape as validateChatCompletion()
export function validateAudioTranscription(
    input: unknown
): { success: true; data: AudioTranscriptionInput } |
   { success: false; param: string | null; message: string }
{
    // Size check must happen BEFORE Zod parses (Zod does not enforce bytes limit for us here)
    // Size check is done by the caller who has access to config.audioMaxFileBytes
    const result = audioTranscriptionSchema.safeParse(input);
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

**Note on `z.file()` vs `z.instanceof(File)`:** Zod v4 has a native `z.file()` API with `.min()`, `.max()`, `.mime()`. However, `z.file()` works when the input is a `File` instance; `z.instanceof(File)` is the fallback for when `File` global availability must not be assumed. For this project, `z.instanceof(File)` is safer — it will work correctly regardless of Zod's internal `File` detection logic. The file size check is a separate explicit check (see Pattern 3) because the 413 response needs to be returned before even attempting Zod parsing when the file is too large.

[VERIFIED: Context7/colinhacks/zod — `z.file()` confirmed in Zod v4 docs; `z.strictObject()` confirmed]

### Pattern 3: File Size Enforcement (AUDIO-03 + WHSP-05)

**What:** Two-layer enforcement:
1. `maxRequestBodySize` in `Bun.serve()` — network-level gate rejects any request body over the audio limit before `fetch()` is called.
2. Explicit file size check in the route handler (Phase 5) after `formData()` parsing — returns OpenAI-shaped 413.

Phase 4 handles layer 1 (the Bun.serve config). The explicit 413 validator is also part of Phase 4 because success criterion 2 requires unit-testable behavior.

```typescript
// Source: bun-types/serve.d.ts — confirmed type signature
// index.ts — createServer() modification

export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port
): ReturnType<typeof Bun.serve> {
    return Bun.serve({
        hostname: config.hostname,
        port,
        maxRequestBodySize: config.audioMaxFileBytes,   // WHSP-05: raised to audio limit
        async fetch(request, server) {
            // ...
            // WHSP-05: chat completions — enforce 1 MiB at validation layer
            // (maxRequestBodySize is now audio-sized; chat must be gated explicitly)
            if (request.method === 'POST' && pathname === '/v1/chat/completions') {
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
                // ... existing JSON parse + validateChatCompletion
            }
        }
    });
}
```

**Important:** `maxRequestBodySize` is a global server-level setting — there is no per-route override. The audio file limit (25 MiB) becomes the global ceiling; the chat 1 MiB limit must be enforced explicitly inside the handler.

[VERIFIED: bun-types/serve.d.ts — `maxRequestBodySize?: number`, comment: "What is the maximum size of a request body? (in bytes)", `@default 1024 * 1024 * 128 // 128MB"]

### Pattern 4: Types Extension (AUDIO-06)

**What:** Add `AudioTranscriptionInput` and `AudioTranscriptionResult` to `types.ts`.

```typescript
// Source: types.ts (existing ChatCompletionResult shape to mirror)
// New types to add:

export interface AudioTranscriptionResult {
    text: string;  // AUDIO-06: only field in json format response
}
```

`AudioTranscriptionInput` is inferred from `audioTranscriptionSchema` via `z.infer<>` — it does not need a manual interface in `types.ts`. Only `AudioTranscriptionResult` (the response shape) belongs in `types.ts`.

### Pattern 5: Schema Unit Tests (bun:test, no binary)

**What:** Tests in `tests/unit/audio-schema.test.ts` that import `validateAudioTranscription` and call it with plain objects. No server, no FormData parsing, no sidecar — pure unit tests.

```typescript
// Source: request-schema.test.ts (existing unit test pattern)
// tests/unit/audio-schema.test.ts — NEW

import { test, expect, describe } from "bun:test";
import { validateAudioTranscription } from "../../audio-schema";

describe("validateAudioTranscription", () => {
    test("valid input returns success:true", () => {
        const file = new File(["audio data"], "test.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "whisper-alias", file });
        expect(result.success).toBe(true);
    });

    test("missing file returns success:false with param='file'", () => {
        const result = validateAudioTranscription({ model: "whisper-alias" });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.param).toBe("file");
    });

    test("unknown field returns success:false", () => {
        const file = new File(["data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "x", file, language: "en" });
        expect(result.success).toBe(false);
    });
});
```

**Key:** `new File(["data"], "name", { type: "mime" })` is available in the Bun runtime without any imports. Tests run entirely in-process — no binary, no network. [VERIFIED: bun docs — File is a global Web API in Bun runtime]

### Anti-Patterns to Avoid

- **Setting `maxRequestBodySize` to 1 MiB:** This would reject audio requests at the network level. The Bun default is 128 MiB (generous); Phase 4 raises it to 25 MiB to set an explicit ceiling and then enforces 1 MiB for chat at validation layer.
- **Using `z.file().max()` for the 413 path:** Zod v4's `z.file().max()` returns a `ZodError` — the caller would need to translate it to a 413 rather than 400. It is cleaner to do an explicit `file.size > config.audioMaxFileBytes` check before Zod runs, returning a `413` directly.
- **Validating FormData via `schema.safeParse(formData)`:** FormData is not a plain object. Extract fields first with `.get()`, build a plain object, then pass to `safeParse`.
- **Putting `whisperModelAlias` as a required config field:** Success criterion 3 explicitly requires that a missing `WHISPER_MODEL_ALIAS` does not crash the server. Use `optional()` from the existing config helper.
- **Adding `response_format` as `z.string()`:** It should be `z.literal('json').optional()` — v2.0 only supports json format; other values should be rejected (AUDIO-05, unknown field rejection).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Unknown key rejection | Custom key allowlist check | `z.strictObject()` | Already proven in chat schema; zero-code edge-case handling |
| File type detection | Custom MIME check | `z.instanceof(File)` + phase-level logic | Phase 4 does not need MIME validation; whisper-server handles format |
| Body size parsing | Parse Content-Length manually and compare | Explicit `content-length` header check + `maxRequestBodySize` in Bun.serve | Two-liner; built-in Bun network gate covers extreme cases |

**Key insight:** The audio schema in Phase 4 is smaller than the chat schema — only 3 fields (`model`, `file`, `response_format`). Resist any temptation to add complexity before Phase 5 needs it.

---

## Common Pitfalls

### Pitfall 1: `z.file()` vs `z.instanceof(File)` — Zod v4 API
**What goes wrong:** Using `z.file()` from Zod v4 works when the input is actually a `File` instance. The method chain `.max(bytes)` on `z.file()` generates a `ZodError` instead of returning a 413 HTTP response.
**Why it happens:** Zod treats size violations as validation errors with code `too_big`, not as HTTP 413 conditions.
**How to avoid:** Keep the 413 check as an explicit pre-Zod `if (file.size > config.audioMaxFileBytes) return openaiError(..., 413)` in the route handler (Phase 5). Use `z.instanceof(File)` in the schema for structural validation.
**Warning signs:** Test returns 400 instead of 413 for oversized files.

### Pitfall 2: `maxRequestBodySize` is global — no per-route override
**What goes wrong:** Assuming that `maxRequestBodySize` can be set differently for `/v1/chat/completions` vs `/v1/audio/transcriptions`.
**Why it happens:** The option is on `Bun.serve()` options object, not per-request.
**How to avoid:** Set `maxRequestBodySize` to the larger audio limit (25 MiB); enforce the smaller chat limit explicitly inside the chat completions handler using a `Content-Length` header check.
**Warning signs:** Chat completions accept bodies larger than 1 MiB after the change.

### Pitfall 3: `createServer()` signature change breaks integration tests
**What goes wrong:** Adding a `maxRequestBodySize` parameter to `createServer()` instead of reading it from `config` inside the function.
**Why it happens:** Following the pattern of `port` being a parameter, but `maxRequestBodySize` is not test-variable.
**How to avoid:** Read `maxRequestBodySize` directly from `config.audioMaxFileBytes` inside `createServer()`. Keep the function signature unchanged: `createServer(adapters, port?)`.
**Warning signs:** Existing integration tests fail to compile.

### Pitfall 4: `import type` violation with `verbatimModuleSyntax`
**What goes wrong:** Writing `import { AudioTranscriptionInput } from './audio-schema'` when `AudioTranscriptionInput` is a type.
**Why it happens:** `verbatimModuleSyntax: true` in `tsconfig.json` requires `import type` for type-only imports.
**How to avoid:** If `AudioTranscriptionInput` is `z.infer<typeof audioTranscriptionSchema>`, it is a type alias — always use `import type { AudioTranscriptionInput }`.
**Warning signs:** TypeScript error about "type-only imports must be aliased as 'import type'".

### Pitfall 5: FormData `.get()` returns `File | string | null` — not `File`
**What goes wrong:** TypeScript errors when passing `formData.get('file')` directly to `validateAudioTranscription()` because its type is `string | File | null`.
**Why it happens:** The `FormData.get()` Web API is typed to return the union regardless of field type.
**How to avoid:** Build the input object explicitly: `const input = { model: formData.get('model'), file: formData.get('file') }`. Zod's `z.instanceof(File)` will reject the `string | null` cases and report validation errors cleanly.
**Warning signs:** TypeScript errors at callsite, or Zod reporting unexpected type errors on valid `File` inputs.

---

## Code Examples

### Config additions

```typescript
// Source: config.ts (existing pattern — all env reads here)
// Additive block for Phase 4:

whisperHost: process.env["WHISPER_HOST"] ?? "127.0.0.1",
whisperPort: Number(process.env["WHISPER_PORT"] ?? 8080),
whisperTimeoutMs: Number(process.env["WHISPER_TIMEOUT_MS"] ?? 30_000),
whisperModelAlias: optional("WHISPER_MODEL_ALIAS"),    // null when unset — no crash
audioMaxFileBytes: Number(process.env["AUDIO_MAX_FILE_BYTES"] ?? 26_214_400),  // 25 MiB
maxRequestBodyBytes: Number(process.env["MAX_REQUEST_BODY_BYTES"] ?? 1_048_576), // 1 MiB
```

### Audio schema validator

```typescript
// Source: request-schema.ts pattern applied to audio domain
// audio-schema.ts:

import * as z from 'zod';

export const audioTranscriptionSchema = z.strictObject({
    model: z.string(),
    file: z.instanceof(File),
    response_format: z.literal('json').optional(),
});

export type AudioTranscriptionInput = z.infer<typeof audioTranscriptionSchema>;

export function validateAudioTranscription(input: unknown):
    { success: true; data: AudioTranscriptionInput } |
    { success: false; param: string | null; message: string }
{
    const result = audioTranscriptionSchema.safeParse(input);
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

### Bun.serve maxRequestBodySize

```typescript
// Source: bun-types/serve.d.ts — maxRequestBodySize?: number, default 128MB
// In createServer() — no signature change:

return Bun.serve({
    hostname: config.hostname,
    port,
    maxRequestBodySize: config.audioMaxFileBytes,   // 25 MiB (raised from Bun's 128 MiB default)
    async fetch(request, server) {
        // ...
    }
});
```

### AudioTranscriptionResult type

```typescript
// Source: types.ts pattern (ChatCompletionResult as reference)
// Add to types.ts:

export interface AudioTranscriptionResult {
    text: string;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `z.instanceof(File).refine(f => f.size <= max)` | `z.instanceof(File)` + explicit pre-check | Zod v4 | Cleaner 413 path; Zod doesn't know about HTTP status codes |
| Manual FormData field iteration | `formData.get('fieldName')` | Web API standard | Direct access by name is reliable in Bun |
| `z.object().strict()` | `z.strictObject()` | Zod v4 | `.strict()` method no longer exists in Zod v4; `z.strictObject()` is the v4 API |

**Deprecated/outdated:**
- `z.object().strict()`: This is the Zod v3 API. The project already uses `z.strictObject()` correctly in `request-schema.ts`. Do not use the v3 form.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `z.instanceof(File)` correctly validates `File` instances in Bun's runtime (where `File` is a global) | Architecture Patterns, Pattern 2 | If `File` global is unavailable in test context, tests fail — workaround: `new File(...)` in tests already exercises this |
| A2 | Content-Length header is reliable for chat-completion request size checking | Pitfall 2 | Clients that omit Content-Length would bypass the check — risk is low (well-formed clients always send it for JSON bodies); add fallback to parse and re-check body byte length if needed |

**Verified claims:** All core claims verified via bun-types, Context7/zod docs, and live codebase inspection.

---

## Open Questions

1. **Should `validateAudioTranscription` accept a model alias that does not exist in the whisper model registry?**
   - What we know: AUDIO-02 says "validate model matches a known whisper alias" — but the whisper alias registry does not exist yet (Phase 6 builds it). The audio schema validator only knows about `z.string()` for model; alias lookup is done after schema validation, matching the chat pattern (`isKnownAlias()` called in the route handler after `validateChatCompletion` passes).
   - What's unclear: Should Phase 4 add a `validateAudioModel(alias: string)` helper that Phase 5 calls, or is that Phase 5's concern?
   - Recommendation: Phase 4 builds the schema validator only. The alias check function belongs to the route wiring in Phase 5. Keep Phase 4 self-contained.

2. **Should `maxRequestBodyBytes` (1 MiB for chat) be enforced via Content-Length check or by reading the body and measuring?**
   - What we know: Content-Length is a request header that clients send voluntarily. Large JSON bodies are unusual for this API; the risk of a missing Content-Length is low.
   - What's unclear: Success criterion 4 says "without changing the 1 MiB chat-completion behavior" — the existing code has no 1 MiB enforcement at all (Bun's default was 128 MiB). Raising `maxRequestBodySize` to 25 MiB technically loosens the chat gate, which previously was also unconstrained.
   - Recommendation: Implement the Content-Length check as described. It matches the existing `REQUEST_TIMEOUT_MS`/`MAX_REQUEST_BODY_BYTES` env var design from CLAUDE.md §7. For Phase 4 unit test coverage, the schema test exercises the schema only — the Content-Length enforcement test would require an integration test, which is Phase 5's scope.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun runtime | All tests and server | ✓ | 1.3.11 | — |
| zod | `audio-schema.ts` | ✓ | 4.4.3 | — |
| whisper-server binary | Phase 4 tests | Not required | — | Schema tests run without it (phase gate requirement) |

**Missing dependencies with no fallback:** None — Phase 4 is explicitly scoped to require no whisper binary.

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (no new auth path added) | — |
| V3 Session Management | No | — |
| V4 Access Control | No (no new endpoint exposed) | — |
| V5 Input Validation | Yes | `z.strictObject()` + explicit file size check |
| V6 Cryptography | No | — |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Oversized upload crashing server | DoS | `maxRequestBodySize` at Bun.serve level + explicit 413 in validator |
| Path traversal via filename | Tampering | Not applicable — Phase 4 does not write files; whisper sidecar owns file handling |
| API key exposure via error messages | Info disclosure | Already handled by existing `openaiError()` — never reflect request content in errors |
| Unknown field injection | Tampering | `z.strictObject()` rejects unrecognized keys |

---

## Sources

### Primary (HIGH confidence)
- `/oven-sh/bun` (Context7) — `request.formData()`, `Blob.size`, file upload patterns
- `node_modules/bun-types/serve.d.ts` — `maxRequestBodySize?: number` type definition with JSDoc default comment (128 MB)
- `/colinhacks/zod` (Context7) — `z.file()`, `z.strictObject()`, `z.instanceof()`, `safeParse()`, Zod v4 API
- `config.ts`, `request-schema.ts`, `index.ts`, `types.ts` — live codebase for patterns

### Secondary (MEDIUM confidence)
- `bun.sh/docs/api/http` (WebFetch) — `Bun.serve()` configuration options; `maxRequestBodySize` not directly listed on page but confirmed via type definitions

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — zod version confirmed installed; Bun types confirmed locally
- Architecture: HIGH — mirrors established patterns exactly; all integration points verified in live code
- Pitfalls: HIGH — derived from actual type constraints and existing test patterns
- maxRequestBodySize behavior: HIGH — confirmed via `bun-types` type annotation with JSDoc

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (stable; Zod v4 and Bun APIs change infrequently)
