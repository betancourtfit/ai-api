# Phase 1: Foundation - Pattern Map

**Mapped:** 2026-06-05
**Files analyzed:** 8 new/modified files
**Analogs found:** 6 / 8 (2 files have no codebase analog — patterns come from RESEARCH.md)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `index.ts` | route handler / server | request-response | `index.ts` (current) | exact — in-place rewrite |
| `config.ts` | config | — | `index.ts` lines 19-20 (env reads) | partial — only 2 env reads exist today |
| `types.ts` | model / interface | — | `types.ts` (current) | exact — in-place replacement |
| `model-registry.ts` | service | request-response | `index.ts` lines 5-16 (service registry) | partial — same registry concept, different shape |
| `request-schema.ts` | middleware / validator | request-response | none | no analog — new pattern via RESEARCH.md |
| `cerebras-adapter.ts` (or `services/cerebras.ts` rewrite) | service | request-response | `services/cerebras.ts` | exact — in-place rewrite |
| `groq-adapter.ts` (or `services/groq.ts` rewrite) | service | request-response | `services/groq.ts` | exact — in-place rewrite |
| Auth logic (inline in `index.ts`) | middleware | request-response | none | no analog — new pattern via RESEARCH.md |

---

## Pattern Assignments

### `index.ts` (route handler, request-response) — in-place rewrite

**Analog:** `index.ts` (current)

**Server bootstrap pattern** (lines 18-20, 49):
```typescript
const server = Bun.serve({
    hostname: process.env.HOSTNAME ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    async fetch(request) {
        // ...
    },
});

console.log(`Server is running on ${server.url}`);
```
Copy this shell verbatim. Replace `process.env.*` reads with `config.port` / `config.hostname` imported from `config.ts`.

**Route dispatch pattern** (lines 22-45):
```typescript
const { pathname } = new URL(request.url);

if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return new Response("ok", { status: 200 });
}

if (request.method === "POST" && pathname === "/chat") {
    // ...
}

return new Response("Not found", { status: 404 });
```
Copy the `new URL(request.url)` pathname extraction and the `method + pathname` guard pattern. Replace the `/chat` block with `/v1/chat/completions` and `/v1/models` blocks. Keep the 404 catch-all at the bottom.

**Health route pattern** (line 26-28):
```typescript
if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return new Response("ok", { status: 200 });
}
```
Keep `GET /health` exactly. Keep the root `/` alias (CONTEXT.md discretion, current code does this). No auth on health per EP-04.

**Service array + selection** (lines 5-16):
```typescript
const services: AIService[] = [groqService, cerebrasService];
let currentServiceIndex = 0;

function getNextService() {
    const service = services[currentServiceIndex];
    currentServiceIndex = (currentServiceIndex + 1) % services.length;
    return service;
}
```
This is replaced in Phase 1 by a deterministic first-eligible selector (not round-robin — that is Phase 2). The array pattern (register both adapters, iterate to pick one) is reused; the cycling logic is replaced with first-in-`PROVIDER_ORDER` selection.

**Console log style** (line 49):
```typescript
console.log(`Server is running on ${server.url}`);
```
Template literals, no logger library in Phase 1.

---

### `config.ts` (config module) — new file

**Analog:** `index.ts` lines 19-20 (only existing env reads in codebase)
```typescript
hostname: process.env.HOSTNAME ?? "0.0.0.0",
port: Number(process.env.PORT ?? 3000),
```

**Pattern to copy:** the `??` nullish-coalescing default pattern for optional vars. Extend this into a full `config` object exported as `const`. Use a `required()` helper (no codebase analog — from RESEARCH.md Pattern 7) for mandatory keys.

**Naming convention (from `services/groq.ts` line 4):**
```typescript
const groq = new Groq();
```
SDK clients are assigned to simple camelCase `const`s at module level. Apply same style to `config` export: `export const config = { ... } as const`.

**Import convention (from `services/cerebras.ts` line 1-2):**
```typescript
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { AIService, ChatMessage } from '../types';
```
`import type` for type-only imports (required by `verbatimModuleSyntax: true`). No path aliases — relative paths only.

---

### `types.ts` (interfaces) — in-place replacement

**Analog:** `types.ts` (current, all 9 lines)
```typescript
export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface AIService {
    name: string;
    chat: (messages: ChatMessage[]) => Promise<AsyncIterable<string>>;
}
```

**Pattern to copy:**
- `interface` keyword (not `type` alias) for object shapes — matches project convention.
- Named exports only (`export interface`) — no default exports.
- `ChatMessage` shape is reused in the new `CompletionParams` type; keep the `role` union as-is.
- `AIService` is **deleted** and replaced by `ProviderAdapter` (RESEARCH.md Pattern 1). Copy the `name: string` property pattern — all adapters carry a `name` identifier.
- 4-space indent throughout.

---

### `model-registry.ts` (service, request-response) — new file

