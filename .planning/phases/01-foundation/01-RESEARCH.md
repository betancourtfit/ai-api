# Phase 1: Foundation - Research

**Researched:** 2026-06-05
**Domain:** OpenAI-compatible proxy — Bun/TypeScript, groq-sdk v1.x, cerebras_cloud_sdk, Zod v4 validation
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Build **both** Cerebras and Groq adapters behind a single shared non-streaming adapter interface. Phase 1 does not pick one provider exclusively — both are implemented so Phase 2 round-robin lands on top with zero adapter rework.
- **D-02:** **Non-streaming path only this phase.** Implement `stream: false` completions end-to-end. Streaming (`stream: true`) is deferred entirely to Phase 2. The current streaming `AIService` (`AsyncIterable<string>`) interface is replaced by a non-streaming completion contract; streaming method can be stubbed/deferred.
- **D-03:** **Minimal structure, grow later.** Refactor the flat `index.ts` and add config, model-registry, request schema, and the two provider adapters as a small number of root-level files. Do NOT scaffold the full spec section-21 directory tree yet. Keep files at root level per project constraint.
- **D-04:** When the client **omits** `max_completion_tokens`, **inject a default of 4096** before forwarding. Make the default env-configurable (`DEFAULT_MAX_COMPLETION_TOKENS`, default `4096`).
- **D-05:** On validation failure, return the **first offending field only** — stop at first violation, `error.param` = that field. All errors use the OpenAI shape `{ "error": { "message", "type", "code", "param" } }`.

### Claude's Discretion

- Exact config module API, Zod schema layout, adapter interface signature, and file names.
- Which single provider the non-streaming call resolves to at runtime when both are configured: planner may pick a deterministic default (e.g. first in `PROVIDER_ORDER`) since true round-robin is Phase 2.
- `/health` body shape and whether root `/` stays a health alias.

### Deferred Ideas (OUT OF SCOPE)

- Streaming relay / SSE — Phase 2 (STREAM-01..07)
- Round-robin routing, cooldown, rate-limit header parsing, failover — Phase 2 (ROUTE/RL)
- Full response normalization (reasoning strip, x_groq strip, chunk rewrite) — Phase 3 (NORM)
- Observability (X-Request-ID, structured logs, X-LLM-Provider) — Phase 3 (OBS)
- Full spec section-21 directory tree — adopt when Phase 2/3 needs it
- `/ready` degraded mode, `/internal/providers/status` — Phase 2 (EP-05, EP-06)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFRA-01 | groq-sdk upgraded to ^1.2.1 | Verified: current latest is 1.2.1 (published 2026-05-28). API surface unchanged from v0.37.x for non-streaming path. |
| INFRA-02 | `cerebras` CLI binary package removed | Confirmed: package installs platform-specific native binaries + CLI binary; unused in source. |
| INFRA-03 | Both SDK clients initialized with `maxRetries: 0` | Verified: both SDKs accept `{ maxRetries: 0 }` in constructor. |
| INFRA-04 | Zod v4 (`^4.4.3`) installed | Verified: v4.4.3 is latest stable. Import: `import * as z from "zod"`. |
| INFRA-05 | Config module centralizes all env vars | Pattern: module-level typed exports reading `process.env.*` with defaults. |
| AUTH-01 | Reject missing Authorization header → 401 + OpenAI error shape | Pattern documented with OpenAI error shape. |
| AUTH-02 | Reject invalid proxy key → 401 + OpenAI error shape | Same pattern. |
| AUTH-03 | Constant-time key comparison (`crypto.timingSafeEqual`) | Verified: `timingSafeEqual` available via `node:crypto` in Bun 1.3.11. |
| AUTH-04 | Never log Authorization header | Code pattern: extract key, immediately discard header reference. |
| EP-04 | `GET /health` liveness response (no auth) | Existing pattern in `index.ts`: `new Response("ok", { status: 200 })`. |
| EP-07 | Remove old `/chat` endpoint | Simple deletion from fetch router. |
| VALID-01 | Unknown model aliases → 400 | Validate model against registry keys after Zod parse. |
| VALID-02 | `messages` required → 400 | `z.strictObject({ messages: z.array(...) })`. |
| VALID-03 | Allowlisted fields forwarded | Zod schema defines exactly: model, messages, temperature, top_p, max_completion_tokens, stream, stop, seed. |
| VALID-04 | Explicit reject fields: logprobs, logit_bias, top_logprobs | Handled by `z.strictObject()` — unrecognized keys throw `unrecognized_keys` error. |
| VALID-05 | `messages[].name` rejected → 400 | Use `z.strictObject()` on message objects — name field is not in the allowlist. |
| VALID-06 | `n != 1` rejected → 400 | Add `n: z.literal(1).optional()` with refinement or simply exclude `n` from allowlist. |
| VALID-07 | Unknown/unlisted fields rejected → 400 | `z.strictObject()` at top level handles this. |
| REG-01 | Model registry loaded from `MODEL_REGISTRY_JSON` env var | Pattern: `JSON.parse(process.env.MODEL_REGISTRY_JSON ?? '{}')`. |
| REG-02 | Initial alias `gpt-oss-120b-balanced` maps to both providers | Registry entry format documented. |
| REG-03 | Alias only routes to providers it maps to | Registry lookup returns provider-specific model ID or undefined. |
| REG-04 | `GET /v1/models` returns alias IDs only | Returns `Object.keys(registry)` in OpenAI list format. |
</phase_requirements>

---

## Summary

