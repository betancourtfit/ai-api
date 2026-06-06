---
phase: 04-audio-foundation
reviewed: 2026-06-06T00:00:00Z
depth: standard
files_reviewed: 20
files_reviewed_list:
  - .env.test
  - audio-schema.ts
  - config.ts
  - index.ts
  - model-registry.ts
  - request-schema.ts
  - response-normalizer.ts
  - routing/cooldown-manager.ts
  - routing/provider-state.ts
  - schema-utils.ts
  - services/cerebras.ts
  - services/groq.ts
  - tests/integration/mock-adapters.ts
  - tests/integration/server.test.ts
  - tests/routing/cooldown-manager.test.ts
  - tests/routing/provider-state.test.ts
  - tests/unit/audio-schema.test.ts
  - tests/unit/response-normalizer.test.ts
  - types.ts
  - request-schema.test.ts
findings:
  critical: 3
  warning: 6
  info: 3
  total: 12
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-06-06T00:00:00Z
**Depth:** standard
**Files Reviewed:** 20
**Status:** issues_found

## Summary

This is a Bun-based OpenAI-compatible proxy that routes across Cerebras and Groq inference providers. The overall architecture is sound — the allowlist-rebuild normalizer, streaming SSE relay, and stateful round-robin cooldown logic are well-structured. The test suite has solid coverage of the happy path and most failure modes.

Three blockers were found: a timing-safe comparison that leaks the key's byte length through early-exit on length mismatch, a Cerebras rate-limit reset header that is parsed but silently never used in cooldown calculation, and numeric config fields that accept `NaN` silently. Six warnings and three informational items cover routing edge cases, a missing Groq `temperature=0` conversion, incomplete test assertions, and dead state fields.

---

## Critical Issues

### CR-01: `verifyToken` length pre-check leaks proxy key byte length — timing side-channel

**File:** `index.ts:52-54`
**Issue:** `verifyToken` short-circuits with `return false` when `a.length !== b.length` before reaching `timingSafeEqual`. This means an attacker can determine the exact byte length of `config.personalProxyApiKey` by observing which token lengths cause an early return versus which proceed to the constant-time comparison. For a pure-ASCII key, this leaks the character count. For a key containing multi-byte characters (non-ASCII), this leaks the UTF-8 byte count, which is a finer-grained oracle. Repeated probing with tokens of increasing length will trivially identify the key length, reducing the brute-force search space by an order of magnitude.

The current code:
```typescript
function verifyToken(token: string, expected: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;   // leaks byte length
    return timingSafeEqual(a, b);
}
```

**Fix:** Pad both buffers to the same length so `timingSafeEqual` always runs, then separately check that the original lengths matched:
```typescript
function verifyToken(token: string, expected: string): boolean {
    const enc = new TextEncoder();
    const a = enc.encode(token);
    const b = enc.encode(expected);
    const maxLen = Math.max(a.length, b.length);
    const paddedA = new Uint8Array(maxLen);
    const paddedB = new Uint8Array(maxLen);
    paddedA.set(a);
    paddedB.set(b);
    // timingSafeEqual always runs — no length oracle
    return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}
```

---

### CR-02: Cerebras `resetRequestsDaySeconds` is parsed but silently omitted from `calcCooldownMs` — daily-quota 429s are under-cooled

**File:** `routing/cooldown-manager.ts:50-57`
**Issue:** `ParsedCerebrasHeaders.resetRequestsDaySeconds` is populated from `x-ratelimit-reset-requests-day` (line 31), but `calcCooldownMs` only uses:
```typescript
Math.max(defaultCooldownSeconds, retryAfterSeconds, resetTokensMinuteSeconds, resetTokensSeconds)
```
`resetRequestsDaySeconds` is not in the `Math.max` call. When Cerebras returns a 429 for exhausting its daily request quota, the reset value will be on the order of hours (up to 86 400 seconds). The proxy applies only `DEFAULT_COOLDOWN_SECONDS` (default 60 s), re-attempts after 60 s, receives another 429, and repeats. This violates CLAUDE.md §13.3 ("calculate a cooldown" from the reset headers) and generates continuous upstream 429s until the daily quota resets.

