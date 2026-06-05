# Phase 2: Routing + Streaming — Pattern Map

**Mapped:** 2026-06-05
**Files analyzed:** 8 (new/modified)
**Analogs found:** 8 / 8 (all files have close Phase 1 analogs)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `routing/provider-state.ts` | service | event-driven | `services/cerebras.ts` + `index.ts` | role-match (state + selector logic) |
| `routing/cooldown-manager.ts` | utility | transform | `request-schema.ts` | role-match (parse + transform pure functions) |
| `services/cerebras.ts` | service | streaming | `services/groq.ts` (existing complete()) | exact (same adapter, new method) |
| `services/groq.ts` | service | streaming | `services/cerebras.ts` (existing complete()) | exact (same adapter, new method) |
| `config.ts` | config | — | `config.ts` (self — additive change) | exact |
| `request-schema.ts` | utility | transform | `request-schema.ts` (self — one-line change) | exact |
| `index.ts` | controller | request-response + streaming | `index.ts` (self — routing loop replaced) | exact |
| `tests/routing/provider-state.test.ts` | test | — | `request-schema.test.ts` | role-match (bun:test describe/test pattern) |
| `tests/routing/cooldown-manager.test.ts` | test | — | `request-schema.test.ts` | role-match (bun:test describe/test pattern) |

---

## Pattern Assignments

### `routing/provider-state.ts` (service, event-driven)

**Analog:** `index.ts` (module-level mutable state pattern) + `services/cerebras.ts` (named export singleton)

**Imports pattern** — copy from `services/cerebras.ts` lines 3-6:
```typescript
import { config } from '../config';
import { resolveUpstreamModel } from '../model-registry';
import type { CompletionParams } from '../types';
```
Adapt: replace with imports from `config` and `model-registry` only; no SDK import needed.

**Module-level state pattern** — copy from `index.ts` lines 13-16:
```typescript
const adapterMap = {
    cerebras: cerebrasAdapter,
    groq: groqAdapter,
} as const;
```
Adapt: replace `adapterMap` with `state: Record<Provider, ProviderState>` — same pattern of typed keyed record at module level, mutable (do NOT use `as const` on state).

**Named export pattern** — copy from `services/cerebras.ts` lines 11, `services/groq.ts` line 11:
```typescript
export const cerebrasAdapter: ProviderAdapter = { ... };
export const groqAdapter: ProviderAdapter = { ... };
```
Adapt: use named function exports (`export function isEligible`, `export function chooseEligibleProviders`, `export function resetForTesting`) — same named-export-only convention, no default exports.

**Module-level cursor pattern** — copy from `index.ts` lines 134-144:
```typescript
// Phase 1: pick first eligible provider in PROVIDER_ORDER
let chosenAlias: string | null = null;
let completionResult = null;
for (const provider of config.providerOrder) {
    const upstreamModelId = resolveUpstreamModel(input.model, provider);
    if (!upstreamModelId) continue;
    const adapter = adapterMap[provider as keyof typeof adapterMap];
    if (!adapter) continue;
    completionResult = await adapter.complete(upstreamModelId, params);
    chosenAlias = input.model;
    break;
}
```
Adapt: this loop moves INTO `routing/provider-state.ts` as `chooseEligibleProviders()`. The `let currentIndex` cursor pattern mirrors the `let chosenAlias` / `let completionResult` mutables above — use `let roundRobinCursor = 0` at module level instead.

**`resetForTesting()` export requirement** — no direct analog in Phase 1; see RESEARCH.md Pattern 1 lines 276-291 for the full implementation. The pattern for test-isolation exports is established in `request-schema.ts` which exports `validateChatCompletion` for direct unit testing — same philosophy: keep logic in a module, export what tests need.

---

### `routing/cooldown-manager.ts` (utility, transform)

**Analog:** `request-schema.ts` — pure transformation functions with typed inputs/outputs