Phase 1 refactors four prototype files into a spec-compliant non-streaming proxy slice. The primary technical work is: (1) upgrading groq-sdk from 0.37 to 1.2.1, (2) installing Zod v4 for strict allowlist validation, (3) replacing the streaming `AIService` interface with a typed non-streaming completion contract, (4) wiring downstream Bearer auth with constant-time comparison, and (5) returning OpenAI-shaped responses with the logical alias in the `model` field.

The groq-sdk v1.0.0 jump was a TypeScript migration — the `chat.completions.create()` call shape and response types are compatible with 0.37.x usage, so the upgrade is low-risk. The cerebras_cloud_sdk `messages as any` cast in the existing code is a real type mismatch: the SDK's message types use a richer union than the existing `ChatMessage` interface, and it must be resolved by casting to `ChatCompletionCreateParamsNonStreaming` explicitly rather than using `as any`.

Zod v4 introduces `z.strictObject()` as the canonical strict-validation primitive (`.strict()` method is deprecated). The `safeParse` + `error.issues[0]` pattern extracts the first offending field, mapping its `path[0]` to `error.param` in the OpenAI error shape. `X-Cerebras-Version-Patch: 2` is passed via the second argument to `create()` as `{ headers: { 'X-Cerebras-Version-Patch': '2' } }` — the SDK's `RequestOptions.headers` field supports this natively.

**Primary recommendation:** Replace `AIService` with `ProviderAdapter` interface returning `Promise<ChatCompletionResult>`. Wire both adapters in Phase 1 with a simple "first eligible" selector (first in `PROVIDER_ORDER`) since round-robin is Phase 2. Auth, validation, and alias rewrite are stateless middleware steps applied sequentially in the `Bun.serve` fetch handler before the adapter call.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Downstream Bearer auth | API / Backend (proxy) | — | Key comparison is server-side; client never sees upstream keys |
| Request validation (allowlist + reject) | API / Backend (proxy) | — | Enforces intersection contract before any upstream call |
| Logical model alias resolution | API / Backend (proxy) | — | Registry is server-side config; clients use stable aliases |
| Non-streaming completion call | Provider adapter | API proxy (orchestrator) | Provider-specific HTTP/SDK logic isolated in adapter |
| Response normalization (alias rewrite) | API / Backend (proxy) | — | Rewrites upstream model ID → logical alias in response |
| Config / env loading | API / Backend (proxy) | — | Single config module; no env spread across files |
| Health endpoint | API / Backend (proxy) | — | Liveness probe — no auth, no upstream call |
| Models list endpoint | API / Backend (proxy) | — | Returns registry keys only; no upstream call |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `groq-sdk` | ^1.2.1 | Official Groq TypeScript SDK | Handles auth, retries, error parsing, streaming; maintained by Groq |
| `@cerebras/cerebras_cloud_sdk` | ^1.59.0 (current); ^1.64.1 available | Official Cerebras TypeScript SDK | Same rationale as groq-sdk; `as any` cast removed in Phase 1 |
| `zod` | ^4.4.3 | Request schema validation | TypeScript-first; 14x faster than v3; `z.strictObject()` enables allowlist enforcement |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` | Bun built-in | `timingSafeEqual` for constant-time key comparison | AUTH-03 — always use over `===` for secret comparison |
| `@types/bun` | latest (1.3.5) | TypeScript types for `Bun.serve()`, `Bun.file`, etc. | Already in devDependencies |

### Removed

| Package | Reason |
|---------|--------|
| `cerebras` ^1.2.7 | CLI binary package (~40 MB), not imported in source. Remove from `dependencies`. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `zod` | `valibot` | Valibot is smaller but z.strictObject() pattern has stronger community precedent; Zod v4 closed the size gap |
| `node:crypto timingSafeEqual` | manual char-by-char compare | Hand-rolling constant-time comparison is an anti-pattern; always use the runtime primitive |

**Installation:**
```bash
bun add groq-sdk@^1.2.1 zod@^4.4.3
bun remove cerebras
```

**Version verification:**
```bash
npm view groq-sdk version        # 1.2.1 (published 2026-05-28)
npm view zod version             # 4.4.3 (stable)
npm view @cerebras/cerebras_cloud_sdk version  # 1.64.1 (latest, backwards-compatible with ^1.59.0)
```

---

## Package Legitimacy Audit

> slopcheck run on all packages to be installed/retained.

| Package | Registry | Age | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-------------|-----------|-------------|
| `groq-sdk` | npm | ~2 yrs (created 2024-02-16) | github.com/groq/groq-typescript | [OK] | Approved |
| `@cerebras/cerebras_cloud_sdk` | npm | ~1.75 yrs (created 2024-08-27) | github.com/Cerebras/cerebras-cloud-sdk-node | [OK] | Approved |
| `zod` | npm | ~6 yrs (created 2020-03-07) | github.com/colinhacks/zod | [OK] | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none

**Packages flagged as suspicious [SUS]:** none

*Note: `groq-sdk` flagged by slopcheck as "Name ends with '-sdk' -- classic LLM naming pattern. Name looks like LLM bait but package is established." — slopcheck rated [OK] overall; the warning is cosmetic.*

---

## Architecture Patterns

### System Architecture Diagram

```
Downstream Client (OpenAI SDK / curl)
  |
  | Authorization: Bearer PERSONAL_PROXY_API_KEY
  v
