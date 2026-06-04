# Architecture Research

**Project:** bun-ai-api — OpenAI-Compatible Proxy (Refactor)
**Researched:** 2026-06-04
**Overall confidence:** HIGH (Bun docs verified via Context7; spec sourced from refactor.md)

---

## Recommended Architecture

```text
Client
  | Authorization: Bearer PERSONAL_PROXY_API_KEY
  v
┌─────────────────────────────────────────────────────────────────┐
│  index.ts  —  Bun.serve() entry + route registration           │
│                                                                  │
│  routes/                                                         │
│    health.ts            GET /health                             │
│    ready.ts             GET /ready                              │
│    models.ts            GET /v1/models                          │
│    chat-completions.ts  POST /v1/chat/completions               │
│    providers-status.ts  GET /internal/providers/status          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ calls middleware functions before dispatch
                            v
┌───────────────────────────────────────────────────────────────┐
│  middleware/                                                    │
│    auth.ts         — Bearer token validation, 401 on fail      │
│    request-id.ts   — UUID stamp on every request               │
└───────────────────────────┬───────────────────────────────────┘
                            │ validated request object
                            v
┌───────────────────────────────────────────────────────────────┐
│  routing/                                                       │
│    provider-router.ts    — chooseEligibleProviders(), loop     │
│    provider-state.ts     — ProviderState registry (in-memory)  │
│    cooldown-manager.ts   — parse rate-limit headers, set/check │
└───────────────────────────┬───────────────────────────────────┘
                            │ selected provider + upstream model ID
                            v
┌───────────────────────────────────────────────────────────────┐
│  providers/                                                     │
│    provider-adapter.ts   — shared ProviderAdapter interface    │
│    cerebras-adapter.ts   — wraps cerebras_cloud_sdk            │
│    groq-adapter.ts       — wraps groq-sdk                      │
└───────────────────────────┬───────────────────────────────────┘
                            │ raw SDK response / stream
                            v
┌───────────────────────────────────────────────────────────────┐
│  services/                                                      │
│    model-registry.ts     — alias→{cerebras,groq} resolution    │
│    response-normalizer.ts — strip vendor fields, rewrite model  │
│    stream-relay.ts       — async generator → SSE Response      │
└───────────────────────────┬───────────────────────────────────┘
                            │ OpenAI-compatible Response
                            v
                         Client
```

Support modules (no request-path dependency):

```text
schemas/
  chat-completions.ts   — allowlist field validator (pre-routing)

utils/
  errors.ts             — OpenAI-style error bodies (400/401/429/500)
  logger.ts             — structured JSON logger, redacts secrets

config.ts               — env var loader, validated at startup
types.ts                — shared interfaces: ProviderState, ProviderAdapter,
                          NormalizedRequest, NormalizedResponse, LogicalAlias
```

---

## Component Boundaries

### `index.ts`

Owns: `Bun.serve()` instantiation, route table declaration, server lifecycle.
Does not own: any business logic. Every route entry delegates immediately to a handler in `routes/`.

Pattern: routes declared as `{ "/v1/chat/completions": { POST: chatCompletionsHandler } }`. The `fetch` fallback returns 404. Middleware is applied inside each route handler via composed function calls, not a framework chain.

### `middleware/auth.ts`

Owns: extracting the `Authorization` header, constant-time comparison against `PERSONAL_PROXY_API_KEY`, returning `401` when absent or invalid.
Does not own: request ID, logging, route logic.
Called by: `chat-completions.ts`, `models.ts`, `providers-status.ts`. Health and ready routes do not require auth.

Pattern (Bun has no built-in middleware pipeline — compose with higher-order functions):

```typescript
// middleware/auth.ts
export function requireAuth(req: Request): Response | null {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(token, config.personalProxyApiKey)) {
    return errors.unauthorized();
  }
  return null; // pass
}

// usage in any route handler
export async function POST(req: Request): Promise<Response> {
  const authError = requireAuth(req);
  if (authError) return authError;
  // ...
}
```

### `middleware/request-id.ts`