**Imports pattern** — copy from `request-schema.ts` lines 1-3:
```typescript
// request-schema.ts — Zod v4 strict allowlist validation (VALID-01/02/03/04/05/06/07)
// Uses z.strictObject() — rejects any key not in the schema (Pitfall 7: no .strict() in v4)
import * as z from 'zod';
```
Adapt: `cooldown-manager.ts` has no library imports — pure TypeScript. Comment header follows same pattern: `// routing/cooldown-manager.ts — rate-limit header parsers and cooldown calculation (RL-01..07)`.

**Export shape pattern** — copy from `request-schema.ts` lines 29, 32-35:
```typescript
export type ChatCompletionInput = z.infer<typeof chatCompletionSchema>;

export function validateChatCompletion(body: unknown):
    { success: true; data: ChatCompletionInput } |
    { success: false; param: string | null; message: string }
```
Adapt: same pattern of exported type + exported functions with typed return. For `cooldown-manager.ts`:
```typescript
export interface ParsedCerebrasHeaders { ... }
export interface ParsedGroqHeaders { ... }
export function parseCerebrasHeaders(headers: Headers): ParsedCerebrasHeaders { ... }
export function parseGroqHeaders(headers: Headers): ParsedGroqHeaders { ... }
export function calcCooldownMs(...): number { ... }
```

**Private helper pattern** — copy from `request-schema.ts` lines 39-55 (`firstIssue` extraction logic as internal detail):
```typescript
// D-05: return first offending field only — stop at first violation
const firstIssue = result.error.issues[0];
if (!firstIssue) return { success: false, param: null, message: 'Invalid request body' };
let param: string | null;
if (firstIssue.path.length > 0) { ... }
```
Adapt: same pattern of private helper functions (`toFloat`, `toNum`, `parseDuration`) that are NOT exported — they are implementation details of the exported parsers.

**Null safety pattern** — copy from `services/cerebras.ts` lines 42-52:
```typescript
choices: response.choices.map((c, i) => ({
    index: i,
    message: { role: 'assistant', content: c.message.content ?? '' },
    finish_reason: c.finish_reason ?? null,
})),
usage: {
    prompt_tokens: response.usage?.prompt_tokens ?? 0,
    completion_tokens: response.usage?.completion_tokens ?? 0,
    total_tokens: response.usage?.total_tokens ?? 0,
},
```
Adapt: same `?? undefined` and `?? 0` null-coalescing pattern applies to header parsing — `toFloat` and `toNum` return `number | undefined`, matching `noUncheckedIndexedAccess` strict mode.

---

### `services/cerebras.ts` — `stream()` method addition (service, streaming)

**Analog:** `services/cerebras.ts` existing `complete()` method — same file, additive change

**Existing imports to preserve** (lines 1-6 — do not modify):
```typescript
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from '@cerebras/cerebras_cloud_sdk/resources/chat';
import { config } from '../config';
import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from '../types';
```
Add `StreamChunk` to the `import type` from `'../types'` when `types.ts` is updated.

**SDK singleton pattern** — copy from `services/cerebras.ts` line 9 (unchanged):
```typescript
const cerebras = new Cerebras({ apiKey: config.cerebrasApiKey, maxRetries: 0 });
```
The singleton stays; `stream()` uses the same `cerebras` instance.

**Complete() call pattern to mirror for stream()** — `services/cerebras.ts` lines 16-32:
```typescript
const response = await cerebras.chat.completions.create(
    {
        model: upstreamModelId,
        messages: params.messages,
        temperature: params.temperature ?? undefined,
        top_p: params.top_p ?? undefined,
        max_completion_tokens: params.max_completion_tokens,
        stop: params.stop ?? undefined,
        seed: params.seed ?? undefined,
        stream: false,  // <- change to: stream: true
    } as ChatCompletionCreateParamsNonStreaming,
    {
        headers: {
            'X-Cerebras-Version-Patch': config.cerebrasVersionPatch,
        },
    }
) as ChatCompletion.ChatCompletionResponse;
```
Adapt for `stream()`: change `stream: false` to `stream: true`, cast to streaming overload type, pass `{ signal }` in SDK options, return the async iterable. Remove `as ChatCompletionCreateParamsNonStreaming` cast; use the streaming overload cast instead.

