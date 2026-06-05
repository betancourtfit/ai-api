---
phase: 03-full-compliance-tests
reviewed: 2026-06-05T23:20:33Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - index.ts
  - model-registry.ts
  - response-normalizer.ts
  - routing/cooldown-manager.ts
  - services/cerebras.ts
  - services/groq.ts
  - tests/integration/mock-adapters.ts
  - tests/integration/server.test.ts
  - tests/unit/response-normalizer.test.ts
  - types.ts
findings:
  critical: 1
  warning: 8
  info: 10
  total: 19
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-06-05T23:20:33Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed the Phase 3 proxy implementation (server factory, normalizer, cooldown manager, adapters, registry) plus its direct dependencies (`config.ts`, `request-schema.ts`, `routing/provider-state.ts`) for cross-reference verification. The core happy paths (auth, validation, round-robin, normalization, SSE relay) are correct and well-tested. However, the upstream error pass-through path leaks upstream credential state downstream (Critical), the streaming error path silently swallows mid-stream failures with no logging, no failure accounting, and no `[DONE]` distinction, a 429 without headers skips cooldown entirely, and TEST-03 does not actually prove cooldown recovery because `resetForTesting()` wipes the cooldown before the assertion. Two documented eligibility/config behaviors (unhealthy-after-repeated-failures, `REQUEST_TIMEOUT_MS`/`MAX_REQUEST_BODY_BYTES`) are unimplemented.

## Critical Issues

### CR-01: Upstream 401/403 errors relayed verbatim downstream — leaks upstream credential state and corrupts downstream auth semantics

**File:** `index.ts:286-294` and `index.ts:493-501` (classification source: `routing/cooldown-manager.ts:69-79`)
**Issue:** When an upstream provider returns a non-failover error (`classifyError` puts 400, 401, 403, 404, 413, 422 in `noFailoverStatuses`), the proxy returns `classified.message` and `classified.status` directly to the downstream client. Two concrete failures:

1. If `CEREBRAS_API_KEY` or `GROQ_API_KEY` is invalid/revoked, the upstream returns 401 with a message like "Invalid API key". The proxy relays HTTP **401** plus that message to a downstream client that authenticated **correctly** with the proxy key. This violates CLAUDE.md §6 ("do not reveal upstream credential state") and breaks acceptance criterion 12's semantics (401 is reserved for invalid downstream credentials — OpenAI SDKs will tell the user their proxy key is wrong and may stop retrying).
2. Upstream 404 (stale model mapping, a server-side config bug) is relayed as a client-facing 404 `invalid_request_error`, blaming the client for a proxy misconfiguration.

The `rewriteUpstreamModelIds()` de-leaking only masks model IDs; it does not mask credential/permission state, upstream org identifiers, or other internal details in upstream messages.
**Fix:**
```typescript
// in both failover loops, replace the !shouldFailover branch:
if (!classified.shouldFailover) {
    const status = classified.status ?? 502;
    // 401/403/404 from upstream are proxy-side config problems — never relay as-is
    if (status === 401 || status === 403 || status === 404) {
        log('error', { event: 'upstream_config_error', requestId, provider, status });
        return withRequestId(openaiError(
            'Upstream provider configuration error.',
            'server_error',
            'upstream_error',
            null,
            502
        ));
    }
    // 400/413/422 reflect the client's payload — safe to relay message + status
    return withRequestId(openaiError(
        rewriteUpstreamModelIds(classified.message ?? 'Upstream provider rejected the request.'),
        'invalid_request_error',
        'upstream_error',
        null,
        status
    ));
}
```

## Warnings

### WR-01: Mid-stream errors silently swallowed — no log, no `recordFailure`, and success recorded before any data received

