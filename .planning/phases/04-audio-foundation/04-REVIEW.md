---
phase: 04-audio-foundation
reviewed: 2026-06-06T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - index.ts
  - tests/integration/server.test.ts
findings:
  critical: 2
  warning: 4
  info: 3
  total: 9
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-06-06
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Review focused on the new ReadableStream body-reader in `index.ts` (POST /v1/chat/completions) that replaced `request.text()`, plus the surrounding routing and streaming paths and their integration tests.

The streaming body reader is structurally sound — it counts actual wire bytes, handles cancellation, and decodes correctly. However, two critical issues were found: a logic error that allows a zero-byte empty body to bypass the body gate entirely and reach `JSON.parse("")` producing a misleading error code, and a `verifyToken` length pre-check that leaks the expected key length via a timing side-channel, directly undermining the stated constant-time comparison guarantee. Four warnings cover: a missing `finally` that can leave the ReadableStream locked after a mid-read error, use of `chosenProvider` (outer scope) instead of the closure-safe `finalProvider` when building streaming response headers, cursor advancement before confirming any eligible provider exists, and a lone `as any` cast in the test file. Three info items cover: missing streaming-failover integration test coverage, a non-obvious log-level comparison direction, and a missing guard for the `PROXY_KEY` env var in the test suite.

---

## Critical Issues

### CR-01: Empty body bypasses byte-gate and reaches `JSON.parse("")` with wrong error code

**File:** `index.ts:210-262`

**Issue:** When a client sends a POST with no body (or an empty body), `request.body` is a ReadableStream that yields zero chunks. The `!request.body` guard on line 210 does **not** catch this — a present-but-empty ReadableStream is truthy. The `while(true)` loop exits immediately on the first `done=true` read, `runningTotal` stays 0, `limitExceeded` stays false, and `chunks` is empty. `new TextDecoder().decode(new Uint8Array(0))` returns `""`. Then `JSON.parse("")` at line 259 throws `SyntaxError`, which is caught by the **outer** `catch` at line 252 — returning the `'Failed to read request body.'` message with code `invalid_request_error`, rather than the `'Request body must be valid JSON.'` path that would be reached if the body were non-empty invalid JSON. The functional consequence is a misleading error message; both paths return HTTP 400, but the wrong `code` is emitted and the wrong catch block is exercised.

**Fix:** After the `if (limitExceeded)` block and before building `combined`, add an explicit empty-body check:
```typescript
if (chunks.length === 0) {
    return withRequestId(openaiError(
        'Request body is required.',
        'invalid_request_error',
        'body_required',
        null,
        400
    ));
}
```

---

### CR-02: `verifyToken` length pre-check leaks expected key length via timing side-channel

**File:** `index.ts:50-55`

**Issue:** The `verifyToken` function performs a plain `a.length !== b.length` check before `timingSafeEqual`. When lengths differ, the function returns `false` immediately without calling `timingSafeEqual`. This early-return branch is measurably faster than the constant-time comparison, making the response latency observable: an attacker can submit tokens of varying byte-lengths and measure response time to confirm exactly how long the proxy key is. Once the length is known, brute-force search space is dramatically reduced. The comment on line 49 acknowledges needing to avoid the `timingSafeEqual` throw for different-length inputs, but the chosen solution trades the throw for a timing oracle.

The CLAUDE.md spec §6 requires "use constant-time comparison when practical."

**Fix:** Pad both buffers to a fixed maximum length so `timingSafeEqual` always runs, then also confirm lengths match to prevent false positives from padding:
```typescript
function verifyToken(token: string, expected: string): boolean {
    // Pad both to MAX so timingSafeEqual always executes — no fast-exit on length difference.
    // The final length check is a plain boolean operation, not a timing-observable branch
    // of the crypto comparison path.
    const MAX = 512;
    const a = Buffer.alloc(MAX);
    const b = Buffer.alloc(MAX);
    Buffer.from(token).copy(a);
    Buffer.from(expected).copy(b);
    const constantTimeEq = timingSafeEqual(a, b);
    return constantTimeEq && token.length === expected.length;
}
```
Alternatively, use HMAC to normalize lengths before comparison, which eliminates the length leak entirely:
```typescript
import { createHmac } from 'node:crypto';

function verifyToken(token: string, expected: string): boolean {
    // HMAC normalizes both inputs to fixed digest length — no length information leaks.
    const a = createHmac('sha256', expected).update(token).digest();
    const b = createHmac('sha256', expected).update(expected).digest();
    return timingSafeEqual(a, b);
}
```

---

## Warnings

### WR-01: Inner reader not released on mid-read error — ReadableStream can remain locked

**File:** `index.ts:218-232`

**Issue:** The inner `try/catch` around the `while(true)` reader loop (lines 218-232) catches errors from `reader.read()` and immediately returns an error response — but it does **not** call `reader.releaseLock()` before returning. When the `catch` branch is taken (network error, premature disconnect, etc.), the `ReadableStream` body remains in a locked state. In Bun's HTTP model the connection eventually cleans up, but the stream is not properly signalled as consumed, and any future attempt by the framework to inspect or drain `request.body` will encounter a locked stream.

**Fix:** Add a `finally` block to release the lock when the read loop exits abnormally:
```typescript
try {
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        runningTotal += value.byteLength;
        if (runningTotal > config.maxRequestBodyBytes) {
            limitExceeded = true;
            await reader.cancel();
            break;
        }
        chunks.push(value);
    }
} catch {
    try { reader.releaseLock(); } catch { /* ignore */ }
    return withRequestId(openaiError('Failed to read request body.', 'invalid_request_error', 'invalid_request_error', null, 400));
}
```

