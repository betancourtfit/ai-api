---
phase: 04-audio-foundation
reviewed: 2026-06-06T00:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - audio-schema.ts
  - config.ts
  - index.ts
  - tests/unit/audio-schema.test.ts
  - types.ts
findings:
  critical: 1
  warning: 2
  info: 4
  total: 7
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-06-06
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Reviewed the audio-foundation wave-1 changes: new `audio-schema.ts` Zod validators, whisper/audio config fields in `config.ts`, the raised `maxRequestBodySize` plus the chat 1 MiB Content-Length gate in `index.ts`, the `AudioTranscriptionResult` type, and the new unit tests.

The Zod schema work is solid: strict allowlist, `File` instanceof check, first-error extraction with correct `param` derivation for both pathed issues and top-level `unrecognized_keys`. The TDD tests cover the allowlist and size paths.

The main problems are in the body-size enforcement added to `index.ts`: the new chat 1 MiB limit trusts the client-supplied `Content-Length` header and is trivially bypassable (Critical), and the global gate is set to exactly the audio file ceiling, which guarantees that a maximum-size legitimate audio file will be rejected by Bun's opaque built-in gate instead of the intended AUDIO-03 413 path (Warning). Numeric env parsing remains unvalidated, so a misconfigured value silently disables the limit (Warning).

## Critical Issues

### CR-01: Chat 1 MiB body limit is enforced via client-controlled Content-Length header — trivially bypassable

**File:** `index.ts:191-200`
**Issue:** The WHSP-05 chat limit reads the request's `Content-Length` header and compares it to `config.maxRequestBodyBytes`:

```ts
const contentLength = Number(request.headers.get('content-length') ?? 0);
if (contentLength > config.maxRequestBodyBytes) { ... 413 ... }
```

Three bypass paths:
1. **Chunked transfer encoding:** an HTTP/1.1 client sending `Transfer-Encoding: chunked` omits `Content-Length` entirely. `request.headers.get('content-length')` returns `null`, `Number(null ?? 0)` is `0`, the check passes, and `await request.json()` at line 205 then buffers up to 25 MiB (the new global `maxRequestBodySize` ceiling) of JSON on the chat endpoint — a 25x violation of the declared 1 MiB chat limit.
2. **Malformed header:** `Content-Length: abc` yields `Number('abc')` = `NaN`; `NaN > limit` is `false`, so the check passes.
3. **Understated header:** depending on how strictly the server reconciles header vs. actual bytes, a lying header can also slip through; the handler never verifies the actual body size it parsed.

Before this phase, `maxRequestBodySize` was Bun's enforced byte-accurate gate. This change replaced a byte-accurate 1 MiB enforcement with an advisory header check and raised the real gate to 25 MiB, so the chat endpoint's effective limit regressed from 1 MiB to 25 MiB for any client that omits or malformes the header. This defeats the stated purpose of the explicit gate ("chat 1 MiB limit enforced in handler") and allows memory-amplified abuse of the chat path by any authenticated client.

**Fix:** Enforce the limit on actual bytes, not the header. Keep the header check as a fast-fail, then verify after reading:

```ts
const contentLength = Number(request.headers.get('content-length') ?? 0);
if (Number.isFinite(contentLength) && contentLength > config.maxRequestBodyBytes) {
    return withRequestId(openaiError(/* ... 413 ... */));
}

const raw = await request.text();
if (Buffer.byteLength(raw) > config.maxRequestBodyBytes) {
    return withRequestId(openaiError(
        `Request body too large. Maximum is ${config.maxRequestBodyBytes} bytes.`,
        'invalid_request_error', 'request_too_large', null, 413
    ));
}
let body: unknown;
try { body = JSON.parse(raw); } catch { /* existing 400 path */ }
```

(For stricter memory bounds, read `request.body` incrementally and abort once the running byte count exceeds the limit.)

## Warnings

### WR-01: `maxRequestBodySize` set to exactly `audioMaxFileBytes` — a max-size audio file can never reach the AUDIO-03 413 path

**File:** `index.ts:102`, `config.ts:37`
**Issue:** The global gate is `maxRequestBodySize: config.audioMaxFileBytes` (25 MiB). But the future audio endpoint receives `multipart/form-data`, where the total request body = file bytes + multipart boundaries + part headers + the `model`/`response_format` fields. A file at or near the documented 25 MiB ceiling produces a body strictly larger than 25 MiB, so Bun rejects it at the transport gate before the handler runs. Consequences:

1. `validateAudioFileSize` (the carefully built, unit-tested AUDIO-03 413 path with its descriptive message) is unreachable for the boundary region just below the file limit — the exact cases it exists for.
2. Bun's built-in rejection is not an OpenAI-shaped error and carries no `X-Request-ID`, violating the project's error-contract and OBS-01 conventions for that path.

