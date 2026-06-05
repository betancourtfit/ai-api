# Phase 2: Routing + Streaming — Research

**Researched:** 2026-06-05
**Domain:** Stateful provider routing, rate-limit header parsing, SSE relay in Bun.serve()
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ROUTE-01 | In-memory `ProviderState` per provider | §Architecture Patterns — ProviderState shape |
| ROUTE-02 | Provider eligibility check | §Architecture Patterns — eligibility predicate |
| ROUTE-03 | Stateful round-robin with cursor | §Architecture Patterns — cursor pattern |
| ROUTE-04 | Fail over to next eligible provider | §Don't Hand-Roll — error classify pattern |
| ROUTE-05 | Failover for 408,429,498,500,502,503,504 | §Common Pitfalls — 498 APIError mapping |
| ROUTE-06 | No failover for 400,401,403,404,413,422 | §Failover Policy |
| ROUTE-07 | 503 with OpenAI error body when no provider | §Code Examples |
| ROUTE-08 | `resetForTesting()` export for test isolation | §Architecture Patterns — module design |
| RL-01 | Cerebras rate-limit header parse | §Rate-Limit Header Parsing |
| RL-02 | Groq rate-limit header parse | §Rate-Limit Header Parsing |
| RL-03 | Separate parsers for each provider | §Rate-Limit Header Parsing |
| RL-04 | Cooldown = max(retryAfter, resetTokensSeconds, DEFAULT_COOLDOWN) | §Cooldown Calculation |
| RL-05 | Automatic recovery when Date.now() >= cooldownUntil | §Architecture Patterns |
| RL-06 | Groq 498 treated same as 429 | §Common Pitfalls |
| RL-07 | Cooldown events logged | §Observability |
| STREAM-01 | `stream:true` returns `Content-Type: text/event-stream` | §SSE Relay in Bun |
| STREAM-02 | SSE relay as async generator, no buffering | §SSE Relay in Bun |
| STREAM-03 | `server.timeout(request, 0)` before returning streaming Response | §SSE Relay in Bun |
| STREAM-04 | `firstChunkSent` flag; no failover after first chunk | §Streaming Pitfalls |
| STREAM-05 | Upstream abort on downstream disconnect | §SSE Relay in Bun |
| STREAM-06 | `data: [DONE]\n\n` preserved | §SSE Relay in Bun |
| STREAM-07 | Inline chunk normalization before yield | §SSE Relay in Bun |
| EP-01 | `POST /v1/chat/completions` non-streaming | Satisfied by Phase 1; Phase 2 wires router |
| EP-02 | `POST /v1/chat/completions` streaming | §SSE Relay in Bun |
| EP-03 | `GET /v1/models` logical aliases | Satisfied by Phase 1 |
| EP-05 | `GET /ready` with degraded mode | §Ready + Status Endpoints |
| EP-06 | `GET /internal/providers/status` auth-gated | §Ready + Status Endpoints |
</phase_requirements>

---

## Summary

Phase 2 replaces the Phase 1 "first-eligible" provider selector with a stateful round-robin router that tracks per-provider availability, applies cooldowns on 429/498/5xx, and fails over to the alternate provider before surfacing an error. The three major deliverables are: (1) the provider-state module with eligibility checks and cursor management, (2) rate-limit header parsers that feed cooldown calculations, and (3) the SSE relay that streams chunks from SDK async iterables to Bun's Response body without buffering.

All SDK and runtime APIs needed for Phase 2 are confirmed from source code. The groq-sdk and cerebras_cloud_sdk both expose `APIError` subclasses with `.status` and `.headers` properties available in `catch` blocks — no need to parse HTTP directly. Streaming uses the same `create()` call with `stream: true`, which returns `APIPromise<Stream<Chunk>>` — an async iterable — that is consumed directly in an async generator passed to `new Response()`. Bun's `server.timeout(request, 0)` disables the idle timeout for the request before returning the streaming Response.

The `request-schema.ts` `stream` field must be widened from `z.literal(false)` to `z.boolean()` in Phase 2 to allow `stream: true`. The Phase 1 comment explicitly anticipated this change. Config must grow four new env vars: `DEFAULT_COOLDOWN_SECONDS`, `MAX_PROVIDER_ATTEMPTS_PER_REQUEST`, `EXPOSE_PROVIDER_HEADER`, `ENABLE_INTERNAL_STATUS_ENDPOINT`.