---

### WR-02: Streaming headers use `chosenProvider` (outer scope) instead of closure-safe `finalProvider`

**File:** `index.ts:529`

**Issue:** The streaming response headers object at lines 524-530 references `chosenProvider` (declared at line 333, type `Provider | null`) for the optional `X-LLM-Provider` header. All other provider-sensitive references inside the async generator body correctly use `finalProvider` (re-assigned at line 428 after TypeScript narrowing). The header is constructed outside the generator using the outer-scope variable. While functionally equivalent at this point (both hold the same non-null value after the guard at line 400), the pattern is inconsistent and creates a maintenance hazard: if the pre-stream loop is ever refactored, `chosenProvider` could be null or stale while `finalProvider` is the correct captured value.

**Fix:**
```typescript
const streamHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Request-ID': requestId,
    ...(config.exposeProviderHeader ? { 'X-LLM-Provider': finalProvider } : {}),
};
```

---

### WR-03: `advanceCursor()` called unconditionally before confirming any eligible provider exists

**File:** `index.ts:301-303`

**Issue:** `chooseEligibleProviders(input.model)` and `advanceCursor()` are called at lines 301-302 before the `candidates.length === 0` check at line 304. Every request that finds no eligible providers still advances the cursor. Under repeated no-eligible-provider conditions (e.g., both providers in cooldown), the cursor drifts N steps for N requests, causing non-deterministic provider ordering once providers recover. The cursor should only advance when routing actually occurs.

**Fix:** Move `advanceCursor()` to after the empty-candidates guard:
```typescript
const candidates = chooseEligibleProviders(input.model);

if (candidates.length === 0) {
    // cursor NOT advanced — no provider was selected
    log('info', { event: 'request_complete', ..., statusCode: 503 });
    return withRequestId(openaiError(..., 503));
}

advanceCursor(); // Only advance when at least one candidate exists
```

---

### WR-04: `as any` cast in TEST-15 bypasses strict type checking on assertion

**File:** `tests/integration/server.test.ts:421`

**Issue:** Line 421 uses `(await res.json() as any).error?.code` — the only `as any` cast in the test file. All other response-body assertions (TEST-06, TEST-07, TEST-08, TEST-13) correctly type their `.json()` result. The `as any` cast means TypeScript cannot catch a typo in `.error?.code` at compile time, defeating the value of strict typing in the test suite.

**Fix:**
```typescript
const body = await res.json() as { error?: { code?: string } };
expect(body.error?.code).toBe('request_too_large');
```

---

## Info

### IN-01: No integration test for `stream: true` failover path

**File:** `tests/integration/server.test.ts` (missing test)

**Issue:** TEST-10 validates the happy-path SSE format for streaming. Tests TEST-02 through TEST-05 cover failover and exhaustion exclusively for the non-streaming `complete()` path. There is no test that exercises the streaming failover: the loop at `index.ts:339-397` where `adapter.stream()` throws and the proxy attempts the next eligible provider is entirely untested by integration tests. The mid-stream error path at `index.ts:486-519` (generator `catch` block emitting `[DONE]` after a failure) is also untested.

**Fix:** Add a test asserting that when `mockCerebras.streamMock` throws `CerebrasAPIError(500, ...)`, the response is still HTTP 200, `Content-Type: text/event-stream`, contains `data: [DONE]`, and `mockGroq.streamMock.mock.calls.length` is 1.

---

### IN-02: Log level gate direction non-obvious; future `debug` level addition likely to break

**File:** `index.ts:17-25`

**Issue:** The level gate at line 23 uses `entryLevel <= configuredLogLevel`. With `{ error: 0, warn: 1, info: 2 }` this is correct (lower number = higher severity, gate passes for same-or-less severity). However, the comment at line 16 only states the map values, not the comparison semantics. Adding a `debug: 3` level without understanding the `<=` direction would work correctly, but adding any level with a number greater than `info` expecting it to mean "more verbose" could cause confusion. The pattern is fragile because the comparison direction and numeric assignment are both load-bearing and neither is explained.

**Fix:** Add a comment explaining the direction:
```typescript
// Severity levels: lower number = higher severity. Gate: emit when entryLevel <= configuredLogLevel.
// error=0 (critical), warn=1 (warnings+errors), info=2 (all messages).
```

---

### IN-03: `PROXY_KEY` non-null assertion produces `"Bearer undefined"` when `.env.test` is absent

**File:** `tests/integration/server.test.ts:14`

**Issue:** `const PROXY_KEY = process.env['PERSONAL_PROXY_API_KEY']!` uses `!` to assert non-null. If `.env.test` is absent or `PERSONAL_PROXY_API_KEY` is unset, `process.env['PERSONAL_PROXY_API_KEY']` returns `undefined`. TypeScript's `!` operator does not coerce at runtime — `PROXY_KEY` holds `undefined`. The template literal `` `Bearer ${PROXY_KEY}` `` then produces `"Bearer undefined"`, causing every auth-dependent test to fail with 401 instead of the expected status, yielding confusing test output with no indication that missing configuration is the cause.

**Fix:** Add a guard in `beforeAll`:
```typescript
beforeAll(() => {
    if (!PROXY_KEY) {
        throw new Error(
            'PERSONAL_PROXY_API_KEY is not set. Create tests/.env.test with the proxy key before running integration tests.'
        );
    }
    mockCerebras = makeMockAdapter('cerebras');
    mockGroq = makeMockAdapter('groq');
    server = createServer({ cerebras: mockCerebras, groq: mockGroq }, 0);
});
```

---

_Reviewed: 2026-06-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