**Field-by-field build pattern** — `services/cerebras.ts` lines 37-53:
```typescript
return {
    id: response.id,
    object: 'chat.completion',
    created: response.created,
    model: response.model,
    choices: response.choices.map((c, i) => ({
        index: i,
        message: { role: 'assistant', content: c.message.content ?? '' },
        finish_reason: c.finish_reason ?? null,
    })),
    ...
};
```
Adapt for stream chunks: build `StreamChunk` objects field-by-field in the async generator — same explicit field mapping, never spread the raw SDK chunk. Strip `time_info`, `reasoning`, `usage` from individual chunks per spec §15.

---

### `services/groq.ts` — `stream()` method addition (service, streaming)

**Analog:** `services/groq.ts` existing `complete()` method — same file, additive change

**Existing imports to preserve** (lines 1-6 — do not modify):
```typescript
import Groq from 'groq-sdk';
import { config } from '../config';
import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from '../types';
```
Add `StreamChunk` to the `import type` from `'../types'`.

**SDK singleton pattern** — `services/groq.ts` line 9 (unchanged):
```typescript
const groq = new Groq({ apiKey: config.groqApiKey, maxRetries: 0 });
```

**Complete() call pattern to mirror for stream()** — `services/groq.ts` lines 15-24:
```typescript
const response = await groq.chat.completions.create({
    model: upstreamModelId,
    messages: params.messages,
    temperature: params.temperature ?? undefined,
    top_p: params.top_p ?? undefined,
    max_completion_tokens: params.max_completion_tokens,
    stop: params.stop ?? undefined,
    seed: params.seed ?? undefined,
    stream: false,  // <- change to: stream: true
});
```
Adapt: change `stream: false` → `stream: true`; the overload returns `Stream<ChatCompletionChunk>` (async iterable). Groq SDK does NOT need the extra `headers` options object (no version-patch header required). Pass `{ signal }` in the options object to propagate the AbortSignal.

**No-spread field build pattern** — `services/groq.ts` lines 26-46 comment block:
```typescript
// Build result field-by-field — do NOT spread response (Pitfall 5).
// Groq-specific fields (internal metadata, hardware cache stats, tier) are
// structurally excluded by only copying the standard OpenAI-compatible fields.
```
Same principle applies to chunk normalization: build `StreamChunk` field-by-field, exclude `x_groq`, `usage`, and any Groq-specific fields from individual chunks.

---

### `config.ts` — 4 new env vars (config, additive)

**Analog:** `config.ts` itself — exact same pattern, additive lines only

**Existing pattern** (lines 11-25 — copy exactly for new entries):
```typescript
export const config = {
    port: Number(process.env["PORT"] ?? 3000),
    hostname: process.env["HOSTNAME"] ?? "0.0.0.0",
    personalProxyApiKey: required("PERSONAL_PROXY_API_KEY"),
    ...
    logLevel: process.env["LOG_LEVEL"] ?? "info",
} as const;
```

**New entries to add** — follow the existing `Number(process.env[...] ?? default)` and `=== 'true'` boolean patterns:
```typescript
defaultCooldownSeconds: Number(process.env["DEFAULT_COOLDOWN_SECONDS"] ?? 60),
maxProviderAttemptsPerRequest: Number(process.env["MAX_PROVIDER_ATTEMPTS_PER_REQUEST"] ?? 2),
exposeProviderHeader: (process.env["EXPOSE_PROVIDER_HEADER"] ?? "false") === "true",
enableInternalStatusEndpoint: (process.env["ENABLE_INTERNAL_STATUS_ENDPOINT"] ?? "true") === "true",
```
Note: `as const` is already on the object — new entries are frozen automatically. Do NOT change the `as const` assertion; just append new keys before the closing `} as const`.