Bun.serve() fetch handler  [index.ts]
  |
  +-- GET /health  ─────────────────────────> Response("ok", 200)  [no auth]
  |
  +-- GET /v1/models ──────────────────────> auth → modelRegistry.list() → OpenAI list response
  |
  +-- POST /v1/chat/completions
        |
        v
    [1] authMiddleware(request)
          → extract Bearer token
          → timingSafeEqual(token, PERSONAL_PROXY_API_KEY)
          → 401 on fail
        |
        v
    [2] parseBody → validateSchema(body, chatCompletionSchema)
          → z.strictObject() → safeParse
          → 400 + first-error on fail
        |
        v
    [3] validateModel(body.model, modelRegistry)
          → 400 "Unknown model" on fail
        |
        v
    [4] injectDefaults(body)
          → max_completion_tokens ??= DEFAULT_MAX_COMPLETION_TOKENS (4096)
        |
        v
    [5] resolveProvider(body.model, config.PROVIDER_ORDER)
          → pick first eligible provider from PROVIDER_ORDER
          → 503 if none
        |
        v
    [6] adapter.complete(upstreamModelId, body)   [cerebras-adapter.ts / groq-adapter.ts]
          → SDK call with stream: false
          → normalizeResponse: rewrite model → logical alias, strip time_info, strip x_groq
        |
        v
    Response(200, normalizedCompletion)
```

### Recommended Project Structure (D-03: minimal, root-level)

```
bun-ai-api/
├── index.ts              # Bun.serve(), fetch router, auth middleware, request pipeline
├── config.ts             # All process.env reads, validation, typed exports
├── types.ts              # ProviderAdapter interface, ChatCompletionResult, OpenAI error types
├── model-registry.ts     # Registry load, lookup, list functions
├── request-schema.ts     # Zod v4 strictObject schema + validation helpers
├── cerebras-adapter.ts   # Cerebras SDK wrapper (non-streaming complete())
├── groq-adapter.ts       # Groq SDK wrapper (non-streaming complete())
├── services/             # (keep existing directory — existing files replaced in-place)
│   ├── groq.ts           # REPLACED by groq-adapter.ts or deleted
│   └── cerebras.ts       # REPLACED by cerebras-adapter.ts or deleted
├── package.json
├── tsconfig.json
└── ...
```

*Note: `services/` directory kept only if adapters are placed there to preserve the existing import convention. D-03 allows either — planner decides.*

### Pattern 1: Non-Streaming Adapter Interface

**What:** A typed interface that both provider adapters implement. Returns a structured completion result, not a stream.

**When to use:** Phase 1 and Phase 2 (Phase 2 adds a streaming method to the same interface).

```typescript
// Source: CONTEXT.md D-01/D-02 + Cerebras/Groq SDK docs
// types.ts

