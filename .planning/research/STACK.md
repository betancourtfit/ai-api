# Stack Research: OpenAI-Compatible Proxy Middleware in Bun

**Project:** bun-ai-api — Cerebras + Groq proxy  
**Researched:** 2026-06-04  
**Sources:** Context7 (groq-typescript, oven-sh/bun, colinhacks/zod, cerebras-cloud-sdk-node), official Groq rate-limit docs, official Cerebras rate-limit docs, npm registry

---

## Recommended Stack

| Library | Version | Purpose | Confidence |
|---------|---------|---------|------------|
| `bun` runtime | >=1.1.29 (prod), >=1.3.11 (dev) | HTTP server, SSE, test runner, env loading | HIGH |
| `groq-sdk` (`groq-sdk` on npm) | ^1.2.1 (latest: 1.2.1) | Groq upstream calls, streaming, error types | HIGH |
| `@cerebras/cerebras_cloud_sdk` | ^1.64.1 (latest: 1.64.1) | Cerebras upstream calls, streaming | HIGH |
| `zod` | ^4.4.3 (latest stable: 4.4.3) | Request body validation, schema inference | HIGH |
| `@types/bun` | latest (1.3.5 resolved) | Bun runtime TypeScript types | HIGH |
| `typescript` | ^5 (peer) | Type checking — Bun transpiles natively, no emit | HIGH |

**No additional runtime dependencies are needed.** Logging, UUID generation, SSE, env loading, and the test runner are all covered by Bun built-ins or the two provider SDKs.

---

## Key Library Details

### Bun.serve() — SSE Streaming Relay

**Pattern: async generator (preferred for relay)**

Bun supports two SSE patterns. The async generator form is the right choice for a relay because it lets you `yield` each chunk from the upstream SDK iterator directly, and Bun cancels the generator automatically on client disconnect:

```typescript
// routes/chat.ts
Bun.serve({
  routes: {
    "/v1/chat/completions": async (req, server) => {
      server.timeout(req, 0); // REQUIRED: default idle timeout is 10s
      // ...parse and auth...

      return new Response(
        async function* () {
          const stream = await providerClient.chat.completions.create({
            ...params,
            stream: true,
          });
          for await (const chunk of stream) {
            const json = JSON.stringify(normalizeChunk(chunk));
            yield `data: ${json}\n\n`;
          }
          yield "data: [DONE]\n\n";
        },
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Request-ID": requestId,
          },
        }
      );
    },
  },
});
```

**Critical gotcha:** `server.timeout(req, 0)` must be called before returning the Response. Bun's default idle timeout is 10 seconds — a quiet LLM stream (e.g., waiting for the first token) will drop the connection silently without this call.

**No-failover-after-first-chunk constraint:** Once the generator has yielded at least one `data:` line, do not attempt failover. The HTTP response headers and status 200 are already committed. Detect errors from the upstream SDK before yielding or catch them after the first yield and close the stream cleanly with an SSE-level error event.

**ReadableStream alternative:** Also supported, but the async generator form is simpler for relay use. The `ReadableStream` form requires manual `cancel()` cleanup.

---

### groq-sdk — Version, Streaming, Error, Rate Limit Headers

**Current version:** 1.2.1 (latest on npm as of 2026-06-04). The `package.json` pins `^0.37.0` — this is significantly behind. Upgrade is recommended but requires verifying the streaming API surface hasn't changed (the for-await pattern is stable).

**Streaming API surface (verified, HIGH confidence):**

```typescript
import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const stream = await groq.chat.completions.create({
  model: "openai/gpt-oss-20b",
  messages: [...],
  stream: true,
});
// stream is AsyncIterable<ChatCompletionChunk>
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content ?? "";
}
```

**Error handling — rate limit:**