**Primary recommendation:** Implement as three parallel modules — `routing/provider-state.ts` (state + cursor), `routing/cooldown-manager.ts` (header parsers + cooldown calc), and extend `services/cerebras.ts` / `services/groq.ts` with a `stream()` method. Wire them in `index.ts`, replacing the Phase 1 `for` loop with the router. Keep `ProviderAdapter` extended, not replaced.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Provider selection + cursor | routing/provider-state.ts | index.ts (caller) | State lives in a single module; index.ts only calls chooseProviders() |
| Eligibility check | routing/provider-state.ts | — | Encapsulated with state; no business logic should escape |
| Cooldown tracking | routing/provider-state.ts | — | cooldownUntil is state; reading Date.now() happens in eligibility predicate |
| Rate-limit header parse | routing/cooldown-manager.ts | provider adapters (headers source) | Parsers are provider-specific; live next to cooldown logic |
| Cooldown calculation | routing/cooldown-manager.ts | — | Pure math function; easily unit-tested |
| SSE relay | index.ts (route handler) | services/*.ts (SDK call) | Response construction is route handler responsibility |
| Upstream abort on disconnect | index.ts | — | AbortController paired with Request.signal; both in route handler scope |
| Non-streaming adapter call | services/cerebras.ts, services/groq.ts | — | Phase 1 pattern retained; `.complete()` unchanged |
| Streaming adapter call | services/cerebras.ts, services/groq.ts | — | New `.stream()` method added to each adapter |
| Config env vars | config.ts | — | All env reads centralized per INFRA-05 |
| /ready endpoint | index.ts | routing/provider-state.ts | /ready reads provider state; returns degraded/ok |
| /internal/providers/status | index.ts | routing/provider-state.ts | Protected diagnostic; reads state snapshot |

---

## Standard Stack

### Core (already installed — no new packages)

| Library | Version (installed) | Purpose | Phase 2 Usage |
|---------|--------------------|---------|-|
| `groq-sdk` | 1.2.1 | Groq upstream calls | `stream:true` overload → `Stream<ChatCompletionChunk>` async iterable |
| `@cerebras/cerebras_cloud_sdk` | 1.64.1 | Cerebras upstream calls | `stream:true` overload → `Stream<ChatCompletion>` async iterable |
| `zod` | 4.4.3 | Request validation | Widen `stream` field from `z.literal(false)` to `z.boolean()` |

No new npm packages are required for Phase 2. All routing, cooldown, and SSE logic is implemented in TypeScript using built-in Bun APIs and the already-installed SDKs. [VERIFIED: local node_modules]

### Phase 2 Config Additions (new env vars not yet in config.ts)

| Env Var | Default | Type | Purpose |
|---------|---------|------|---------|
| `DEFAULT_COOLDOWN_SECONDS` | `60` | number | Fallback cooldown when no reset header available |
| `MAX_PROVIDER_ATTEMPTS_PER_REQUEST` | `2` | number | Maximum provider tries per request |
| `EXPOSE_PROVIDER_HEADER` | `false` | boolean | Emit `X-LLM-Provider` header in response |
| `ENABLE_INTERNAL_STATUS_ENDPOINT` | `true` | boolean | Expose `/internal/providers/status` |

[VERIFIED: config.ts grep — all four are absent from current config; CLAUDE.md §7 specifies them]

---

## Package Legitimacy Audit

No new packages are installed in Phase 2. This section is not applicable.

---

## Architecture Patterns

### System Architecture Diagram

```
Downstream Client
        |
        | POST /v1/chat/completions (Bearer token)
        v
index.ts (Bun.serve fetch handler)
    |-- auth gate (unchanged from Phase 1)
    |-- Zod validation (stream widened to z.boolean())
    |-- alias resolution (unchanged)
    |
    v
chooseEligibleProviders(logicalModel, providerState)   [routing/provider-state.ts]
    |
    | returns ordered Provider[] filtered by eligibility
    v
for each provider attempt (max MAX_PROVIDER_ATTEMPTS_PER_REQUEST):
    |
    |-- resolve upstreamModelId from registry
    |-- call adapter.complete() or adapter.stream()
    |       |
    |       | SDK APIError thrown
    |       v
    |   classifyError(err)
    |       |-- status 408,429,498,500,502,503,504 → failover=true
    |       |-- status 400,401,403,404,413,422     → failover=false (return error immediately)
    |       |-- no status (network err)             → failover=true
    |       v
    |   failover=true → parseRateLimitHeaders(err.headers, provider) → setCooldown(provider, cooldown)
    |                   → continue to next provider
    |   failover=false → return openaiError() to client immediately
    |
    | all providers exhausted
    v
return 503 OpenAI error body

STREAMING PATH (stream:true):
    | server.timeout(request, 0)   ← disables Bun idle timeout for this request
    | build AbortController tied to request.signal
    v
new Response(async function* () {
    firstChunkSent = false
    try {
        for await (const chunk of sdkStream) {
            firstChunkSent = true
            yield sseChunk(normalizeChunk(chunk, logicalAlias))
        }
        yield "data: [DONE]\n\n"
    } catch (err) {
        if (!firstChunkSent) → surface error as 5xx (by NOT yielding [DONE], closing stream)
        // after first chunk: preserve stream integrity, cannot switch providers
    }
}, { headers: { "Content-Type": "text/event-stream" } })
```

### Recommended Project Structure

```
routing/
  provider-state.ts    # ProviderState shape, eligibility, cursor, resetForTesting()
  cooldown-manager.ts  # parseGroqHeaders(), parseCerebrasHeaders(), calcCooldown()
services/
  cerebras.ts          # add stream() method alongside existing complete()
  groq.ts              # add stream() method alongside existing complete()
config.ts              # add 4 new env vars
request-schema.ts      # widen stream: z.literal(false) → z.boolean()
types.ts               # add StreamChunk type; extend ProviderAdapter with stream()
index.ts               # replace Phase 1 for-loop with router; add streaming branch;
                       # add /ready and /internal/providers/status routes
tests/
  provider-state.test.ts   # unit: round-robin, eligibility, cooldown, recovery
  cooldown-manager.test.ts # unit: header parse (Groq duration string, Cerebras float)
  routing.test.ts          # integration: alternating, 429 failover, exhaustion
```

### Pattern 1: ProviderState Module

**What:** Module-level state object (one entry per provider). Never exposed directly — only through getter functions and `resetForTesting()`.

**When to use:** Any code that needs to read or mutate provider availability.

```typescript
// Source: CLAUDE.md §12 + local SDK analysis
// routing/provider-state.ts

export type Provider = 'cerebras' | 'groq';

export interface ProviderState {
    provider: Provider;
    enabled: boolean;
    configured: boolean;
    healthy: boolean;
    cooldownUntil: number | null;      // epoch ms
    lastSelectedAt: number | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    lastStatusCode: number | null;
    consecutiveFailures: number;
    rateLimitSnapshot?: Record<string, string>;
}

// Module-level state — reset via resetForTesting() in tests
const state: Record<Provider, ProviderState> = {
    cerebras: { provider: 'cerebras', enabled: true, configured: true,
                healthy: true, cooldownUntil: null, lastSelectedAt: null,
                lastSuccessAt: null, lastFailureAt: null, lastStatusCode: null,
                consecutiveFailures: 0 },
    groq:     { provider: 'groq',     enabled: true, configured: true,
                healthy: true, cooldownUntil: null, lastSelectedAt: null,
                lastSuccessAt: null, lastFailureAt: null, lastStatusCode: null,
                consecutiveFailures: 0 },
};

let roundRobinCursor = 0;   // index into config.providerOrder

export function isEligible(provider: Provider, logicalModel: string): boolean {
    const s = state[provider];
    if (!s.configured || !s.enabled || !s.healthy) return false;
    if (s.cooldownUntil !== null && Date.now() < s.cooldownUntil) return false;
    if (!resolveUpstreamModel(logicalModel, provider)) return false;
    return true;
}

export function chooseEligibleProviders(logicalModel: string): Provider[] {
    const order = config.providerOrder; // e.g. ['cerebras', 'groq']
    // Rotate starting from cursor
    const candidates: Provider[] = [];
    for (let i = 0; i < order.length; i++) {
        const p = order[(roundRobinCursor + i) % order.length]!;
        if (isEligible(p, logicalModel)) candidates.push(p);
    }
    return candidates;
}

export function advanceCursor(): void {
    roundRobinCursor = (roundRobinCursor + 1) % config.providerOrder.length;
}

export function setCooldown(provider: Provider, untilMs: number, snapshot?: Record<string, string>): void {
    state[provider]!.cooldownUntil = untilMs;
    state[provider]!.healthy = false;
    if (snapshot) state[provider]!.rateLimitSnapshot = snapshot;
}

export function recordSuccess(provider: Provider, statusCode: number): void {
    const s = state[provider]!;
    s.lastStatusCode = statusCode;
    s.lastSuccessAt = Date.now();
    s.consecutiveFailures = 0;
    s.healthy = true;
    s.cooldownUntil = null;
}

export function recordFailure(provider: Provider, statusCode: number): void {
    const s = state[provider]!;
    s.lastStatusCode = statusCode;
    s.lastFailureAt = Date.now();
    s.consecutiveFailures++;
}

export function getStateSnapshot(): Record<Provider, ProviderState> {
    return JSON.parse(JSON.stringify(state)); // deep-clone to prevent external mutation
}

// ROUTE-08: test isolation
export function resetForTesting(): void {
    for (const provider of ['cerebras', 'groq'] as Provider[]) {
        state[provider] = {
            provider,
            enabled: true,
            configured: true,
            healthy: true,
            cooldownUntil: null,
            lastSelectedAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastStatusCode: null,
            consecutiveFailures: 0,
        };
    }
    roundRobinCursor = 0;
}
```

### Pattern 2: Rate-Limit Header Parsers

**What:** Provider-specific parsers that extract reset times from response headers returned by `APIError.headers` or from successful response headers via `.withResponse()`.

**When to use:** After any upstream call that returns a response (success or error) from a provider.

**Key facts confirmed from live SDK source code:**

- Both SDKs expose `error.headers` on caught `APIError` instances — type is `Headers` (Web API). [VERIFIED: node_modules source]
- Both SDKs support `.withResponse()` on `APIPromise<T>` which returns `{ data: T, response: Response }` — giving access to `response.headers` on success. [VERIFIED: node_modules source]
- Cerebras reset headers are **float seconds** (e.g., `"33011.382867097855"`) — parse with `parseFloat()`. [VERIFIED: inference-docs.cerebras.ai/support/rate-limits]
- Groq reset headers are **duration strings** (e.g., `"2m59.56s"`) — require custom parser. [VERIFIED: console.groq.com/docs/rate-limits]
- Groq `retry-after` is a plain **integer seconds** string (e.g., `"2"`). [VERIFIED: console.groq.com/docs/rate-limits]

```typescript
// Source: CLAUDE.md §13 + verified from Groq/Cerebras documentation
// routing/cooldown-manager.ts

export interface ParsedCerebrasHeaders {
    remainingRequestsDay?: number;
    remainingTokensMinute?: number;
    resetRequestsDaySeconds?: number;    // float seconds until reset
    resetTokensMinuteSeconds?: number;   // float seconds until reset
}

export interface ParsedGroqHeaders {
    remainingRequests?: number;
    remainingTokens?: number;
    resetRequestsSeconds?: number;       // parsed from "Xm Y.Zs" duration string
    resetTokensSeconds?: number;         // parsed from "Xm Y.Zs" duration string
    retryAfterSeconds?: number;          // plain integer string on 429
}

export function parseCerebrasHeaders(headers: Headers): ParsedCerebrasHeaders {
    const get = (h: string) => headers.get(h);
    return {
        remainingRequestsDay: toNum(get('x-ratelimit-remaining-requests-day')),
        remainingTokensMinute: toNum(get('x-ratelimit-remaining-tokens-minute')),
        resetRequestsDaySeconds: toFloat(get('x-ratelimit-reset-requests-day')),
        resetTokensMinuteSeconds: toFloat(get('x-ratelimit-reset-tokens-minute')),
    };
}

export function parseGroqHeaders(headers: Headers): ParsedGroqHeaders {
    const get = (h: string) => headers.get(h);
    return {
        remainingRequests: toNum(get('x-ratelimit-remaining-requests')),
        remainingTokens: toNum(get('x-ratelimit-remaining-tokens')),
        resetRequestsSeconds: parseDuration(get('x-ratelimit-reset-requests')),
        resetTokensSeconds: parseDuration(get('x-ratelimit-reset-tokens')),
        retryAfterSeconds: toFloat(get('retry-after')),
    };
}

// Parse Groq duration strings: "2m59.56s" → seconds; "30s" → 30; "1m" → 60
function parseDuration(s: string | null): number | undefined {
    if (!s) return undefined;
    const m = s.match(/^(?:(\d+)m)?(?:([0-9.]+)s)?$/);
    if (!m) return undefined;
    const minutes = m[1] ? Number(m[1]) : 0;
    const secs    = m[2] ? Number(m[2]) : 0;
    return minutes * 60 + secs;
}

// RL-04: cooldown = max(retryAfter, resetTokensSeconds, DEFAULT_COOLDOWN_SECONDS)
export function calcCooldownMs(
    parsed: ParsedGroqHeaders | ParsedCerebrasHeaders,
    defaultCooldownSeconds: number,
): number {
    const candidates: number[] = [defaultCooldownSeconds];

    if ('retryAfterSeconds' in parsed && parsed.retryAfterSeconds != null) {
        candidates.push(parsed.retryAfterSeconds);
    }
    if ('resetTokensMinuteSeconds' in parsed && parsed.resetTokensMinuteSeconds != null) {
        candidates.push(parsed.resetTokensMinuteSeconds);
    }
    if ('resetTokensSeconds' in parsed && parsed.resetTokensSeconds != null) {
        candidates.push(parsed.resetTokensSeconds);
    }

    return Math.max(...candidates) * 1000; // return ms for Date.now() comparison
}

function toFloat(s: string | null): number | undefined {
    if (!s) return undefined;
    const n = parseFloat(s);
    return isNaN(n) ? undefined : n;
}
function toNum(s: string | null): number | undefined {
    if (!s) return undefined;
    const n = Number(s);
    return isNaN(n) ? undefined : n;
}
```

### Pattern 3: Error Classification (Failover vs. Client Error)

**What:** Determine whether a caught `APIError` from a provider SDK should trigger failover to the alternate provider or be returned immediately to the client.

**Key facts confirmed from SDK source code:**
- Groq 498 (Flex Tier Capacity Exceeded) falls through to generic `APIError` class — it is not mapped to any named subclass. Check `error.status === 498`. [VERIFIED: node_modules/groq-sdk/src/core/error.ts]
- `APIConnectionError` has `status === undefined` — treat as failover (transient network issue). [VERIFIED: both SDK error.ts files]

```typescript
// Source: CLAUDE.md §14 + local SDK error.ts analysis
import { APIError as GroqAPIError } from 'groq-sdk';
import { APIError as CerebrasAPIError } from '@cerebras/cerebras_cloud_sdk';

type SDKError = GroqAPIError | CerebrasAPIError;

const FAILOVER_STATUSES = new Set([408, 429, 498, 500, 502, 503, 504]);
const NO_FAILOVER_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

export function classifyError(err: unknown): {
    shouldFailover: boolean;
    status: number | undefined;
    headers: Headers | undefined;
} {
    if (err instanceof GroqAPIError || err instanceof CerebrasAPIError) {
        const status = err.status as number | undefined;
        if (status === undefined) {
            // Network/connection error — failover
            return { shouldFailover: true, status: undefined, headers: undefined };
        }
        if (FAILOVER_STATUSES.has(status)) {
            return { shouldFailover: true, status, headers: err.headers as Headers | undefined };
        }
        if (NO_FAILOVER_STATUSES.has(status)) {
            return { shouldFailover: false, status, headers: err.headers as Headers | undefined };
        }
        // Unknown status — fail safe, failover
        return { shouldFailover: true, status, headers: err.headers as Headers | undefined };
    }
    // Unknown error type — failover
    return { shouldFailover: true, status: undefined, headers: undefined };
}
```

### Pattern 4: SSE Relay in Bun.serve()

**What:** Stream SDK async iterable chunks through Bun's `Response` body as Server-Sent Events.

**Confirmed Bun APIs:**
- `new Response(asyncIterable, headers)` — Bun accepts async generators as Response body. No buffering. [VERIFIED: node_modules/bun-types/docs/runtime/streams.mdx]
- `server.timeout(request, 0)` — disables idle timeout per-request; required to prevent Bun's 10-second default from killing a quiet LLM stream. Signature: `timeout(request: Request, seconds: number): void`. [VERIFIED: node_modules/bun-types/serve.d.ts:1028]
- The `server` object is available as second parameter of `fetch(request, server)`. [VERIFIED: node_modules/bun-types/serve.d.ts:574]

**Groq streaming:** `groq.chat.completions.create({ ...params, stream: true })` returns `APIPromise<Stream<ChatCompletionChunk>>`. `ChatCompletionChunk` has `id`, `choices`, `created`, `model`, `object: 'chat.completion.chunk'`, `x_groq?`. [VERIFIED: node_modules/groq-sdk/src/resources/chat/completions.ts]

**Cerebras streaming:** `cerebras.chat.completions.create({ ...params, stream: true })` returns `APIPromise<Stream<ChatCompletion>>` where `ChatCompletion` is a union including `ChatChunkResponse` (with `object: 'chat.completion.chunk'` field). `ChatChunkResponse` has `choices?`, `id`, `created`, `model`, `time_info?`, `usage?`. [VERIFIED: node_modules/@cerebras/cerebras_cloud_sdk/src/resources/chat/completions.ts]

**Abort signal:** Upstream SDK streams expose `stream.controller` (an `AbortController`). To abort upstream when the downstream client disconnects, link `stream.controller.abort()` to the downstream `Request.signal`. In Bun, `request.signal` is available in `fetch()` and fires when the client disconnects.

```typescript
// Source: bun-types + groq-sdk/cerebras SDK source analysis
// Streaming branch in index.ts

if (input.stream === true) {
    // STREAM-03: disable Bun idle timeout for streaming requests
    server.timeout(request, 0);

    const controller = new AbortController();

    // STREAM-05: abort upstream when downstream disconnects
    request.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const sdkStream = await adapter.stream(upstreamModelId, params, controller.signal);

    const body = (async function* () {
        let firstChunkSent = false;
        try {
            for await (const chunk of sdkStream) {
                // STREAM-07: normalize inline before yielding
                const normalized = normalizeChunk(chunk, input.model);
                firstChunkSent = true;
                yield `data: ${JSON.stringify(normalized)}\n\n`;
            }
            // STREAM-06: preserve [DONE] sentinel
            yield 'data: [DONE]\n\n';
        } catch (err) {
            // STREAM-04: no failover after first chunk sent
            // If firstChunkSent: stream is already mid-flight; close silently
            // If !firstChunkSent: error could surface as a truncated stream
            if (!firstChunkSent) {
                // The generator has no way to send a 5xx at this point — the
                // HTTP status is already committed by the time we start iterating.
                // Log the error; the client will see an abruptly closed stream.
                console.error('[stream] error before first chunk', err);
            }
        }
    })();

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
```

**Important:** Because `Bun.serve()` must return a `Response` from the `fetch` handler, and the HTTP status code is committed when `new Response()` is constructed, streaming errors that occur mid-stream (after headers are sent) cannot be converted to HTTP error responses. This is the inherent limitation of STREAM-04.

**Provider adapter stream() method signature:**

```typescript
// types.ts extension
export interface ProviderAdapter {
    name: string;
    complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult>;
    stream(
        upstreamModelId: string,
        params: CompletionParams,
        signal: AbortSignal,
    ): Promise<AsyncIterable<StreamChunk>>;
}

export interface StreamChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;   // adapter yields upstream id; index.ts normalizes to alias
    choices: Array<{
        index: number;
        delta: { role?: string; content?: string | null };
        finish_reason: string | null;
    }>;
}
```

### Pattern 5: Request Schema — stream Field Widening

**What:** Phase 1 set `stream: z.literal(false)` to reject `stream: true`. Phase 2 must accept both.

**Change required in `request-schema.ts` line 19:**

```typescript
// Before (Phase 1):
stream: z.literal(false).optional(),

// After (Phase 2):
stream: z.boolean().optional(),
```

The test case `"stream:true returns success:false with param='stream'"` in `request-schema.test.ts` must be updated or deleted — `stream: true` now succeeds.

### Pattern 6: Ready + Status Endpoints

**`GET /ready` (EP-05):**

```typescript
// Auth NOT required per CLAUDE.md §20 (readiness is infrastructure-callable)
// No auth required — same as /health
if (request.method === 'GET' && pathname === '/ready') {
    const eligibleProviders = (['cerebras', 'groq'] as Provider[])
        .filter(p => isEligible(p, /* use first registered alias */ listAliases()[0] ?? ''));

    const unavailableProviders = (['cerebras', 'groq'] as Provider[])
        .filter(p => !eligibleProviders.includes(p));

    const ready = eligibleProviders.length > 0;
    const mode = unavailableProviders.length === 0 ? 'ok' : 'degraded';

    return new Response(
        JSON.stringify({
            ready,
            mode,
            eligibleProviders,
            unavailableProviders,
        }),
        {
            status: ready ? 200 : 503,
            headers: { 'Content-Type': 'application/json' },
        }
    );
}
```

**`GET /internal/providers/status` (EP-06):**

```typescript
// Auth required; controlled by ENABLE_INTERNAL_STATUS_ENDPOINT
if (config.enableInternalStatusEndpoint
    && request.method === 'GET'
    && pathname === '/internal/providers/status') {
    // Auth gate already ran above this point
    return new Response(
        JSON.stringify({ providers: getStateSnapshot() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}
```

### Anti-Patterns to Avoid

- **Retrying the same provider immediately after 429:** The requirement is to fail over to the alternate provider first, then re-enter the cooled-down provider only after the cooldown expires. Never retry the same provider within the same request.
- **Buffering streaming response to normalize:** Normalization (model alias rewrite, reasoning strip) MUST happen inline per chunk before `yield`. Do not collect all chunks, then normalize.
- **Failing over after first streaming chunk sent:** Once `firstChunkSent = true`, the HTTP status code and headers are committed. Switching providers would require aborting the downstream response and retrying — which the spec explicitly prohibits (STREAM-04).
- **Using `as const` on mutable state objects:** The `state` record in `provider-state.ts` is intentionally mutable; do not mark it `as const`.
- **Calling `server.timeout` after `return new Response(...)`:** Must call `server.timeout(request, 0)` BEFORE constructing and returning the streaming Response.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSE framing | Custom SSE encoder | Plain template literal `\`data: ${json}\n\n\`` | SSE format is trivially simple: `data: <payload>\n\n`. Both providers already handle the SSE layer; the proxy just reformats chunks. |
| HTTP request to upstream | Raw `fetch()` to Cerebras/Groq URLs | `groq-sdk` / `cerebras_cloud_sdk` `create({ stream: true })` | SDKs handle auth, retry=0, error classes with `.status`+`.headers`, SSE parsing, abort signal propagation via `stream.controller`. |
| Duration string parsing | Regex from scratch | The `parseDuration()` function in Pattern 2 above | Groq uses `"Xm Y.Zs"` — simple regex with minute+second groups. |
| Structured error bodies | Custom error class | `openaiError()` helper already in `index.ts` | Already implemented in Phase 1. |
| Test fakes for SDK clients | Full mock object | `mock.module('./services/cerebras', ...)` in bun:test | `mock.module()` replaces the entire module; no need to inject adapters. |

**Key insight:** The SDKs abstract all HTTP complexity including SSE streaming. The proxy's streaming job is to: (1) call `create({ stream: true })`, (2) `for await` over the returned `Stream<Chunk>`, (3) `yield` formatted SSE lines. The SDK handles the upstream TCP connection, SSE framing, abort propagation via `stream.controller`.

---

## Rate-Limit Header Parsing Detail

### Cerebras Headers (RL-01)

Headers returned with every response (confirmed from official docs):

```
x-ratelimit-limit-requests-day         (integer)
x-ratelimit-limit-tokens-minute        (integer)
x-ratelimit-remaining-requests-day     (integer)
x-ratelimit-remaining-tokens-minute    (integer)
x-ratelimit-reset-requests-day         (float seconds, e.g. "33011.382867097855")
x-ratelimit-reset-tokens-minute        (float seconds, e.g. "11.382867097854614")
```

[VERIFIED: inference-docs.cerebras.ai/support/rate-limits]

**Parser note:** Use `parseFloat()` not `parseInt()`. The values are fractional seconds from the current moment. To convert to absolute epoch ms: `Date.now() + parseFloat(value) * 1000`.

**On 429:** Cerebras may reject before processing if token estimate exceeds quota. `x-ratelimit-reset-tokens-minute` will be the binding header.

### Groq Headers (RL-02)

Headers returned with responses (confirmed from official docs):

```
x-ratelimit-limit-requests             (integer)
x-ratelimit-limit-tokens               (integer)
x-ratelimit-remaining-requests         (integer)
x-ratelimit-remaining-tokens           (integer)
x-ratelimit-reset-requests             (duration string, e.g. "2m59.56s" or "30s" or "1m")
x-ratelimit-reset-tokens               (duration string)
retry-after                            (integer seconds — only on 429 responses)
```

[VERIFIED: console.groq.com/docs/rate-limits]

**Duration string parser:** Pattern `^(?:(\d+)m)?(?:([0-9.]+)s)?$` — handles `"2m59.56s"`, `"30s"`, `"1m"`, `"1m30s"`.

**On 498:** Groq 498 (Flex Tier Capacity Exceeded) falls through to the generic `APIError` class in the SDK — no named subclass, no `RateLimitError`. Check `error.status === 498`. The error will have `error.headers` containing the Groq rate-limit headers if available. Treat identically to 429. [VERIFIED: node_modules/groq-sdk/src/core/error.ts]

### Accessing Headers from SDKs

**On error:** `APIError.headers` is `Headers | undefined`. Both Groq and Cerebras APIError classes expose this as `readonly headers`. [VERIFIED: node_modules source — both error.ts files]

```typescript
} catch (err) {
    if (err instanceof GroqAPIError && err.headers) {
        const parsed = parseGroqHeaders(err.headers as Headers);
        // ...
    }
}
```

**On success (for capturing headers from non-error responses):** Use `.withResponse()`:

```typescript
const { data, response } = await groq.chat.completions.create({ ... }).withResponse();
const parsed = parseGroqHeaders(response.headers);
```

This matters for Phase 2 because even successful responses should update `rateLimitSnapshot` for the diagnostics endpoint.

---

## Common Pitfalls

### Pitfall 1: Groq 498 Looks Like a 5xx But Needs Its Own Classification

**What goes wrong:** Developer sees status code 498 and routes it through the `>= 500` branch of their error classifier, missing that it should be treated as a quota event (same as 429), not a generic server error.

**Why it happens:** 498 is a Groq-specific non-standard status. The SDK `error.generate()` falls through to generic `APIError` — not `InternalServerError`. The check `status >= 500` misses it.

**How to avoid:** Add `498` explicitly to the `FAILOVER_STATUSES` set alongside `429`. Do not rely on `>= 500` for Groq quota codes.

**Warning signs:** Test cases where Groq 498 does not trigger cooldown + failover.

### Pitfall 2: Cerebras Reset Times Are Relative, Not Absolute

**What goes wrong:** Developer stores `parseFloat(resetHeader)` directly as `cooldownUntil`, then compares against `Date.now()`. Since the header value is ~11 seconds (not 1.7 trillion), the comparison `Date.now() >= 11` is always true — the cooldown never takes effect.

**Why it happens:** Cerebras headers are "seconds from now until reset" (relative), not Unix epoch timestamps (absolute).

**How to avoid:** `cooldownUntil = Date.now() + parseFloat(header) * 1000`.

**Warning signs:** Providers never enter cooldown despite receiving 429 with reset headers.

### Pitfall 3: Groq Duration String Parsing Edge Cases

**What goes wrong:** Parser handles `"2m59.56s"` but fails on `"30s"` (no minutes component) or `"1m"` (no seconds component).

**Why it happens:** Regex `(\d+)m(\d+)s` requires both groups present. Groq docs show all three forms exist.

**How to avoid:** Make both groups optional with `?`: `^(?:(\d+)m)?(?:([0-9.]+)s)?$`.

**Warning signs:** `parseDuration("30s")` returns `undefined` instead of `30`.

### Pitfall 4: Committing HTTP Status Before Streaming Starts

**What goes wrong:** Developer attempts to return a 503 when the first provider fails and `stream: true`, but the code has already begun the streaming Response — the HTTP status is committed.

**Why it happens:** In Bun (and HTTP/1.1 generally), headers and status are sent when the Response is returned from `fetch()`. Any failover decision must happen BEFORE `new Response()` is constructed.

**How to avoid:** Attempt all provider selections BEFORE constructing the streaming Response. Only begin streaming once a provider has been chosen and the SDK stream obtained. If stream start itself throws (before the first `yield`), the Response has not been returned yet and you can still return a 503.

**Warning signs:** The `firstChunkSent` flag is checked — but if the error occurs during `adapter.stream()` (before the generator starts), you have not yet returned `new Response()` and CAN surface the error correctly.

### Pitfall 5: `fetch(request)` vs `fetch(request, server)` — Missing server Parameter

**What goes wrong:** `server.timeout(request, 0)` throws `server is not defined` because the `fetch` handler is declared as `async fetch(request)` without the second `server` parameter.

**Why it happens:** The current `index.ts` uses `async fetch(request)` with only one parameter (sufficient for Phase 1 which doesn't need `server`). Phase 2 must add `server` as the second parameter.

**How to avoid:** Change `async fetch(request)` to `async fetch(request, server)` in `Bun.serve()`. Type annotation: `fetch(request: Request, server: Server)`.

**Warning signs:** TypeScript error on `server.timeout` — `server` is not in scope.

### Pitfall 6: Round-Robin Cursor Advances Even When Provider Is Ineligible

**What goes wrong:** The cursor advances after every selection attempt (including failed ones), causing non-deterministic alternation when a provider is in cooldown.

**Why it happens:** Simple "advance on every call" logic does not distinguish between "provider was tried" and "provider was eligible."

**How to avoid:** Advance the cursor exactly once per request — before or after the loop, not on each iteration. The cursor advances unconditionally; eligibility filtering is applied on top of the rotated order.

### Pitfall 7: bun test Cannot Import from index.ts Directly for Router Tests

**What goes wrong:** Tests that import `from './index.ts'` to test routing pull in `Bun.serve()` at module load, binding to a port. Tests interfere with each other or block the port.

**Why it happens:** `Bun.serve()` is called at module top-level in `index.ts`.

**How to avoid:** Keep routing logic in pure modules (`routing/provider-state.ts`, `routing/cooldown-manager.ts`) that have no side-effects at import time. Test those modules directly. Use `mock.module()` to stub adapters for integration tests that exercise the request handler without real HTTP calls.

---

## Runtime State Inventory

Not applicable — Phase 2 is a greenfield extension to an existing in-process server. No external state stores, OS-level registrations, or persistent data involved.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | Runtime | Yes | 1.3.11 | — |
| groq-sdk | Groq streaming | Yes | 1.2.1 | — |
| @cerebras/cerebras_cloud_sdk | Cerebras streaming | Yes | 1.64.1 | — |
| zod | Schema widening | Yes | 4.4.3 | — |
| CEREBRAS_API_KEY | Cerebras calls | Assumed present (Phase 1 passed live UAT) | — | — |
| GROQ_API_KEY | Groq calls | Assumed present (Phase 1 registered groqAdapter) | — | — |
| PERSONAL_PROXY_API_KEY | Auth | Assumed present | — | — |

**Missing dependencies with no fallback:** None.

**Config additions needed before any routing code runs:**

```typescript
// config.ts additions
defaultCooldownSeconds: Number(process.env['DEFAULT_COOLDOWN_SECONDS'] ?? 60),
maxProviderAttemptsPerRequest: Number(process.env['MAX_PROVIDER_ATTEMPTS_PER_REQUEST'] ?? 2),
exposeProviderHeader: (process.env['EXPOSE_PROVIDER_HEADER'] ?? 'false') === 'true',
enableInternalStatusEndpoint: (process.env['ENABLE_INTERNAL_STATUS_ENDPOINT'] ?? 'true') === 'true',
```

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | bun:test (built-in, no install needed) |
| Config file | none — `bun test` discovers `*.test.ts` automatically |
| Quick run command | `bun test routing/` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ROUTE-01 | ProviderState shape correct | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-02 | Eligibility predicate blocks cooldown/unconfigured | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-03 | Round-robin alternates Cerebras→Groq→Cerebras | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-04 | 429 from first provider → second provider used | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-05 | 500/502/503/504 trigger failover | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-06 | 400/401/403/404 do NOT trigger failover | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-07 | Both in cooldown → 503 | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| ROUTE-08 | resetForTesting() resets state | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| RL-01 | Cerebras header parse: float seconds | unit | `bun test routing/cooldown-manager.test.ts` | No — Wave 0 |
| RL-02 | Groq header parse: duration string + retry-after | unit | `bun test routing/cooldown-manager.test.ts` | No — Wave 0 |
| RL-03 | parsers are separate functions | unit | code review | — |
| RL-04 | calcCooldownMs picks max of inputs | unit | `bun test routing/cooldown-manager.test.ts` | No — Wave 0 |
| RL-05 | Provider re-enters rotation after cooldownUntil | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| RL-06 | Groq 498 same as 429 | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| STREAM-01 | Response Content-Type is text/event-stream | manual UAT | `curl -N ...` | — |
| STREAM-02 | Chunks arrive without buffering | manual UAT | `curl -N ...` | — |
| STREAM-03 | server.timeout(request, 0) called | code review | — | — |
| STREAM-04 | No failover after first chunk | manual UAT | kill connection mid-stream | — |
| STREAM-05 | Upstream abort on disconnect | manual UAT | close curl mid-stream | — |
| STREAM-06 | [DONE] sentinel present | manual UAT | `curl -N ... | tail` | — |
| STREAM-07 | model rewritten in each chunk | manual UAT | `curl -N ... | grep model` | — |
| EP-05 | /ready returns degraded when one provider down | unit | `bun test routing/provider-state.test.ts` | No — Wave 0 |
| EP-06 | /internal/providers/status auth-gated | unit | integration test | No — Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test routing/`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green + streaming manual UAT before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `routing/provider-state.test.ts` — covers ROUTE-01..08, RL-05, RL-06, EP-05
- [ ] `routing/cooldown-manager.test.ts` — covers RL-01..04
- [ ] `routing/provider-state.ts` — the module under test
- [ ] `routing/cooldown-manager.ts` — the module under test

*(Existing `request-schema.test.ts` will need its `stream:true → 400` test case removed or updated when schema is widened.)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (diagnostics endpoint) | Existing `verifyToken()` constant-time compare — reused on EP-06 |
| V3 Session Management | no | Stateless proxy |
| V4 Access Control | yes | `/internal/providers/status` gated behind same auth + `ENABLE_INTERNAL_STATUS_ENDPOINT` flag |
| V5 Input Validation | yes | Zod strict schema (widened `stream` field) |
| V6 Cryptography | no | No new crypto; existing `timingSafeEqual` unchanged |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Provider API key leakage via diagnostics | Information Disclosure | `getStateSnapshot()` excludes API key values; config never stored in state |
| Secrets in logs | Information Disclosure | `console.error` in routing MUST NOT log `err.headers` directly — may contain Authorization echoes |
| DoS via streaming connection exhaustion | Denial of Service | `server.timeout(request, 0)` with downstream abort signal prevents zombie connections |
| Timing oracle on proxy key | Information Disclosure | Existing `timingSafeEqual` on `/internal/providers/status` — length check first |
| Provider rate-limit amplification (retry storm) | Denial of Service | MAX_PROVIDER_ATTEMPTS_PER_REQUEST=2 caps retries per request |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 1 first-eligible selection | Stateful round-robin with cooldown | Phase 2 | Correct free-tier distribution across both providers |
| `stream: z.literal(false)` | `stream: z.boolean()` | Phase 2 | Accepts `stream:true` from clients |
| Only `complete()` on ProviderAdapter | `complete()` + `stream()` on ProviderAdapter | Phase 2 | Enables streaming through adapter boundary |
| Flat provider selection in index.ts | Encapsulated routing module | Phase 2 | Testable without HTTP server |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `request.signal` on `Request` in Bun.serve() fires when downstream client disconnects | SSE relay pattern | Upstream not aborted on disconnect; zombie SDK connections. Workaround: connect to `stream.controller.abort()` on the SDK side as a fallback. |
| A2 | Groq returns `x-ratelimit-*` headers on successful (non-429) responses | Rate-Limit Headers | `rateLimitSnapshot` for successful calls won't populate; diagnostics endpoint is less informative. Non-blocking for routing correctness. |
| A3 | Cerebras also returns rate-limit headers on all responses, not just 429 | Rate-Limit Headers | Same as A2 — snapshot won't populate on success. |

**All SDK API claims (`.status`, `.headers`, `.withResponse()`, streaming return types, `ChatCompletionChunk` shape, `Stream` class) are VERIFIED from local node_modules source.** [VERIFIED: node_modules]

**Bun API claims (`server.timeout(request, 0)`, `fetch(request, server)` second param, async generator as Response body) are VERIFIED from bun-types source.** [VERIFIED: node_modules/bun-types]

**Rate-limit header formats verified against provider official documentation.** [VERIFIED: inference-docs.cerebras.ai, console.groq.com]

---

## Open Questions

1. **Does Cerebras send rate-limit headers on non-429 responses?**
   - What we know: Docs show headers in rate-limit context, not guaranteed on every response.
   - What's unclear: Whether to call `.withResponse()` on every successful completion to capture snapshot.
   - Recommendation: Attempt to parse headers on success; if headers are absent, skip snapshot update. Non-blocking.

2. **Does `request.signal` reliably fire on client disconnect in Bun 1.3.11?**
   - What we know: Bun's `Request` inherits the standard `AbortSignal`. The SDK `Stream.controller.abort()` method is the documented way to abort a stream.
   - What's unclear: Whether Bun automatically aborts `request.signal` on TCP close.
   - Recommendation: Connect both sides: `request.signal.addEventListener('abort', () => sdkStream.controller.abort())`. If `request.signal` does not fire, the SDK stream will drain naturally when the downstream connection closes (Bun will stop writing to the response body, causing backpressure on the generator).

3. **Should `/ready` be auth-gated?**
   - What we know: CLAUDE.md §20 does not require auth on `/ready`. Phase 1's `/health` has no auth. `/ready` is called by infrastructure (load balancers, EasyPanel health checks).
   - Recommendation: No auth on `/ready`. Auth only on `/internal/providers/status`.

---

## Sources

### Primary (HIGH confidence — verified from local source)

- `node_modules/groq-sdk/src/core/error.ts` — `APIError.status`, `APIError.headers`, error class hierarchy, 498 handling
- `node_modules/@cerebras/cerebras_cloud_sdk/src/error.ts` — same
- `node_modules/groq-sdk/src/core/api-promise.ts` — `.withResponse()` API
- `node_modules/@cerebras/cerebras_cloud_sdk/src/core.ts` — `.withResponse()` API
- `node_modules/groq-sdk/src/core/streaming.ts` — `Stream<T>` class, `controller: AbortController`
- `node_modules/@cerebras/cerebras_cloud_sdk/src/streaming.ts` — same
- `node_modules/groq-sdk/src/resources/chat/completions.ts` — `ChatCompletionChunk` interface, streaming overload
- `node_modules/@cerebras/cerebras_cloud_sdk/src/resources/chat/completions.ts` — `ChatChunkResponse`, streaming overload
- `node_modules/bun-types/serve.d.ts:1028` — `server.timeout(request: Request, seconds: number): void`
- `node_modules/bun-types/docs/runtime/streams.mdx` — async generator as Response body pattern
- `node_modules/bun-types/docs/test/mocks.mdx` — `mock.module()` for adapter stubbing

### Secondary (HIGH confidence — official provider documentation)

- `inference-docs.cerebras.ai/support/rate-limits` — Cerebras header names and float-seconds format
- `console.groq.com/docs/rate-limits` — Groq header names and duration-string format
- `console.groq.com/docs/errors` — Groq 498 "Flex Tier Capacity Exceeded" description

### Tertiary (not needed — all claims verified from above)

None.

---

## Metadata

**Confidence breakdown:**
- ProviderState design: HIGH — fully specified in CLAUDE.md §12; no external dependency
- SDK streaming APIs: HIGH — verified from installed node_modules source code
- Rate-limit header formats: HIGH — verified from official provider documentation
- Bun streaming + timeout API: HIGH — verified from installed bun-types source
- Groq 498 classification: HIGH — verified from groq-sdk error.ts (falls through to generic APIError)
- Cooldown calculation: HIGH — pure math; formula specified in CLAUDE.md §13.3
- Test architecture: HIGH — bun:test mock.module confirmed available

**Research date:** 2026-06-05
**Valid until:** 2026-07-05 (SDK APIs are stable; provider header formats change rarely)
