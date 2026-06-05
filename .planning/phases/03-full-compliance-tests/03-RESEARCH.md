# Phase 3: Full Compliance + Tests — Research

**Researched:** 2026-06-05
**Domain:** Response normalization, structured observability, bun:test integration suite with mocked adapters
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: Real server + mocked adapters.** Integration suite boots a real `Bun.serve()` instance (random port) and asserts via `fetch()` — full HTTP path including headers, SSE wire format, and status codes exactly as clients see them. Provider adapters are mocked; SDKs never hit the network.
- **D-02: `createServer(adapters)` factory seam.** Refactor `index.ts` to export a `createServer(adapters)` factory returning the server (or `Bun.serve` config); the entrypoint calls it with real adapters. Tests call it with mock adapters on port 0. This also fixes the "server starts on import" problem.
- **D-03: `setSystemTime()` for cooldown expiry.** TEST-03 uses `bun:test`'s `setSystemTime()` fake clock to jump past `cooldownUntil` — deterministic, no real waiting. Cooldown logic already reads `Date.now()`, no refactor needed.
- **D-04: Mocked only — no live tests in suite.** `bun test` is 100% deterministic: no quota burn, runs offline. Live verification against real Cerebras/Groq stays manual (curl, as in Phase 1/2 verification).
- **D-05: Central normalizer module.** New `response-normalizer.ts` (spec §21): one function for non-streaming bodies, one for streaming chunks. Adapters return raw SDK output; normalizer applied at the route layer. Single place to test NORM-01..09; both providers share one path. Fold the existing inline model-rewrite in `index.ts` stream relay and the inline Cerebras stripping into this module.
- **D-06: Allowlist-rebuild.** Normalizer constructs a clean response containing ONLY known OpenAI fields (`id`, `object`, `created`, `model`, `choices`, `usage`, `system_fingerprint`; choices: `index`, `message`/`delta`, `finish_reason`; message/delta: `role`, `content`, `tool_calls`). Unknown or future provider fields can never leak — satisfies success criterion 1 by construction.
- **D-07: Upstream error passthrough + ID rewrite.** Upstream provider error messages pass through (wrapped in OpenAI error shape per NORM-10), but known upstream model IDs in the message text are rewritten back to the logical alias before sending. Preserves "no raw provider model IDs appear in any response."
- **D-08: Missing usage → synthesize zeros + warn log.** If upstream omits `usage` on a non-streaming response, emit `{prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}` and log a warning. NORM-08 always holds; anomaly visible in logs.

### Claude's Discretion

- **Test file layout** — current state is mixed (`request-schema.test.ts` co-located at root; `tests/routing/*.test.ts` mirror dir). Planner picks a consistent convention; spec §21 suggests `tests/unit` + `tests/integration` but consolidation extent is discretionary.
- **X-Request-ID semantics** — generate per request (OBS-01 says UUID per request); whether to honor an inbound `X-Request-ID` is discretionary.
- **Logger shape** — keep `console.log(JSON.stringify(...))` or extract a small logger util with `LOG_LEVEL` gating; either is fine as long as OBS-02..04 fields/redactions hold.
- **Stream latency definition** in logs (TTFB vs total duration) — pick one and log it consistently.
- **Mock adapter design** — scriptable per-test responses (200/429 with headers/500/SSE chunk sequences) shaped however fits the `createServer` seam.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NORM-01 | `model` rewritten to logical alias in non-streaming responses | §Normalizer: allowlist-rebuild pattern; `response-normalizer.ts` |
| NORM-02 | `model` rewritten in every streaming chunk | §Normalizer: streaming chunk normalizer function |
| NORM-03 | Cerebras `choices[*].message.reasoning` stripped | §Normalizer: allowlist-rebuild excludes unknown fields by construction |
| NORM-04 | Cerebras `choices[*].reasoning_logprobs` stripped | §Normalizer: same — not in allowlist |
| NORM-05 | Cerebras `time_info` top-level field stripped | §Normalizer: same — not in allowlist |
| NORM-06 | Cerebras `delta.reasoning` stripped from streaming chunks | §Normalizer: chunk normalizer omits non-allowlisted delta fields |
| NORM-07 | Groq `x_groq`, `usage_breakdown` stripped | §Normalizer: same — allowlist-rebuild |
| NORM-08 | `usage` present in non-streaming responses (synthesize zeros if missing) | §D-08 pattern |
| NORM-09 | `object` exact: `"chat.completion"` / `"chat.completion.chunk"` | §Normalizer enforces literal type |
| NORM-10 | Error responses always `{ "error": { "message", "type", "code", "param" } }` | §openaiError() sweep + NORM-10 audit |
| OBS-01 | `X-Request-ID` header on every response | §X-Request-ID injection pattern |
| OBS-02 | Structured JSON log per request (required fields, no secrets) | §Structured Logging pattern |
| OBS-03 | Cooldown/failover events logged | Already present in index.ts; extend with requestId |
| OBS-04 | No keys/prompts/responses/reasoning in logs | §Logging redaction rules |
| OBS-05 | Optional `X-LLM-Provider` header (`EXPOSE_PROVIDER_HEADER`) | §OBS-05 pattern |
| TEST-01 | Alternating provider selection | §Integration test: adapter injection via createServer |
| TEST-02 | 429 triggers cooldown, subsequent go to alternate | §Integration test: mock adapter throws APIError-like with status 429 |
| TEST-03 | Provider recovers after cooldown expiry | §setSystemTime() fake clock pattern |
| TEST-04 | 500/502/503/504 trigger failover | §Integration test: mock adapter throws on first call |
| TEST-05 | Both-provider exhaustion returns 503 | §Integration test: both mocks always throw |
| TEST-06 | Invalid auth returns 401 | §Integration test: missing/wrong Authorization header |
| TEST-07 | Unknown alias returns 400 | §Integration test: model="does-not-exist" |
| TEST-08 | Unsupported fields return 400 | §Integration test: logprobs, n=2, messages[].name |
| TEST-09 | Non-streaming response shape validated | §Integration test: id, object, model, choices, usage present |
| TEST-10 | Streaming SSE format validated, [DONE] present | §SSE reading pattern in tests |
| TEST-11 | Upstream model ID rewritten to logical alias | §Integration test: mock returns upstream ID; assert response.model === alias |
| TEST-12 | Provider state reset between tests | §resetForTesting() + beforeEach pattern |
</phase_requirements>

