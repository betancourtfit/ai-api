# Phase 8 Research: Hexagonal Architecture Audit + Refactor

**Researched:** 2026-07-23
**Phase:** 08-hexagonal-architecture-audit-refactor
**Question answered:** What do I need to know to PLAN a Clean/Hexagonal refactor of this codebase without changing behavior?

---

## 1. Baseline facts (measured, not assumed)

| Fact | Value | How verified |
|---|---|---|
| Test suite | **111 pass / 0 fail**, 287 assertions, 8 files, ~220 ms | `bun test` |
| Source files | 16 `.ts` (excl. tests), 1 355 LOC production | `wc -l` |
| Largest file | `index.ts` — **1 012 LOC** (74 % of production LOC) | `wc -l` |
| Runtime deps | `@cerebras/cerebras_cloud_sdk`, `groq-sdk`, `zod` | `package.json` |
| Structure | flat root + `routing/` + `services/` + `tests/` | `find` |

> ROADMAP text says "104 existing tests". The real number is **111** (grew after Phase 7 code review). Plans must gate on `bun test` exit 0 + no decrease from 111, not on the stale literal.

**Directories named in the ROADMAP scope that do not exist:** `routes/`, `providers/`, `middleware/`, `schemas/`. The audit must be written against the *actual* tree.

---

## 2. Actual module map

```
index.ts                    1012  Bun.serve fetch(): 6 routes + auth + provider loop + SSE + logging + error factories + entrypoint
config.ts                     78  process.env reads → frozen `config` const (module-load side effects, throws on bad values)
types.ts                      60  CompletionParams, ChatCompletionResult, CompletionOutcome, StreamChunk, ProviderAdapter, AudioTranscriptionResult
model-registry.ts             49  parses MODEL_REGISTRY_JSON at import; resolve / isKnown / list / rewriteUpstreamModelIds
request-schema.ts             58  Zod strictObject + validateChatCompletion
audio-schema.ts               60  Zod strictObject + validateAudioTranscription + validateAudioFileSize
schema-utils.ts               11  Zod issue helper
response-normalizer.ts        78  normalizeResponse / normalizeChunk (allowlist rebuild)
whisper-service.ts            78  WhisperService interface + NoopWhisperService + HttpWhisperService (HTTP adapter)
routing/provider-state.ts    137  module-level mutable state + cursor + eligibility + resetForTesting()
routing/cooldown-manager.ts  139  header parsers + calcCooldownMs + classifyError (imports SDK APIError)
services/cerebras.ts         122  Cerebras SDK adapter (module-level lazy singleton)
services/groq.ts             108  Groq SDK adapter (module-level lazy singleton)
```

---

## 3. Gap report — hexagonal violations with evidence

Severity: **C** critical (blocks the layering outright) · **H** high · **M** medium · **L** low.

