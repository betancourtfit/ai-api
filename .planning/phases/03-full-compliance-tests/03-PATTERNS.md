# Phase 3: Full Compliance + Tests — Pattern Map

**Mapped:** 2026-06-05
**Files analyzed:** 4 new/modified files
**Analogs found:** 4 / 4

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `response-normalizer.ts` | utility/transform | transform | `services/cerebras.ts` + `services/groq.ts` (field-by-field build pattern) | role-match |
| `index.ts` (refactor) | route/middleware | request-response | `index.ts` itself (wrapping existing `Bun.serve()` in factory) | self-refactor |
| `tests/integration/server.test.ts` | test (integration) | request-response | `tests/routing/provider-state.test.ts` + `tests/routing/cooldown-manager.test.ts` | role-match |
| `services/cerebras.ts` (minor edit) | service/adapter | request-response | `services/groq.ts` (identical adapter structure) | exact |

---

## Pattern Assignments

### `response-normalizer.ts` (utility, transform)

**Analog:** `services/cerebras.ts` (field-by-field allowlist rebuild, lines 50–68) and `services/groq.ts` (lines 42–60)

**Imports pattern** (`services/cerebras.ts` lines 1–7):
```typescript
import type { ChatCompletionResult, StreamChunk } from './types';
```

**Core pattern — allowlist-rebuild for non-streaming** (`services/cerebras.ts` lines 50–68):

Both existing adapters already build `ChatCompletionResult` field-by-field rather than spreading the SDK response. The normalizer extends this same pattern as a standalone pure function.

```typescript
// services/cerebras.ts lines 50-68 — field-by-field build (do NOT spread)
const result: ChatCompletionResult = {
    id: completion.id,
    object: 'chat.completion',
    created: completion.created,
    model: completion.model, // caller rewrites to logical alias
    choices: completion.choices.map((c, i) => ({
        index: i,
        message: { role: 'assistant', content: c.message.content ?? '' },
        finish_reason: c.finish_reason ?? null,
    })),
    usage: {
        prompt_tokens: completion.usage?.prompt_tokens ?? 0,
        completion_tokens: completion.usage?.completion_tokens ?? 0,
        total_tokens: completion.usage?.total_tokens ?? 0,
    },
    system_fingerprint: completion.system_fingerprint ?? undefined,
};
```

**Core pattern — delta rebuild for streaming chunks** (`services/cerebras.ts` lines 95–121 and `services/groq.ts` lines 79–106):

Both adapters build `StreamChunk['choices'][number]['delta']` by conditionally setting only defined fields — the exact pattern the `normalizeChunk()` function replicates.

```typescript
// services/cerebras.ts lines 105-115 — conditional delta field assignment
const delta: StreamChunk['choices'][number]['delta'] = {};
if (choice.delta?.role !== undefined && choice.delta.role !== null) {
    delta.role = choice.delta.role;
}
if (choice.delta && 'content' in choice.delta) {
    delta.content = choice.delta.content ?? null;
}
return {
    index: choice.index,
    delta,
    finish_reason: choice.finish_reason ?? null,
};
```

**`system_fingerprint` conditional spread pattern** (`services/cerebras.ts` line 65 and `services/groq.ts` line 57):
```typescript
// Both adapters: optional field only set when present — use same pattern in normalizer
system_fingerprint: completion.system_fingerprint ?? undefined,
```

**Inline model rewrite to fold into normalizer** (`index.ts` lines 295 and 339):
```typescript
// index.ts line 295 — streaming inline rewrite (REPLACE with normalizeChunk call)
const normalized = { ...chunk, model: input.model };

// index.ts line 339 — non-streaming inline rewrite (REPLACE with normalizeResponse call)
result.model = input.model;
```

**Import type convention** (`services/cerebras.ts` line 6, verbatimModuleSyntax):
```typescript
import type { ProviderAdapter, ChatCompletionResult, CompletionOutcome, CompletionParams, StreamChunk } from '../types';
```

---

