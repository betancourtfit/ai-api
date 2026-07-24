# Architecture — bun-ai-api

The layering contract for this repository. It is binding: `tests/architecture/boundaries.test.ts` is its executable form, and a change here without a matching change there is a bug.

*Gap report that motivated this: `.planning/phases/08-hexagonal-architecture-audit-refactor/08-ARCHITECTURE-AUDIT.md`*

---

## 1. Why hexagonal here

This proxy is not an app with one database. It has **two interchangeable upstream inference providers** (Cerebras, Groq), **two transcription backends** (whisper.cpp sidecar, no-op), and **two downstream wire contracts** (OpenAI Chat Completions, Gemini `:generateContent`). Every one of those is a swap point — a port by nature, not by taste. Round-robin routing, cooldown windows, failover classification, and response normalization are policies that must hold identically no matter which side is plugged in, and must be testable without booting an HTTP server or holding an API key.

The concrete pain that motivated the split: `index.ts` reached **1 012 LOC** with provider orchestration fused into the `Bun.serve()` `fetch` closure. Deciding whether a 429 warrants failover required constructing a `Request`. Two near-identical ~60-line attempt loops (streaming and non-streaming) drifted independently. Failure classification imported vendor SDK error classes, so routing policy could not compile without `groq-sdk`. Layering fixes each of those mechanically.

---

## 2. Layer rules

| Layer | Directory | May import | May NOT import |
|---|---|---|---|
| **Domain** | `domain/` | other `domain/` modules only | anything else — **no npm SDKs** (`groq-sdk`, `@cerebras/*`), **no `zod`**, **no `Bun.*`**, **no `Request`/`Response`/`Headers`**, **no `process.env`**, **no `config`** |
| **Application** | `application/use-cases/` | `domain/`, `application/ports/` | adapters, `config`, npm SDKs, `zod`, `Bun.*`, `Request`/`Response`/`Headers` |
| **Ports** | `application/ports/` | `domain/` types only | concrete adapters, vendor SDK types, `config`, `zod` |
| **Adapters** | `adapters/inbound/**`, `adapters/outbound/**` | `application/ports`, `domain/`, their own vendor SDK, `zod`, Web/Bun APIs | *other* adapters' internals; another adapter's vendor SDK |
| **Composition** | `composition/`, `config.ts`, `index.ts` | everything | — (this is the only layer allowed to read `process.env` and construct concrete adapters) |

**Direction of dependency is always inward.** Adapters know about ports; ports never know about adapters. What an inner layer may not import is not a style preference — it is the boundary. If you need an inner layer to reach outward, you need a new port, not an import.

---

## 3. Port signature primitives

A port signature may use only runtime-agnostic types that model a real capability.

**Allowed in port signatures:**
`AbortSignal` · `File` / `Blob` · `Uint8Array` · `AsyncIterable<T>` · plain objects and `Record<string, string>`-style maps · domain types from `domain/`.

**Forbidden in port signatures:**
`Headers` · `Request` · `Response` · `FormData` · `URL` / `URLSearchParams` · every vendor SDK type (`groq-sdk`, `@cerebras/*`, including their `APIError` classes) · `ZodType` and any Zod-derived type.

**Rationale:** the allowed set is standard across Bun, Node, and Deno and expresses a genuine capability — cancellation, a binary payload, an incremental sequence. The forbidden set is HTTP-transport-specific or vendor-specific; it ties the policy to one delivery mechanism or one supplier. That is exactly the leak recorded as **V-04** (`CompletionOutcome.headers: Headers` forcing routing policy to read WHATWG headers) and **V-03** (failure classification written against SDK `APIError`). A rate-limit snapshot crosses a port as `Record<string, string>`, never as `Headers`.

---

## 4. Target tree

Layers are **top-level directories — there is no `src/`**, honouring the standing project decision on flat root-level structure. This vocabulary (`domain`, `ports`, `adapters`, `composition root`) supersedes the illustrative `src/routes|providers|middleware|schemas` sketch in `CLAUDE.md` §21; the concerns named there all survive, relocated into the layers below.