| ID | Sev | Violation | Evidence | Boundary crossed |
|---|:--:|---|---|---|
| V-01 | C | **No domain/application layer exists.** All orchestration (eligibility → attempt → classify → cooldown → failover → normalize → log) lives inside the `Bun.serve()` `fetch` closure. Business rules are inseparable from HTTP transport and cannot run headless. | `index.ts:495-993` (chat), `:370-458` (transcription), `:176-351` (Gemini) | delivery ⇄ application |
| V-02 | C | **God file.** `index.ts` fuses 5 concerns: error DTO factories (`:32-55`), auth primitives (`:58-87`), header helpers (`:89-113`), the whole server (`:116-999`), the entrypoint (`:1002-1012`). | `index.ts` (1 012 LOC) | all |
| V-03 | H | **Dependency direction inverted — inner modules import vendor SDKs.** Failure classification is a routing *policy*, yet it is written against Cerebras/Groq `APIError` classes. | `routing/cooldown-manager.ts:2-3`, used at `:70` | domain → vendor |
| V-04 | H | **Transport types leak into the port contract.** `CompletionOutcome.headers` is a WHATWG `Headers`; the routing policy then reads raw HTTP headers. `ProviderAdapter.stream()` is fine (`AbortSignal` is runtime-agnostic) but `Headers` is not. | `types.ts:32-34`, `index.ts:89-93`, `routing/cooldown-manager.ts:102-126` | domain → HTTP |
| V-05 | H | **Hidden global mutable state; no repository port.** `let state` / `let roundRobinCursor` at module scope, shared by every concurrent request. `resetForTesting()` is exported from *production* code — the canonical missing-DI smell. | `routing/provider-state.ts:23-24`, `:105-108` | application ⇄ infrastructure |
| V-06 | H | **Multiple composition roots / import-time side effects.** Importing almost any module reads env, parses JSON, or can throw: config const, registry parse, SDK singletons. | `config.ts:24`, `model-registry.ts:8-13`, `services/cerebras.ts:8,16`, `services/groq.ts:9,17`, `index.ts:1002-1012` | composition |
| V-07 | H | **Port and adapter in the same module.** `whisper-service.ts` declares the `WhisperService` interface *and* the concrete HTTP adapter *and* imports `config`. | `whisper-service.ts:4,6-9,31-77` | port ⇄ adapter |
| V-08 | M | **Two wire contracts duplicate the same use case.** The Gemini shim and the OpenAI transcription route each re-implement auth → size check → transcribe → error map → log. Only `validateAudioFileSize` is shared. A third wire format triples the copy. | `index.ts:176-351` vs `:370-458` | delivery ⇄ application |
| V-09 | M | **Duplicated orchestration between streaming and non-streaming.** Two near-identical ~60-line provider-attempt loops (classify → recordFailure → advanceCursor → 429 cooldown → failover). | `index.ts:660-723` vs `:867-967` | application (DRY) |
| V-10 | M | **Cross-cutting concerns hand-rolled inline.** `withRequestId` rebuilds every `Response`; the Bearer gate is a bare `if`; the logger is a free function closing over module state. No middleware pipeline. | `index.ts:135-139`, `:354-367`, `:24-29` | delivery |
| V-11 | M | **Dispatch is an ordered `if`-chain, order is load-bearing.** 8 sequential predicate blocks; the Gemini route *must* precede the Bearer gate (documented at `:172`). No route table, not testable in isolation. | `index.ts:143,147,176,370,460,473,495,996` | delivery |
| V-12 | M | **Orchestration returns HTTP `Response`.** `openaiError()` is called from inside the provider-attempt loop, so the use case cannot exist without the HTTP layer. | `index.ts:681`, `:925`, factories at `:32-55` | application → delivery |
| V-13 | M | **`config` acts as a global service locator.** Imported directly by 6 modules across every would-be layer. | `index.ts:4`, `model-registry.ts:3`, `routing/provider-state.ts:2`, `services/*.ts:5-6`, `whisper-service.ts:4` | all → infrastructure |
| V-14 | L | **Layout does not match the documented intent.** ROADMAP names `routes/ providers/ middleware/ schemas/`; none exist. `services/` holds provider adapters; `whisper-service.ts` sits at root beside an existing `services/`. | tree vs ROADMAP §Scope | naming |
| V-15 | L | **Tests are coupled to physical file paths.** Moving `createServer` or `resetForTesting` breaks the suite immediately. | `tests/integration/server.test.ts:8,10`, `gemini-compat.test.ts:21` | test ⇄ structure |

**Counts:** 2 critical · 5 high · 6 medium · 2 low.

---

## 4. What is already correct (do not "fix")

These are genuine hexagonal wins and must survive the refactor unchanged:

1. **`ProviderAdapter` is a real port** (`types.ts:51-55`) — two interchangeable implementations, injected into `createServer(adapters, ...)` (`index.ts:116-121`). Tests already substitute mocks (`tests/integration/mock-adapters.ts`).
2. **`WhisperService` is a real port** with Noop + Http implementations, injected the same way.
3. **`createServer()` is already a partial composition seam** (D-02) — importing `index.ts` does not bind a port; `import.meta.main` guards the entrypoint.
4. **`response-normalizer.ts` is already pure** — no imports except types. It is the template every extracted domain module should follow.
5. **Allowlist-rebuild normalization** (never spread raw upstream objects) is the security-relevant invariant behind NORM-01..09; preserve it verbatim.

---

## 5. Target architecture

### 5.1 Layer rules (the contract the refactor is judged against)