---

## Summary

Phase 3 delivers the three remaining columns of MVP completeness: (1) response normalization that strips all provider-specific fields by allowlist-rebuild, (2) X-Request-ID + structured JSON logging on every response path, and (3) a 12-case integration test suite that exercises the full HTTP path with mocked adapters rather than real SDK calls.

The critical enabling refactor is `createServer(adapters)` (D-02): the current `index.ts` calls `Bun.serve()` at module load time with hardwired `cerebrasAdapter` and `groqAdapter`. Extracting a factory function that accepts an adapter map as a parameter makes the server testable — tests pass in scriptable mock adapters on `port: 0`, get back a `Server` object, call the test, then stop the server. The entrypoint (`index.ts`) calls `createServer({ cerebras: cerebrasAdapter, groq: groqAdapter })` exactly as before.

The normalization architecture (D-05 + D-06) is the safest possible design: a `response-normalizer.ts` module reconstructs responses field-by-field from an allowlist. The Cerebras adapter currently strips `reasoning` and `time_info` inline (noted in comments at lines 48-49 of `services/cerebras.ts`); this logic moves to the normalizer and is deleted from the adapter. The inline model-rewrite in the stream relay (`index.ts:295`) and the inline `result.model = input.model` in the non-streaming path (`index.ts:339`) are also folded into the normalizer. One place to update, one place to test.

The test suite (D-01) uses `bun:test`'s `setSystemTime()` for cooldown time travel (TEST-03), `beforeEach(() => resetForTesting())` for state isolation (TEST-12), and SSE stream reading via `ReadableStream.getReader()` for streaming assertions (TEST-10). No new packages are needed.

**Primary recommendation:** Implement in three waves — Wave 1: `response-normalizer.ts` + `createServer` refactor + observability headers (NORM-01..10, OBS-01..05); Wave 2: integration test file covering TEST-01..12; Wave 3: verify + sweep all error paths for NORM-10 compliance.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Non-streaming body normalization | `response-normalizer.ts` | `index.ts` (calls normalizer) | Central module; both adapters feed into it |
| Streaming chunk normalization | `response-normalizer.ts` | `index.ts` (stream relay calls normalizer per chunk) | Replaces inline model-rewrite + fold Cerebras inline strip |
| Error body shape (NORM-10) | `index.ts` (`openaiError()`) | All error paths | Helper already exists; audit for completeness |
| X-Request-ID generation | `index.ts` (top of `fetch` handler) | — | Request-scoped; generated once, passed through |
| X-Request-ID attachment | `index.ts` (all response construction sites) | — | Must attach to EVERY Response constructor |
| Structured JSON log | `index.ts` | optional `logger.ts` utility | Current `console.log(JSON.stringify(...))` pattern extended |
| X-LLM-Provider header | `index.ts` (non-streaming + streaming response) | — | Conditional on `config.exposeProviderHeader` |
| Integration test server | `tests/integration/server.test.ts` | — | `createServer(mocks)` factory, port 0, fetch against real HTTP |
| Mock adapter definitions | `tests/integration/server.test.ts` or shared `tests/helpers/adapters.ts` | — | Scriptable per-test; typed as `ProviderAdapter` |
| Provider state isolation | `routing/provider-state.ts` (`resetForTesting()`) | `beforeEach` in test file | Already exists; tests must call it |
| Fake clock for cooldown tests | `bun:test` `setSystemTime()` | — | Date.now() already used in eligibility check; no code change |

---

## Standard Stack

### Core (all already installed — no new packages)

| Library | Version (installed) | Purpose | Phase 3 Usage |
|---------|--------------------|---------|-|
| `bun:test` | built-in (Bun 1.3.11) | Test runner + assertions + mocking | `describe`, `test`, `expect`, `beforeEach`, `afterEach`, `mock`, `setSystemTime` |
| `@cerebras/cerebras_cloud_sdk` | 1.64.1 | Cerebras types for mock adapter shape | `APIError` type for mock throws in TEST-02..05 |
| `groq-sdk` | 1.2.1 | Groq types for mock adapter shape | Same |
| `zod` | 4.4.3 | Request validation (unchanged) | No changes in Phase 3 |

[VERIFIED: local node_modules — `bun test` currently runs 39 tests across 3 files at 129ms]

No new npm packages are required for Phase 3. All normalization, observability, and test infrastructure uses Bun built-ins and the already-installed SDKs.

---

## Package Legitimacy Audit

No new packages are installed in Phase 3. This section is not applicable.

---

## Architecture Patterns

### System Architecture Diagram

```
Downstream Client
        |
        | POST /v1/chat/completions  (Bearer token)
        v
index.ts — createServer(adapters) factory
    |-- request ID generated (crypto.randomUUID())    [OBS-01]
    |-- auth gate (unchanged)
    |-- Zod validation (unchanged)
    |-- alias resolution (unchanged)
    |
    v
chooseEligibleProviders()  [routing/provider-state.ts — unchanged]
    |
    | for each provider attempt:
    |   adapter.complete() or adapter.stream()
    |   on success:
    |     normalizeResponse(result, logicalAlias)      [response-normalizer.ts — NORM-01..09]
    |     OR normalizeChunk(chunk, logicalAlias) per yield [NORM-02,06]
    |   on error:
    |     wrap in openaiError() shape                  [NORM-10]
    |
    v
Response construction
    |-- attach X-Request-ID header                    [OBS-01]
    |-- attach X-LLM-Provider header if enabled       [OBS-05]
    |-- emit structured JSON log                      [OBS-02..04]
    v
Downstream Client

NORMALIZER MODULE (response-normalizer.ts):
    normalizeResponse(raw: ChatCompletionResult, alias: string): ChatCompletionResult
        → builds clean object with ONLY: id, object, created, model(=alias),
          choices[]{index, message{role,content}, finish_reason}, usage, system_fingerprint?

    normalizeChunk(raw: StreamChunk, alias: string): StreamChunk
        → builds clean chunk with ONLY: id, object, created, model(=alias),
          choices[]{index, delta{role?,content?}, finish_reason}

TEST SEAM (createServer factory):
    createServer(adapters: Record<Provider, ProviderAdapter>): Server
        → current Bun.serve() call wrapped in function
        → tests call with mock adapters, port: 0
        → after each test, call server.stop()
```

### Recommended Project Structure