**Analog:** `index.ts` lines 5-8 (service registry array)
```typescript
const services: AIService[] = [
    groqService,
    cerebrasService
];
```
The concept (a registry of known providers/aliases, iterated at request time) maps to the model registry. The implementation is different (JSON object keyed by alias, not an array), but the pattern of module-level constant initialization is the same.

**Module-level singleton init pattern** (from `services/groq.ts` line 4, `services/cerebras.ts` line 5):
```typescript
const groq = new Groq();
// ...
const cerebras = new Cerebras();
```
Parse `config.modelRegistryJson` once at module load as a module-level `const`. Throw immediately if invalid (surfaces misconfiguration on startup, same philosophy as SDK clients reading env at import time).

**Named export pattern** (from `services/groq.ts` line 6, `services/cerebras.ts` line 7):
```typescript
export const groqService: AIService = { ... };
export const cerebrasService: AIService = { ... };
```
Export named functions: `export function resolveUpstreamModel(...)`, `export function isKnownAlias(...)`, `export function listAliases()`. No default export.

---

### `request-schema.ts` (middleware/validator, request-response) — new file, no codebase analog

**No existing analog.** Zod is not yet in the codebase. Use RESEARCH.md Pattern 4 directly.

**Key points for planner:**
- Import: `import * as z from "zod"` (Zod v4 canonical import).
- Use `z.strictObject()` not `z.object()` — the `.strict()` method does not exist in v4.
- Use `result.error.issues[0]` not `.errors[0]` — `.errors` was removed in v4.
- `export const chatCompletionSchema` + `export function validateChatCompletion(body: unknown)` — named exports only.
- `export type ChatCompletionInput = z.infer<typeof chatCompletionSchema>` for downstream typing.

---

### `services/cerebras.ts` (service, request-response) — in-place rewrite

**Analog:** `services/cerebras.ts` (current, all 24 lines)

