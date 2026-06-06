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
  - package.json
  - request-schema.test.ts
  - request-schema.ts
  - response-normalizer.ts
  - routing/cooldown-manager.ts
  - routing/provider-state.ts
  - services/cerebras.ts
  - services/groq.ts
  - tests/integration/mock-adapters.ts
  - tests/integration/server.test.ts
  - tests/routing/cooldown-manager.test.ts
  - tests/routing/provider-state.test.ts
  - tests/unit/audio-schema.test.ts
  - tests/unit/response-normalizer.test.ts
  - types.ts
findings:
  critical: 3
  warning: 4
  info: 3
  total: 10
status: fixed
---

# Phase 04: Code Review Report

**Reviewed:** 2026-06-06
**Depth:** standard
**Files Reviewed:** 20
**Status:** issues_found

## Summary

Phase 04 adds the audio transcription schema and config foundation (`audio-schema.ts`, new `config.ts`
fields for Whisper sidecar and file-size limits), extends `types.ts` with `AudioTranscriptionResult`,
and hardens the chat body-size gate in `index.ts` with `Buffer.byteLength` enforcement and a
`Number.isFinite` fast-fail. The new audio schema and per-field validators are structurally correct.
The `Buffer.byteLength(raw)` gate is the right mechanism for closing the chunked-encoding bypass.

Three critical defects were found across the full file set:

1. A non-numeric value in `MAX_REQUEST_BODY_BYTES` or `AUDIO_MAX_FILE_BYTES` produces `NaN` via
   bare `Number()`, silently disabling both the 1 MiB chat gate and the 25 MiB audio file-size check
   (both comparisons with `NaN` return `false` and pass through unlimited data).
2. A `429` response from a provider that carries no response headers skips the cooldown entirely —
   the provider immediately re-enters the eligible pool on the next request, violating the
   `DEFAULT_COOLDOWN_SECONDS` fallback rule in `CLAUDE.md §13.3`.
3. Errors that occur mid-stream after the first SSE chunk has been sent are silently swallowed: no
   log entry is emitted and no `data: [DONE]` sentinel is written, leaving SSE-aware clients hanging.

---

## Critical Issues

### CR-01: NaN from invalid numeric env vars silently disables both body-size checks

**File:** `config.ts:37-38`, `index.ts:193,210`

**Issue:** All new size-related env vars are parsed with bare `Number()`:

```ts
// config.ts:37-38
audioMaxFileBytes:   Number(process.env["AUDIO_MAX_FILE_BYTES"]   ?? 26_214_400),
maxRequestBodyBytes: Number(process.env["MAX_REQUEST_BODY_BYTES"] ?? 1_048_576),
```

`Number("25MB")` and `Number("disabled")` both return `NaN`. That `NaN` propagates into both
guards in the chat endpoint:

```ts
// index.ts:193 — fast-fail: Number.isFinite(NaN) → false → skipped (by design, fine here)
if (Number.isFinite(declaredLength) && declaredLength > config.maxRequestBodyBytes)

// index.ts:210 — ACTUAL gate: Buffer.byteLength(raw) > NaN → false → body is never rejected
if (Buffer.byteLength(raw) > config.maxRequestBodyBytes)
```

The actual gate at line 210 fails open when `maxRequestBodyBytes` is `NaN`: `n > NaN` is always
`false` in IEEE 754, so every request body passes regardless of size.

The same applies to `audioMaxFileBytes`:
- `file.size > NaN` in `validateAudioFileSize` → `false` → any file size accepted.
- `maxRequestBodySize: NaN` passed to `Bun.serve()` → Bun falls back to its internal default
  (128 MiB), silently widening the transport gate.

**Fix:** Validate numeric env vars at startup and throw on invalid input so the failure is loud:

```ts
function requiredPositiveInt(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
            `Config: ${name}="${raw}" must be a positive finite number (got ${value})`
        );
    }
    return Math.floor(value);
}

// in config object:
audioMaxFileBytes:   requiredPositiveInt("AUDIO_MAX_FILE_BYTES",   26_214_400),
maxRequestBodyBytes: requiredPositiveInt("MAX_REQUEST_BODY_BYTES", 1_048_576),
```

