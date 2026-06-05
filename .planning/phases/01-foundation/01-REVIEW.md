---
phase: 01-foundation
reviewed: 2026-06-05T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - .env.test
  - config.ts
  - index.ts
  - model-registry.ts
  - package.json
  - request-schema.test.ts
  - request-schema.ts
  - services/cerebras.ts
  - services/groq.ts
  - types.ts
findings:
  critical: 1
  warning: 4
  info: 5
  total: 10
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-06-05
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed the Phase 1 walking skeleton: env config, Bun.serve router with Bearer auth, Zod strict-allowlist validation, model alias registry, and two non-streaming provider adapters. Verification performed: `bunx tsc --noEmit` passes clean; `bun test` passes 16/16; prototype-chain and non-object-registry behaviors were reproduced empirically with `bun -e`.

The validation layer (request-schema.ts) is solid — strict allowlist, correct first-error extraction including the `unrecognized_keys` path, and tests cover the reject-list. The adapters correctly build responses field-by-field (no spread), stripping Cerebras `time_info`/`reasoning` and Groq telemetry per spec §15.

The critical gap: **the upstream call path has zero error handling.** Any provider failure (429, 5xx, network error, SDK timeout) escapes `adapter.complete()` as an uncaught exception inside `fetch()`. There is no `error` handler on `Bun.serve()`, and Bun defaults to development mode when `NODE_ENV !== "production"`, where the default error response includes error details/stack traces. This violates D-05 ("OpenAI-style error shape used for ALL error paths"), spec §14 (upstream status mapping), and risks leaking internal details downstream. Secondary issues: the model registry trusts `JSON.parse` output without shape validation and uses prototype-chain-sensitive lookups, and config values are cast/parsed without validation.

No hardcoded secrets found. `.env.test` contains clearly-fake test fixtures only. Auth uses `timingSafeEqual` with a documented length pre-check (acceptable per spec "constant-time when practical").

## Critical Issues

### CR-01: Upstream provider errors are completely unhandled — non-OpenAI 500s and potential stack-trace leak

**File:** `index.ts:141` (also `index.ts:47` — missing `error` handler on `Bun.serve()`)
**Issue:** `completionResult = await adapter.complete(upstreamModelId, params)` has no try/catch. Both SDKs are configured with `maxRetries: 0` (services/cerebras.ts:9, services/groq.ts:9), so every upstream 429, 5xx, 4xx, network failure, or timeout throws an `APIError` that propagates uncaught out of `fetch()`. Consequences:

1. The downstream client receives Bun's default error response — **not** the OpenAI-style error JSON that `openaiError()` was built for ("used for ALL error paths" per the comment at index.ts:18 is false).
2. `Bun.serve()` has no `error` handler and `development` defaults to `true` when `NODE_ENV !== "production"` — Bun's development error response includes the error message and stack, which for SDK errors can contain upstream request URLs and internal details. This is an information-disclosure risk in any deployment that forgets to set `NODE_ENV=production`.
3. The provider loop aborts on the first throw: a Cerebras 429 fails the whole request even though Groq is mapped and eligible. Full failover/cooldown is Phase 2, but per CLAUDE.md §3 a request must not fail "merely because the provider selected first is temporarily unavailable" — at minimum the throw must be caught and mapped today.
4. Spec §14's status mapping table (429→failover, 400→pass through, etc.) is entirely unimplemented; a malformed-for-upstream request (e.g. `stop` array of 5 entries) surfaces as a leaky 500 instead of a mapped 400.

**Fix:**
```ts
// index.ts — wrap the upstream call and map errors to OpenAI shape
let lastError: unknown = null;
for (const provider of config.providerOrder) {
    const upstreamModelId = resolveUpstreamModel(input.model, provider);
    if (!upstreamModelId) continue;
    const adapter = adapterMap[provider];
    if (!adapter) continue;
    try {
        completionResult = await adapter.complete(upstreamModelId, params);
        chosenAlias = input.model;
        break;
    } catch (err) {
        lastError = err;
        // Phase 1 minimal: log status (no secrets) and try next provider for
        // transient codes (408/429/5xx); return mapped error for 4xx.
        const status = (err as { status?: number }).status;
        if (status !== undefined && status < 500 && status !== 408 && status !== 429) {
            return openaiError('Upstream rejected the request.', 'invalid_request_error', String(status), null, status === 400 ? 400 : 502);
        }
        continue;
    }
}
```
Also add a defensive top-level handler so nothing ever escapes as a raw 500:
```ts
const server = Bun.serve({
    // ...
    error(err) {
        console.error('unhandled', err instanceof Error ? err.message : err);
        return openaiError('Internal server error.', 'server_error', 'internal_error', null, 500);
    },
});
```