```
index.ts                      # import createServer; call with real adapters; export nothing else
response-normalizer.ts        # NEW: normalizeResponse(), normalizeChunk()
routing/
  provider-state.ts           # unchanged (resetForTesting() already there)
  cooldown-manager.ts         # unchanged
services/
  cerebras.ts                 # remove inline reasoning/time_info comments (normalizer owns it)
  groq.ts                     # no changes
request-schema.ts             # no changes
config.ts                     # no changes
types.ts                      # no changes (ChatCompletionResult + StreamChunk already defined)
tests/
  routing/
    provider-state.test.ts    # existing — 10 tests, passing
    cooldown-manager.test.ts  # existing — passing
  integration/
    server.test.ts            # NEW: 12 integration test cases (TEST-01..12)
request-schema.test.ts        # existing — 13 unit tests, passing (at root — leave in place)
```

### Pattern 1: `createServer(adapters)` Factory Seam (D-02)

**What:** Extract `Bun.serve()` call from module top level into an exported factory function. Entrypoint behavior unchanged; tests get a fresh server per test file.

**When to use:** Any time the test suite needs to boot the real server with mock adapters.

```typescript
// Source: D-02 decision + bun-types/docs/test lifecycle pattern
// index.ts — BEFORE (current Phase 2):

const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(request, server) { ... },
});
console.log(`Server is running on ${server.url}`);

// index.ts — AFTER (Phase 3):

import type { Server } from 'bun';
import type { Provider } from './routing/provider-state';
import type { ProviderAdapter } from './types';

export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port = config.port
): Server {
    return Bun.serve({
        hostname: config.hostname,
        port,
        async fetch(request, server) {
            // ...all handler logic, using `adapters` instead of hardwired adapterMap
        },
    });
}

// Bottom of file — entrypoint only when run directly:
// (Bun has no require.main === module; use top-level call outside function)
const server = createServer({ cerebras: cerebrasAdapter, groq: groqAdapter });
console.log(`Server is running on ${server.url}`);
```

**Port 0 usage in tests:**

```typescript
// Source: bun-types/docs/test/lifecycle.mdx server setup pattern
// tests/integration/server.test.ts

import { beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer } from '../../index';
import { resetForTesting } from '../../routing/provider-state';

let server: ReturnType<typeof createServer>;
const PROXY_KEY = 'test-proxy-key';

// Set env before importing config-dependent modules
process.env['PERSONAL_PROXY_API_KEY'] = PROXY_KEY;
process.env['CEREBRAS_API_KEY'] = 'test-cerebras-key';
process.env['GROQ_API_KEY'] = 'test-groq-key';

beforeAll(() => {
    server = createServer(makeMockAdapters(), 0); // port 0 = OS assigns free port
});

afterAll(() => {
    server.stop(true); // force-close connections
});

beforeEach(() => {
    resetForTesting(); // TEST-12: state isolation
});

function url(path: string): string {
    return `http://${server.hostname}:${server.port}${path}`;
}
```

**Critical:** `port: 0` makes Bun assign a random free port. Read it back from `server.port`. [VERIFIED: node_modules/bun-types/serve.d.ts — `port` property on `Server`]

### Pattern 2: Response Normalizer — Allowlist Rebuild (D-05, D-06)

**What:** Pure functions that construct clean OpenAI-shaped objects from raw adapter output. Field omission is the stripping mechanism — no delete, no spread-then-delete. Unknown fields from any provider can never appear.

**When to use:** Immediately after adapter returns result (non-streaming), and per-chunk in the stream relay (streaming).

```typescript
// Source: CONTEXT.md D-05/D-06 + types.ts field definitions
// response-normalizer.ts

import type { ChatCompletionResult, StreamChunk } from './types';