Apply the same pattern to `defaultCooldownSeconds`, `maxProviderAttemptsPerRequest`,
`whisperPort`, and `whisperTimeoutMs` for defence-in-depth.

---

### CR-02: 429 response with no response headers skips DEFAULT_COOLDOWN_SECONDS — provider stays eligible

**File:** `index.ts:329` (streaming path), `index.ts:536` (non-streaming path)

**Issue:** Both error-handling loops gate the cooldown-setting on `classified.headers` being truthy:

```ts
if ((classified.status === 429 || classified.status === 498) && classified.headers) {
    // parse headers, calc cooldown, setCooldown(provider, ...)
    continue;
}

// Falls through here when status === 429 but headers === undefined:
failoverReason = `status_429`;
log('warn', { event: 'provider_failover', ... });
// NO setCooldown call — provider.healthy remains true, cooldownUntil stays null
```

When a provider SDK throws a `429` without attaching response headers (network interception,
SDK-level error, upstream proxy stripping headers), `classified.headers` is `undefined`, the
inner block is skipped, and `setCooldown` is never called. `recordFailure` only increments
`consecutiveFailures` and does not affect `entry.healthy`. On the very next request, the
429-ing provider is fully eligible and selected again.

`CLAUDE.md §13.3` states explicitly: *"If reset data is unavailable, use DEFAULT_COOLDOWN_SECONDS."*

**Fix:** Separate the cooldown decision from the header-parsing availability check. Apply this fix
to both the streaming path (~line 329) and the non-streaming path (~line 536):

```ts
if (classified.status === 429 || classified.status === 498) {
    const parsed = classified.headers
        ? parseRateLimitHeaders(provider, classified.headers)
        : {};
    const snapshot = classified.headers
        ? toRateLimitSnapshot(parsed as Record<string, number | undefined>)
        : {};
    const cooldownMs = calcCooldownMs(parsed, config.defaultCooldownSeconds);
    const cooldownUntil = Date.now() + cooldownMs;

    setCooldown(provider, cooldownUntil,
        Object.keys(snapshot).length > 0 ? snapshot : undefined);
    failoverReason = `status_${classified.status}`;
    log('warn', {
        event: 'provider_cooldown',
        requestId,
        provider,
        status: classified.status,
        cooldownUntil: new Date(cooldownUntil).toISOString(),
    });
    continue;
}
```

---

### CR-03: Mid-stream error after first SSE chunk is silently swallowed — no log, no [DONE] sentinel

**File:** `index.ts:423-450`

**Issue:** The streaming generator's catch block is guarded by `if (!firstChunkSent)`. When
`firstChunkSent` is `true` and the stream fails mid-way, the catch body does nothing:

```ts
} catch (err) {
    if (!firstChunkSent) {
        // logs here only — firstChunkSent=true skips this entirely
    }
    // When firstChunkSent === true:
    // - no log of any kind
    // - no request_complete event
    // - no yield of 'data: [DONE]\n\n'
    // generator returns normally; stream connection closes
}
```

Consequences:
1. The downstream client receives a truncated SSE stream with no `data: [DONE]` sentinel.
   OpenAI-compatible SDK clients and `EventSource` consumers that wait for `[DONE]` will hang
   or time out rather than closing gracefully.
2. No `request_complete` log is emitted, creating a complete observability blind spot for
   mid-stream failures.
3. `CLAUDE.md §16` item 4 requires the `data: [DONE]` sentinel to always be present.

**Fix:** Log the error and yield `[DONE]` unconditionally, regardless of `firstChunkSent`:

```ts
} catch (err) {
    const classified = classifyError(err);
    log('warn', {
        event: firstChunkSent
            ? 'stream_error_after_first_chunk'
            : 'stream_error_before_first_chunk',
        requestId,
        provider: finalProvider,
        status: classified.status,
    });
    log('info', {
        event: 'request_complete',
        requestId,
        timestamp: new Date(requestStart).toISOString(),
        route: `${request.method} ${pathname}`,
        logicalAlias: input.model,
        provider: finalProvider,
        upstreamModelId: finalUpstreamModelId,
        attempt: finalAttemptCount,
        streaming: true,
        statusCode: classified.status ?? 500,
        latencyMs: Date.now() - requestStart,
        failoverReason: finalFailoverReason,
        usage: streamUsage,
    });
    // Always emit [DONE] — SSE protocol requires the sentinel even on error
    yield 'data: [DONE]\n\n';
}
```

