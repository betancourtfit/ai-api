---
phase: 04-audio-foundation
reviewed: 2026-06-06T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - audio-schema.ts
  - config.ts
  - index.ts
  - tests/integration/server.test.ts
  - tests/unit/audio-schema.test.ts
  - types.ts
findings:
  critical: 3
  warning: 3
  info: 3
  total: 9
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-06-06
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Phase 04 delivers two waves: wave 1 (04-01) adds the audio/Whisper config fields, `AudioTranscriptionResult`
type, `audio-schema.ts` Zod validators, and a 1 MiB Content-Length gate plus raised `maxRequestBodySize`
in `index.ts`. Wave 2 (04-02) replaces the header-based gate with a `Buffer.byteLength(raw)` gate to
close three bypass paths identified as CR-01.

The Zod schema, size validator, and config additions are structurally correct. The `Buffer.byteLength(raw)`
approach is the right fix for CR-01. However, three critical issues remain:

1. The regression tests for CR-01 (TEST-13 and TEST-15) are vacuous: the 04-02 SUMMARY explicitly
   states they "passed before the fix" because Bun's `fetch()` in `bun:test` always injects the correct
   `Content-Length`, so the old broken gate and the new correct gate produce the same test results.

2. The fast-fail at `index.ts:192` uses `Number(request.headers.get('content-length'))` which returns
   `Number(null)` = `0` when no header is present. `Number.isFinite(0)` is `true`, so the fast-fail
   path is entered for every header-less POST. The comparison `0 > limit` saves it from a false 413
   today, but the null-to-zero conversion means the guard is semantically incorrect and fragile.

3. `maxRequestBodySize` is set to exactly `config.audioMaxFileBytes` (25 MiB). A maximum-size audio
   file plus multipart overhead exceeds that boundary, so Bun rejects the request at the transport
   layer before the handler runs — `validateAudioFileSize`, the purposely-built AUDIO-03 413 path with
   its structured error message, is unreachable for any file at or near the documented limit.

---

## Critical Issues

### CR-01: Regression tests TEST-13 and TEST-15 cannot detect a revert to the broken header gate

**File:** `tests/integration/server.test.ts:350-413`
**Issue:** The 04-02 SUMMARY (line 85) explicitly states: "TEST-13 and TEST-15 passed before the fix
because Bun's fetch() in tests automatically sets Content-Length to the correct body size (overriding
explicit headers or filling in missing ones)."

This means both tests return 413 against the *old* broken `Number(request.headers.get('content-length') ?? 0)`
check and against the new `Buffer.byteLength(raw)` check — because `fetch()` in `bun:test` always sends
a correct Content-Length, making both implementations agree. The tests cannot distinguish the safe
implementation from the vulnerable one. Reverting `Buffer.byteLength(raw)` back to the header check
would leave TEST-13 and TEST-15 green while restoring the chunked-encoding and understated-header
bypass paths.

**Fix:** Add a source-level guard test that will fail if `Buffer.byteLength(raw)` is removed, and
document explicitly in the test file that integration tests cannot cover the raw-HTTP bypass paths:

```typescript
// In tests/integration/server.test.ts, add as a separate test:
test('SECURITY: Buffer.byteLength gate must be present in source (CR-01 guard)', () => {
    // bun:test fetch() always sends correct Content-Length, so TEST-13/TEST-15 cannot
    // catch a revert to the header-based gate. This source assertion fills that gap.
    const src = require('node:fs').readFileSync(
        new URL('../../index.ts', import.meta.url), 'utf-8'
    );
    expect(src).toContain('Buffer.byteLength(raw)');
    expect(src).not.toContain('request.json()');
});
```

For integration-level coverage of the actual bypass, use a raw TCP stream or `node:http` with explicit
chunked encoding instead of `fetch()`.

---

### CR-02: `Number(null)` = `0` enters the fast-fail path for every header-less request

**File:** `index.ts:192-193`
**Issue:** `request.headers.get('content-length')` returns `null` when the header is absent.
`Number(null)` evaluates to `0`. `Number.isFinite(0)` is `true`. The condition
`Number.isFinite(declaredLength) && declaredLength > config.maxRequestBodyBytes`
evaluates as `true && (0 > 1048576)` = `false` for every absent-header POST, so no incorrect 413
fires today.