// NORM-01, NORM-03..05, NORM-07..09: allowlist-rebuild for non-streaming
export function normalizeResponse(
    raw: ChatCompletionResult,
    logicalAlias: string
): ChatCompletionResult {
    return {
        id: raw.id,
        object: 'chat.completion',                    // NORM-09: enforce exact literal
        created: raw.created,
        model: logicalAlias,                          // NORM-01: rewrite to alias
        choices: raw.choices.map((c) => ({
            index: c.index,
            message: {
                role: c.message.role,
                content: c.message.content,
                // tool_calls: c.message.tool_calls,  // omit until tool calling enabled
            },
            finish_reason: c.finish_reason,
        })),
        usage: raw.usage ?? {                         // NORM-08: synthesize zeros if missing
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
        // system_fingerprint: included only if present (optional field)
        ...(raw.system_fingerprint !== undefined
            ? { system_fingerprint: raw.system_fingerprint }
            : {}),
    };
}

// NORM-02, NORM-06, NORM-07: allowlist-rebuild for streaming chunks
export function normalizeChunk(
    raw: StreamChunk,
    logicalAlias: string
): StreamChunk {
    return {
        id: raw.id,
        object: 'chat.completion.chunk',              // NORM-09: enforce exact literal
        created: raw.created,
        model: logicalAlias,                          // NORM-02: rewrite alias in every chunk
        choices: raw.choices.map((c) => {
            // Build delta with only allowlisted fields (NORM-06: no delta.reasoning)
            const delta: StreamChunk['choices'][number]['delta'] = {};
            if (c.delta.role !== undefined) delta.role = c.delta.role;
            if ('content' in c.delta) delta.content = c.delta.content ?? null;
            return {
                index: c.index,
                delta,
                finish_reason: c.finish_reason,
            };
        }),
    };
}
```

**Integration with `index.ts` (replacing current inline rewrites):**

```typescript
// Non-streaming path (replaces result.model = input.model at line 339):
const normalized = normalizeResponse(result, input.model);
return new Response(JSON.stringify(normalized), { ... });

// Streaming path (replaces { ...chunk, model: input.model } at line 295):
const normalized = normalizeChunk(chunk, input.model);
if (!hasVisibleChunkData(normalized)) continue;
yield `data: ${JSON.stringify(normalized)}\n\n`;
```

### Pattern 3: X-Request-ID Generation and Attachment (OBS-01)

**What:** Generate a UUID at the top of the fetch handler and attach it to every Response via a shared header builder.

**When to use:** Every response path — success, 400, 401, 503, streaming, error.

```typescript
// Source: OBS-01 requirement + Bun built-in crypto.randomUUID()
// index.ts — top of fetch handler

async fetch(request: Request, server: Server) {
    const requestId = crypto.randomUUID();   // built-in in Bun (Web Crypto API)
    const { pathname } = new URL(request.url);

    // Helper to attach X-Request-ID to any Response
    function withRequestId(response: Response): Response {
        response.headers.set('X-Request-ID', requestId);
        return response;
    }

    // --- all routes use withRequestId() on every return ---
    if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        return withRequestId(new Response('ok', { status: 200 }));
    }
    // ... every other return path:
    return withRequestId(openaiError(...));
}
```

**Alternative approach (headers object — avoids header mutation):**

Rather than calling `response.headers.set()` on an immutable Response, construct all Responses with an explicit headers object that includes `X-Request-ID`:

```typescript
// Helper that wraps openaiError to include X-Request-ID:
function openaiError(
    message: string, type: string, code: string | number,
    param: string | null = null, status: number = 400,
    extraHeaders: Record<string, string> = {}
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } }
    );
}
// Call site: openaiError('...', '...', '...', null, 401, { 'X-Request-ID': requestId })
```

The `withRequestId(response)` wrapper approach is cleaner — one mutation point rather than threading `requestId` into every call site. [ASSUMED: Bun Response headers are mutable after construction — verify against bun-types if TypeScript errors appear]

**Streaming responses:** Attach X-Request-ID in the streaming `Response` headers object, not after construction (headers are committed at Response construction time):

```typescript
return new Response(body, {
    status: 200,
    headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-ID': requestId,             // OBS-01: attach here
        ...(config.exposeProviderHeader         // OBS-05: conditional provider header
            ? { 'X-LLM-Provider': chosenProvider }
            : {}),
    },
});
```

### Pattern 4: Structured JSON Logging (OBS-02..04)

**What:** Extend current `console.log(JSON.stringify({...}))` calls to include required OBS-02 fields on every request completion. Never log secrets, prompts, or reasoning.

**When to use:** End of each handled request (non-streaming: after response built; streaming: after stream completes or errors).

```typescript
// Source: OBS-02 field list + OBS-04 redaction rules + CLAUDE.md §19
// Required fields for every request log entry:
console.log(JSON.stringify({
    requestId,                           // OBS-02
    timestamp: new Date().toISOString(), // OBS-02
    route: pathname,                     // OBS-02
    logicalAlias: input.model,           // OBS-02 "logical model alias"
    provider: chosenProvider,            // OBS-02
    upstreamModelId,                     // OBS-02
    attempt: attemptNumber,              // OBS-02 "provider attempt number"
    streaming: input.stream === true,    // OBS-02
    statusCode: 200,                     // OBS-02
    latencyMs: Date.now() - requestStart,// OBS-02 "latency"
    failoverReason: failoverReason ?? null, // OBS-02
    // usage is safe to log (token counts, not content)
    usage: result.usage,
    // NEVER log: Authorization header, API keys, messages, choices content, reasoning
}));
```

**LOG_LEVEL gating (Claude's Discretion — keep simple):**

```typescript
// Minimal logger — avoids a separate logger.ts file:
function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
    const levels = { error: 0, warn: 1, info: 2 };
    const configLevel = levels[config.logLevel as keyof typeof levels] ?? 2;
    if (levels[level] <= configLevel) {
        console.log(JSON.stringify({ level, ...data }));
    }
}
```

**OBS-03: cooldown and failover events** — already in `index.ts` (`provider_cooldown`, `provider_failover` events). Add `requestId` to these event objects to link them to the request log entry.

**OBS-04: Never log:**
- `request.headers.get('Authorization')` — never
- `config.cerebrasApiKey`, `config.groqApiKey`, `config.personalProxyApiKey` — never
- `input.messages` — never (full prompt content)
- `result.choices[*].message.content` — never (full response content)
- Any field named `reasoning` or `reasoning_logprobs` — never

### Pattern 5: NORM-10 Sweep — Error Body Audit

**What:** Every error path in `index.ts` must return `openaiError()` — never a flat body or raw `new Response(...)` with plain text.

**Current error paths to verify (line references from Phase 2 index.ts):**

| Line | Path | Uses openaiError()? |
|------|------|---------------------|
| 94 | `/health` 200 | N/A (not an error) |
| 170 | JSON parse failure | Yes |
| 176-183 | Zod validation failure | Yes |
| 188-196 | Unknown alias | Yes |
| 213-220 | No eligible provider (pre-streaming) | Yes |
| 244-251 | Streaming adapter non-failover error | Yes |
| 277-285 | Streaming no-provider-available | Yes |
| 349-356 | Non-streaming adapter non-failover error | Yes |
| 383-390 | Non-streaming exhaustion | Yes |
| 392 | 404 catch-all | NO — `new Response('Not found', { status: 404 })` |

The 404 catch-all at line 392 must be wrapped in `openaiError()` for NORM-10 compliance. Additionally, `X-Request-ID` must attach even to the 404 path.

### Pattern 6: Integration Test Structure — `createServer` + Mock Adapters

**What:** Boot the real HTTP server with scriptable mock adapters. Assertions made via real `fetch()` calls.

**Key design decisions for mock adapters:**

The mock adapter must conform to the `ProviderAdapter` interface from `types.ts`:

```typescript
// Source: types.ts ProviderAdapter interface + D-01/D-02 decisions
export interface ProviderAdapter {
    name: string;
    complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome>;
    stream(upstreamModelId: string, params: CompletionParams, signal: AbortSignal): Promise<AsyncIterable<StreamChunk>>;
}
```

**Mock adapter factory pattern:**

```typescript
// Source: bun:test mock() + CONTEXT.md D-01 decisions
import { mock } from 'bun:test';
import type { ProviderAdapter, CompletionOutcome, StreamChunk } from '../../types';