### `index.ts` (refactor: `createServer(adapters)` factory + X-Request-ID + structured logs + NORM-10 sweep)

**Analog:** `index.ts` itself — self-refactor wrapping the existing `Bun.serve()` call

**Current server startup pattern** (`index.ts` lines 86–394) — wrap in factory:
```typescript
// index.ts lines 86-88 — BEFORE (module-level Bun.serve call):
const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(request, server) { ... },
});

// AFTER — factory function; bare top-level call stays for direct entry:
export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port = config.port
): Server {
    return Bun.serve({
        hostname: config.hostname,
        port,
        async fetch(request, server) { ... }, // uses `adapters` instead of `adapterMap`
    });
}
const server = createServer({ cerebras: cerebrasAdapter, groq: groqAdapter });
```

**Auth pattern** (`index.ts` lines 35–58) — unchanged; copy for reference when threading `requestId`:
```typescript
// index.ts lines 36-48 — extractBearerToken + verifyToken; all auth error returns need X-Request-ID
function extractBearerToken(request: Request): string | null { ... }
function verifyToken(token: string, expected: string): boolean { ... }
```

**`openaiError()` helper** (`index.ts` lines 22–33) — NORM-10 base; extend with optional `extraHeaders`:
```typescript
// index.ts lines 22-33 — current shape (missing X-Request-ID threading)
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}
```

**Existing structured log events** (`index.ts` lines 260–265 and 269–273) — extend with `requestId` field:
```typescript
// index.ts lines 260-265 — provider_cooldown event (add requestId, remove in Phase 3)
console.log(JSON.stringify({
    event: 'provider_cooldown',
    provider,
    status: classified.status,
    cooldownUntil: new Date(cooldownUntil).toISOString(),
}));

// index.ts lines 269-273 — provider_failover event (add requestId)
console.log(JSON.stringify({
    event: 'provider_failover',
    provider,
    status: classified.status,
}));
```

**404 catch-all to fix** (`index.ts` line 392) — NORM-10 non-compliance:
```typescript
// index.ts line 392 — BEFORE (plain text, not openaiError):
return new Response('Not found', { status: 404 });

// AFTER — NORM-10 compliant:
return withRequestId(openaiError('The requested endpoint does not exist.', 'invalid_request_error', 'not_found', null, 404));
```

**Streaming response construction** (`index.ts` lines 316–323) — X-Request-ID must be in headers object at construction time (not mutated after):
```typescript
// index.ts lines 316-323 — BEFORE:
return new Response(body, {
    status: 200,
    headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    },
});
// AFTER — add X-Request-ID (and optional X-LLM-Provider) here, not after construction
```

**Non-streaming response construction** (`index.ts` lines 340–344) — add X-Request-ID header and normalizer call:
```typescript
// index.ts lines 340-344 — BEFORE:
result.model = input.model;
return new Response(
    JSON.stringify(result),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
);
// AFTER: const normalized = normalizeResponse(result, input.model);
```

**`adapterMap` const** (`index.ts` lines 16–19) — replaced by the `adapters` parameter in the factory:
```typescript
// index.ts lines 16-19 — current hardwired map (replaced by factory parameter):
const adapterMap: Record<Provider, ProviderAdapter> = {
    cerebras: cerebrasAdapter,
    groq: groqAdapter,
};
```

---

### `tests/integration/server.test.ts` (test, request-response)

**Analog:** `tests/routing/provider-state.test.ts` (lifecycle, `beforeEach`/`resetForTesting`, state isolation) and `tests/routing/cooldown-manager.test.ts` (APIError constructor shapes, named describe blocks)

**Imports pattern** (`tests/routing/provider-state.test.ts` lines 1–13):
```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import {
    advanceCursor,
    chooseEligibleProviders,
    resetForTesting,
    setCooldown,
} from "../../routing/provider-state";
```

**`beforeEach` state-isolation pattern** (`tests/routing/provider-state.test.ts` lines 16–19) — TEST-12:
```typescript
describe("provider-state", () => {
    beforeEach(() => {
        resetForTesting();
    });
    // ...
});
```