**SDK import pattern** (line 1):
```typescript
import Cerebras from '@cerebras/cerebras_cloud_sdk';
```
Copy exactly. Single-quotes on SDK import (matches this file's existing style).

**`import type` pattern** (line 2):
```typescript
import type { AIService, ChatMessage } from '../types';
```
Replace with: `import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from '../types';` (or `'./types'` if adapter is moved to root). `import type` is required by `verbatimModuleSyntax: true`.

**SDK singleton init** (line 5):
```typescript
const cerebras = new Cerebras();
```
Replace with `maxRetries: 0` (INFRA-03): `const cerebras = new Cerebras({ apiKey: config.cerebrasApiKey, maxRetries: 0 });`. Import `config` from `./config` (not `'../config'` if file stays in `services/`).

**Named export + adapter object** (lines 7-23):
```typescript
export const cerebrasService: AIService = {
    name: "cerebras",
    async chat(messages: ChatMessage[]) {
        const chatCompletion = await cerebras.chat.completions.create({
            messages: messages as any,
            model: 'qwen-3-32b',
            stream: true,
            // ...
        });
        return (async function* () { ... });  // BUG: not invoked
    }
}
```
Copy the `export const [name]: [Interface] = { name: "cerebras", async [method](...) { ... } }` shape. Replace:
- `AIService` → `ProviderAdapter`
- `chat(messages)` → `complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult>`
- `stream: true` → `stream: false` (required for non-streaming TypeScript overload)
- `messages as any` → explicit cast to `ChatCompletionCreateParamsNonStreaming` (import from `@cerebras/cerebras_cloud_sdk`)
- Add second argument to `create()`: `{ headers: { "X-Cerebras-Version-Patch": config.cerebrasVersionPatch } }`
- Construct `ChatCompletionResult` field-by-field (do not spread response — strips `time_info`, `reasoning`)

**`as any` anti-pattern** (line 11) — do NOT copy:
```typescript
messages: messages as any,   // BUG — replace with typed cast
```
Replace with: `{ ...params } as ChatCompletionCreateParamsNonStreaming`

---

### `services/groq.ts` (service, request-response) — in-place rewrite

**Analog:** `services/groq.ts` (current, all 26 lines)

**SDK import pattern** (line 1):
```typescript
import { Groq } from 'groq-sdk';
```
Note: uses named `{ Groq }` import with single-quotes. After upgrading to v1.2.1, the default export `import Groq from 'groq-sdk'` is also valid — either works. Keep single-quotes to match this file.

**Value import for types** (line 2) — note inconsistency vs. cerebras.ts:
```typescript
import { AIService, ChatMessage } from '../types';   // no 'import type'
```
Fix this: use `import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from '../types';` to comply with `verbatimModuleSyntax: true`.

**SDK singleton init** (line 4):
```typescript
const groq = new Groq();
```
Replace with: `const groq = new Groq({ apiKey: config.groqApiKey, maxRetries: 0 });`

**Named export + object shape** (lines 6-24):
```typescript
export const groqService: AIService = {
    name: "groq",
    async chat(messages: ChatMessage[]) {
        const chatCompletion = await groq.chat.completions.create({
            messages,
            model: "moonshotai/kimi-k2-instruct-0905",
            temperature: 0.6,
            max_completion_tokens: 4096,
            top_p: 1,
            stream: true,
            stop: null
        });
        return (async function* () {
            for await (const chunk of chatCompletion) {
                yield chunk.choices[0]?.delta?.content || '';
            }
        })();
    }
}
```
Copy the `export const groqAdapter: ProviderAdapter = { name: "groq", async complete(...) { ... } }` shape. Replace:
- `stream: true` → `stream: false`
- hardcoded `model` → `upstreamModelId` parameter
- hardcoded `temperature`, `top_p`, `stop` → values from `params`
- streaming async generator body → field-by-field construction of `ChatCompletionResult`
- `model: response.model` is kept as-is; caller in `index.ts` rewrites it to the logical alias
- Strip `response.x_groq`, `response.usage_breakdown`, `response.service_tier` by not including them in the returned object

**Optional chaining style** (line 21):
```typescript
chunk.choices[0]?.delta?.content || ''
```
Keep `?.` optional chaining + `?? ""` (prefer `??` over `||` for null-coalescing in new code, to avoid falsy-string issues).

---

## Shared Patterns

### Bun.serve() fetch router
**Source:** `index.ts` lines 18-47
**Apply to:** `index.ts` rewrite only
```typescript
Bun.serve({
    hostname: ...,
    port: ...,
    async fetch(request) {
        const { pathname } = new URL(request.url);
        if (method === "GET" && pathname === "/health") { ... }
        if (method === "POST" && pathname === "/v1/chat/completions") { ... }
        return new Response("Not found", { status: 404 });
    },
});
```

### Module-level SDK singleton
**Source:** `services/groq.ts` line 4; `services/cerebras.ts` line 5
**Apply to:** `groq-adapter.ts` / `cerebras-adapter.ts`, `model-registry.ts`
```typescript
const groq = new Groq();             // groq.ts line 4
const cerebras = new Cerebras();     // cerebras.ts line 5
```
All expensive initialization (SDK clients, registry parse) happens once at module load, not per-request.

### Named exports only, no default exports
**Source:** `services/groq.ts` line 6; `services/cerebras.ts` line 7; `types.ts` lines 1,6
**Apply to:** all new files
```typescript
export const groqService: AIService = { ... };
export const cerebrasService: AIService = { ... };
export interface ChatMessage { ... }
```

### `import type` for type-only imports
**Source:** `services/cerebras.ts` line 2
**Apply to:** all new files that import interfaces/types
```typescript
import type { AIService, ChatMessage } from '../types';
```
Required by `verbatimModuleSyntax: true` in `tsconfig.json`.

### 4-space indentation, single-file handler blocks
**Source:** all existing files (consistent throughout)
**Apply to:** all new files
```typescript
export const groqService: AIService = {
    name: "groq",
    async chat(messages: ChatMessage[]) {
        const chatCompletion = await groq.chat.completions.create({
            // 4-space indent at each nesting level
        });
    }
}
```

### Response construction
**Source:** `index.ts` lines 27, 45
**Apply to:** all error and success responses in `index.ts`
```typescript
return new Response("ok", { status: 200 });
// ...
return new Response("Not found", { status: 404 });
```
For JSON bodies (new pattern — no codebase analog yet), add `headers: { "Content-Type": "application/json" }`:
```typescript
return new Response(JSON.stringify({ ... }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
});
```

### OpenAI error shape (new — no codebase analog)
**Source:** RESEARCH.md Pattern 6
**Apply to:** all error returns in `index.ts` (auth failures, validation failures, model-not-found)
```typescript
return new Response(
    JSON.stringify({
        error: { message, type, code, param },
    }),
    { status, headers: { "Content-Type": "application/json" } }
);
```

### Auth middleware (new — no codebase analog)
**Source:** RESEARCH.md Pattern 5
**Apply to:** all authenticated routes in `index.ts` (`/v1/models`, `/v1/chat/completions`)
```typescript
import { timingSafeEqual } from "node:crypto";
// length check first — timingSafeEqual throws on length mismatch
const a = Buffer.from(token);
const b = Buffer.from(expected);
if (a.length !== b.length) return false;
return timingSafeEqual(a, b);
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `request-schema.ts` | middleware / validator | request-response | Zod not yet in codebase; no validation layer exists |
| Auth logic (in `index.ts`) | middleware | request-response | No auth exists in current code; `timingSafeEqual` pattern is new |

Both are fully specified in RESEARCH.md Patterns 4 and 5 respectively.

---

## Metadata

**Analog search scope:** `/Users/juanabetancourt/Documents/github/tests/bun-ai-api/` — all `.ts` files at root and `services/`
**Files scanned:** 4 (`index.ts`, `types.ts`, `services/groq.ts`, `services/cerebras.ts`)
**Pattern extraction date:** 2026-06-05
**Note on file placement:** D-03 permits planner to decide whether adapters live at root (`cerebras-adapter.ts`) or replace `services/cerebras.ts` in-place. Either works — the patterns above apply to both placements. Import paths (`../types` vs `./types`) adjust accordingly.