| Layer | Directory | May import | May **not** import |
|---|---|---|---|
| Domain | `domain/` | other `domain/` modules only | anything else — no npm SDKs, no `zod`, no `Bun.*`, no `Request`/`Response`/`Headers`, no `process.env`, no `config` |
| Application | `application/` | `domain/`, `application/ports/` | adapters, `config`, npm SDKs, `zod`, `Bun.*`, `Request`/`Response` |
| Ports | `application/ports/` | `domain/` types only | concrete adapters, vendor types |
| Adapters | `adapters/inbound/**`, `adapters/outbound/**` | `application/ports`, `domain/`, their own vendor SDK | *other* adapters' internals |
| Composition | `composition/`, `config.ts`, `index.ts` | everything | — |

**Explicitly allowed runtime-agnostic Web primitives in ports** (pragmatism over dogma): `AbortSignal`, `File`/`Blob`, `Uint8Array`, `AsyncIterable`. **Explicitly forbidden in ports:** `Headers`, `Request`, `Response`, `FormData`, and every vendor SDK type. Rationale: the first group is standard across Bun/Node/Deno and models real capabilities (cancellation, binary payload); the second group is HTTP-transport-specific and is exactly what leaks today (V-04).

### 5.2 Target tree (flat top-level layers — honours the standing "no `src/`" project decision)

```
domain/
  types.ts                    CompletionParams, ChatCompletionResult, StreamChunk, TranscriptionResult,
                              UpstreamFailure, RateLimitSnapshot, ProviderId
  errors.ts                   UpstreamRejectedError, NoProviderAvailableError, TranscriptionUnavailableError
  model-registry.ts           createModelRegistry(map) → { isKnownAlias, resolveUpstreamModel, listAliases, rewriteUpstreamModelIds }
  rate-limits.ts              parseCerebrasHeaders / parseGroqHeaders over Record<string,string>; calcCooldownMs
  failure-classification.ts   classifyUpstreamFailure(UpstreamFailure) → { shouldFailover, status, message, headers }
  provider-state.ts           createProviderStateStore({ order, clock }) → instance (no module globals)
  normalization.ts            normalizeResponse / normalizeChunk (verbatim move)
application/
  ports/  chat-provider.ts · transcription.ts · provider-state-store.ts · clock.ts · logger.ts
  use-cases/  create-chat-completion.ts · stream-chat-completion.ts · transcribe-audio.ts
              list-models.ts · get-readiness.ts · get-provider-status.ts
adapters/
  inbound/http/
    server.ts · router.ts
    middleware/request-id.ts · middleware/bearer-auth.ts
    routes/health.ts · ready.ts · models.ts · chat-completions.ts · transcriptions.ts
           gemini-generate-content.ts · providers-status.ts
    presenters/openai-error.ts · gemini-error.ts · sse.ts
    schemas/request-schema.ts · audio-schema.ts · schema-utils.ts     (Zod = delivery concern)
  outbound/
    cerebras-chat-provider.ts · groq-chat-provider.ts · sdk-error-mapper.ts
    http-whisper.ts · noop-whisper.ts · console-logger.ts · system-clock.ts
composition/container.ts        buildContainer(config) → { chatProviders, whisper, store, logger, clock, useCases }
config.ts                       loadConfig() + default instance (composition layer — allowed to read process.env)
index.ts                        entrypoint + `export { createServer }` compatibility shim
```

### 5.3 The de-vendoring seam (fixes V-03)

`classifyError(err: unknown)` today does `err instanceof GroqAPIError || err instanceof CerebrasAPIError`. Split it:

- `adapters/outbound/sdk-error-mapper.ts` — **adapter**: `toUpstreamFailure(err: unknown): UpstreamFailure` performs the `instanceof` checks and flattens `err.headers` into `Record<string,string>`.
- `domain/failure-classification.ts` — **pure**: `classifyUpstreamFailure(f: UpstreamFailure)` keeps the 408/429/498/500/502/503/504 failover set and the 400/401/403/404/413/422 terminal set. Zero SDK imports.

Each `ChatProviderPort` implementation catches its own SDK error and rethrows/returns an `UpstreamFailure`, so the use case never sees a vendor type. This simultaneously fixes V-04, since the flattened header map replaces `Headers`.