Owns: generating a UUID for each request, attaching it as `X-Request-ID` to the outgoing response.
Does not own: any routing, auth, or logging sink. Provides the request ID string; logger consumes it.

### `routing/provider-state.ts`

Owns: the single in-memory `ProviderState` map (keyed by provider name), all reads and mutations to that map (`markCooldown`, `markFailure`, `markSuccess`, `isEligible`, `snapshot`).
Does not own: routing decisions, cooldown calculation. It is a pure state container with typed accessors.

This is the only stateful singleton in the system. It must be a module-level singleton (not instantiated per-request) so state persists across requests within the same Bun process.

### `routing/cooldown-manager.ts`

Owns: parsing provider-specific rate-limit headers from upstream responses, computing `cooldownUntil` timestamps, calling `providerState.markCooldown(provider, until)`.
Does not own: provider state storage, routing decisions.

### `routing/provider-router.ts`

Owns: the `chooseEligibleProviders(logicalAlias, state)` function and the failover loop. Reads `providerState` to filter eligible providers, advances the round-robin cursor, calls the adapter, invokes cooldown-manager on 429, drives the attempt loop.
Does not own: HTTP, adapter implementation, state storage.

### `providers/provider-adapter.ts`

Owns: the `ProviderAdapter` interface definition.
Does not own: implementation — this is the contract only.

```typescript
export interface ProviderAdapter {
  readonly name: "cerebras" | "groq";
  chatCompletions(
    upstreamModelId: string,
    body: NormalizedRequest,
    signal: AbortSignal
  ): Promise<ProviderResult>;
}

export type ProviderResult =
  | { ok: true; streaming: false; data: RawCompletion; headers: Headers }
  | { ok: true; streaming: true; stream: AsyncIterable<string>; headers: Headers }
  | { ok: false; retryable: boolean; status: number; body: unknown; headers: Headers };
```

### `providers/cerebras-adapter.ts` and `providers/groq-adapter.ts`

Owns: SDK instantiation (module-level singleton), mapping `NormalizedRequest` to SDK call arguments, calling `sdk.chat.completions.create()`, returning a typed `ProviderResult`.
Does not own: routing, state, response normalization, SSE relay. Provider-specific quirks (e.g. Cerebras `X-Cerebras-Version-Patch`, Groq `498` error code) are handled here and nowhere else.

### `services/model-registry.ts`

Owns: loading `MODEL_REGISTRY_JSON`, resolving `logicalAlias → { cerebras: string, groq: string }`, providing the set of providers that can serve a given alias.
Does not own: routing decisions. Returns data; router decides.

### `services/response-normalizer.ts`

Owns: stripping Cerebras-specific fields (`choices[*].message.reasoning`, `reasoning_logprobs`, `time_info`), stripping Groq telemetry, rewriting `model` field to the logical alias.
Does not own: adapter call, streaming logic. Operates on already-received objects.
For streaming: normalizes each SSE chunk's `model` field inline as it passes through `stream-relay.ts`.

### `services/stream-relay.ts`

Owns: wrapping a provider SDK `AsyncIterable<string>` into a Bun `Response` with `Content-Type: text/event-stream`, setting `server.timeout(req, 0)` to disable idle timeout, forwarding chunks without buffering, detecting client disconnect via `AbortSignal` or `ReadableStream.cancel`.
Does not own: upstream SSE parsing, response normalization decisions (calls normalizer per chunk).

### `schemas/chat-completions.ts`