```
domain/
  types.ts                    CompletionParams, ChatCompletionResult, StreamChunk, TranscriptionResult,
                              UpstreamFailure, RateLimitSnapshot, ProviderId
  errors.ts                   UpstreamRejectedError, NoProviderAvailableError, TranscriptionUnavailableError
  model-registry.ts           createModelRegistry(map) → { isKnownAlias, resolveUpstreamModel, listAliases,
                                                           rewriteUpstreamModelIds }
  rate-limits.ts              parseCerebrasHeaders / parseGroqHeaders over Record<string,string>; calcCooldownMs
  failure-classification.ts   classifyUpstreamFailure(UpstreamFailure) → { shouldFailover, status, message, headers }
  provider-state.ts           createProviderStateStore({ order, clock }) → instance (no module globals)
  normalization.ts            normalizeResponse / normalizeChunk (allowlist rebuild)
application/
  ports/        chat-provider.ts · transcription.ts · provider-state-store.ts · clock.ts · logger.ts
  use-cases/    create-chat-completion.ts · stream-chat-completion.ts · transcribe-audio.ts
                list-models.ts · get-readiness.ts · get-provider-status.ts
adapters/
  inbound/http/                 (= adapters/inbound/http/ — the OpenAI + Gemini delivery layer)
    server.ts · router.ts · read-limited-body.ts
    middleware/   request-id.ts · bearer-auth.ts
    routes/       health.ts · ready.ts · models.ts · chat-completions.ts · transcriptions.ts
                  gemini-generate-content.ts · providers-status.ts
    presenters/   openai-error.ts · gemini-error.ts · sse.ts
    schemas/      request-schema.ts · audio-schema.ts · schema-utils.ts      (Zod is a delivery concern)
  outbound/
    cerebras-chat-provider.ts · groq-chat-provider.ts · sdk-error-mapper.ts
    http-whisper.ts · noop-whisper.ts · console-logger.ts · system-clock.ts
composition/
  container.ts                buildContainer(config) → { chatProviders, whisper, store, logger, clock, useCases }
config.ts                     loadConfig() + default instance (composition layer — may read process.env)
index.ts                      entrypoint + `export { createServer }`
```

---

## 5. The de-vendoring seam

`classifyError(err: unknown)` originally performed `err instanceof GroqAPIError || err instanceof CerebrasAPIError`, which dragged both SDKs into routing policy. It is split in two:

- **`adapters/outbound/sdk-error-mapper.ts` (adapter).** `toUpstreamFailure(err: unknown): UpstreamFailure` owns the `instanceof` checks and flattens `err.headers` into a plain `Record<string, string>`. This is the only module in the repo permitted to name a vendor error class.
- **`domain/failure-classification.ts` (pure).** `classifyUpstreamFailure(f: UpstreamFailure)` decides failover. Zero SDK imports, zero `Headers`.

The failover status set is **`{408, 429, 498, 500, 502, 503, 504}`** — try the next eligible provider.
The terminal status set is **`{400, 401, 403, 404, 413, 422}`** — return the error to the caller, do not fail over.
Anything outside both sets defaults to failover.

Each `ChatProviderPort` implementation catches its own SDK error and surfaces an `UpstreamFailure`, so a use case never sees a vendor type. The flattened header map replacing `Headers` closes V-04 at the same time.

---

## 6. Enforcement

`tests/architecture/boundaries.test.ts` is the executable form of this document. It walks `domain/` and `application/` with `Bun.Glob`, extracts every `import … from '<spec>'`, and asserts the specifier is permitted for that file's layer. **Adding a forbidden import fails `bun test`** — this is a gate, not a lint suggestion.

Forbidden specifier substrings the guard checks:

| Scope | Rejected substrings |
|---|---|
| `domain/` and `application/` | `groq-sdk`, `@cerebras/`, `'zod'`, `process.env`, `Bun.`, `../config`, `./config`, `adapters/` |
| `domain/` additionally | `application/` |

If a rule in this document changes, change the guard in the same commit. A guard that silently stops matching is worse than no guard.

---

## 7. Invariants that outrank the architecture

If a layering rule ever conflicts with one of these, **the invariant wins** and the layering bends.

1. **The public wire contract is frozen.** Same paths, methods, status codes, header names (`X-Request-ID`, `X-LLM-Provider`), JSON shapes, SSE framing, and the `data: [DONE]` sentinel — including on error paths. A diff there is a bug, never a refactor.
2. **Constant-time proxy-key comparison.** The Bearer check pads both buffers and always runs `timingSafeEqual`; it must not regress to a length pre-check or a `===`.
3. **Never log secrets, prompts, transcripts, or reasoning content.** Structured logs carry metadata only — request ID, route, alias, provider, status, latency, token counts, quota headers.
4. **Allowlist-rebuild normalization.** Responses are reconstructed field by field; raw upstream objects are never spread and fields are never `delete`d. Replacing this with a spread is a security regression.
5. **Request-size limits are enforced on measured bytes**, not on a declared `Content-Length`.
6. **Zero new npm packages.** Dependency injection is hand-written factory functions; no DI container library, no framework.
7. **Route order is load-bearing.** `/health`, `/ready`, and `POST /v1beta/models/{model}:generateContent` are matched *before* the global Bearer gate — Gemini authenticates via `x-goog-api-key` / `?key=`, not Bearer. The router keeps an explicit ordered table with this comment attached.

---

*Contract for bun-ai-api. Established in Phase 08.*