---

### `request-schema.ts` — `stream` field widening (utility, one-line change)

**Analog:** `request-schema.ts` itself — exact same file, single field change

**Line to change** (line 19):
```typescript
// Before (Phase 1):
stream: z.literal(false).optional(),

// After (Phase 2):
stream: z.boolean().optional(),
```
All other lines in `request-schema.ts` are unchanged. The comment on line 18 must also be updated to remove the Phase 1 restriction note.

**Test file impact** — `request-schema.test.ts` line 28-38 contains:
```typescript
test("stream:true returns success:false with param='stream'", () => {
    const result = validateChatCompletion({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
    });
    expect(result.success).toBe(false);
    ...
});
```
This test must be **deleted or inverted** — after widening, `stream: true` returns `success: true`.

---

### `index.ts` — router replacement + streaming branch + new routes (controller, request-response + streaming)

**Analog:** `index.ts` itself — same file restructured

**Imports block to extend** (lines 1-9):
```typescript
import { timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { isKnownAlias, resolveUpstreamModel, listAliases } from './model-registry';
import { validateChatCompletion } from './request-schema';
import type { CompletionParams } from './types';
import { cerebrasAdapter } from './services/cerebras';
import { groqAdapter } from './services/groq';
```
Add Phase 2 imports after line 9:
```typescript
import type { Server } from 'bun';
import { chooseEligibleProviders, advanceCursor, recordSuccess, recordFailure, setCooldown, getStateSnapshot, isEligible } from './routing/provider-state';
import { parseCerebrasHeaders, parseGroqHeaders, calcCooldownMs } from './routing/cooldown-manager';
import { APIError as GroqAPIError } from 'groq-sdk';
import { APIError as CerebrasAPIError } from '@cerebras/cerebras_cloud_sdk';
```

**`openaiError()` helper** — `index.ts` lines 19-30 (unchanged — reuse exactly):
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

**Auth helpers** — `index.ts` lines 33-45 (unchanged — reuse exactly):
```typescript
function extractBearerToken(request: Request): string | null { ... }
function verifyToken(token: string, expected: string): boolean { ... }
```

**`Bun.serve()` fetch signature change** — `index.ts` line 50:
```typescript
// Before (Phase 1):
async fetch(request) {

// After (Phase 2 — adds server parameter for server.timeout()):
async fetch(request: Request, server: Server) {
```

**Route ordering pattern** — `index.ts` lines 53-84 (preserved):
1. `GET /health` — no auth (line 54)
2. Auth gate (lines 59-68)
3. `GET /v1/models` — auth required (lines 71-84)
4. `POST /v1/chat/completions` — auth required (lines 87+)

**Phase 2 adds two routes** after `GET /v1/models` and before `POST /v1/chat/completions`:
```typescript
// GET /ready — no auth; infrastructure-callable (EP-05)
if (request.method === 'GET' && pathname === '/ready') { ... }

// GET /internal/providers/status — auth already verified above (EP-06)
if (config.enableInternalStatusEndpoint
    && request.method === 'GET'
    && pathname === '/internal/providers/status') { ... }
```

**Phase 1 for-loop to replace** — `index.ts` lines 134-154 (remove this entire block):
```typescript
// Phase 1: pick first eligible provider in PROVIDER_ORDER (round-robin is Phase 2)
let chosenAlias: string | null = null;
let completionResult = null;
for (const provider of config.providerOrder) {
    const upstreamModelId = resolveUpstreamModel(input.model, provider);
    if (!upstreamModelId) continue;
    const adapter = adapterMap[provider as keyof typeof adapterMap];
    if (!adapter) continue;
    completionResult = await adapter.complete(upstreamModelId, params);
    chosenAlias = input.model;
    break;
}
```
Replace with Phase 2 router loop (see RESEARCH.md Architecture Diagram lines 126-144 for pseudocode). Same overall shape — `for` loop over providers, `continue` on skip, `break` on success — but now uses `chooseEligibleProviders()`, `classifyError()`, `setCooldown()`, and `advanceCursor()`.