```typescript
import Groq from "groq-sdk";

try {
  await groq.chat.completions.create({ ... });
} catch (err) {
  if (err instanceof Groq.RateLimitError) {
    // err.status === 429
    // err.headers contains rate limit headers
    const retryAfterSeconds = Number(err.headers?.get("retry-after") ?? "60");
    // Groq rate limit headers (always on responses, retry-after only on 429):
    //   x-ratelimit-limit-requests       (RPD)
    //   x-ratelimit-limit-tokens         (TPM)
    //   x-ratelimit-remaining-requests
    //   x-ratelimit-remaining-tokens
    //   x-ratelimit-reset-requests       (time until RPD resets)
    //   x-ratelimit-reset-tokens         (time until TPM resets)
    //   retry-after                      (seconds, only on 429)
  }
}
```

**Raw header access (non-error path):** Use `.withResponse()` to get both parsed data and the raw `Response` object if you need to read rate-limit headers from successful responses:

```typescript
const { data, response } = await groq.chat.completions
  .create({ ... })
  .withResponse();
const remaining = response.headers.get("x-ratelimit-remaining-requests");
```

**Groq error types:** `Groq.RateLimitError` (429), `Groq.InternalServerError` (500–504), `Groq.APIConnectionError` (network/timeout). All are subclasses of `Groq.APIError`. The `status` property holds the HTTP status code.

---

### @cerebras/cerebras_cloud_sdk — Streaming, Error, Rate Limit Headers

**Current version:** 1.64.1 (latest on npm as of 2026-06-04). `package.json` pins `^1.59.0` — within range, no upgrade needed.

**Streaming API surface (verified, HIGH confidence):**

```typescript
import Cerebras from "@cerebras/cerebras_cloud_sdk";
const cerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });

const stream = await cerebras.chat.completions.create({
  model: "gpt-oss-120b",   // native Cerebras alias
  messages: [...],
  stream: true,
  stream_options: { include_usage: true }, // usage only in final chunk
});
// stream is AsyncIterable<ChatCompletion>
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content ?? "";
  // time_info and reasoning fields appear on final chunk — strip these
}
```

**Fields to strip from Cerebras responses (per PROJECT.md requirement):**
- `choices[*].message.reasoning`
- `choices[*].reasoning_logprobs`
- `time_info`

**Rate limit headers — Cerebras (on EVERY response, not just 429):**
```
x-ratelimit-limit-requests-day
x-ratelimit-limit-tokens-minute
x-ratelimit-remaining-requests-day
x-ratelimit-remaining-tokens-minute
x-ratelimit-reset-requests-day       (seconds, decimal: e.g. "33011.382...")
x-ratelimit-reset-tokens-minute
```

**SDK auto-retry:** The Cerebras SDK automatically retries 429 responses up to 2 times with exponential backoff by default. **Disable this** with `maxRetries: 0` in the constructor — the proxy's own routing layer manages failover and cooldown, not the SDK:

```typescript
const cerebras = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
  maxRetries: 0, // let the proxy handle retries/failover
});
```

**Same pattern applies for groq-sdk** — disable SDK-level retries so the proxy router has full control.

**Error type:** `Cerebras.RateLimitError` for 429. Catch and read headers from `err.headers` or from the response object (since Cerebras sends rate-limit headers on all responses, you can read them from successful calls too).

---

### Zod — Request Body Validation

**Current version:** 4.4.3 (stable). Zod v4 is a ground-up rewrite with breaking changes from v3.

**Why Zod v4, not v3:**
- 14x faster string parsing, 7x faster array parsing — relevant for a hot request path
- 57% smaller core bundle (ESM, tree-shakable)
- TypeScript compile time: ~175 type instantiations vs >25,000 in v3
- v3 is still installable via `zod/v3` import path for gradual migration — no conflict

**Breaking changes that affect this project:**
- String format validators moved to top-level: `z.email()` not `z.string().email()` — does not affect request body validation for chat completions (we validate `model`, `messages`, `stream`, etc., not email strings)
- Import: `import * as z from "zod"` or `import { z } from "zod"` — both work in v4
- `z.strictObject()` for allowlist-based validation (rejects unknown keys with error)

**Pattern for allowlist validation (intersection contract):**