export interface ChatCompletionResult {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;  // will be rewritten to logical alias by normalizer
    choices: Array<{
        index: number;
        message: { role: "assistant"; content: string };
        finish_reason: string | null;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    system_fingerprint?: string;
}

export interface ProviderAdapter {
    name: string;
    complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult>;
    // stream() deferred to Phase 2 — stub or omit here
}

// CompletionParams = validated + default-injected body (internal type, not public contract)
export interface CompletionParams {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    temperature?: number | null;
    top_p?: number | null;
    max_completion_tokens: number;  // always present after default injection
    stop?: string | string[] | null;
    seed?: number | null;
}
```

### Pattern 2: Groq Adapter (non-streaming)

**What:** Wraps groq-sdk v1.2.1 non-streaming call. Uses `ChatCompletionCreateParamsNonStreaming` overload.

```typescript
// Source: github.com/groq/groq-typescript README + completions.ts
// groq-adapter.ts  (or services/groq.ts replacement)

import Groq from "groq-sdk";
import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from "./types";

const groq = new Groq({
    apiKey: process.env["GROQ_API_KEY"],
    maxRetries: 0,   // INFRA-03: proxy handles retries/failover itself
});

export const groqAdapter: ProviderAdapter = {
    name: "groq",
    async complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult> {
        const response = await groq.chat.completions.create({
            model: upstreamModelId,
            messages: params.messages,
            temperature: params.temperature ?? undefined,
            top_p: params.top_p ?? undefined,
            max_completion_tokens: params.max_completion_tokens,
            stop: params.stop ?? undefined,
            seed: params.seed ?? undefined,
            stream: false,
        });
        return {
            id: response.id,
            object: "chat.completion",
            created: response.created,
            model: response.model,   // caller rewrites to logical alias
            choices: response.choices.map((c, i) => ({
                index: i,
                message: { role: "assistant", content: c.message.content ?? "" },
                finish_reason: c.finish_reason ?? null,
            })),
            usage: {
                prompt_tokens: response.usage?.prompt_tokens ?? 0,
                completion_tokens: response.usage?.completion_tokens ?? 0,
                total_tokens: response.usage?.total_tokens ?? 0,
            },
            system_fingerprint: response.system_fingerprint,
        };
    },
};
```

**Key points:**
- `stream: false` is explicit — TypeScript resolves to the `ChatCompletionCreateParamsNonStreaming` overload, returning `ChatCompletion` (not `Stream<>`).
- `response.x_groq` field exists on the response type (Groq-specific metadata: `id`, `debug`, `usage`). Strip it — do not forward to downstream.
- `response.usage_breakdown` also exists (Groq hardware cache stats). Strip it.
- `response.service_tier` exists. Strip it from downstream response for clean normalization.

### Pattern 3: Cerebras Adapter (non-streaming)

**What:** Wraps `@cerebras/cerebras_cloud_sdk`. Uses `ChatCompletionCreateParamsNonStreaming` overload. Passes `X-Cerebras-Version-Patch: 2` as per-request header.

```typescript
// Source: github.com/Cerebras/cerebras-cloud-sdk-node src/_client.ts + completions.ts
// cerebras-adapter.ts

import Cerebras from "@cerebras/cerebras_cloud_sdk";
import type { ProviderAdapter, ChatCompletionResult, CompletionParams } from "./types";

const cerebras = new Cerebras({
    apiKey: process.env["CEREBRAS_API_KEY"],
    maxRetries: 0,  // INFRA-03
});

const CEREBRAS_VERSION_PATCH = process.env["CEREBRAS_VERSION_PATCH"] ?? "2";

export const cerebrasAdapter: ProviderAdapter = {
    name: "cerebras",
    async complete(upstreamModelId: string, params: CompletionParams): Promise<ChatCompletionResult> {
        const response = await cerebras.chat.completions.create(
            {
                model: upstreamModelId,
                messages: params.messages,
                temperature: params.temperature ?? undefined,
                top_p: params.top_p ?? undefined,
                max_completion_tokens: params.max_completion_tokens,
                stop: params.stop ?? undefined,
                seed: params.seed ?? undefined,
                stream: false,
            } as import("@cerebras/cerebras_cloud_sdk").ChatCompletionCreateParamsNonStreaming,
            {
                headers: {
                    "X-Cerebras-Version-Patch": CEREBRAS_VERSION_PATCH,
                },
            }
        );
        // response.time_info: strip (per spec §15 — not forwarded downstream)
        // response.choices[*].message.reasoning: strip (per spec §12 — never expose)
        return {
            id: response.id,
            object: "chat.completion",
            created: response.created,
            model: response.model,   // caller rewrites to logical alias
            choices: response.choices.map((c, i) => ({
                index: i,
                message: { role: "assistant", content: c.message.content ?? "" },
                finish_reason: c.finish_reason ?? null,
            })),
            usage: {
                prompt_tokens: response.usage?.prompt_tokens ?? 0,
                completion_tokens: response.usage?.completion_tokens ?? 0,
                total_tokens: response.usage?.total_tokens ?? 0,
            },
            system_fingerprint: response.system_fingerprint,
        };
    },
};
```

**Key points:**
- `as ChatCompletionCreateParamsNonStreaming` cast is required because `messages` is `Array<{role, content}>` (our internal type) while Cerebras SDK expects its richer union. This is the correct fix for the existing `as any` cast — scoped to the specific overload rather than silencing the whole call.
- The `response` here is `ChatCompletionResponse` (the Cerebras response variant), which includes `time_info` as a top-level field. Strip before returning.
- `response.choices[*].message.reasoning` may be present on reasoning models. Strip per spec §12.

### Pattern 4: Zod v4 Strict Allowlist Validation

**What:** `z.strictObject()` rejects any key not in the schema. `safeParse` returns the first error for D-05.

```typescript
// Source: zod.dev/api (verified 2026-06-05)
// request-schema.ts

import * as z from "zod";

const messageSchema = z.strictObject({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    // NOTE: 'name' field intentionally OMITTED — rejected by z.strictObject()
});

export const chatCompletionSchema = z.strictObject({
    model: z.string(),
    messages: z.array(messageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stream: z.literal(false).optional(),  // Phase 1: only false accepted
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    seed: z.number().int().optional(),
    // 'n' is NOT in the allowlist — z.strictObject() rejects it
    // 'logprobs', 'logit_bias', 'top_logprobs' — NOT in allowlist, rejected
    // 'frequency_penalty', 'presence_penalty' — NOT in allowlist (v2 extension)
});

export type ChatCompletionInput = z.infer<typeof chatCompletionSchema>;

// D-05: return first offending field only
export function validateChatCompletion(body: unknown): 
    { success: true; data: ChatCompletionInput } | 
    { success: false; param: string | null; message: string } 
{
    const result = chatCompletionSchema.safeParse(body);
    if (result.success) return { success: true, data: result.data };
    
    const firstIssue = result.error.issues[0];
    if (!firstIssue) return { success: false, param: null, message: "Invalid request body" };
    
    // path is e.g. [] for top-level, ['messages'] for messages field,
    // ['messages', 0, 'name'] for nested rejection
    const param = firstIssue.path.length > 0 
        ? String(firstIssue.path[0])   // first path segment = field name
        : null;
    
    return { success: false, param, message: firstIssue.message };
}
```

**Key Zod v4 behaviors verified:**
- `z.strictObject()` emits `code: "unrecognized_keys"` for extra keys. The `path` for this issue is `[]` (top-level), and `keys` property lists offending key names. The `message` is descriptive.
- For nested strict objects (messageSchema), `unrecognized_keys` on `messages[0].name` produces `path: ['messages', 0]` — `path[0]` is `"messages"` which is a reasonable `param` value.
- `z.literal(false).optional()` for `stream` rejects `stream: true` with a clear error, which maps to `param: "stream"`. Phase 2 will widen this to `z.boolean().optional()`.

### Pattern 5: Auth Middleware

**What:** Extract Bearer token, constant-time compare, return 401 on fail.

```typescript
// Source: AUTH-01..04 requirements + node:crypto timingSafeEqual (verified in Bun 1.3.11)
// Inline in index.ts or extracted to auth.ts

import { timingSafeEqual } from "node:crypto";

function extractBearerToken(request: Request): string | null {
    const header = request.headers.get("Authorization");
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice(7);
}

function verifyToken(token: string, expected: string): boolean {
    // timingSafeEqual requires same-length buffers
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
```

**Important:** `timingSafeEqual` throws if buffers differ in length — always check length first.

### Pattern 6: OpenAI Error Shape

**What:** All error responses (auth, validation, upstream errors) use this shape per D-05 and spec §14.

```typescript
// D-05 shape — used for ALL errors in Phase 1
function openaiError(
    message: string, 
    type: string, 
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({
            error: { message, type, code, param },
        }),
        { status, headers: { "Content-Type": "application/json" } }
    );
}

// Examples:
// 401 missing auth:
openaiError("No authorization provided", "invalid_request_error", "missing_auth", null, 401)

// 400 validation fail (first field):
openaiError(`Invalid value for 'logprobs'`, "invalid_request_error", "invalid_request_error", "logprobs", 400)

// 400 unknown model:
openaiError(`Unknown model: gpt-4-turbo`, "invalid_request_error", "model_not_found", "model", 400)
```

### Pattern 7: Config Module

**What:** Single module reads all `process.env.*`, validates presence of required keys, exports typed constants.

```typescript
// config.ts — all env reads in one place (INFRA-05)
// Bun auto-loads .env and .env.local — no dotenv needed

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Required env var ${name} is not set`);
    return v;
}

export const config = {
    port: Number(process.env["PORT"] ?? 3000),
    hostname: process.env["HOSTNAME"] ?? "0.0.0.0",
    personalProxyApiKey: required("PERSONAL_PROXY_API_KEY"),
    cerebrasApiKey: required("CEREBRAS_API_KEY"),
    groqApiKey: required("GROQ_API_KEY"),
    cerebrasBaseUrl: process.env["CEREBRAS_BASE_URL"] ?? "https://api.cerebras.ai/v1",
    groqBaseUrl: process.env["GROQ_BASE_URL"] ?? "https://api.groq.com/openai/v1",
    cerebrasVersionPatch: process.env["CEREBRAS_VERSION_PATCH"] ?? "2",
    defaultMaxCompletionTokens: Number(process.env["DEFAULT_MAX_COMPLETION_TOKENS"] ?? 4096),
    providerOrder: (process.env["PROVIDER_ORDER"] ?? "cerebras,groq").split(",") as Array<"cerebras" | "groq">,
    modelRegistryJson: process.env["MODEL_REGISTRY_JSON"] 
        ?? `{"gpt-oss-120b-balanced":{"cerebras":"gpt-oss-120b","groq":"openai/gpt-oss-120b"}}`,
    logLevel: process.env["LOG_LEVEL"] ?? "info",
} as const;
```

**Note:** `required()` throws at startup if a required key is missing — this surfaces misconfiguration immediately, not on first request.

### Pattern 8: Model Registry

**What:** Parses `MODEL_REGISTRY_JSON`, exposes alias lookup and list functions.

```typescript
// model-registry.ts (REG-01..04)
import { config } from "./config";

type RegistryEntry = Record<string, string>;  // { cerebras: "...", groq: "..." }
type Registry = Record<string, RegistryEntry>;

let registry: Registry;
try {
    registry = JSON.parse(config.modelRegistryJson) as Registry;
} catch {
    throw new Error(`MODEL_REGISTRY_JSON is not valid JSON`);
}

// REG-03: returns undefined if alias has no mapping for that provider
export function resolveUpstreamModel(alias: string, provider: string): string | undefined {
    return registry[alias]?.[provider];
}

// REG-01: check alias exists
export function isKnownAlias(alias: string): boolean {
    return alias in registry;
}

// REG-04: returns stable alias IDs only
export function listAliases(): string[] {
    return Object.keys(registry);
}
```

### Anti-Patterns to Avoid

- **`as any` on messages:** The existing cerebras adapter uses `messages as any`. Replace with explicit `as ChatCompletionCreateParamsNonStreaming` cast scoped to the create() call — this preserves type safety elsewhere.
- **String equality for secrets:** `token === expected` is not constant-time. Use `timingSafeEqual` always (AUTH-03).
- **`process.env.*` spread across files:** Config reads outside `config.ts` violate INFRA-05. If a new file needs a config value, import it from `config.ts`.
- **`stream: true` in non-streaming path:** The existing adapters default to `stream: true`. Explicitly set `stream: false` in Phase 1 adapters to hit the correct TypeScript overload.
- **Forwarding `x_groq` / `time_info` / `reasoning`:** These are provider-specific fields. Strip them before constructing `ChatCompletionResult`. The `ChatCompletionResult` type defined above makes this structural — fields not in the interface cannot be forwarded.
- **Forwarding `service_tier` / `service_tier_used`:** Cerebras-specific fields. Not in `ChatCompletionResult`.
- **Using `z.object()` instead of `z.strictObject()`:** `z.object()` passes through unknown keys silently. Must use `z.strictObject()` for VALID-07.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Constant-time string comparison | Custom loop | `timingSafeEqual` from `node:crypto` | Timing attacks are real; hand-rolled loops leak information via branch timing |
| Request schema validation | Manual field checks | Zod v4 `z.strictObject()` | Nested type safety, first-error extraction, unrecognized-key rejection — ~50 lines of manual validation would miss edge cases |
| SDK authentication + retry | Raw `fetch()` to upstream | Keep groq-sdk + cerebras_cloud_sdk | SDKs handle auth header injection, error parsing to typed classes, connection reuse, TLS — reimplementing is weeks of work |
| JSON parse with error handling | `try { JSON.parse(...) }` inline | Zod safeParse on the parsed object | Zod validates shape after parse; keeps validation in one place |

**Key insight:** The entire value of keeping both SDKs is that `Groq.APIError` and `Cerebras.APIError` give typed access to `err.status`, `err.headers`, and `err.error` — Phase 2 rate-limit header parsing depends on this. Don't replace with raw fetch.

---

## Common Pitfalls

### Pitfall 1: groq-sdk 0.37 → 1.x Import Path

**What goes wrong:** v0.37.x exported `Groq` as default. v1.x preserves this. However, the module entrypoint restructured in v1.0.0 (TypeScript migration). If `import Groq from 'groq-sdk'` stops working, check that the package installed is actually 1.x and not cached at 0.37.x.

**Why it happens:** `bun install` with `^0.37.0` will not auto-upgrade to `^1.2.1`. The version constraint must be manually bumped in `package.json` before running `bun install`.

**How to avoid:** Explicitly set `"groq-sdk": "^1.2.1"` in `package.json`, then run `bun install`. Verify `bun.lock` shows `groq-sdk@1.2.1`.

**Warning signs:** TypeScript errors on `groq.chat.completions.create()` — check resolved version in bun.lock.

### Pitfall 2: Cerebras `messages` Type Mismatch

**What goes wrong:** The Cerebras SDK `messages` field is `Array<SystemMessageRequest | UserMessageRequest | AssistantMessageRequest | ToolMessageRequest>`. Each variant's `content` is a union of `string | Array<TextContent | ImageURLContent | ...>`. Our internal `CompletionParams.messages` is `Array<{ role, content: string }>`, which is structurally narrower. TypeScript will error without a cast.

**Why it happens:** Provider SDK types reflect the full API capability (multimodal content, tool messages, name field). Our proxy enforces a strict intersection contract with only string content.

**How to avoid:** Cast only the `create()` call params: `cerebras.chat.completions.create({ ...params } as ChatCompletionCreateParamsNonStreaming, options)`. Do NOT use `as any` — use the exact overload type. This gives TypeScript the overload resolution hint it needs and is safe because our validated params are a subset.

**Warning signs:** TS error `Type 'string' is not assignable to type 'string | TextContent[]...'` on the messages argument.

### Pitfall 3: `z.strictObject()` Error Path for `messages[].name`

**What goes wrong:** When a client sends `messages: [{ role: "user", content: "hi", name: "Alice" }]`, Zod reports an `unrecognized_keys` error with `path: ['messages', 0]` (not `path: ['messages', 0, 'name']`). The `param` extracted as `path[0]` would be `"messages"`, not `"name"`.

**Why it happens:** `z.strictObject()` on nested schemas emits the error at the object level, not the key level. The offending key is listed in `issue.keys` array, not in `path`.

**How to avoid:** For the `param` field in the OpenAI error shape, use `path[0]` (the top-level field) as the primary param. This is spec-faithful — OpenAI's own `param` field points to the containing field, not the nested key name. The `message` field provides the specific detail.

**Warning signs:** `error.param = "messages"` when client sent `messages[].name` — this is correct behavior, not a bug.

### Pitfall 4: Cerebras `time_info` in Response Type

**What goes wrong:** `response.time_info` exists on the Cerebras `ChatCompletionResponse` type and will be present on non-streaming responses. If the adapter naively spreads the SDK response (`{ ...response }`), `time_info` leaks into the downstream body.

**Why it happens:** The SDK response type is a superset of OpenAI's response shape.

**How to avoid:** The `ChatCompletionResult` interface approach (constructing the return object field-by-field) makes this structurally impossible — unmapped fields cannot be included. Never spread provider responses.

**Warning signs:** Downstream client receives `time_info` field in response body.

### Pitfall 5: Groq `x_groq` and `usage_breakdown` in Response

**What goes wrong:** Groq non-streaming responses include `x_groq` (Groq-internal metadata with `id`, hardware cache stats) and `usage_breakdown`. Spreading `response` into the downstream body exposes provider identity.

**Why it happens:** `x_groq` is in the Groq SDK `ChatCompletion` type with optional typing — TypeScript will not flag its presence.

**How to avoid:** Same as Pitfall 4 — construct `ChatCompletionResult` field-by-field. The `usage` from `response.usage` (standard) is forwarded; `x_groq.usage` (hardware stats) is not.

**Warning signs:** Downstream response has `x_groq` key — provider identity leak.

### Pitfall 6: `timingSafeEqual` with Different-Length Buffers

**What goes wrong:** `timingSafeEqual` throws a `TypeError` if the two buffers have different byte lengths. Calling `timingSafeEqual(Buffer.from("short"), Buffer.from("a-much-longer-key"))` raises an exception, crashing the request handler.

**Why it happens:** The function guarantees constant-time comparison, but only for equal-length inputs.

**How to avoid:** Always check `a.length !== b.length` and return `false` before calling `timingSafeEqual`. See Pattern 5 above.

**Warning signs:** Unhandled `TypeError: Input buffers must have the same byte length` in request logs when clients send short/malformed tokens.

### Pitfall 7: Zod v4 — Removed `z.object().strict()` Method

**What goes wrong:** Code using `z.object({ ... }).strict()` — common in Zod v3 guides — will fail in v4 with a method-not-found error. The `.strict()` method is deprecated in v4.

**Why it happens:** Zod v4 moved strict object creation to the top-level function `z.strictObject()`.

**How to avoid:** Use `z.strictObject({ ... })` exclusively. Never use `z.object({ ... }).strict()` in this codebase.

**Warning signs:** Runtime error or TypeScript error: `Property 'strict' does not exist on ZodObject` (if types are current) or silent pass-through of extra fields (if using an older type bundle).

### Pitfall 8: `X-Cerebras-Version-Patch` Header Becomes Default on 2026-07-21

**What goes wrong:** Per Cerebras docs, version patch 2 becomes the **default** on 2026-07-21 — after that date, sending the header is no longer necessary, and Cerebras may deprecate it.

**Why it happens:** The header is transitional. The CLAUDE.md spec (§5.1) says to make it configurable.

**How to avoid:** `config.cerebrasVersionPatch` is env-configurable (D-03 discretion area). When Cerebras removes the header from their docs, simply unset `CEREBRAS_VERSION_PATCH` in `.env`.

**Warning signs:** Post-2026-07-21, Cerebras may return 400 or warning for the header. Monitor upstream changelog.

---

## Code Examples

### Non-Streaming Groq SDK Call (v1.2.1)

```typescript
// Source: github.com/groq/groq-typescript README (verified 2026-06-05)
import Groq from "groq-sdk";

const groq = new Groq({ maxRetries: 0 });

const response = await groq.chat.completions.create({
    messages: [{ role: "user", content: "Hello" }],
    model: "openai/gpt-oss-120b",
    stream: false,
    max_completion_tokens: 4096,
});
// response is Groq.Chat.ChatCompletion
// response.model = "openai/gpt-oss-120b"  (upstream model ID, not logical alias)
// response.x_groq = { id: "...", debug: null, usage: { dram_cached_tokens: ... } }
// response.usage_breakdown = { ... }  <- strip both
```

### Non-Streaming Cerebras SDK Call (^1.59.0)

```typescript
// Source: github.com/Cerebras/cerebras-cloud-sdk-node (verified 2026-06-05)
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "@cerebras/cerebras_cloud_sdk";

const cerebras = new Cerebras({ maxRetries: 0 });

const response = await cerebras.chat.completions.create(
    {
        model: "gpt-oss-120b",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
        max_completion_tokens: 4096,
    } as ChatCompletionCreateParamsNonStreaming,
    { headers: { "X-Cerebras-Version-Patch": "2" } }
);
// response is Cerebras.ChatCompletionResponse
// response.time_info = { queue_time, prompt_time, completion_time, total_time }  <- strip
// response.choices[0].message.reasoning  <- strip if present
```

### Zod v4 Strict Schema Usage

```typescript
// Source: zod.dev/api (verified 2026-06-05)
import * as z from "zod";

const schema = z.strictObject({
    model: z.string(),
    messages: z.array(z.strictObject({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
    })).min(1),
});

// Extra key rejected:
const result = schema.safeParse({ model: "x", messages: [...], logprobs: true });
// result.success = false
// result.error.issues[0].code = "unrecognized_keys"
// result.error.issues[0].path = []
// result.error.issues[0].message = "Unrecognized key(s) in object: 'logprobs'"
```

### Error Response Shape

```typescript
// Source: CONTEXT.md D-05 + REQUIREMENTS.md VALID-01..07
// All errors — auth, validation, model-not-found, upstream — use this shape

return new Response(
    JSON.stringify({
        error: {
            message: "Unknown model 'gpt-4-turbo'",
            type: "invalid_request_error",
            code: "model_not_found",
            param: "model",
        },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
);
```

### GET /v1/models Response

```typescript
// Source: CLAUDE.md §9 (verified spec)
// Returns logical aliases only — REG-04

return new Response(
    JSON.stringify({
        object: "list",
        data: listAliases().map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "personal-proxy",
        })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
);
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| groq-sdk `^0.37.0` (JS) | groq-sdk `^1.2.1` (TypeScript-native) | v1.0.0 released 2025-12-15 | Typed errors, TypeScript-first API; same call surface |
| `z.object({}).strict()` | `z.strictObject({})` | Zod v4.0 | Method removed (deprecated); must use top-level function |
| `z.ZodError.errors` | `z.ZodError.issues` | Zod v4.0 | `.errors` property removed; use `.issues` |
| `z.ZodError.format()` / `.flatten()` | Not available | Zod v4.0 | Removed; use `.issues` array directly |
| Cerebras version patch optional | Cerebras version patch default on 2026-07-21 | Announced 2026-01-21 | Header becomes unnecessary after July 2026 |

**Deprecated/outdated:**
- `AIService` interface (existing `types.ts`): The `chat: (messages) => Promise<AsyncIterable<string>>` streaming contract is replaced by `ProviderAdapter.complete()` in Phase 1. The old interface is deleted.
- `services/groq.ts` + `services/cerebras.ts` (existing): These are the streaming prototype adapters. They are replaced by `groq-adapter.ts` and `cerebras-adapter.ts` (or in-place rewrites). The `cerebras.ts` contains a known bug (returns generator function not invoked result).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The groq-sdk v0.37 → v1.x upgrade does not break the non-streaming `chat.completions.create()` call shape | Standard Stack, Pattern 2 | Low: changelog confirms only TypeScript migration and bug fixes; call surface unchanged |
| A2 | `@cerebras/cerebras_cloud_sdk` is compatible with Bun 1.3.11 (it uses node-fetch, abort-controller as polyfills) | Standard Stack | Medium: SDK has Node.js polyfill dependencies; if Bun compatibility breaks, test with `bun test` will surface it |
| A3 | Cerebras does not return a non-2xx error for `X-Cerebras-Version-Patch: 2` on the gpt-oss-120b model | Pattern 3 | Low: per docs, v2 is a supported test version valid until July 2026 |
| A4 | `gpt-oss-120b` is the Cerebras model ID for the `gpt-oss-120b-balanced` alias | Standard Stack | Low: per CLAUDE.md §8 model registry table and Groq model list confirming `openai/gpt-oss-120b` |

**If this table's risks materialize:** A2 is the most actionable — if Cerebras SDK fails under Bun, add a targeted test in Phase 1 verification.

---

## Open Questions

1. **Should `services/` directory be kept or files moved to root?**
   - What we know: D-03 says root-level; existing code uses `services/` directory.
   - What's unclear: Whether to rename adapters to `groq-adapter.ts` at root, or replace `services/groq.ts` in-place.
   - Recommendation: Replace in-place (`services/groq.ts` → rewritten non-streaming adapter) to minimize git diff. Planner decides based on D-03 discretion.

2. **Should Phase 1 include `GET /v1/models` (EP-03) or only the endpoints listed in CONTEXT.md phase boundary?**
   - What we know: CONTEXT.md phase boundary explicitly includes `GET /v1/models`. REQUIREMENTS.md shows EP-03 as Phase 2.
   - What's unclear: This is a conflict between CONTEXT.md boundary description and REQUIREMENTS.md traceability table.
   - Recommendation: Follow CONTEXT.md (more specific, written after REQUIREMENTS.md) — include `GET /v1/models` in Phase 1. EP-03 in REQUIREMENTS.md was likely mis-assigned.

3. **Should `stream: true` requests be rejected in Phase 1 validation, or silently accepted and queued for Phase 2?**
   - What we know: D-02 defers streaming to Phase 2. Validation schema uses `z.literal(false).optional()` which will reject `stream: true` with a 400.
   - What's unclear: Whether clients should receive an actionable error vs. silent omission.
   - Recommendation: Reject `stream: true` with `400` and `param: "stream"` and message "Streaming is not yet supported." This is honest and helps clients, and the Zod schema already handles it cleanly.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | Runtime | ✓ | 1.3.11 (local), 1.1.29 (Docker) | — |
| Node.js | Dev tooling only | ✓ | v22.22.3 | — |
| `node:crypto` | AUTH-03 `timingSafeEqual` | ✓ | Bun built-in (verified) | — |
| `.env` file | All secret keys | ✓ | Present (166 bytes) | — |
| Upstream APIs (Cerebras, Groq) | Integration tests | Not probed | — | Unit tests with mock adapters |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** Upstream APIs not probed (this is expected — integration tests require valid API keys).

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `timingSafeEqual` for proxy key comparison; reject missing/invalid Bearer with 401 |
| V3 Session Management | no | Stateless proxy — no sessions |
| V4 Access Control | partial | `/health` open; all other endpoints require auth |
| V5 Input Validation | yes | Zod v4 `z.strictObject()` — strict allowlist, first-error on fail |
| V6 Cryptography | no | No key generation or storage; `timingSafeEqual` is timing-safe comparison, not crypto |

### Known Threat Patterns for this Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Upstream key exfiltration via error response | Information Disclosure | Never include `CEREBRAS_API_KEY` / `GROQ_API_KEY` in responses or logs; error body uses only proxy-generated messages |
| Prompt content logging | Information Disclosure | `console.log` must never log `messages[]` content (AUTH-04 extended) |
| Oversized request body | Denial of Service | `MAX_REQUEST_BODY_BYTES` env var (1MB default); validate body size before parsing |
| Timing attack on proxy key | Elevation of Privilege | `timingSafeEqual` with length pre-check (AUTH-03) |
| Field injection via pass-through | Tampering | `z.strictObject()` rejects all non-allowlisted fields before upstream call |
| Provider credential leak in downstream response | Information Disclosure | `ChatCompletionResult` interface strips all provider-specific fields structurally |

---

## Sources

### Primary (HIGH confidence)
- `github.com/groq/groq-typescript` README + `src/resources/chat/completions.ts` + `src/core/error.ts` — groq-sdk v1.2.1 API surface, error types, non-streaming call shape
- `github.com/Cerebras/cerebras-cloud-sdk-node` `src/resources/chat/completions.ts` + `src/core.ts` + `src/error.ts` — Cerebras SDK create() signature, RequestOptions.headers, error hierarchy
- `zod.dev/api` and `zod.dev/v4/changelog` — `z.strictObject()`, `safeParse`, `issues[0]`, removed `.strict()` method, import path
- `inference-docs.cerebras.ai/api-reference/versions` — X-Cerebras-Version-Patch valid values and 2026-07-21 default cutover
- `inference-docs.cerebras.ai/support/rate-limits` — Cerebras rate-limit header names and float-seconds reset format (Phase 2 context, not Phase 1)
- `console.groq.com/docs/rate-limits` — Groq rate-limit headers, duration-string format, `retry-after` only on 429
- `console.groq.com/docs/errors` — HTTP 498 definition, Groq error body shape
- `console.groq.com/docs/openai` — Groq's explicit list of unsupported OpenAI fields

### Secondary (MEDIUM confidence)
- npm registry (`npm view groq-sdk`, `npm view zod`, `npm view @cerebras/cerebras_cloud_sdk`) — current versions, publish dates, repository URLs, confirmed names
- `inference-docs.cerebras.ai/api-reference/chat-completions` — Cerebras non-streaming response fields including `time_info`

### Tertiary (LOW confidence — noted in Assumptions Log)
- groq-sdk CHANGELOG.md — v0.37 → v1.0.0 breaking change claim of "no API-surface changes" is based on changelog absence of breaking changes, not an explicit migration guide

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all package versions verified against npm registry; slopcheck [OK] on all three; official repos confirmed
- Architecture: HIGH — locked decisions from CONTEXT.md; SDK type signatures verified directly from source
- Pitfalls: HIGH — derived from actual SDK source files and Zod v4 docs; not from training-data assumptions
- groq-sdk v0.37 → v1.x compatibility: MEDIUM — changelog does not explicitly list breaking changes; call surface appears unchanged but not officially confirmed as "no breaking changes"

**Research date:** 2026-06-05
**Valid until:** 2026-07-21 (Cerebras version patch becomes default; review Cerebras header config)