// Factory returns a ProviderAdapter with a scriptable .complete mock
function makeMockAdapter(name: string): ProviderAdapter & {
    completeMock: ReturnType<typeof mock>;
} {
    const completeMock = mock(async (): Promise<CompletionOutcome> => ({
        result: {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: name === 'cerebras' ? 'gpt-oss-120b' : 'openai/gpt-oss-120b', // upstream IDs
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        headers: new Headers(),
    }));

    return {
        name,
        complete: completeMock,
        stream: mock(async function* (): Promise<AsyncIterable<StreamChunk>> {
            yield* (async function* () {
                yield {
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk' as const,
                    created: Math.floor(Date.now() / 1000),
                    model: name === 'cerebras' ? 'gpt-oss-120b' : 'openai/gpt-oss-120b',
                    choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
                };
            })();
        }),
        completeMock,
    };
}
```

**Per-test mock scriptability (for failover/cooldown tests):**

```typescript
// For TEST-02 (429 triggers cooldown):
// Use mockImplementationOnce to make first call throw, second succeed
import { APIError as GroqAPIError } from 'groq-sdk';

cerebrasMock.complete.mockImplementationOnce(async () => {
    const error = new GroqAPIError(429, undefined, 'rate limited', new Headers({
        'retry-after': '30',
    }));
    throw error;
});
// Second call (to groq) succeeds via default implementation
```

### Pattern 7: SSE Stream Reading in Tests (TEST-10)

**What:** Consume SSE response body in a test, collect all `data:` lines, assert format and [DONE] sentinel.

```typescript
// Source: bun:test async test pattern + CONTEXT.md D-01
// tests/integration/server.test.ts

test("TEST-10: streaming SSE format validated, [DONE] present", async () => {
    const res = await fetch(url('/v1/chat/completions'), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PROXY_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-oss-120b-balanced',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('X-Request-ID')).toBeTruthy(); // OBS-01

    // Collect all SSE lines
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));

    // Assert [DONE] sentinel is last data line (STREAM-06)
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBe('data: [DONE]');

    // Assert at least one chunk with correct shape
    const dataLines = lines.filter(l => l !== 'data: [DONE]');
    expect(dataLines.length).toBeGreaterThan(0);
    const chunk = JSON.parse(dataLines[0]!.slice(6)); // strip "data: "
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.model).toBe('gpt-oss-120b-balanced'); // NORM-02: alias, not upstream ID
});
```

**Important:** `await res.text()` buffers the full SSE body — acceptable for testing (the test doesn't care about TTFB). The production relay path is non-buffering via async generator. [VERIFIED: bun:test pattern — `Response.text()` available in Bun]

### Pattern 8: `setSystemTime()` for Cooldown Recovery (TEST-03)

**What:** Advance `Date.now()` past `cooldownUntil` without real waiting.

**Key fact:** `setSystemTime()` in `bun:test` affects `Date.now()` which is what `isEligible()` reads in `routing/provider-state.ts:32`. No refactor needed. [VERIFIED: node_modules/bun-types/docs/test/dates-times.mdx]

```typescript
// Source: bun-types/docs/test/dates-times.mdx + provider-state.ts isEligible()
import { setSystemTime } from 'bun:test';

test("TEST-03: provider recovers after cooldown expiry", async () => {
    // Arrange: trigger a 429 on cerebras so it cools down
    // (use mockImplementationOnce to throw 429, then succeed)
    const before = Date.now();
    cerebrasMock.complete.mockImplementationOnce(async () => {
        throw new GroqAPIError(429, undefined, 'rate limited', new Headers({ 'retry-after': '60' }));
    });

    // First request routes to groq (cerebras cooled down)
    await fetch(url('/v1/chat/completions'), { ...requestOpts });

    // Advance time past cooldown
    setSystemTime(new Date(before + 61_000)); // 61 seconds forward

    // Cerebras is now eligible again
    // Next request should alternate back to cerebras
    const res = await fetch(url('/v1/chat/completions'), { ...requestOpts });
    expect(res.status).toBe(200);

    // Clean up fake clock after test
    setSystemTime(); // reset to real time
});
```

**Critical:** Call `setSystemTime()` (no args) in `afterEach` or at end of TEST-03 to restore real time — otherwise subsequent tests see frozen time. [VERIFIED: bun-types/docs/test/dates-times.mdx]

### Pattern 9: Mock Adapter Throws for Failover Tests (TEST-02, TEST-04, TEST-05)

**What:** Use `mockImplementationOnce` to make mock adapters throw `APIError`-shaped errors on first call, simulating 429 or 5xx from a provider.

```typescript
// Source: bun:test mock.mockImplementationOnce() + groq-sdk/cerebras error classes
import { APIError as GroqAPIError } from 'groq-sdk';
import { APIError as CerebrasAPIError } from '@cerebras/cerebras_cloud_sdk';

// TEST-04: 500 triggers failover
cerebrasMock.complete.mockImplementationOnce(async () => {
    throw new CerebrasAPIError(500, undefined, 'Internal Server Error', undefined);
});
// groq mock uses default (success) implementation — request succeeds via failover
const res = await fetch(...);
expect(res.status).toBe(200);
const body = await res.json();
expect(body.model).toBe('gpt-oss-120b-balanced'); // routed to groq

// TEST-05: both providers exhausted
cerebrasMock.complete.mockImplementation(async () => {
    throw new CerebrasAPIError(500, undefined, 'down', undefined);
});
groqMock.complete.mockImplementation(async () => {
    throw new GroqAPIError(500, undefined, 'down', undefined);
});
const res = await fetch(...);
expect(res.status).toBe(503);
const body = await res.json();
expect(body.error.code).toBe('no_provider_available');