```typescript
import { z } from "zod";

const ChatCompletionRequestSchema = z.strictObject({
  model: z.string(),
  messages: z.array(
    z.strictObject({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  seed: z.number().int().optional(),
});

// In request handler:
const body = await req.json();
const result = ChatCompletionRequestSchema.safeParse(body);
if (!result.success) {
  return Response.json(
    { error: { message: result.error.message, type: "invalid_request_error" } },
    { status: 400 }
  );
}
// result.data is fully typed
```

**`z.strictObject()` is the right tool** — it throws on unknown keys, implementing the allowlist contract without manual field enumeration. Fields like `logprobs`, `logit_bias`, `n` are rejected automatically if not in the schema.

---

### Stateful In-Memory Provider State

**No external dependency needed.** A module-level singleton is the correct pattern for single-process, no-persistence state in Bun:

```typescript
// state/providers.ts
export type ProviderState = {
  name: "cerebras" | "groq";
  enabled: boolean;
  cooldownUntil: number | null; // Date.now() ms, null = available
};

const state: ProviderState[] = [
  { name: "cerebras", enabled: true, cooldownUntil: null },
  { name: "groq", enabled: true, cooldownUntil: null },
];

let roundRobinIndex = 0;

export function getEligibleProvider(): ProviderState | null {
  const now = Date.now();
  const eligible = state.filter(
    (p) => p.enabled && (p.cooldownUntil === null || p.cooldownUntil <= now)
  );
  if (eligible.length === 0) return null;
  const chosen = eligible[roundRobinIndex % eligible.length];
  roundRobinIndex++;
  return chosen;
}

export function setCooldown(name: string, seconds: number): void {
  const p = state.find((p) => p.name === name);
  if (p) p.cooldownUntil = Date.now() + seconds * 1000;
}
```

**Why this approach:**
- Bun runs single-threaded; no mutex or atomic operations needed
- Module-level state persists across requests within a process (correct behavior)
- No Redis, no file, no shared memory — matches the single-instance constraint
- Cooldown expiry is lazy (checked at selection time, not via a timer) — simple and correct
- Export functions not raw state — tests can import and manipulate state directly

---

### Bun Test — HTTP Server Integration Pattern

**Pattern: real server on port 0, `beforeAll`/`afterAll`:**

```typescript
// tests/chat.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../server"; // returns Server from Bun.serve()

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = createServer({ port: 0 }); // port 0 = OS assigns free port
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true); // true = force close active connections
});

test("POST /v1/chat/completions returns 401 without auth", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-oss-120b-balanced", messages: [] }),
  });
  expect(res.status).toBe(401);
});
```

**Mocking provider SDKs for unit tests** — use `mock.module()` to replace the SDK before import:

```typescript
import { mock } from "bun:test";

mock.module("groq-sdk", () => ({
  default: class MockGroq {
    chat = {
      completions: {
        create: mock(async () => ({ choices: [{ message: { content: "ok" } }] })),
      },
    };
  },
}));
```

**Key insight:** Because Bun runs TypeScript natively with zero compile step, `beforeAll(() => Bun.serve(...))` is safe — no dist/ artifacts needed. Export the server factory from a module (`server.ts`) rather than calling `Bun.serve()` at module load time, so tests can construct a fresh instance.

---

### UUID / Request ID Generation

`crypto.randomUUID()` is a Web API available natively in Bun — no `uuid` package needed.

```typescript
const requestId = crypto.randomUUID(); // returns "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
```

---

### Structured Logging

No library needed for MVP. Use `JSON.stringify` to console.log structured objects. Bun writes stdout synchronously. If a logging library is desired later, `pino` is the standard choice (extremely fast, structured, Bun-compatible) — but it adds a dependency and is not required given the single-user, personal-use scope.

---

## What NOT to Use