**File:** `index.ts:350`, `index.ts:391-418`
**Issue:** Three related defects in the streaming body generator:
1. `recordSuccess(chosenProvider, 200)` at line 350 fires after `adapter.stream()` resolves but **before any chunk is received**. The SDK call resolving does not mean the completion succeeded.
2. The `catch` block at line 391 only acts `if (!firstChunkSent)`. When an error occurs **after** the first chunk, the generator exits with zero side effects: no log entry of any kind (no `request_complete`, no error event), no `recordFailure`, no cooldown evaluation if the mid-stream error was a 429.
3. A provider that consistently fails mid-stream is therefore never penalized — `consecutiveFailures` stays at 0 and it remains first in rotation forever, while observability (spec §19: status code, latency, failover reason must be logged) shows nothing for these requests.

Note: not sending `[DONE]` after partial output is correct per spec §14/§16, but the client-side truncation must at least be visible in logs.
**Fix:** Move `recordSuccess` after the first successful chunk yield (or after stream completion), and add an `else` branch in the catch:
```typescript
} catch (err) {
    const classified = classifyError(err);
    recordFailure(finalProvider, classified.status ?? 0);
    if (firstChunkSent) {
        log('warn', { event: 'stream_error_mid_stream', requestId, provider: finalProvider, status: classified.status });
        log('info', { event: 'request_complete', requestId, /* ... */ statusCode: classified.status ?? 500, /* truncated: true */ });
    } else {
        // existing before-first-chunk handling
    }
}
```

### WR-02: Stream failure before first chunk returns HTTP 200 with an empty body and no failover

**File:** `index.ts:359-419`
**Issue:** Failover only happens while `adapter.stream(...)` is pending (lines 271-323). Once the SDK promise resolves and the 200/`text/event-stream` response is constructed, any error raised before the first chunk produces a 200 response whose body ends with **zero bytes** — no JSON chunk, no `[DONE]`, no SSE `error` event. Spec §14 only forbids failover "after partial output has already reached the downstream client"; before the first chunk is sent, failover is allowed and expected. Clients (e.g., the OpenAI SDK) will see an empty, sentinel-less stream and either hang on parsing or report a malformed response with no diagnostic.
**Fix:** Minimal: emit an OpenAI-style error as an SSE event before closing when `!firstChunkSent`:
```typescript
if (!firstChunkSent) {
    yield `data: ${JSON.stringify({ error: { message: 'Upstream stream failed before any output.', type: 'server_error', code: 'upstream_error', param: null } })}\n\n`;
}
```
Better: pre-read the first chunk from `sdkStream` inside the failover loop (before constructing the Response) so pre-first-chunk failures still fail over to the alternate provider.

### WR-03: 429/498 without headers skips cooldown entirely — provider stays in rotation

**File:** `index.ts:297` and `index.ts:504`
**Issue:** The cooldown branch is gated on `classified.headers` being truthy: `if ((classified.status === 429 || classified.status === 498) && classified.headers)`. `classifyError` types `headers` as `HeaderSource | undefined` (`routing/cooldown-manager.ts:63`), and SDK `APIError` instances can carry `undefined` headers (the tests construct exactly this at `server.test.ts:275`). A 429 with no headers falls through to the generic failover branch: the provider is **not** cooled down and will be retried on the very next request, violating spec §13.3 ("If reset data is unavailable, use DEFAULT_COOLDOWN_SECONDS") and acceptance criteria 5/6.
**Fix:**
```typescript
if (classified.status === 429 || classified.status === 498) {
    const parsed = classified.headers ? parseRateLimitHeaders(provider, classified.headers) : {};
    const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);
    const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
    // ... setCooldown as today
}
```

### WR-04: TEST-03 does not test cooldown recovery — `resetForTesting()` wipes the cooldown before the assertion