// Restore defaults in afterEach via resetForTesting() + mock.clearAllMocks()
```

### Pattern 10: `mock.module()` — NOT USED (adapter injection preferred)

**What:** `mock.module('./services/cerebras', ...)` is the Phase 2 RESEARCH suggestion, but D-02 supersedes it. With the `createServer(adapters)` factory, tests inject mock adapters at the function call level — no module-level patching needed. This is cleaner and avoids the hoisting/side-effect complexities described in the bun:test mocks documentation.

**Why adapter injection beats `mock.module()`:**
- No preload file needed
- Mock adapters typed as `ProviderAdapter` — TypeScript catches shape errors
- Each test controls its own adapter behavior via `mockImplementationOnce`
- Module side effects (config loading, SDK client creation) never occur in tests

### Anti-Patterns to Avoid

- **Spreading raw SDK response then deleting fields:** `const clean = { ...rawSdkResponse }; delete clean.time_info;` — fields can accumulate over SDK updates. Allowlist-rebuild makes it impossible for unknown fields to leak.
- **Setting `response.headers.set()` after `new Response()` on streaming:** Headers are committed at construction time for streaming responses. X-Request-ID and X-LLM-Provider must go into the headers object passed to `new Response(body, { headers: {...} })`.
- **Logging `err` objects directly:** An `err instanceof APIError` has `.headers` which may contain provider Authorization echoes. Log only `err.status` and `err.message` — never `err.headers` or the full error object.
- **Calling `setSystemTime()` without resetting:** If TEST-03 sets fake time and doesn't restore it, subsequent tests run with stale time — cooldowns never expire, or always expire. Always call `setSystemTime()` (no args) to restore.
- **Port collision in parallel test files:** `port: 0` lets Bun pick a free port per server instance. Never hardcode a test port. Read `server.port` after startup.
- **`mock.clearAllMocks()` without `resetForTesting()`:** Clearing mock call history does not reset provider routing state. Both are needed in `beforeEach`.
- **`response.text()` on streaming response mid-stream:** `res.text()` works fine in tests because the stream completes before the assertion. Do NOT use streaming `ReadableStreamDefaultReader` unless you specifically need to test streaming behavior — `res.text()` is simpler and correct for shape validation.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UUID generation | Custom random ID generator | `crypto.randomUUID()` (built-in Web Crypto) | Available in Bun; produces RFC 4122 v4 UUID; zero dependencies |
| Field stripping | `delete obj.field` loops | Allowlist-rebuild function (Pattern 2) | Delete is fragile — new SDK fields appear silently; rebuild cannot leak |
| Mock network layer | Custom HTTP interceptor | `createServer(adapters)` with mock adapters | Proper HTTP path including headers, status, SSE; cheaper than intercepting at HTTP level |
| Time travel | `sleep(61000)` in TEST-03 | `setSystemTime()` from `bun:test` | No waiting; deterministic; already verified to affect `Date.now()` |
| SSE parser | Custom `text/event-stream` decoder | `res.text()` split on `\n` | SSE format is simple; full SSE parser is overkill for validation |
| Error subclass hierarchy | Custom error types | Wrap in `openaiError()` at catch sites | `openaiError()` already exists and produces the correct shape |

**Key insight:** Phase 3 is primarily about connecting existing parts, not building new infrastructure. The normalizer is a pure function that constructs a new object — the hardest part is resisting the urge to complicate it.

---

## Common Pitfalls

### Pitfall 1: `Bun.serve()` Port Binding on Import (createServer refactor)

**What goes wrong:** Current `index.ts` calls `Bun.serve()` at module top level. Importing `index.ts` in a test file immediately binds to `config.port` (3000). Multiple test files fail to start their own server instance.

**Why it happens:** Bun evaluates module side effects on import. There is no "dry import" mode.

**How to avoid:** The `createServer(adapters)` refactor (D-02) wraps `Bun.serve()` in a function. Importing `createServer` from `index.ts` has no side effects. The entrypoint call at the bottom of `index.ts` runs only when the module is the entry point, not when imported. In Bun, there is no `require.main === module` equivalent — instead, restructure so the `Bun.serve()` call is always inside `createServer()`, and the top-level call at the bottom of `index.ts` is left bare (only runs when `bun index.ts` is invoked directly).

**Warning signs:** TypeScript sees `const server = Bun.serve(...)` at module scope; tests observe port-in-use errors or two servers on the same port.

### Pitfall 2: X-Request-ID Missing on Some Paths

**What goes wrong:** X-Request-ID is attached to the happy path and the common error paths, but the 404 catch-all, the `/health` route, or the `/ready` route returns a Response without the header.

**Why it happens:** OBS-01 says "every response" — easy to miss non-OpenAI paths that don't go through `openaiError()`.

**How to avoid:** Generate `requestId` at the very top of the `fetch` handler (before any branching). Use a `withRequestId(response)` helper that wraps every return site, or audit all `return new Response(...)` calls and verify the headers object includes `'X-Request-ID': requestId`.

**Warning signs:** TEST-06 (auth rejection) and TEST-07 (alias rejection) verify `X-Request-ID` on error responses — if those fail on the header check, a path was missed.

### Pitfall 3: `setSystemTime` Leaking Between Tests

**What goes wrong:** TEST-03 sets a future time to expire the cooldown. Subsequent tests in the file see `Date.now()` returning that future value — cooldowns that are set with `Date.now() + 60_000` immediately expire.

**Why it happens:** `setSystemTime()` affects the global `Date` for the entire process until reset.

**How to avoid:** Call `setSystemTime()` (no args = reset to real time) in an `afterEach` hook scoped to the cooldown test, OR at the end of TEST-03 itself. Prefer `afterEach` to guarantee cleanup even on test failure.

**Warning signs:** TEST-01 or TEST-02 (which run after TEST-03 if tests are sequential) show unexpected cooldown states.

### Pitfall 4: Non-Streaming 404 Missing `openaiError()` Shape

**What goes wrong:** The 404 catch-all at `index.ts:392` returns `new Response('Not found', { status: 404 })` — a flat string body, not `{ error: { message, type, code, param } }`.

**Why it happens:** The catch-all was written before NORM-10 was a requirement; it predates the compliance pass.

**How to avoid:** In Phase 3, change `return new Response('Not found', { status: 404 })` to `return withRequestId(openaiError('Not found', 'invalid_request_error', 'not_found', null, 404))`.

**Warning signs:** NORM-10 compliance check — any route that returns a `404` with a non-JSON body fails.

### Pitfall 5: `mock.module()` Hoisting with `createServer` Import

**What goes wrong:** If `mock.module('./services/cerebras', ...)` is called AND `createServer` is imported from `index.ts`, the original module has already been evaluated (singleton SDK clients created, config read). The mock patches the exported adapter reference but the SDK client singleton may already be initialized.

**Why it happens:** Module evaluation order in ESM.

**How to avoid:** D-02 eliminates this pitfall entirely. Adapter injection via `createServer(adapters)` means no module-level patching is ever needed. Tests never call `mock.module('./services/cerebras', ...)`.

### Pitfall 6: `usage` Synthesis Warning Log Leaking Content

**What goes wrong:** D-08 says "emit warning log" when `usage` is missing. A naive log statement might include `result` or `params` in the log object, leaking prompt content.

**How to avoid:** Log only the fact that usage was missing, the provider, and the request ID. Never log the completion result or the messages:

```typescript
// Safe:
log('warn', { event: 'usage_missing', provider: chosenProvider, requestId });
// Unsafe:
log('warn', { event: 'usage_missing', result }); // result contains choices with content
```

---

## Code Examples

### Full Request Log Entry (OBS-02 compliant)

```typescript
// Source: CLAUDE.md §19 field list + OBS-04 redaction rules
// Emitted once per completed request at the end of the handler