| What | Why Not |
|------|---------|
| `express` / `hono` / `fastify` | `Bun.serve()` covers all requirements; extra dependency adds surface area, diverges from CLAUDE.md constraint |
| `openai` npm package as proxy shim | The proxy IS the OpenAI-compatible layer; using the OpenAI SDK to proxy to itself creates circular confusion and unnecessary dep |
| `dotenv` | Bun auto-loads `.env` and `.env.local`; importing dotenv is a no-op and a lint warning |
| `ws` package | `WebSocket` is built-in to Bun; `ws` is Node.js-only ergonomics |
| `better-sqlite3` | `bun:sqlite` is built-in; better-sqlite3 is Node.js-native-module incompatible with Bun |
| `ioredis` | `Bun.redis` is built-in; also, the project explicitly has no Redis/persistence requirement |
| `uuid` package | `crypto.randomUUID()` is a Web API standard, available in Bun globally |
| `pino` / `winston` | Overkill for personal-use, single-instance proxy; structured `console.log(JSON.stringify(...))` is sufficient |
| `jest` / `vitest` | `bun test` is the runtime; Jest/Vitest require Node.js and are explicitly excluded by CLAUDE.md |
| `zod` v3 | v4 is stable at 4.4.3, significantly faster, smaller bundle, better TS compile performance; no reason to pin v3 for a greenfield project |
| `cerebras` package (^1.2.7) | This is a native CLI binary (platform-specific), not an SDK. It installs `cerebras-darwin-arm64` etc. The existing `package.json` dependency should be removed — it is unused in application code and adds ~40MB of native binaries to the install |
| SDK-level auto-retry (Cerebras default: 2 retries) | Disable with `maxRetries: 0` on both SDK clients. The proxy router owns retry/failover logic; SDK retries create timing conflicts with cooldown state and can delay failover to the alternate provider |

---

## Open Questions

1. **groq-sdk version gap:** Current pin is `^0.37.0`; latest is `1.2.1`. The major version bump (0.x → 1.x) likely has breaking changes. Before upgrading, verify the streaming `for await` API surface and `Groq.RateLimitError` class name are unchanged. Check the groq-typescript CHANGELOG.

2. **Cerebras `time_info` field shape:** The Cerebras SDK docs confirm `time_info` appears on the final streaming chunk. Verify the exact field path (`chunk.time_info` vs `chunk.usage.time_info`) against a live response or the SDK's TypeScript type definitions before writing the strip logic.

3. **Groq model alias format:** The PROJECT.md model registry maps `gpt-oss-120b-balanced` → `openai/gpt-oss-120b` for Groq. The groq-sdk example in Context7 uses `model: 'openai/gpt-oss-20b'` — confirming the `openai/` prefix format is current. Verify `openai/gpt-oss-120b` is a valid Groq model ID against `/openai/v1/models`.

4. **Zod v4 `z.strictObject` on discriminated unions:** The `messages` array contains `role`-discriminated objects. Verify `z.strictObject` behaves as expected when nested inside `z.array()` for the allowlist behavior — specifically that extra fields on individual message objects are rejected.

5. **`server.stop()` behavior in `bun test`:** Bun's `Server.stop(true)` forcibly closes active connections. Confirm this does not leave dangling async generators mid-stream in integration tests — may need a short `await` or drain pattern after `stop()`.

---

## Sources

- Context7 `/groq/groq-typescript`: streaming API, error types, `.withResponse()`, rate limit headers — HIGH confidence
- Context7 `/oven-sh/bun`: SSE patterns, `server.timeout(req, 0)`, `port: 0`, `mock.module()`, `beforeAll`/`afterAll` — HIGH confidence  
- Context7 `/colinhacks/zod`: `z.strictObject()`, `safeParse`, v4 API changes — HIGH confidence
- Context7 `/cerebras/cerebras-cloud-sdk-node`: streaming API, `stream_options.include_usage`, `maxRetries` — HIGH confidence
- [Groq Rate Limits docs](https://console.groq.com/docs/rate-limits): exact header names, `retry-after` format — HIGH confidence
- [Cerebras Rate Limits docs](https://inference-docs.cerebras.ai/support/rate-limits): header names, decimal seconds format — HIGH confidence
- npm registry: version verification (`groq-sdk@1.2.1`, `@cerebras/cerebras_cloud_sdk@1.64.1`, `zod@4.4.3`) — HIGH confidence