Owns: runtime validation of the POST body against the allowlisted field set. Rejects `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, `n != 1`. Returns typed `NormalizedRequest` on success, or an error descriptor on failure.
Does not own: provider routing, auth.

### `utils/errors.ts`

Owns: factory functions for OpenAI-style error response bodies (`{ error: { message, type, code } }`), HTTP status codes 400/401/429/500/503.
Does not own: logging, routing.

### `utils/logger.ts`

Owns: structured JSON log output per-request (request ID, provider, latency, status, failover reason, token usage, quota headers). Redacts secrets. Accepts `LOG_LEVEL` env to suppress verbosity.
Does not own: anything else.

### `config.ts`

Owns: reading and validating all env vars at startup, exporting a frozen config object. Fails fast if required vars are absent.
Does not own: any request handling.

---

## Data Flow

### Non-Streaming Completion

```
1. Client:  POST /v1/chat/completions { Authorization: Bearer ... }
2. index.ts:  dispatch to routes/chat-completions.ts POST handler
3. middleware/request-id.ts:  generate requestId (UUID)
4. middleware/auth.ts:  validate Bearer token → 401 or pass
5. schemas/chat-completions.ts:  validate body fields → 400 or NormalizedRequest
6. services/model-registry.ts:  resolve logical alias → upstreamModelIds per provider → 400 if unknown
7. routing/provider-router.ts:  filter eligible providers, sort by round-robin cursor
8.   for each eligible provider (up to MAX_PROVIDER_ATTEMPTS_PER_REQUEST):
       a. routing/provider-state.ts:  check isEligible() — skip if in cooldown
       b. providers/<name>-adapter.ts:  call SDK, await result
       c. if ok:
            services/response-normalizer.ts:  strip vendor fields, rewrite model alias
            routing/provider-state.ts:  markSuccess()
            utils/logger.ts:  log request metadata
            return normalized Response with X-Request-ID header
       d. if retryable (408/429/498/500-504):
            routing/cooldown-manager.ts:  parse headers, compute cooldownUntil
            routing/provider-state.ts:  markCooldown() or markFailure()
            continue to next provider
       e. if not retryable (400/401/403/404/422/413):
            utils/errors.ts:  map to OpenAI error body
            return immediately (no failover)
9. if all providers exhausted:
     utils/errors.ts:  503 no provider available
     utils/logger.ts:  log exhaustion event
```

### Streaming Completion

```
1–7: Same as non-streaming (auth → validation → alias resolution → eligibility)
8.   routing/provider-router.ts:  select first eligible provider
       a. providers/<name>-adapter.ts:  call SDK with stream: true
       b. if first chunk NOT yet sent and error occurs:
            → same failover as non-streaming (try next provider)
       c. once first chunk sent:
            → NO failover; preserve stream integrity per spec (refactor.md §14)
            services/stream-relay.ts:  wrap provider AsyncIterable<string> in async generator
              - per chunk: services/response-normalizer.ts rewrites model field
              - server.timeout(req, 0) disables idle timeout
              - ReadableStream.cancel fires when client disconnects → abort upstream
              - yield formatted SSE data: lines
              - yield final "data: [DONE]\n\n" sentinel
            return Response(asyncGenerator, { "Content-Type": "text/event-stream" })
```

### Provider State Transitions

```
ELIGIBLE
  → on 429:      COOLDOWN (cooldownUntil = now + computed_seconds)
  → on 5xx:      consecutiveFailures++ (ELIGIBLE until threshold → UNHEALTHY)
  → on success:  consecutiveFailures = 0, lastSuccessAt = now

COOLDOWN
  → isEligible() checks Date.now() > cooldownUntil → back to ELIGIBLE automatically
  → no explicit transition needed; time-based check in provider-router

UNHEALTHY (repeated failures)
  → manual re-enable via /ready re-check or restart
  → /internal/providers/status exposes this state
```

---

## Stateful Components

### `routing/provider-state.ts` — The Only Mutable Singleton

```typescript
// Module-level singleton — lives for process lifetime
const state: Map<ProviderName, ProviderState> = new Map([
  ["cerebras", initialState("cerebras")],
  ["groq", initialState("groq")],
]);