const requestStart = Date.now(); // set at top of fetch handler

// ... after response is built and before return:
console.log(JSON.stringify({
    requestId,                                      // OBS-02
    timestamp: new Date(requestStart).toISOString(),// OBS-02
    route: `${request.method} ${pathname}`,         // OBS-02
    logicalAlias: input.model,                      // OBS-02
    provider: chosenProvider,                       // OBS-02
    upstreamModelId,                                // OBS-02
    attempt: attemptNumber,                         // OBS-02
    streaming: input.stream === true,               // OBS-02
    statusCode: 200,                                // OBS-02
    latencyMs: Date.now() - requestStart,           // OBS-02 (total duration for non-streaming)
    failoverReason: failoverReason ?? null,         // OBS-02
    usage: normalized.usage,                        // token counts are safe to log
    // NOT LOGGED: messages, choices content, API keys, reasoning
}));
```

### Cooldown Event Log (OBS-03)

```typescript
// Extend existing event with requestId:
console.log(JSON.stringify({
    event: 'provider_cooldown',
    requestId,                  // links to request log
    provider,
    status: classified.status,
    cooldownUntil: new Date(cooldownUntil).toISOString(),
    // NOT LOGGED: classified.headers (may contain auth info)
}));
```

### 404 Catch-All with NORM-10 Compliance

```typescript
// Replaces: return new Response('Not found', { status: 404 });
return withRequestId(openaiError(
    'The requested endpoint does not exist.',
    'invalid_request_error',
    'not_found',
    null,
    404
));
```

### Test: Non-Streaming Response Shape (TEST-09 + TEST-11)

```typescript
// Source: D-01 real server pattern + NORM-01 model alias requirement
test("TEST-09+11: non-streaming shape and model alias rewrite", async () => {
    const res = await fetch(url('/v1/chat/completions'), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PROXY_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-oss-120b-balanced',
            messages: [{ role: 'user', content: 'hi' }],
        }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-ID')).toBeTruthy();   // OBS-01

    const body = await res.json();
    // NORM-09: object literal
    expect(body.object).toBe('chat.completion');
    // NORM-01: model is logical alias, not upstream ID
    expect(body.model).toBe('gpt-oss-120b-balanced');
    // NORM-08: usage always present
    expect(body.usage).toBeDefined();
    expect(typeof body.usage.prompt_tokens).toBe('number');
    expect(typeof body.usage.completion_tokens).toBe('number');
    expect(typeof body.usage.total_tokens).toBe('number');
    // NORM-03..07: provider-specific fields absent
    expect(body.time_info).toBeUndefined();
    expect(body.x_groq).toBeUndefined();
    expect(body.choices[0].message.reasoning).toBeUndefined();
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Inline model-rewrite: `result.model = input.model` | `normalizeResponse(result, alias)` in normalizer | Phase 3 | Single normalization path; Cerebras/Groq share it |
| Inline chunk rewrite: `{ ...chunk, model: input.model }` | `normalizeChunk(chunk, alias)` in normalizer | Phase 3 | Eliminates spread that could carry unknown fields |
| Inline Cerebras strip comments (`services/cerebras.ts:48-49`) | Allowlist-rebuild in normalizer | Phase 3 | Comments → code enforcement |
| No X-Request-ID | UUID per request, attached to every Response | Phase 3 | OBS-01 compliance |
| Sparse `console.log` events | Structured JSON per request with full OBS-02 field set | Phase 3 | OBS-02..04 compliance |
| `Bun.serve()` at module scope | `createServer(adapters)` factory | Phase 3 | Integration tests can boot server with mock adapters |
| 39 passing unit tests | 39 unit + 12 integration = 51 tests | Phase 3 | TEST-01..12 compliance |

**Deprecated/outdated after Phase 3:**
- `result.model = input.model` mutation at `index.ts:339` — replaced by normalizer
- `{ ...chunk, model: input.model }` spread at `index.ts:295` — replaced by normalizer
- `new Response('Not found', { status: 404 })` catch-all — replaced by `openaiError()`

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `Response.headers.set()` is mutable in Bun (for `withRequestId` wrapper) | Pattern 3 | If immutable, use header-in-constructor approach (also documented in Pattern 3 as alternative) — no correctness risk, small refactor |
| A2 | `crypto.randomUUID()` is available as a global in Bun 1.3.11 without any import | Pattern 3 | If not available, use `import { randomUUID } from 'node:crypto'` — 1-line fix |
| A3 | `server.stop(true)` force-closes the server including in-flight connections | Pattern 1 | If server doesn't stop cleanly, `afterAll` hangs. Fallback: `server.stop()` (graceful) then proceed |
| A4 | `APIError` constructors for both SDKs accept `(status, body, message, headers)` positionally | Pattern 9 (mock throws) | If constructor differs, use `Object.create()` or check error.ts in node_modules — already done for cooldown-manager.test.ts which constructs them successfully |

**A4 is LOW risk:** `tests/routing/cooldown-manager.test.ts` already constructs `GroqAPIError` and `CerebrasAPIError` with `(status, undefined, "boom", headers)` in tests that currently pass. [VERIFIED: existing test file, 39/39 passing]

**All other claims VERIFIED from local node_modules or existing passing tests.**

---

## Open Questions (RESOLVED)

1. **Should `withRequestId()` mutate or reconstruct?**
   - What we know: HTTP headers on a `Response` object are writable via `.headers.set()` in browsers. Bun's implementation may or may not mirror this.
   - What's unclear: Whether Bun's `Response.headers` is mutable post-construction.
   - Recommendation: Use the header-in-constructor approach for all non-streaming responses (pass `extraHeaders` to `openaiError()`) and the headers object for streaming responses. This is always safe regardless of mutability. The `withRequestId` wrapper is a convenience shortcut that can be used if TypeScript does not complain.

2. **Should `/health` and `/ready` include X-Request-ID?**
   - What we know: OBS-01 says "every response." `/health` and `/ready` are called by infrastructure health checkers that may not care about X-Request-ID.
   - What's unclear: Whether "every response" includes unauthenticated infrastructure endpoints.
   - Recommendation: Include on all endpoints (including `/health`, `/ready`) for consistency with OBS-01 literal reading. Costs nothing and makes logs traceable.

3. **Test file location — root vs `tests/integration/`?**
   - What we know: `request-schema.test.ts` is at root; `tests/routing/*.test.ts` is in a subdirectory.
   - Recommendation (Claude's discretion): Place the integration test at `tests/integration/server.test.ts`. This follows the spec §21 suggested structure and keeps unit and integration tests clearly separated. Leave `request-schema.test.ts` at root (moving it would change import paths in a passing file — not worth it for Phase 3).

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | Runtime + test runner | Yes | 1.3.11 | — |
| `bun:test` | Integration tests | Yes (built-in) | 1.3.11 | — |
| `setSystemTime` | TEST-03 | Yes (built-in) | verified in docs | — |
| `mock.mockImplementationOnce` | TEST-02..05 | Yes (built-in) | verified in docs | — |
| `crypto.randomUUID()` | OBS-01 X-Request-ID | Assumed yes (Web Crypto global) | — | `import { randomUUID } from 'node:crypto'` |
| `server.port` after `port: 0` | Test URL construction | Assumed yes (Bun Server object) | — | hardcode if not exposed |

**Missing dependencies with no fallback:** None.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `bun:test` (built-in, no install needed) |
| Config file | none — `bun test` discovers `*.test.ts` automatically |
| Quick run command | `bun test tests/integration/` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NORM-01 | model rewritten to alias (non-streaming) | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| NORM-02 | model rewritten in each chunk | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| NORM-03..07 | Provider-specific fields absent | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| NORM-08 | usage present (synthesized if missing) | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| NORM-09 | object exact string values | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| NORM-10 | All errors are `{ error: {...} }` shape | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| OBS-01 | X-Request-ID on every response | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| OBS-02 | Structured log fields (manual verify via console output) | manual | run with `bun test 2>&1 | grep requestId` | — |
| OBS-04 | No secrets in logs | code review | — | — |
| OBS-05 | X-LLM-Provider header when enabled | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| TEST-01..12 | All 12 integration cases | integration | `bun test tests/integration/server.test.ts` | No — Wave 0 |
| NORM-* (unit) | normalizeResponse/normalizeChunk pure functions | unit | `bun test response-normalizer.test.ts` | Optional Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test tests/integration/`
- **Per wave merge:** `bun test`
- **Phase gate:** `bun test` reports 51 tests passing (39 existing + 12 new integration tests)

### Wave 0 Gaps

- [ ] `tests/integration/server.test.ts` — the 12 integration test cases (TEST-01..12)
- [ ] `response-normalizer.ts` — the normalizer module (NORM-01..09)

Optional but recommended:
- [ ] `response-normalizer.test.ts` — unit tests for pure normalizer functions (fast, isolated; enables TDD on normalizer before wiring into index.ts)

*(Existing 39 tests in 3 files all pass — no Wave 0 changes to existing test files required)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (unchanged) | `verifyToken()` constant-time compare — no changes |
| V3 Session Management | no | Stateless proxy |
| V4 Access Control | yes (unchanged) | `/internal/providers/status` gated — no changes |
| V5 Input Validation | yes (unchanged) | Zod strict schema — no changes |
| V6 Cryptography | no | No new crypto; `crypto.randomUUID()` uses Web Crypto PRNG |

### Known Threat Patterns for Phase 3 Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Provider model ID leakage in responses | Information Disclosure | Allowlist-rebuild normalizer (D-06) — upstream IDs cannot appear in normalized output |
| Chain-of-thought/reasoning leakage | Information Disclosure | Allowlist-rebuild excludes `reasoning`, `reasoning_logprobs` fields (CLAUDE.md §26 rule 12) |
| Secrets in structured logs | Information Disclosure | OBS-04 redaction rules enforced by log call sites — never log `err.headers`, prompts, responses |
| X-Request-ID as correlation oracle | Information Disclosure | UUID is not a secret; do not use it as auth token; it is safe to return to clients |
| Provider key echo via error messages | Information Disclosure | D-07: upstream error text passes through but known model IDs rewritten; keys never appear in error messages from providers (API keys are not echoed by Cerebras/Groq error bodies) |

---

## Sources

### Primary (HIGH confidence — verified from local source)

- `node_modules/bun-types/docs/test/mocks.mdx` — `mock.module()`, `mockImplementationOnce()`, mock lifecycle
- `node_modules/bun-types/docs/test/dates-times.mdx` — `setSystemTime()` affects `Date.now()`; reset with no-arg call
- `node_modules/bun-types/docs/test/lifecycle.mdx` — `beforeAll`/`afterAll`/`beforeEach` scoping; server setup/teardown pattern
- `tests/routing/cooldown-manager.test.ts` (existing) — verified `APIError` constructor shape for mock throws
- `tests/routing/provider-state.test.ts` (existing) — `resetForTesting()` usage pattern
- `index.ts` — all current error paths, inline model-rewrite locations, streaming relay structure
- `services/cerebras.ts` — adapter output shape; inline reasoning/time_info strip comments
- `services/groq.ts` — adapter output shape; field-by-field build pattern
- `types.ts` — `ChatCompletionResult`, `StreamChunk`, `ProviderAdapter` interfaces
- `routing/provider-state.ts` — `resetForTesting()` already exported; `isEligible()` reads `Date.now()`

### Secondary (HIGH confidence — existing RESEARCH.md)

- `.planning/phases/02-routing-streaming/02-RESEARCH.md` — SDK APIError constructor shapes, bun:test patterns, streaming relay architecture
- `.planning/phases/03-full-compliance-tests/03-CONTEXT.md` — all locked decisions D-01..D-08

### Tertiary

None — all claims grounded in local sources.

---

## Metadata

**Confidence breakdown:**
- Normalizer design: HIGH — pure function over known types; `ChatCompletionResult`/`StreamChunk` interfaces are the spec
- `createServer` factory: HIGH — straightforward wrapper; `Bun.serve` API unchanged
- `setSystemTime()` for TEST-03: HIGH — verified from bun-types docs; `isEligible()` already reads `Date.now()`
- Mock adapter pattern: HIGH — `ProviderAdapter` interface typed; existing tests prove `APIError` constructor shapes
- X-Request-ID: HIGH — `crypto.randomUUID()` is Web Crypto standard; one [ASSUMED] on header mutability with safe fallback
- Structured logging: HIGH — existing `console.log(JSON.stringify(...))` pattern; extend with new fields

**Research date:** 2026-06-05
**Valid until:** 2026-07-05 (all claims from local source; Bun APIs stable within minor versions)