---

## Warnings

### WR-01: `recordSuccess` called before any stream data is consumed — premature success state

**File:** `index.ts:382`

**Issue:** `recordSuccess(chosenProvider, 200)` is called immediately after `adapter.stream()`
resolves. `adapter.stream()` returns an `AsyncIterable` without consuming any bytes — it only
opens the upstream connection. If the first `for await` iteration inside the generator throws,
the provider state already shows `lastSuccessAt = Date.now()`, `lastStatusCode = 200`, and
`consecutiveFailures = 0`. The `catch` block at line 423 then runs with `firstChunkSent = false`
but cannot undo the already-committed success record. The `/internal/providers/status` endpoint
would display the provider as healthy following a stream-open failure.

**Fix:** Move `recordSuccess` into the generator body, called on the first data received:

```ts
const body = (async function* () {
    let firstChunkSent = false;
    try {
        for await (const chunk of sdkStream) {
            const normalized = normalizeChunk(chunk, input.model);
            if (!hasVisibleChunkData(normalized)) continue;
            if (!firstChunkSent) {
                recordSuccess(finalProvider, 200); // first real data — mark success now
                firstChunkSent = true;
            }
            yield `data: ${JSON.stringify(normalized)}\n\n`;
        }
        if (!firstChunkSent) recordSuccess(finalProvider, 200); // complete but empty stream
        yield 'data: [DONE]\n\n';
        // ... log request_complete ...
    } catch (err) {
        recordFailure(finalProvider, classifyError(err).status ?? 0);
        // ... log + yield [DONE] per CR-03 fix ...
    }
})();
```

Remove the `recordSuccess` call at the current line 382.

---

### WR-02: `streamUsage` is a dead variable — always `null` in completion logs

**File:** `index.ts:393,421,447`

**Issue:** `let streamUsage: unknown = null` is declared at line 393 and never assigned any
value other than `null`. Every `request_complete` log for the streaming path emits `usage: null`.
The Cerebras and Groq streaming SDKs do emit a terminal usage chunk (a chunk with
`choices: []` and a populated `usage` field); this information is currently discarded. The
OBS-02 observability requirement for per-request token usage is never satisfied on streaming
requests.

**Fix:** Capture the usage from the terminal chunk, or document the incompleteness with a typed
placeholder:

```ts
// Minimal capture (streams a usage-carrying terminal chunk):
for await (const chunk of sdkStream) {
    const rawChunk = chunk as Record<string, unknown>;
    if (rawChunk['usage'] && Array.isArray(rawChunk['choices']) &&
            (rawChunk['choices'] as unknown[]).length === 0) {
        streamUsage = rawChunk['usage'];
        continue; // terminal usage chunk — not forwarded downstream
    }
    const normalized = normalizeChunk(chunk, input.model);
    // ...
}
```

Alternatively, replace with `const streamUsage: null = null; // TODO: OBS-02 streaming usage`
to make the incompleteness visible in the type system.

---

### WR-03: `PROVIDER_ORDER` env var uses an unsafe cast with no runtime validation

**File:** `config.ts:24`, `routing/provider-state.ts:21`

**Issue:**

```ts
providerOrder: (process.env["PROVIDER_ORDER"] ?? "cerebras,groq").split(",") as Array<"cerebras" | "groq">,
```

The `as` cast is erased at runtime. An invalid value like `PROVIDER_ORDER=cerebras,groq,openai`
places the string `"openai"` into `providerOrder`. In `provider-state.ts:27`,
`const entry = state[provider]` returns `undefined` for `"openai"` — with `noUncheckedIndexedAccess: true`
TypeScript types `entry` as `ProviderState | undefined`, but the code dereferences `entry.configured`
immediately without a guard, throwing a `TypeError` that crashes the request handler.

**Fix:** Validate at config load time:

```ts
providerOrder: (() => {
    const VALID: ReadonlySet<string> = new Set(["cerebras", "groq"]);
    const order = (process.env["PROVIDER_ORDER"] ?? "cerebras,groq")
        .split(",").map(s => s.trim());
    for (const p of order) {
        if (!VALID.has(p)) {
            throw new Error(
                `Config: PROVIDER_ORDER contains invalid provider "${p}". ` +
                `Allowed values: cerebras, groq`
            );
        }
    }
    return order as Array<"cerebras" | "groq">;
})(),
```

---

### WR-04: TEST-03 resets all provider state inside the test — makes the cooldown-expiry assertion untestable

**File:** `tests/integration/server.test.ts:261-269`

**Issue:** The test named "provider recovers after cooldown expiry" calls `resetForTesting()`
inside the test body after advancing the system clock:

```ts
setSystemTime(new Date(before + 61_000));

// Wipes ALL state including the cooldown that was just set
resetForTesting();
resetMockAdapter(mockCerebras);
resetMockAdapter(mockGroq);

const res2 = await post(validBody);
expect(mockCerebras.completeMock.mock.calls.length).toBeGreaterThan(0);
```

After `resetForTesting()`, cerebras is healthy with no cooldown regardless of the clock value.
The assertion `calls.length > 0` passes even if `isEligible` never consulted `Date.now()`.
The test does not prove that cooldown expiry restores provider eligibility — it only proves
that a freshly-initialized provider state allows cerebras to be selected.

**Fix:** Reset mocks only, not routing state. Let the cooldown expire via the clock:

```ts
setSystemTime(new Date(before + 61_000));

// Reset mocks only — routing state (including the active cooldown) is preserved
resetMockAdapter(mockCerebras);
resetMockAdapter(mockGroq);

const res2 = await post(validBody);
expect(res2.status).toBe(200);
// Cerebras should have been selected because the cooldown expired at +60s and
// the cursor is back to 0 (groq handled request 1, cursor advanced to groq=1, wraps to 0)
expect(mockCerebras.completeMock.mock.calls.length).toBeGreaterThan(0);
```

---

## Info

### IN-01: No `test` script in `package.json`

**File:** `package.json`

**Issue:** `package.json` defines `start` and `dev` scripts but no `test` script. Running
`npm test` or `bun run test` fails with "Missing script: test". CI pipelines and contributor
tooling that rely on the conventional `test` entry point cannot discover the test suite.

**Fix:**

```json
"scripts": {
    "start": "bun index.ts",
    "dev": "bun --watch run index.ts",
    "test": "bun test"
}
```

---

### IN-02: Unknown-key `param` extraction untested in `audio-schema.test.ts`

**File:** `tests/unit/audio-schema.test.ts:49-53`

**Issue:** The test `"unknown field 'language' returns success:false"` asserts only
`result.success === false`. The `unrecognized_keys` extraction branch in
`audio-schema.ts:36-39` — which extracts the offending key name from `firstIssue.keys` and
returns it as `param` — is not exercised by any assertion. If that branch regresses to
returning `null`, the test remains green.

**Fix:** Assert the extracted param:

```ts
expect(result.success).toBe(false);
if (!result.success) {
    expect(result.param).toBe('language');
}
```

---

### IN-03: Identical `as { keys?: string[] }` cast duplicated in `audio-schema.ts` and `request-schema.ts`

**File:** `audio-schema.ts:38`, `request-schema.ts:52`

**Issue:** Both files contain an identical pattern:

```ts
const keys = (firstIssue as { keys?: string[] }).keys;
param = (keys && keys[0]) ? keys[0] : null;
```

In Zod v4, `unrecognized_keys` issues carry `issue.keys: string[]` directly on the typed
`ZodUnrecognizedKeysIssue` shape. The cast to `{ keys?: string[] }` (with optional `?`)
is weaker than the real type and the duplication will diverge on the next edit to either
file. Both files should use the same narrowed import or a shared helper.

**Fix:** Extract a shared helper or import the Zod type directly:

```ts
// shared helper in a utils file, or inline in each schema:
function getUnrecognizedKey(issue: z.ZodIssue): string | null {
    if (issue.code !== 'unrecognized_keys') return null;
    // Zod v4: ZodUnrecognizedKeysIssue has keys: string[]
    const keys = (issue as z.core.$ZodIssueUnrecognizedKeys).keys;
    return keys[0] ?? null;
}
```

---

_Reviewed: 2026-06-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