**File:** `tests/integration/server.test.ts:239-271`
**Issue:** The test triggers a Cerebras 429 cooldown, advances the fake clock past expiry with `setSystemTime`, then calls `resetForTesting()` at line 262 — which rebuilds the entire provider state (`cooldownUntil: null`, `healthy: true`) — before making the assertion request. The subsequent assertion (`mockCerebras.completeMock.mock.calls.length > 0`) passes regardless of whether the cooldown-expiry logic in `isEligible` works. If the expiry branch in `provider-state.ts:31-35` were broken, this test would still pass green. Acceptance criterion 7 ("a provider returns to rotation after its cooldown expires") is effectively untested.
**Fix:** Remove `resetForTesting()` from the recovery phase. Keep the cooldown state, advance the clock, and instead make two requests (groq serves the first via cursor; the second must hit cerebras now that its cooldown expired), or assert directly that cerebras serves while cursor points at it:
```typescript
setSystemTime(new Date(before + 61_000));
// do NOT resetForTesting() — that destroys the state under test
const resA = await post(validBody); // cursor → groq
const resB = await post(validBody); // cursor wraps → cerebras must be eligible again
expect(mockCerebras.completeMock.mock.calls.length).toBe(2); // initial 429 + recovered call
```

### WR-05: No request timeout — Bun's default 10s idleTimeout will kill slow non-streaming completions; `REQUEST_TIMEOUT_MS` unimplemented

**File:** `index.ts:98-101`, `services/cerebras.ts:28`, `services/groq.ts:28`
**Issue:** `Bun.serve()` is created without `idleTimeout`, so Bun's default (10 seconds of socket inactivity) applies. For a non-streaming completion, no bytes flow on the downstream socket while the proxy awaits the upstream SDK; any upstream latency above ~10s (large `max_completion_tokens` — the injected default is 4096 — plus provider queueing) causes Bun to drop the connection mid-request. `server.timeout(request, 0)` is only applied on the streaming path (line 351). Separately, the spec-mandated `REQUEST_TIMEOUT_MS` (CLAUDE.md §7, default 120000) is not implemented anywhere: `adapter.complete()` is called with no signal/timeout, so a hung upstream blocks the request indefinitely from the proxy's perspective.
**Fix:** Set `idleTimeout` on `Bun.serve` (or call `server.timeout(request, <REQUEST_TIMEOUT_MS/1000>)` on the non-streaming path), add `requestTimeoutMs` to `config.ts`, and pass `AbortSignal.timeout(config.requestTimeoutMs)` into `adapter.complete()`; classify the resulting abort as a 408-style failover.

### WR-06: Model registry shape is never validated — malformed `MODEL_REGISTRY_JSON` crashes the request path or corrupts error rewriting

**File:** `model-registry.ts:8-13`, `model-registry.ts:44-48`
**Issue:** Only JSON *syntax* is validated. Structurally invalid but syntactically valid values pass module load and explode later, on the hot path:
- `MODEL_REGISTRY_JSON=null` → `registry = null` → `isKnownAlias()` throws `TypeError: Cannot use 'in' operator` on every `/v1/chat/completions` request (unhandled → 500 from Bun, not an OpenAI-shaped error).
- `MODEL_REGISTRY_JSON='{"alias":"not-an-object"}'` or array values → `resolveUpstreamModel` returns characters/undefined silently.
- An entry with an empty-string upstream ID makes `rewriteUpstreamModelIds` execute `text.split('').join(alias)` (line 46), interleaving the alias between **every character** of the error message.
- Non-string upstream IDs (e.g., numbers) are forwarded as the upstream `model` parameter.

`config.ts` is loaded from env, so this is operator-controlled input, but spec §26.10 demands "explicit validation over silent fallbacks", and a config typo currently produces a per-request crash instead of a startup failure.
**Fix:** After `JSON.parse`, validate shape and fail fast at startup:
```typescript
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MODEL_REGISTRY_JSON must be an object of alias -> provider map');
}
for (const [alias, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`Registry entry for '${alias}' must be an object`);
    for (const [provider, id] of Object.entries(entry)) {
        if (typeof id !== 'string' || id.length === 0) throw new Error(`Upstream model ID for '${alias}.${provider}' must be a non-empty string`);
    }
}
```