## Warnings

### WR-01: Model registry trusts unvalidated JSON shape and uses prototype-chain-sensitive lookups

**File:** `model-registry.ts:10,17,22`
**Issue:** Two verified defects:

1. **No shape validation.** `JSON.parse` succeeds for `MODEL_REGISTRY_JSON=null`, `"hello"`, `123`, or `[]`. The module loads fine, then every `isKnownAlias()` call throws `TypeError: ... is not an Object` (verified) — a startup misconfiguration that crashes **per-request** instead of failing fast at boot, and the crash flows into the unhandled path from CR-01.
2. **Prototype chain leaks through `in` and index access.** Verified: `"constructor" in registry === true`, same for `"toString"` and `"__proto__"`. A request with `model: "constructor"` passes `isKnownAlias()`, then both providers resolve `undefined`, producing a 503 `server_error/no_provider_available` instead of the correct 400 `model_not_found` (acceptance criterion 13). Additionally `resolveUpstreamModel(validAlias, "constructor")` returns the `Object` constructor function (verified `typeof === "function"`) while typed `string | undefined` — unreachable through `index.ts` today only because `providerOrder` is constrained, which is itself unvalidated (WR-02).

**Fix:**
```ts
const parsed: unknown = JSON.parse(config.modelRegistryJson);
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MODEL_REGISTRY_JSON must be a JSON object');
}
// Re-key onto a null-prototype object; validate entry values are string records
registry = Object.create(null);
for (const [alias, entry] of Object.entries(parsed)) { /* validate + assign */ }

export function isKnownAlias(alias: string): boolean {
    return Object.hasOwn(registry, alias);
}
export function resolveUpstreamModel(alias: string, provider: string): string | undefined {
    if (!Object.hasOwn(registry, alias)) return undefined;
    const entry = registry[alias];
    return Object.hasOwn(entry, provider) ? entry[provider] : undefined;
}
```

### WR-02: config.ts performs unvalidated casts and silent NaN/zero coercion

**File:** `config.ts:12,20,21`
**Issue:**
- Line 21: `split(",") as Array<"cerebras" | "groq">` is a lie to the type system. `PROVIDER_ORDER="cerebras, groq"` (space after comma — a very plausible env edit) yields `" groq"`, which fails both `resolveUpstreamModel` and `adapterMap` lookup in index.ts:137-140 — Groq is **silently dropped** from rotation with no log or startup error. `PROVIDER_ORDER=typo` silently leaves zero providers (every request → 503).
- Line 12: `Number(process.env["PORT"] ?? 3000)` — `PORT=""` bypasses `??` (empty string is not nullish), `Number("") === 0`, and port 0 makes Bun bind a random ephemeral port. `PORT=abc` → `NaN` → throw at serve time with an unhelpful message.
- Line 20: `DEFAULT_MAX_COMPLETION_TOKENS=abc` → `NaN` silently stored, then injected into every request as `max_completion_tokens: NaN` and serialized as `null` by `JSON.stringify` inside the SDK — upstream rejection, surfacing via the CR-01 crash path.

**Fix:** Validate at load time, fail fast:
```ts
function requiredInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got '${raw}'`);
    return n;
}
const VALID_PROVIDERS = ['cerebras', 'groq'] as const;
providerOrder: (process.env["PROVIDER_ORDER"] ?? "cerebras,groq")
    .split(",").map(s => s.trim()).filter(Boolean)
    .map(p => {
        if (!VALID_PROVIDERS.includes(p as any)) throw new Error(`Unknown provider '${p}' in PROVIDER_ORDER`);
        return p as "cerebras" | "groq";
    }),