**Fix:**
```typescript
export function calcCooldownMs(
    parsed: Partial<ParsedCerebrasHeaders & ParsedGroqHeaders>,
    defaultCooldownSeconds: number
): number {
    const seconds = Math.max(
        defaultCooldownSeconds,
        parsed.retryAfterSeconds ?? 0,
        parsed.resetTokensMinuteSeconds ?? 0,
        parsed.resetTokensSeconds ?? 0,
        parsed.resetRequestsDaySeconds ?? 0,   // add this
    );
    return Math.round(seconds * 1000);
}
```

---

### CR-03: `config.port` and `config.defaultMaxCompletionTokens` silently accept `NaN`

**File:** `config.ts:25,33`
**Issue:** Both use bare `Number(process.env[...] ?? fallback)`. If `PORT=abc` is set, `Number("abc")` produces `NaN`. `Bun.serve({ port: NaN })` either binds to port 0 or throws an undocumented error at runtime rather than at startup. `defaultMaxCompletionTokens: NaN` causes every injected `max_completion_tokens` value to be `NaN`, which both Cerebras and Groq SDKs will reject with a `400`, producing confusing errors for callers. The codebase already implements `requiredPositiveInt()` — these fields should use it.

**Fix:**
```typescript
// Replace bare Number() calls with the existing validator:
port: requiredPositiveInt("PORT", 3000),
defaultMaxCompletionTokens: requiredPositiveInt("DEFAULT_MAX_COMPLETION_TOKENS", 4096),
```

---

## Warnings

### WR-01: `recordFailure` never sets `healthy = false` — `consecutiveFailures` is dead state

**File:** `routing/provider-state.ts:78-82`
**Issue:** `recordFailure` increments `consecutiveFailures` and updates `lastFailureAt`/`lastStatusCode` but never sets `state[provider].healthy = false`. The `isEligible` check at line 37 gates on `entry.healthy`. For transient failover statuses (408, 500, 502, 503, 504), `recordFailure` is called in the request handler loop but the provider stays `healthy: true`. On the next round-robin turn, the same sick provider is immediately eligible again. `consecutiveFailures` is tracked but checked nowhere — it is dead state. For a sustained upstream outage, the proxy will keep routing to the unhealthy provider on every other request rather than disabling it until it recovers.

**Fix:** Either implement a circuit-breaker threshold that sets `healthy = false` after N consecutive failures, or remove `consecutiveFailures` from `ProviderState` to avoid misleading readers about a health gate that does not exist.

---

### WR-02: `advanceCursor()` is called unconditionally before checking `candidates.length` — cursor advances on zero-candidate requests, and does not advance per failed provider attempt

**File:** `index.ts:301-303`
**Issue:** The cursor advances once at the top of the handler regardless of whether any providers are eligible (lines 301-302). When all providers are on cooldown, the cursor still advances, altering the pick order for the next request. More critically, within the provider-attempt loop the cursor is never re-advanced after a provider fails and is skipped. On recovery, the provider that threw on request N is likely the first candidate on request N+1 because the cursor was only advanced once at request-start, not after the failed attempt. This breaks the "try next eligible provider" guarantee described in CLAUDE.md §12.

**Fix:** Move `advanceCursor()` inside the `catch` block after each failed provider attempt instead of calling it unconditionally at the start of the handler.

---

### WR-03: Groq `temperature = 0` is not converted to `1e-8` — violates documented Groq compatibility requirement

**File:** `services/groq.ts:32,74`
**Issue:** CLAUDE.md §11 documents that "if `n` is supplied, it must equal `1`; `temperature = 0` is converted to `1e-8`." The schema allows `temperature: 0` via `z.number().min(0)`. The Groq adapter forwards `params.temperature ?? undefined` to the Groq SDK without the required conversion. A client sending `temperature: 0` will have `0` forwarded to Groq, which per the documented limitation may behave unexpectedly or be silently clamped.

**Fix:**
```typescript
// In services/groq.ts complete() and stream():
temperature: params.temperature === 0
    ? 1e-8
    : (params.temperature ?? undefined),
```

---

### WR-04: `parseDuration` regex matches the empty string and returns `0` — silent zero-cooldown if header is set to `""`