### WR-07: `consecutiveFailures` is tracked but never consulted — "unhealthy after repeated transient failures" eligibility rule is unimplemented

**File:** `routing/provider-state.ts:78-82` (cross-referenced dependency of `index.ts:284,491`)
**Issue:** Spec §12 eligibility rule 5 states a provider is eligible only when "it has not been marked unhealthy by repeated transient failures." `recordFailure` increments `consecutiveFailures`, but nothing ever reads it: `healthy` only becomes `false` via `setCooldown` (429/498 path). A provider returning endless 500s is retried first on every request forever — each request pays a failed upstream attempt before failing over. Verified by grep: `consecutiveFailures` is written at lines 75/81 and initialized, never read.
**Fix:** In `recordFailure`, mark unhealthy with a short cooldown after a threshold:
```typescript
export function recordFailure(provider: Provider, statusCode: number): void {
    const entry = state[provider];
    entry.lastFailureAt = Date.now();
    entry.lastStatusCode = statusCode;
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= 3) {
        entry.healthy = false;
        entry.cooldownUntil = Date.now() + config.defaultCooldownSeconds * 1000;
    }
}
```

### WR-08: `PROVIDER_ORDER` cast without validation — an invalid value crashes every request with a TypeError

**File:** `config.ts:24` / `routing/provider-state.ts:21,26-28` (cross-referenced dependencies of `index.ts`)
**Issue:** `config.providerOrder` is produced by `split(",")` and force-cast `as Array<"cerebras" | "groq">` with no validation and no trimming. `PROVIDER_ORDER="cerebras, groq"` (space after comma) or `PROVIDER_ORDER=foo,bar` yields entries like `" groq"` or `"foo"`. `chooseEligibleProviders` then calls `isEligible(" groq", ...)` → `state[" groq"]` is `undefined` → `entry.configured` throws `TypeError: Cannot read properties of undefined` on every `/v1/chat/completions` and `/ready` request. The bug is a config-time validation gap that surfaces as a runtime crash.
**Fix:** Validate and trim at config load, failing fast:
```typescript
providerOrder: (process.env["PROVIDER_ORDER"] ?? "cerebras,groq")
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is "cerebras" | "groq" => {
        if (p !== "cerebras" && p !== "groq") throw new Error(`Invalid PROVIDER_ORDER entry: '${p}'`);
        return true;
    }),
```

## Info

### IN-01: `streamUsage` is dead — streaming `request_complete` logs always report `usage: null`

**File:** `index.ts:361`
**Issue:** `streamUsage` is declared, never assigned, and logged at lines 389/415. Spec §19 requires token usage in structured logs; for streaming it is always `null`. Either capture usage from a final usage-bearing chunk (requires `stream_options.include_usage` support) or remove the variable and log `usage: null` explicitly with a comment.
**Fix:** Remove the dead variable or wire it to a usage chunk if/when `include_usage` is added.

### IN-02: Streaming successes never capture rate-limit headers