However:
- The code comment says "fast-fail on **clearly valid** numeric headers" — `null` converted to `0`
  is not a valid declared length and should not be in scope for the fast-fail at all.
- If the comparison direction is accidentally inverted in a future edit (`<` instead of `>`), every
  header-less POST to `/v1/chat/completions` immediately returns 413.
- The intent is to only fast-fail when a cooperative client declares a large value; a missing header
  is the common case for the bypass scenarios this phase fixes, and conflating it with `0` defeats
  the semantic purpose of the guard.

**Fix:** Null-check before calling `Number()`:

```typescript
const contentLengthHeader = request.headers.get('content-length');
if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxRequestBodyBytes) {
        return withRequestId(openaiError(
            `Request body too large. Maximum is ${config.maxRequestBodyBytes} bytes.`,
            'invalid_request_error',
            'request_too_large',
            null,
            413
        ));
    }
}
```

---

### CR-03: `maxRequestBodySize` set to exactly `audioMaxFileBytes` makes `validateAudioFileSize` unreachable for boundary files

**File:** `index.ts:102`, `config.ts:37`
**Issue:** `maxRequestBodySize: config.audioMaxFileBytes` sets the global Bun transport gate to
exactly 25 MiB. A `multipart/form-data` audio upload contains the file bytes plus multipart
boundaries, part headers, and the `model`/`response_format` fields. A file at the declared
25 MiB limit produces a total body strictly larger than 25 MiB. Bun rejects it at the transport
layer before the handler runs, returning a generic non-OpenAI-shaped error with no `X-Request-ID`.

Consequences:
1. `validateAudioFileSize` — the purposely-built, unit-tested AUDIO-03 413 path with its structured
   OpenAI error message — is never reached for files at or near the limit, precisely the boundary
   case it exists to handle.
2. Clients at the boundary receive a Bun transport rejection (no `error.code`, no `X-Request-ID`)
   instead of the documented `413 request_too_large` shape, violating OBS-01 and the error contract.

**Fix:** Add headroom to the transport gate so the application-layer check is authoritative:

```typescript
// index.ts — Bun.serve options
// Audio ceiling + multipart overhead so the handler-layer validateAudioFileSize is the real limit
maxRequestBodySize: config.audioMaxFileBytes + 65_536,
```

Document that `config.audioMaxFileBytes` is the enforced application limit and the transport gate
is only a backstop.

---

## Warnings

### WR-01: Numeric env vars parsed with bare `Number()` — misconfiguration silently disables size limits

**File:** `config.ts:31-38`
**Issue:** All new numeric fields use `Number(process.env[...] ?? default)` with no validation:

- `AUDIO_MAX_FILE_BYTES=25MB` → `NaN` → `maxRequestBodySize: NaN` passed to `Bun.serve()` (Bun
  falls back to its 128 MiB default); `file.size > NaN` is always `false`, so `validateAudioFileSize`
  never rejects any file — fail-open.
- `MAX_REQUEST_BODY_BYTES=1mb` → `NaN` → `Buffer.byteLength(raw) > NaN` is always `false`, so the
  chat 413 gate never fires — fail-open on the security-critical path.
- `WHISPER_PORT=""` (set but empty) → `??` does not guard empty strings; `Number("")` = `0` →
  whisper connects to port 0 instead of the 8080 default.

The threat model (T-04-06) accepted this risk as deployment-controlled, but `NaN` failing open on
size limits is categorically different from "failing loudly in testing" — it fails silently at
runtime with full bypass.

**Fix:** Replace bare `Number()` with a guarded parser for security-relevant size fields:

```typescript
function positiveInt(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Config: ${name}="${raw}" must be a positive number`);
    }
    return n;
}