```

### WR-03: No request body size limit and no configurable upstream timeout

**File:** `index.ts:47` (Bun.serve options), `config.ts` (missing env vars)
**Issue:** Spec §7 requires `MAX_REQUEST_BODY_BYTES=1048576` and `REQUEST_TIMEOUT_MS=120000`. Neither is implemented. `Bun.serve()`'s default `maxRequestBodySize` is 128 MB — a single authenticated client can POST a 100 MB body that is fully buffered by `request.json()` (index.ts:91) and then handed to Zod. Upstream timeout relies on undocumented SDK defaults rather than configured policy.
**Fix:**
```ts
const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: config.maxRequestBodyBytes, // default 1_048_576
    // ...
});
// and pass timeout to SDK constructors:
new Groq({ apiKey: config.groqApiKey, maxRetries: 0, timeout: config.requestTimeoutMs });
```
Note: Bun returns a non-OpenAI-shaped error when `maxRequestBodySize` is exceeded — pair this with the `error` handler from CR-01 to keep the contract.

### WR-04: `GET /ready` endpoint missing despite being step 3 of the implementation sequence

**File:** `index.ts` (absent route)
**Issue:** CLAUDE.md §4 lists `/ready` as a required public endpoint and §23 places it at step 3 — *before* the chat-completions endpoint (step 9) that was implemented. §20 defines its contract (config valid, at least one provider key, at least one alias with an eligible mapping, degraded-mode support). Phase 1 ships steps 1-2 and 4-10 but skipped 3. If this was a deliberate plan deferral it should be documented; otherwise it is a scope gap that deployment targets (EasyPanel readiness probes) will hit immediately.
**Fix:** Add a minimal `/ready` (auth-exempt or auth-gated per plan) that checks `config` loaded, registry non-empty, and at least one alias resolves for at least one provider in `providerOrder`; return `{ ready: true, mode, eligibleProviders, unavailableProviders }`.

## Info

### IN-01: Adapters rewrite `choices[].index` from map position instead of upstream value

**File:** `services/cerebras.ts:43`, `services/groq.ts:35`
**Issue:** `choices.map((c, i) => ({ index: i, ... }))` discards the upstream `c.index`. Harmless while `n` is locked to 1, but it will silently mis-index choices if `n > 1` is ever enabled, and it diverges from "preserve standard fields" (spec §15).
**Fix:** Use `index: c.index ?? i`.

### IN-02: No `test` script in package.json

**File:** `package.json:6-9`
**Issue:** Tests exist and pass but `npm/bun run test` is undefined; CI or contributors must know to invoke `bun test` directly. Also note (repo hygiene, outside reviewed files): git status shows an untracked `package-lock.json` and `node_modules/.bin` contains a stale `cerebras` CLI binary from a removed dependency — `npm install` was run at some point in this Bun-only project. Reinstall with `bun install` and delete the npm lockfile.
**Fix:** Add `"test": "bun test"` to scripts.

### IN-03: Error `code` duplicates `type` for malformed-JSON responses

**File:** `index.ts:93`
**Issue:** `openaiError('Request body must be valid JSON.', 'invalid_request_error', 'invalid_request_error', ...)` sets `code` identical to `type`. OpenAI uses `code: null` or a distinct machine code here. Cosmetic, but client SDKs that branch on `error.code` get a redundant value.
**Fix:** Pass `null` (requires widening the `code` param type) or a distinct code like `'invalid_json'`.

### IN-04: Zero per-request observability — no request ID, no structured logs

**File:** `index.ts` (whole request path)
**Issue:** Spec §19 requires `X-Request-ID` response header and structured logs (provider chosen, status, latency, no secrets). Nothing is logged per request and no request ID is returned. If deferred to a later phase, fine — but currently an upstream failure (CR-01) leaves no server-side trace at all, which makes the unhandled-error problem harder to diagnose in production.
**Fix:** Minimum viable: `const requestId = crypto.randomUUID()` at top of fetch, attach `X-Request-ID` to every response, one structured `console.log` line per completed request.

### IN-05: `stop` array length unbounded in schema

**File:** `request-schema.ts:20`
**Issue:** Both OpenAI and the upstream providers cap `stop` at 4 sequences. `z.array(z.string())` accepts any length (including `[]`), so a 5-element `stop` passes validation and is rejected upstream — currently surfacing through the CR-01 crash path instead of a clean 400 with `param: "stop"`.
**Fix:** `stop: z.union([z.string(), z.array(z.string()).min(1).max(4)]).optional()`.

---

_Reviewed: 2026-06-05_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