**APIError constructor shape** (`tests/routing/cooldown-manager.test.ts` lines 118–129) — verified working for mock throws in TEST-02..05:
```typescript
// cooldown-manager.test.ts lines 118-129 — factory helpers that already work
function groqError(status: number | undefined, headers?: Headers): GroqAPIError {
    return new GroqAPIError(status, undefined, "boom", headers);
}
function cerebrasError(status: number | undefined, headers?: Headers): CerebrasAPIError {
    return new CerebrasAPIError(
        status,
        undefined,
        "boom",
        headers as ConstructorParameters<typeof CerebrasAPIError>[3]
    );
}
```

**APIError imports** (`tests/routing/cooldown-manager.test.ts` lines 1–9):
```typescript
import { describe, expect, test } from "bun:test";
import { APIError as CerebrasAPIError } from "@cerebras/cerebras_cloud_sdk";
import { APIError as GroqAPIError } from "groq-sdk";
```

**Single-provider test assertion style** (`tests/routing/provider-state.test.ts` lines 31–34):
```typescript
test("excludes providers that are cooling down", () => {
    setCooldown("groq", Date.now() + 60_000);
    expect(isEligible("groq", alias)).toBe(false);
    expect(chooseEligibleProviders(alias)).toEqual(["cerebras"]);
});
```

**Test file structure for integration suite** — follow spec §21 `tests/unit` + `tests/integration` layout; server lifecycle in `beforeAll`/`afterAll`, state reset in `beforeEach`:
```typescript
// Pattern from provider-state.test.ts lines 16-19 + research Pattern 1:
import { beforeAll, afterAll, beforeEach, describe, test, expect } from "bun:test";
import { createServer } from "../../index";
import { resetForTesting } from "../../routing/provider-state";

let server: ReturnType<typeof createServer>;
const PROXY_KEY = "test-proxy-key";

beforeAll(() => {
    process.env["PERSONAL_PROXY_API_KEY"] = PROXY_KEY;
    process.env["CEREBRAS_API_KEY"] = "test-cerebras-key";
    process.env["GROQ_API_KEY"] = "test-groq-key";
    server = createServer(makeMockAdapters(), 0);
});

afterAll(() => {
    server.stop(true);
});

beforeEach(() => {
    resetForTesting(); // TEST-12: state isolation between every test
});

function url(path: string): string {
    return `http://${server.hostname}:${server.port}${path}`;
}
```

**`mockImplementationOnce` pattern** (`tests/routing/cooldown-manager.test.ts` line 119 for the constructor shape — combine with `mock()` from bun:test):
```typescript
// For TEST-02 (429 → cooldown) and TEST-04 (5xx → failover):
import { mock } from "bun:test";
const completeMock = mock(async () => defaultSuccessOutcome);
completeMock.mockImplementationOnce(async () => {
    throw new GroqAPIError(429, undefined, "rate limited", new Headers({ "retry-after": "30" }));
});
```

---

### `services/cerebras.ts` (minor edit — remove inline strip comments superseded by normalizer)

**Analog:** `services/groq.ts` (exact same adapter structure)

**Lines to update** (`services/cerebras.ts` lines 47–49 and comment at line 54):
```typescript
// services/cerebras.ts lines 47-49 — comment referencing inline strip (normalizer now owns this):
// Build result field-by-field — do NOT spread response (Pitfall 4):
//   response.time_info: stripped (spec §15 — not forwarded downstream)
//   response.choices[*].message.reasoning: stripped (spec §12 — never expose)