audioMaxFileBytes: positiveInt('AUDIO_MAX_FILE_BYTES', 26_214_400),
maxRequestBodyBytes: positiveInt('MAX_REQUEST_BODY_BYTES', 1_048_576),
```

---

### WR-02: Duplicate error code on body-read failure and JSON parse failure

**File:** `index.ts:208` and `index.ts:225`
**Issue:** Two different conditions return the same `type`/`code` pair
(`'invalid_request_error'` / `'invalid_request_error'`):
- Line 208: `'Failed to read request body.'` — transport-layer read failure
- Line 225: `'Request body must be valid JSON.'` — JSON parse failure

Every other error code in the codebase is a unique, specific string: `'request_too_large'`,
`'missing_auth'`, `'model_not_found'`, `'no_provider_available'`. Using the type string as the
code for these two paths is inconsistent and makes structured client error handling impossible —
the `message` string is the only differentiator, which is fragile.

**Fix:** Assign distinct codes:

```typescript
// Line 208
openaiError('Failed to read request body.', 'invalid_request_error', 'body_read_error', null, 400)

// Line 225
openaiError('Request body must be valid JSON.', 'invalid_request_error', 'json_parse_error', null, 400)
```

---

### WR-03: `as { keys?: string[] }` cast for `unrecognized_keys` is structurally fragile

**File:** `audio-schema.ts:38-39` (mirrors `request-schema.ts:52-53`)
**Issue:** After checking `'keys' in firstIssue`, the code casts to `{ keys?: string[] }` to extract
the offending key name. The `in` guard is correct but the subsequent cast bypasses TypeScript's type
system. If Zod v4 changes the `unrecognized_keys` issue shape (e.g. renames `keys` or changes its type),
the cast will silently succeed at compile time while returning `param: null` at runtime, degrading
OpenAI-compatible error responses with no compiler warning. This pattern is copied from `request-schema.ts`
so both files share the same fragility.

**Fix:** Narrow on the discriminant code and use the named Zod type:

```typescript
// If ZodUnrecognizedKeysIssue is exported from the installed zod version:
import type { ZodUnrecognizedKeysIssue } from 'zod';
// ...
} else if (firstIssue.code === 'unrecognized_keys') {
    const issue = firstIssue as ZodUnrecognizedKeysIssue;
    param = issue.keys[0] ?? null;
}
```

Apply the same fix to `request-schema.ts:50-53`.

---

## Info

### IN-01: TEST-14 weak dual-status assertion reduces diagnostic signal

**File:** `tests/integration/server.test.ts:392`
**Issue:** `expect([413, 431]).toContain(res.status)` accepts either status. The SUMMARY documents
that Bun currently returns `431` for `Content-Length: abc` at the transport layer. The loose assertion
provides no signal if Bun's behavior changes or if future Bun versions start passing the request to
the application handler (which would return 413). The current accepted-statuses comment is accurate
but the assertion itself cannot distinguish between "transport rejected" and "app rejected."

**Fix:** Assert the specific status that Bun currently returns and document why the other would also
be acceptable:

```typescript
// Bun 1.x returns 431 for malformed Content-Length at transport layer.
// If this becomes 413, the app-layer Buffer.byteLength gate is now seeing the request —
// both are valid rejections; update the assertion to match observed behavior.
expect(res.status).toBe(431);
```

---

### IN-02: Unknown-key `param` assertion missing from allowlist test

**File:** `tests/unit/audio-schema.test.ts:49-53`
**Issue:** The `"unknown field 'language' returns success:false"` test asserts `success: false` but
does not assert `result.param`. The dedicated `unrecognized_keys` extraction branch in
`audio-schema.ts:36-39` is therefore untested — it could return `null` or `undefined` without the
test catching it.

**Fix:** Add the param assertion:

```typescript
expect(result.success).toBe(false);
if (!result.success) {
    expect(result.param).toBe('language');
}
```

---

### IN-03: `maxRequestBodySize` raise ships ahead of its audio route consumer

**File:** `index.ts:102`
**Issue:** The global `maxRequestBodySize` is raised from Bun's default 128 MiB to 25 MiB (tighter
than default, but wider than the previous chat-only context). No `/v1/audio/transcriptions` handler
exists yet. The wider gate is pure added attack surface until Phase 5 adds the audio endpoint.
The plan notes this is intentional staged work, but the raise could be deferred to the same wave
that wires the audio route.

**Fix:** Acceptable as staged work; consider reverting the `maxRequestBodySize` raise to a Phase 5
commit so the gate change is always paired with the consumer that justifies it.

---

_Reviewed: 2026-06-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
