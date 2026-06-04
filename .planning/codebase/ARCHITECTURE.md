<!-- refreshed: 2026-06-04 -->
# Architecture

**Analysis Date:** 2026-06-04

## System Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│                       Downstream Client                          │
│           Authorization: Bearer PERSONAL_PROXY_API_KEY           │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP POST /chat
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    HTTP Server Entry Point                        │
│                         `index.ts`                               │
│  ┌──────────────────┐          ┌──────────────────────────────┐  │
│  │  Route: GET /    │          │  Route: POST /chat           │  │
│  │  Route: GET      │          │  Parses ChatMessage[]        │  │
│  │  /health         │          │  Selects service via         │  │
│  └──────────────────┘          │  round-robin (getNextService) │  │
│                                └───────────────┬──────────────┘  │
└────────────────────────────────────────────────┼────────────────┘
                             ┌───────────────────┘
                             │ AIService.chat(messages)
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                      Service Layer                              │
│   ┌───────────────────────┐   ┌──────────────────────────────┐ │
│   │   `services/groq.ts`  │   │  `services/cerebras.ts`      │ │
│   │  groqService          │   │  cerebrasService             │ │
│   │  model: kimi-k2       │   │  model: qwen-3-32b           │ │
│   │  streams via groq-sdk │   │  streams via cerebras SDK    │ │
│   └──────────┬────────────┘   └──────────────┬───────────────┘ │
└──────────────┼─────────────────────────────────┼───────────────┘
               │                                 │
               ▼                                 ▼
┌──────────────────────┐         ┌───────────────────────────────┐
│  Groq Cloud           │         │  Cerebras Inference           │
│  api.groq.com/        │         │  api.cerebras.ai/v1           │
│  openai/v1            │         │                               │
└──────────────────────┘         └───────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| HTTP Server | Request routing, SSE response relay, health check | `index.ts` |
| Round-robin router | Stateless service index cycling (`getNextService`) | `index.ts` |
| Groq service | Wraps groq-sdk, streams completions from Groq Cloud | `services/groq.ts` |
| Cerebras service | Wraps cerebras SDK, streams completions from Cerebras | `services/cerebras.ts` |
| Type definitions | Shared `AIService` interface, `ChatMessage` type | `types.ts` |

## Pattern Overview

**Overall:** Thin HTTP proxy with service-abstracted provider routing

**Key Characteristics:**
- `Bun.serve()` native HTTP server — no Express or external framework
- Round-robin provider selection via module-level mutable index (`currentServiceIndex`)
- All provider responses are async generator streams forwarded as SSE (`text/event-stream`)
- Providers conform to a shared `AIService` interface defined in `types.ts`
- SDK clients instantiated once at module load time (module-level singletons)

## Layers

**Entry / Routing Layer:**
- Purpose: Receive HTTP requests, apply routing logic, return responses
- Location: `index.ts`
- Contains: `Bun.serve()` config, route handlers, round-robin selector
- Depends on: service singletons from `services/`, types from `types.ts`
- Used by: downstream HTTP clients

**Service Layer:**
- Purpose: Encapsulate provider SDK calls and normalize output to async generator streams
- Location: `services/groq.ts`, `services/cerebras.ts`
- Contains: SDK client instances, `AIService` implementations, async generator adapters
- Depends on: `groq-sdk`, `@cerebras/cerebras_cloud_sdk`, `types.ts`
- Used by: `index.ts`

**Type Layer:**
- Purpose: Define shared data contracts between layers
- Location: `types.ts`
- Contains: `ChatMessage` interface, `AIService` interface
- Depends on: nothing
- Used by: all other modules

## Data Flow

### Streaming Chat Request Path

1. Client sends `POST /chat` with `{ messages: ChatMessage[] }` body (`index.ts:30-43`)
2. `getNextService()` returns the next `AIService` in round-robin order (`index.ts:12-16`)
3. Selected service's `.chat(messages)` is awaited — returns `AsyncIterable<string>` (`index.ts:34`)
4. Service calls provider SDK `chat.completions.create({ stream: true })` (`services/groq.ts:9`, `services/cerebras.ts:10`)
5. SDK completion wrapped in async generator, yielding `chunk.choices[0]?.delta?.content` per chunk
6. `new Response(stream, { headers: { "Content-Type": "text/event-stream" } })` relays chunks to client (`index.ts:36-43`)