**Fix:** Set the transport gate to the file ceiling plus a multipart overhead margin so the handler-level check is the authoritative boundary:

```ts
// index.ts
maxRequestBodySize: config.audioMaxFileBytes + 64 * 1024, // multipart overhead headroom
```

Document that `validateAudioFileSize(file, config.audioMaxFileBytes)` is the real limit and the transport gate is only a backstop.

### WR-02: Numeric env vars parsed with bare `Number()` — misconfiguration silently disables limits or produces nonsense values

**File:** `config.ts:31-38` (new fields: `whisperPort`, `whisperTimeoutMs`, `audioMaxFileBytes`, `maxRequestBodyBytes`)
**Issue:** All new numeric fields use `Number(process.env[...] ?? default)` with no validation:

- `AUDIO_MAX_FILE_BYTES=25MB` → `NaN` → `maxRequestBodySize: NaN` passed to `Bun.serve()` (undefined behavior), and `validateAudioFileSize` becomes a no-op (`size > NaN` is always `false`).
- `MAX_REQUEST_BODY_BYTES=1mb` → `NaN` → the chat 413 gate never fires (`contentLength > NaN` is `false`) — fail-open.
- `WHISPER_PORT=""` (set but empty) → `??` does not catch empty string, `Number("")` = `0` → whisper connects to port 0 instead of the 8080 default. Same empty-string trap applies to all four fields.
- Negative values are accepted without complaint.

The pattern is inherited from older fields, but this phase added four more instances, and two of them gate security-relevant size limits where `NaN` fails open.

**Fix:** Add a validated parser and use it for the new fields (and ideally retrofit existing ones):

```ts
function intEnv(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid value for ${name}: must be a positive integer`);
    }
    return n;
}
```

Failing fast at startup is preferable to silently disabled limits.

## Info

### IN-01: New validators, type, and whisper config are exported but unused — no consumer exists yet

**File:** `audio-schema.ts:19,50`, `types.ts:58-60`, `config.ts:30-34`
**Issue:** `validateAudioTranscription`, `validateAudioFileSize`, `AudioTranscriptionResult`, and the four `whisper*` config fields have no callers outside the test file — no `/v1/audio/transcriptions` route exists in `index.ts`. Expected for a foundation wave, but it means the only live behavioral change shipped by this phase is the body-size handling flagged in CR-01/WR-01. The raised 25 MiB `maxRequestBodySize` is therefore pure added attack surface until the audio endpoint lands.
**Fix:** Acceptable as staged work; consider deferring the `maxRequestBodySize` raise to the same wave that adds the audio route so the wider gate never ships without its consumer.

### IN-02: Redundant type assertion after `in` narrowing

**File:** `audio-schema.ts:38`
**Issue:** `const keys = (firstIssue as { keys?: string[] }).keys;` — the preceding `firstIssue.code === 'unrecognized_keys' && 'keys' in firstIssue` check already narrows; if Zod v4's issue union doesn't narrow cleanly, prefer narrowing on the discriminant (`firstIssue.code === 'unrecognized_keys'` narrows to `ZodIssueUnrecognizedKeys`, which has `keys: string[]`) rather than a structural cast that would mask a future shape change.
**Fix:** `if (firstIssue.code === 'unrecognized_keys') { param = firstIssue.keys[0] ?? null; }`

### IN-03: Test gaps — unknown-key `param` and size boundary unasserted

**File:** `tests/unit/audio-schema.test.ts:49-53,70-86`
**Issue:** The unknown-field test (`language`) asserts only `success: false` but not `param === 'language'`, leaving the dedicated `unrecognized_keys` extraction branch (audio-schema.ts:36-39) effectively untested. The size tests cover 101>100 but not the boundary `size === maxBytes` (which the implementation intentionally allows via `>`).
**Fix:** Add `expect(result.param).toBe("language")` to the unknown-field test, and a `validateAudioFileSize(file, file.size)` boundary case asserting `ok: true`.

### IN-04: Pre-existing unsafe cast on `PROVIDER_ORDER` (in scope file, not this phase's diff)

**File:** `config.ts:24`
**Issue:** `.split(",") as Array<"cerebras" | "groq">` accepts any string (e.g., `PROVIDER_ORDER=cerebras, groq` with a space, or a typo) without validation; downstream `adapters[provider]` lookups would yield `undefined`. Pre-existing, noted because the file is in review scope.
**Fix:** Filter/validate entries against the known provider set at startup; throw on unknown values.

---

_Reviewed: 2026-06-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