**File:** `routing/cooldown-manager.ts:127-138`
**Issue:** The regex `^(?:(\d+)m)?(?:([0-9.]+)s)?$` matches the empty string because both capture groups are optional. The `if (!value) return undefined` guard correctly handles `null` and `""` today because `""` is falsy. However, if a future refactor changes the guard to `if (value === null)`, an empty-string header would fall through to the regex, match, and return `0`. `Math.max(defaultCooldownSeconds, ..., 0)` would apply only `defaultCooldownSeconds`, silently under-cooling. The guard should be explicit.

**Fix:**
```typescript
function parseDuration(value: string | null): number | undefined {
    if (value === null || value === '') return undefined;
    // ...rest unchanged
}
```

---

### WR-05: `lastSelectedAt` is initialized but never set — diagnostics endpoint always reports `null`

**File:** `routing/provider-state.ts:13,101,113`
**Issue:** `ProviderState.lastSelectedAt` is always `null`. It is never updated in `chooseEligibleProviders`, `recordSuccess`, or anywhere else. The `GET /internal/providers/status` response includes this field via `getStateSnapshot()`. Operators consulting the diagnostics endpoint will always see `lastSelectedAt: null`, making the field actively misleading.

**Fix:** Set `lastSelectedAt = Date.now()` in `chooseEligibleProviders` when a provider is added to the result list, or remove the field until it is implemented.

---

### WR-06: `classifyError` test for unknown objects omits `message` from `toEqual` — incomplete assertion

**File:** `tests/routing/cooldown-manager.test.ts:157-162`
**Issue:** The assertion:
```typescript
expect(unknownResult).toEqual({
    shouldFailover: true,
    status: undefined,
    headers: undefined,
});
```
does not include `message: undefined`. The actual return from `classifyError` for a non-APIError includes a fourth field `message: undefined` (cooldown-manager.ts line 85). Bun's `toEqual` performs subset matching in some contexts, meaning this test passes today but would not catch a regression where `message` is accidentally set to a non-undefined value for unknown errors (e.g., `String(err)` being substituted).

**Fix:**
```typescript
expect(unknownResult).toEqual({
    shouldFailover: true,
    status: undefined,
    headers: undefined,
    message: undefined,
});
```

---

## Info

### IN-01: `toRateLimitSnapshot` uses an unsafe `as` cast that could silently forward string values as snapshot entries

**File:** `index.ts:73-83` (function definition) and lines 371, 551, 612 (call sites)
**Issue:** Call sites cast parsed header objects to `Record<string, number | undefined>` via `as`. The parsed header interfaces (`ParsedCerebrasHeaders`, `ParsedGroqHeaders`) are correctly typed as `number | undefined` today. The cast silences structural type checking, so if a future header parser returns a string-typed field (e.g., an ISO timestamp), `String(value)` in `toRateLimitSnapshot` will include it verbatim in the snapshot rather than skipping it. No runtime bug today, but the `as` cast removes a compiler safety net.

**Fix:** Accept the union type directly to keep compiler enforcement:
```typescript
import type { ParsedCerebrasHeaders, ParsedGroqHeaders } from './routing/cooldown-manager';

function toRateLimitSnapshot(
    parsed: Partial<ParsedCerebrasHeaders & ParsedGroqHeaders>
): Record<string, string> {
    const snapshot: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'number') {
            snapshot[key] = String(value);
        }
    }
    return snapshot;
}
```

---

### IN-02: `config.ts` inconsistently validates numeric environment variables

**File:** `config.ts:25,33`
**Issue:** Beyond the `NaN` risk (see CR-03), the inconsistency between `requiredPositiveInt()` (used for cooldown, timeout, audio limits) and `Number()` (used for port and default token count) makes the configuration surface harder to audit. A future maintainer adding a new numeric env var may follow the `Number()` pattern and introduce another NaN-silent field.

---

### IN-03: `.env.test` is committed to version control with placeholder proxy key

**File:** `.env.test:1`
**Issue:** The file is committed and contains `PERSONAL_PROXY_API_KEY=test-proxy-key-for-unit-tests`. The value is used literally in test assertions (`server.test.ts:14`). If this repository is ever cloned and the proxy deployed without a `.env` override, the placeholder value would authenticate as a valid proxy key. This is a low-severity risk for a personal project, but the file should be in `.gitignore` with a `.env.test.example` template checked in instead, following the same convention recommended for `.env`.

---

_Reviewed: 2026-06-06T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