### Health Check Path

1. Client sends `GET /` or `GET /health`
2. Server returns `200 "ok"` immediately (`index.ts:26-28`)

## Key Abstractions

**`AIService` Interface:**
- Purpose: Common contract all provider adapters must satisfy
- Definition: `types.ts:6-9`
- Pattern: `{ name: string; chat: (messages: ChatMessage[]) => Promise<AsyncIterable<string>> }`
- Used by: `index.ts` to invoke providers uniformly

**`ChatMessage` Interface:**
- Purpose: Typed message shape matching OpenAI's chat format
- Definition: `types.ts:1-4`
- Pattern: `{ role: "user" | "assistant" | "system"; content: string }`

**`services` Array + `getNextService()`:**
- Purpose: Stateful round-robin across all registered providers
- Location: `index.ts:5-16`
- Pattern: Module-level mutable `currentServiceIndex`, wraps with modulo
- Note: State is process-local and resets on restart; no persistence or cooldown logic

## Entry Points

**HTTP Server:**
- Location: `index.ts:18`
- Triggers: `bun index.ts` or `bun run start`
- Responsibilities: Binds to `process.env.HOSTNAME ?? "0.0.0.0"` and `process.env.PORT ?? 3000`, registers all routes

**`dist/index.js`:**
- Location: `dist/index.js`
- Purpose: Compiled output artifact (not used by `bun run start`; likely from a prior build step)
- Note: Runtime uses `index.ts` directly via Bun's native TypeScript execution

## Architectural Constraints

- **Threading:** Single-threaded Bun event loop. No worker threads. All concurrency is async/await.
- **Global state:** Module-level mutable `currentServiceIndex` in `index.ts:10` is shared across all concurrent requests. Concurrent requests may observe non-deterministic provider ordering under load.
- **Circular imports:** None detected.
- **SDK initialization:** `groq` and `cerebras` client instances are module-level singletons. They read API keys from environment at import time (`services/groq.ts:4`, `services/cerebras.ts:5`).
- **No authentication:** The current implementation has no downstream auth. The `refactor.md` spec requires `Authorization: Bearer PERSONAL_PROXY_API_KEY` — this is not yet implemented.
- **No cooldown / failover:** Current round-robin is naive (blind index cycling). No rate-limit handling, no provider cooldown, no failover on 429.

## Anti-Patterns

### Mutable Module-Level State for Routing

**What happens:** `currentServiceIndex` is a plain `let` variable at module scope in `index.ts:10`, incremented on every request.
**Why it's wrong:** Under concurrent requests the increment is not atomic — two requests may select the same provider. Round-robin fairness is not guaranteed.
**Do this instead:** Use an atomic counter abstraction or route selection inside a dedicated router module with proper concurrency handling, as specified in `refactor.md:449-460`.

### Type Assertion Bypass on Cerebras Messages

**What happens:** `cerebras.chat.completions.create({ messages: messages as any })` in `services/cerebras.ts:11`.
**Why it's wrong:** Bypasses type safety; masks any future SDK type drift silently.
**Do this instead:** Map `ChatMessage[]` to the SDK's expected type explicitly before passing.

### Non-OpenAI-Compatible Route Structure

**What happens:** The single public endpoint is `POST /chat` (`index.ts:30`).
**Why it's wrong:** The intended design (per `refactor.md`) is OpenAI-compatible `POST /v1/chat/completions`. Existing clients built to the OpenAI spec cannot connect without path changes.
**Do this instead:** Expose routes under `/v1/` prefix as specified in `refactor.md:88-94`.

## Error Handling

**Strategy:** Minimal — no explicit try/catch in route handlers.

**Patterns:**
- Unhandled provider errors will propagate as unhandled promise rejections and crash or produce an empty response
- 404 catch-all returns `new Response("Not found", { status: 404 })` for unknown routes (`index.ts:45`)
- No OpenAI-style error JSON bodies returned on failure

## Cross-Cutting Concerns

**Logging:** `console.log` only. Logs selected service name per request (`index.ts:33`). No structured logging.
**Validation:** None. Request body is cast directly via `as { messages: ChatMessage[] }` without runtime validation (`index.ts:31`).
**Authentication:** Not implemented. No downstream Bearer token check present in current code.

---

*Architecture analysis: 2026-06-04*