// Line 54 comment:
model: completion.model, // caller (index.ts) rewrites to logical alias
```

The field-by-field build itself stays intact — only the stale inline-stripping comments and the "caller rewrites" comment need updating to reflect that `response-normalizer.ts` now owns model rewrite and field stripping.

---

## Shared Patterns

### Named Exports Only (No Default Exports)

**Source:** `services/cerebras.ts` line 22, `services/groq.ts` line 23, `routing/provider-state.ts` line 88
**Apply to:** `response-normalizer.ts`
```typescript
export const cerebrasAdapter: ProviderAdapter = { ... }    // services/cerebras.ts:22
export function resetForTesting(): void { ... }             // routing/provider-state.ts:88
// response-normalizer.ts must use:
export function normalizeResponse(...) { ... }
export function normalizeChunk(...) { ... }
```

### `import type` for Type-Only Imports (verbatimModuleSyntax)

**Source:** `services/cerebras.ts` line 6, `index.ts` line 9
**Apply to:** `response-normalizer.ts`, `tests/integration/server.test.ts`
```typescript
import type { ChatCompletionResult, StreamChunk } from './types';
import type { Provider } from './routing/provider-state';
import type { ProviderAdapter } from './types';
```

### 4-Space Indentation

**Source:** All existing files — observed consistently throughout `index.ts`, `services/*.ts`, `tests/**/*.ts`
**Apply to:** All new files in Phase 3.

### Structured JSON Log via `console.log(JSON.stringify(...))`

**Source:** `index.ts` lines 260–273 and 307–311
**Apply to:** New request completion log entries in the refactored `index.ts`
```typescript
// index.ts lines 260-265 — existing cooldown event (pattern to extend with requestId):
console.log(JSON.stringify({
    event: 'provider_cooldown',
    provider,
    status: classified.status,
    cooldownUntil: new Date(cooldownUntil).toISOString(),
}));
```

### OpenAI Error Shape

**Source:** `index.ts` lines 22–33
**Apply to:** All error returns in refactored `index.ts` (including 404 catch-all — currently non-compliant at line 392)
```typescript
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}
```

### Provider State Reset in Tests

**Source:** `tests/routing/provider-state.test.ts` lines 16–19
**Apply to:** `tests/integration/server.test.ts` — `beforeEach` must call `resetForTesting()`
```typescript
beforeEach(() => {
    resetForTesting();
});
```

### Null-coalescing for Optional Fields

**Source:** `services/cerebras.ts` lines 57–63, `services/groq.ts` lines 49–56
**Apply to:** `response-normalizer.ts` usage synthesis (D-08: `?? { prompt_tokens: 0, ... }`)
```typescript
// services/groq.ts lines 53-56:
usage: {
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    total_tokens: data.usage?.total_tokens ?? 0,
},
```

---

## No Analog Found

No files in Phase 3 are fully without analog. The `setSystemTime()` usage in TEST-03 has no existing codebase example but is fully specified in RESEARCH.md Pattern 8 with verified bun-types documentation.

---

## Key Integration Points

### Where normalizer slots into `index.ts`

| Current line | What it does | Phase 3 replacement |
|---|---|---|
| `index.ts:295` | `{ ...chunk, model: input.model }` | `normalizeChunk(chunk, input.model)` |
| `index.ts:339` | `result.model = input.model` | `const normalized = normalizeResponse(result, input.model)` |
| `index.ts:392` | `new Response('Not found', ...)` | `openaiError(...)` via `withRequestId()` |

### Where `requestId` must attach (OBS-01 — every response)

Paths verified in `index.ts`:
- Line 94: `/health` response
- Lines 111–117: `/ready` response
- Lines 127–133: auth 401 error
- Lines 141–144: `/internal/providers/status` 404
- Lines 149–161: `/v1/models` response
- Lines 170, 176–183, 189–195, 213–220: validation error paths
- Lines 244–250, 277–284: streaming error paths
- Lines 316–323: streaming success response (headers at construction time)
- Lines 340–344: non-streaming success response
- Lines 349–356, 383–389: non-streaming error paths
- Line 392: 404 catch-all

---

## Metadata

**Analog search scope:** `/Users/juanabetancourt/Documents/github/tests/bun-ai-api` (all `.ts` files, node_modules excluded)
**Files scanned:** 12 source files
**Pattern extraction date:** 2026-06-05