**File:** `types.ts:54`, `services/cerebras.ts:69-92`, `services/groq.ts:63-78`
**Issue:** `ProviderAdapter.stream()` returns only `AsyncIterable<StreamChunk>` — response headers are discarded, so `setRateLimitSnapshot` is never called on the streaming path (spec §13: "observe rate-limit headers"). Quota visibility in `/internal/providers/status` goes stale when traffic is predominantly streaming.
**Fix:** Have `stream()` return `{ stream, headers }` (using the SDKs' `.withResponse()`) and call `setRateLimitSnapshot` in the streaming success path.

### IN-03: ~45-line failover/cooldown block duplicated between streaming and non-streaming paths

**File:** `index.ts:282-322` and `index.ts:489-529`
**Issue:** The catch-classify-cooldown-failover logic is copy-pasted. WR-03's fix must be applied twice; the two copies will inevitably drift.
**Fix:** Extract a shared `handleProviderError(provider, err, requestId): { action: 'failover' | 'return'; response?: Response }` helper.

### IN-04: Adapters overwrite `choice.index` with array position

**File:** `services/cerebras.ts:54-55`, `services/groq.ts:48-49`
**Issue:** `choices.map((c, i) => ({ index: i, ... }))` discards the upstream `c.index`. Harmless while `n` is locked to 1, but silently wrong if multi-choice is ever enabled.
**Fix:** Use `index: c.index` in both adapters.

### IN-05: `calcCooldownMs` ignores request-quota reset headers — daily-limit 429s are retried every 60s all day

**File:** `routing/cooldown-manager.ts:50-55`
**Issue:** Only `retryAfterSeconds`, `resetTokensMinuteSeconds`, and `resetTokensSeconds` feed the max. `resetRequestsDaySeconds` (Cerebras) and `resetRequestsSeconds` (Groq) are parsed but unused. When a daily request quota is exhausted, the cooldown is 60s, so the exhausted provider burns one futile attempt per minute until midnight. Spec §13.3 step 1 says to inspect provider-specific reset headers.
**Fix:** This needs care (resetRequestsDay can be hours — taking a blind max would over-cool a provider whose minute quota merely blipped). Use the reset header corresponding to the exhausted dimension (remaining == 0) when determinable; otherwise keep current behavior.

### IN-06: `parseDuration` does not handle `h` or `ms` units in Groq reset headers

**File:** `routing/cooldown-manager.ts:127-138`
**Issue:** Groq duration strings can include hours (e.g., `1h2m3s` for daily token limits) and milliseconds (e.g., `120ms`). The regex `^(?:(\d+)m)?(?:([0-9.]+)s)?$` returns `undefined` for both, silently falling back to the default cooldown. Degradation is safe but undercuts header-driven cooldowns.
**Fix:** Extend the regex: `^(?:(\d+)h)?(?:(\d+)m)?(?:([0-9.]+)s)?(?:(\d+)ms)?$` and sum components.

### IN-07: Bearer scheme comparison is case-sensitive

**File:** `index.ts:45`
**Issue:** RFC 7235 makes the auth scheme case-insensitive (`bearer x` is valid). `header?.startsWith('Bearer ')` rejects lowercase schemes with 401. Most SDKs send `Bearer`, so impact is low.
**Fix:** `if (!/^Bearer\s/i.test(header ?? '')) return null; return header.slice(7).trim();`

### IN-08: `verifyToken` length pre-check leaks key length via timing

**File:** `index.ts:50-55`
**Issue:** Returning early on length mismatch leaks the proxy key's length to a timing attacker. Spec only requires constant-time "when practical," so this is acceptable, but hashing both sides first removes the leak cheaply.
**Fix:** Compare `createHash('sha256')` digests of both values with `timingSafeEqual` (always equal length).

### IN-09: Test suite uses non-null assertion on `PERSONAL_PROXY_API_KEY`

**File:** `tests/integration/server.test.ts:14`
**Issue:** If `.env.test` is missing, `PROXY_KEY` is `undefined` and every request sends `Bearer undefined`, producing a wall of confusing 401 failures instead of a clear setup error.
**Fix:** `if (!process.env['PERSONAL_PROXY_API_KEY']) throw new Error('PERSONAL_PROXY_API_KEY missing — create .env.test');`

### IN-10: `MAX_REQUEST_BODY_BYTES` (spec §7) is not implemented

**File:** `index.ts:98-101` (cross-ref `config.ts`)
**Issue:** No `maxRequestBodySize` is set on `Bun.serve`, so Bun's default (~128 MB) applies and the spec's 1 MiB default is ignored. `request.json()` will parse arbitrarily large bodies. Low risk for a personal proxy, but it is a spec-listed env var.
**Fix:** Add `maxRequestBodySize: config.maxRequestBodyBytes` to the `Bun.serve` options and the corresponding config entry.

---

_Reviewed: 2026-06-05T23:20:33Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