**Streaming branch pattern** — insert BEFORE the non-streaming `adapter.complete()` call. Follow `index.ts` pattern of early-return branches — same structure as the existing `/health`, `/v1/models` branches:
```typescript
if (input.stream === true) {
    server.timeout(request, 0);  // STREAM-03: must be before new Response()
    // ... AbortController, adapter.stream(), async generator, new Response(body, {...})
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

**Response pattern for JSON routes** — copy from `index.ts` lines 159-162:
```typescript
return new Response(
    JSON.stringify(completionResult),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
);
```
All JSON responses use this exact two-argument `new Response(body, { status, headers })` form. No `Response.json()` shorthand used in Phase 1 — maintain consistency.

---

### `tests/routing/provider-state.test.ts` + `tests/routing/cooldown-manager.test.ts` (test)

**Analog:** `request-schema.test.ts` — bun:test describe/test pattern

**Imports pattern** — `request-schema.test.ts` lines 1-5:
```typescript
import { test, expect, describe } from "bun:test";
import { validateChatCompletion } from "./request-schema";
import { isKnownAlias, resolveUpstreamModel } from "./model-registry";
```
Adapt: `provider-state.test.ts` imports `{ test, expect, describe, beforeEach }` from `"bun:test"` — add `beforeEach` to call `resetForTesting()` before each test for state isolation. `cooldown-manager.test.ts` imports only `{ test, expect, describe }` (no state to reset).

**`describe` + `test` structure** — `request-schema.test.ts` lines 7-38:
```typescript
describe("validateChatCompletion", () => {
    test("valid body returns success:true with parsed data", () => {
        const result = validateChatCompletion({...});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.model).toBe("gpt-oss-120b-balanced");
        }
    });
    ...
});
```
Copy this `describe` → `test` → `expect` nesting exactly. Use `describe` per requirement group (e.g., `describe("round-robin cursor", ...)`, `describe("eligibility — cooldown", ...)`). Use `beforeEach` at the `describe` level for `resetForTesting()` calls.

**State isolation pattern** — no direct Phase 1 analog (new in Phase 2). Add to provider-state test file:
```typescript
import { resetForTesting } from '../../routing/provider-state';
// ...
describe("...", () => {
    beforeEach(() => { resetForTesting(); });
    test(...);
});
```

**Test directory** — `request-schema.test.ts` lives at root. Phase 2 tests live at `tests/routing/` (subdirectory). File paths in `import` statements will use `../../routing/provider-state` (two levels up from `tests/routing/`). Match the existing relative-path import convention from `request-schema.test.ts` (no path aliases).

---

## Shared Patterns

### Auth Gate
**Source:** `index.ts` lines 58-68
**Apply to:** `GET /internal/providers/status` route (EP-06 only — `/ready` is auth-free like `/health`)
```typescript
const token = extractBearerToken(request);
if (!token || !verifyToken(token, config.personalProxyApiKey)) {
    return openaiError(
        'No authorization provided or invalid credentials.',
        'invalid_request_error',
        'missing_auth',
        null,
        401
    );
}
```
The existing auth gate in `index.ts` runs before all routes below it. `/internal/providers/status` is gated by position in the handler (placed after the auth gate), same as `/v1/models` and `POST /v1/chat/completions`.

### OpenAI Error Body
**Source:** `index.ts` lines 19-30 (`openaiError()` helper)
**Apply to:** All error return sites in Phase 2 — no-provider-available 503, cooldown-triggered failover exhaustion, non-streaming upstream errors
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
503 "no provider available" call site:
```typescript
return openaiError(
    'No eligible provider available for the requested model.',
    'server_error',
    'no_provider_available',
    'model',
    503
);
```

### Config Access
**Source:** `config.ts` lines 11-25 — all modules import the single `config` object
**Apply to:** `routing/provider-state.ts`, `routing/cooldown-manager.ts`, `index.ts` (new env vars)
```typescript
import { config } from '../config';    // from routing/ subdirectory
import { config } from './config';     // from root-level files
```
Never read `process.env` outside `config.ts`. New Phase 2 env vars (`defaultCooldownSeconds`, `maxProviderAttemptsPerRequest`, `exposeProviderHeader`, `enableInternalStatusEndpoint`) are consumed via `config.*` everywhere.

### Named Export Convention
**Source:** `services/cerebras.ts` line 11, `services/groq.ts` line 11, `model-registry.ts` lines 16-28
**Apply to:** All Phase 2 new modules
```typescript
export const cerebrasAdapter: ProviderAdapter = { ... };   // named const export
export function resolveUpstreamModel(...) { ... }           // named function export
```
No default exports anywhere in the project. All new modules (`routing/provider-state.ts`, `routing/cooldown-manager.ts`) use named exports only.

### Null Coalescing Defensive Pattern
**Source:** `services/cerebras.ts` lines 42-52, `services/groq.ts` lines 30-45
**Apply to:** `routing/cooldown-manager.ts` header parsers, `index.ts` chunk normalization
```typescript
content: c.message.content ?? ''      // string field: ?? '' for empty fallback
finish_reason: c.finish_reason ?? null // nullable field: ?? null
prompt_tokens: response.usage?.prompt_tokens ?? 0  // optional chain + 0 fallback
```
Pattern: `??` for nullish coalescence, `?.` for optional chaining on SDK response fields. Applies to all header parsing (`headers.get(name) ?? null` before passing to `toFloat`/`toNum`).

### Import Type Discipline
**Source:** `services/cerebras.ts` lines 4-6
```typescript
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from '@cerebras/cerebras_cloud_sdk/resources/chat';
import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from '../types';
```
**Apply to:** All Phase 2 files — `verbatimModuleSyntax: true` in tsconfig requires `import type` for type-only imports. Value imports use plain `import`. Violating this causes a TypeScript compile error.

### 4-Space Indentation + Single-File Comment Header
**Source:** All Phase 1 files (universal in the project)
**Apply to:** All Phase 2 new files
```typescript
// routing/provider-state.ts — ProviderState shape, eligibility, cursor, resetForTesting() (ROUTE-01..08)
// Single blank line after file-level comment, then imports.
```
4-space indentation throughout. Single-quote imports for SDK packages (`'groq-sdk'`, `'@cerebras/cerebras_cloud_sdk'`). Double-quote strings for JSON values and Response bodies.

---

## No Analog Found

All Phase 2 files have close analogs in the Phase 1 codebase. No files require falling back to RESEARCH.md patterns exclusively.

The following patterns have no codebase analog and must be implemented exactly as specified in RESEARCH.md:
- `resetForTesting()` export (ROUTE-08) — no Phase 1 test-isolation pattern exists
- `server.timeout(request, 0)` call (STREAM-03) — Phase 1 has no streaming routes
- `request.signal` abort propagation (STREAM-05) — Phase 1 has no streaming routes
- `async function*` generator as `Response` body (STREAM-02) — Phase 1 returns only synchronous JSON responses
- Groq duration string parser `parseDuration()` (RL-02) — no string-format header parsing in Phase 1

For these, use RESEARCH.md §Architecture Patterns Pattern 1–4 code blocks as the direct implementation source.

---

## Metadata

**Analog search scope:** `/Users/juanabetancourt/Documents/github/tests/bun-ai-api/` (all `.ts` files excluding `node_modules`, `dist`)
**Files scanned:** 8 source files (all Phase 1 output)
**Pattern extraction date:** 2026-06-05