---

## 6. Migration strategy — how to refactor 1 000 lines with zero behavior change

**Non-negotiable safety rules for every plan:**

1. **`bun test` runs and exits 0 after every task**, not just every plan. 111 tests is the regression harness — it covers auth, validation, round-robin alternation, cooldown, recovery, failover, exhaustion, streaming format, normalization, Gemini shapes, and whisper 503.
2. **Move, then change — never both in one task.** A task either relocates code verbatim or alters a signature; mixing the two makes a red suite ambiguous.
3. **Compatibility shims first, deletion last.** When a module moves, leave `export * from './new/path'` at the old path so `tests/integration/server.test.ts` and `gemini-compat.test.ts` keep importing `../../index`, `../../config`, `../../routing/provider-state` untouched. Only the final plan updates test imports and removes the shims — as a mechanical import rewrite with **zero assertion edits**.
4. **The wire contract is frozen.** Same paths, methods, status codes, header names, JSON key order-independent shapes, SSE framing, and `data: [DONE]` sentinel. Any diff there is a bug, not a refactor.
5. **Zero new npm packages** (ROADMAP non-goal). No DI container library; hand-written factory functions only.
6. **Route-order invariant survives the router extraction:** `/v1beta/models/{model}:generateContent` and `/health`, `/ready` are matched **before** the Bearer gate. Encode this as an explicit ordered route table with a comment, and keep the existing `gemini-compat.test.ts` 401 assertions as the proof.

**Highest-risk edits, ranked:**

| Risk | Why | Mitigation |
|---|---|---|
| Provider-state globals → injected store | `resetForTesting()` is called in `tests/integration/server.test.ts` `beforeEach`; concurrency semantics change if the store is per-request | Keep a single store instance in the composition root (same lifetime as today's module global). Keep `resetForTesting()` as a shim that resets *that* instance until the final plan. |
| SSE relay extraction | Streaming has generator + abort + usage-chunk suppression + error-path `[DONE]` semantics | Move the async generator verbatim into `presenters/sse.ts`; do not "clean up" the `hasVisibleChunkData` / terminal-usage-chunk logic. |
| `config` de-globalisation | 6 importers; `tests/integration/server.test.ts:9` imports `config` directly | Keep `config.ts` as the composition-layer default instance (legal — composition may read env). Only ban *domain/application* from importing it. |
| Zod schema relocation | `request-schema.test.ts` sits at repo root importing `./request-schema` | Shim at old path; final plan moves the test alongside its schema. |

---

## 7. Boundary enforcement (must be automated, not aspirational)

A refactor with no guard decays. Add `tests/architecture/boundaries.test.ts` — a Bun test that walks `domain/` and `application/` with `Bun.Glob`, reads each file, extracts `import ... from '<spec>'`, and asserts the spec matches the layer's allowlist. Forbidden-substring checks to include: `groq-sdk`, `@cerebras/`, `'zod'`, `process.env`, `Bun.`, `'../config'`, `from './config'`, `adapters/`, and — for `domain/` only — `application/`.

This is ~40 lines, needs no dependency, and makes HEX rules executable. It is the single highest-leverage artifact of the phase: it is what stops Phase 9 from re-introducing V-03.

---

## 8. Open questions carried into planning (Claude's discretion — no CONTEXT.md exists for this phase)

1. **Directory naming** — `domain/ application/ adapters/ composition/` chosen over `core/ ports/ infra/` because it matches the ROADMAP's own vocabulary ("domain core, ports, adapters, composition root").
2. **No `src/`** — honours the recorded project decision ("Flat root-level structure (no `src/`) — user preference"). Layers become top-level directories instead.
3. **Use-case return type** — use cases return discriminated-union results (`{ ok: true, ... } | { ok: false, error: DomainError }`), matching the existing `validateChatCompletion` style, rather than throwing. Presenters map errors → HTTP.
4. **Audit artifact location** — the gap report lives in the phase directory (`08-ARCHITECTURE-AUDIT.md`); the durable target contract lives at repo root (`ARCHITECTURE.md`) so future phases and `CLAUDE.md` can point at it.

---

## RESEARCH COMPLETE