// All mutations go through typed functions — no direct Map access outside this module
export function markCooldown(name: ProviderName, cooldownUntil: number): void { ... }
export function markSuccess(name: ProviderName, statusCode: number): void { ... }
export function markFailure(name: ProviderName, statusCode: number): void { ... }
export function isEligible(name: ProviderName, now = Date.now()): boolean { ... }
export function snapshot(): ReadonlyMap<ProviderName, Readonly<ProviderState>> { ... }
```

Safety in single-process Bun: Bun's event loop is single-threaded. JavaScript is not concurrent — only interleaved. Two requests cannot simultaneously mutate the same variable because only one microtask runs at a time. The existing non-atomic `let currentServiceIndex++` in `index.ts` is safe at the JS level; it is incorrect only because interleaving can produce "both requests pick the same index" when the increment is between await points. Moving all state mutations into synchronous functions (no `await` inside the mutation itself) eliminates the interleaving window entirely.

Round-robin cursor implementation:

```typescript
// Synchronous — no await inside, so no interleaving risk
let cursor = 0;
export function nextCursor(eligible: ProviderName[]): ProviderName {
  if (eligible.length === 0) throw new NoEligibleProviderError();
  const chosen = eligible[cursor % eligible.length];
  cursor = (cursor + 1) % Number.MAX_SAFE_INTEGER; // prevent overflow
  return chosen;
}
```

The `rateLimitSnapshot` field inside `ProviderState` is written synchronously after each upstream response header parse. It is safe to snapshot for the diagnostics endpoint.

No locks, mutexes, or atomics are needed. The single-threaded event loop provides the isolation guarantee. This changes only if Bun workers or `Bun.Worker` threads are introduced — which the spec explicitly defers.

---

## Build Order

Components are listed from least to most dependent. Implement in this sequence:

### Layer 0 — Foundation (no dependencies)

1. `config.ts` — env var loading and validation. Every other module depends on this. Fail fast on missing required vars. Provides the frozen config object consumed everywhere.

2. `types.ts` — shared interfaces: `ProviderState`, `ProviderAdapter`, `NormalizedRequest`, `NormalizedResponse`, `ProviderName`, `LogicalAlias`, `ProviderResult`. No logic, just contracts.

3. `utils/errors.ts` — OpenAI error response factories. Depends on nothing except `types.ts`. Needed by validation and routing layers.

4. `utils/logger.ts` — structured JSON logger with log-level gating and secret redaction. Depends on `config.ts` for `LOG_LEVEL`.

### Layer 1 — Schema and Registration

5. `schemas/chat-completions.ts` — allowlist validator. Depends on `types.ts` and `utils/errors.ts`. Can be unit-tested in isolation against raw objects.

6. `services/model-registry.ts` — alias registry loader. Depends on `config.ts` (reads `MODEL_REGISTRY_JSON`). Returns pure data — no side effects, easily unit-tested.

### Layer 2 — State and Routing Logic

7. `routing/provider-state.ts` — in-memory state container. Depends on `types.ts`. Unit-test all transitions: markCooldown, isEligible after expiry, markFailure threshold.

8. `routing/cooldown-manager.ts` — header parser and cooldown calculator. Depends on `provider-state.ts`, `config.ts` (for `DEFAULT_COOLDOWN_SECONDS`). Pure functions, unit-testable.

9. `middleware/request-id.ts` — UUID generator. Depends on nothing.

10. `middleware/auth.ts` — Bearer token check. Depends on `config.ts`, `utils/errors.ts`.

### Layer 3 — Provider Adapters

11. `providers/provider-adapter.ts` — interface definition only. Depends on `types.ts`.

12. `providers/cerebras-adapter.ts` — wraps `cerebras_cloud_sdk`. Depends on `provider-adapter.ts`, `config.ts`, `types.ts`. Returns `ProviderResult`. No routing logic.

13. `providers/groq-adapter.ts` — wraps `groq-sdk`. Same shape as Cerebras adapter. Groq-specific: handle `498` as retryable; map Groq error objects.

### Layer 4 — Response Pipeline

14. `services/response-normalizer.ts` — strip vendor fields, rewrite model. Depends on `types.ts`, `services/model-registry.ts`. Pure transformation functions — no I/O.

15. `services/stream-relay.ts` — SSE relay. Depends on `response-normalizer.ts`, `types.ts`. Uses Bun-native async generator → Response pattern. `server.timeout(req, 0)` requires the `server` reference passed through from the route handler.

### Layer 5 — Routing Orchestration

16. `routing/provider-router.ts` — failover loop. Depends on `provider-state.ts`, `cooldown-manager.ts`, `provider-adapter.ts` (via injected adapters), `model-registry.ts`, `stream-relay.ts`, `response-normalizer.ts`, `logger.ts`. This is the most complex module; build after all its dependencies are tested.

### Layer 6 — Route Handlers

17. `routes/health.ts` — simplest handler. No auth, no routing. Build first to validate server boots.

18. `routes/ready.ts` — reads `provider-state.ts` and `model-registry.ts`. Supports degraded mode.

19. `routes/models.ts` — reads `model-registry.ts`. Requires auth.

20. `routes/chat-completions.ts` — full path. Composes auth → schema → registry → router → relay. Requires all of layers 0–5.

21. `routes/providers-status.ts` — reads `provider-state.ts` snapshot. Requires auth. Optional (`ENABLE_INTERNAL_STATUS_ENDPOINT`).

### Layer 7 — Entry Point

22. `index.ts` — `Bun.serve()` with route table. Import all route handlers. Minimal logic here; just wiring.

### Layer 8 — Tests

23. Unit tests for routing logic (alternation, cooldown, recovery, exhaustion) — can be written once Layer 5 exists.
24. Integration tests for full request paths — require Layer 7.

---

## Key Architecture Decisions

### No middleware framework — composed functions

Bun.serve() has no built-in middleware pipeline. The correct pattern (confirmed by Bun docs) is higher-order functions. Each route handler calls `requireAuth(req)` and similar functions synchronously before proceeding. This is explicit, traceable, and avoids hidden control flow.

### Async generator for SSE relay (not ReadableStream constructor)

Both patterns work in Bun (confirmed via Context7). The async generator form is simpler and closer to the provider SDK's `AsyncIterable<string>` output:

```typescript
return new Response(
  async function* () {
    for await (const chunk of providerStream) {
      yield normalizeChunk(chunk); // inline normalization
    }
    yield "data: [DONE]\n\n";
  },
  { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
);
```

When the client disconnects, Bun cancels the async generator automatically. `server.timeout(req, 0)` must be called before returning the Response to prevent Bun's 10-second idle timeout from closing LLM streams that have momentary silences between tokens.

### Single ProviderState singleton — no class instances

A module-level `Map` with typed accessor functions is sufficient for a single-process server. No class needed; no constructor injection. Tests can reset state by calling an exported `resetForTesting()` function that re-initializes the map.

### Adapters accept AbortSignal

Every SDK call should accept an `AbortSignal` passed from the route handler. For streaming, this is the mechanism by which downstream disconnect aborts the upstream SDK call. Both `groq-sdk` and `cerebras_cloud_sdk` SDK calls accept standard `signal` options.

### Flat root-level structure (not src/)

Matches the project constraint. Directories (`routes/`, `middleware/`, `routing/`, `providers/`, `services/`, `schemas/`, `utils/`) sit directly at the repo root alongside `index.ts`, `config.ts`, `types.ts`.

---

## Sources

- Bun SSE + async generator docs: https://github.com/oven-sh/bun/blob/main/docs/guides/http/sse.mdx (Context7 /oven-sh/bun — HIGH confidence)
- Bun.serve() routing patterns: https://github.com/oven-sh/bun/blob/main/docs/runtime/http/routing.mdx (Context7 /oven-sh/bun — HIGH confidence)
- Bun streaming docs: https://github.com/oven-sh/bun/blob/main/docs/runtime/streams.mdx (Context7 /oven-sh/bun — HIGH confidence)
- Bun server.timeout for streaming: https://github.com/oven-sh/bun/blob/main/docs/runtime/http/server.mdx (Context7 /oven-sh/bun — HIGH confidence)
- Refactor spec architecture section (§21–23): refactor.md in project root
- Current architecture analysis: .planning/codebase/ARCHITECTURE.md
