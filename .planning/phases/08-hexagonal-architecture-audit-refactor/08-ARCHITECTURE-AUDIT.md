# Phase 8 — Architecture Audit (Gap Report)

**Phase:** 08-hexagonal-architecture-audit-refactor
**Date:** 2026-07-23
**Method:** Static read of every production `.ts` file in the repository against the layer rules recorded in `ARCHITECTURE.md`. Every violation below carries at least one `file:line` citation that was opened and confirmed to still point at the cited construct at audit time.
**Target contract: see `ARCHITECTURE.md` (repo root).**

---

## 1. Measured baseline

| Fact | Measured value | Command |
|---|---|---|
| Test suite | **111 pass / 0 fail**, 287 `expect()` calls, 8 files, ~225 ms | `bun test` |
| Production `.ts` files | **13** | `find . -name '*.ts' -not -path './node_modules/*' -not -path './dist/*' -not -path './tests/*' -not -name '*.test.ts'` |
| Production LOC | **1 990** | `wc -l` over the 13 files above |
| Test `.ts` files | **9** (1 of them at repo root) | `find` |
| Test LOC | 1 809 | `wc -l` |
| Largest file | `index.ts` — **1 012 LOC** (51 % of production LOC) | `wc -l` |
| Runtime deps | `@cerebras/cerebras_cloud_sdk`, `groq-sdk`, `zod` | `package.json` |

### Corrections to previously recorded figures

- **ROADMAP says "104 existing tests" — this is stale.** The real, measured count is **111 pass / 0 fail**. All Phase 8 gates are stated as *`bun test` exits 0 AND the pass count does not decrease from 111*, never as the stale literal.
- **`08-RESEARCH.md` §1 says "16 `.ts` (excl. tests), 1 355 LOC production" — both figures are wrong.** The census above is the authoritative one: **13 production files, 1 990 LOC**. The research document's own §2 module map lists exactly these 13 files and their line counts sum to 1 990; only the §1 rollup was miscounted. No violation in this report depends on the rollup.

### Regression harness

The 111-test suite is the regression harness for plans 02, 03, and 04. It covers downstream auth, request validation, alias resolution, round-robin alternation, 429 cooldown, cooldown expiry and recovery, failover, both-provider exhaustion, SSE framing and the `data: [DONE]` sentinel, response normalization, Gemini wire shapes, and the whisper 503 path. **`bun test` must exit 0 after every task, not merely after every plan.**

---

## 2. Layer classification — every production file

Target layers are drawn from exactly six values: `domain`, `application`, `application/ports`, `adapters/inbound/http`, `adapters/outbound`, `composition`.

| File | LOC | Current de-facto role | Target layer | Move required? |
|---|---:|---|---|---|
| `index.ts` | 1012 | God file: error DTO factories, auth primitives, header helpers, the entire `Bun.serve()` router, the provider-attempt loops, the SSE generator, the structured logger, and the entrypoint | `composition` | **Yes** — entrypoint + `createServer` re-export only; routes → `adapters/inbound/http/routes/`, orchestration → `application/use-cases/`, SSE → `adapters/inbound/http/presenters/sse.ts` |
| `config.ts` | 78 | Reads `process.env`, builds and freezes the `config` const at module load | `composition` | No — stays in place; gains `loadConfig()` alongside the default instance (composition may legally read env) |
| `types.ts` | 60 | Shared DTO contracts (`CompletionParams`, `ChatCompletionResult`, `StreamChunk`, `CompletionOutcome`, `AudioTranscriptionResult`) **and** the `ProviderAdapter` port | `domain` | **Yes** — DTOs → `domain/types.ts`; `ProviderAdapter` → `application/ports/chat-provider.ts`; `CompletionOutcome.headers` de-typed off `Headers` |
| `model-registry.ts` | 49 | Alias registry; parses `MODEL_REGISTRY_JSON` at import time and throws | `domain` | **Yes** → `domain/model-registry.ts` as `createModelRegistry(map)`; JSON parsing moves to the composition root |
| `request-schema.ts` | 58 | Zod `strictObject` + `validateChatCompletion` | `adapters/inbound/http` | **Yes** → `adapters/inbound/http/schemas/request-schema.ts` (Zod is a delivery concern) |
| `audio-schema.ts` | 60 | Zod `strictObject` + `validateAudioTranscription` + `validateAudioFileSize` | `adapters/inbound/http` | **Yes** → `adapters/inbound/http/schemas/audio-schema.ts` |
| `schema-utils.ts` | 11 | Zod issue → first-error helper | `adapters/inbound/http` | **Yes** → `adapters/inbound/http/schemas/schema-utils.ts` |
| `response-normalizer.ts` | 78 | Pure allowlist-rebuild normalizer; imports types only | `domain` | **Yes** → `domain/normalization.ts` (verbatim move — this file is already the template) |
| `whisper-service.ts` | 78 | `WhisperService` interface **and** `NoopWhisperService` **and** `HttpWhisperService` **and** a `config` import, all in one module | `application/ports` | **Yes** — split: interface → `application/ports/transcription.ts`; `HttpWhisperService` → `adapters/outbound/http-whisper.ts`; `NoopWhisperService` → `adapters/outbound/noop-whisper.ts` |
| `routing/provider-state.ts` | 137 | Module-level mutable `state` + `roundRobinCursor`, eligibility, cursor advance, and an exported `resetForTesting()` | `domain` | **Yes** → `domain/provider-state.ts` as `createProviderStateStore({ order, clock })`; interface → `application/ports/provider-state-store.ts` |
| `routing/cooldown-manager.ts` | 139 | Rate-limit header parsers, `calcCooldownMs`, and `classifyError` written against vendor SDK `APIError` classes | `domain` | **Yes** — split: parsers + cooldown → `domain/rate-limits.ts`; failover policy → `domain/failure-classification.ts`; the `instanceof` checks → `adapters/outbound/sdk-error-mapper.ts` |
| `services/cerebras.ts` | 122 | Cerebras SDK adapter behind a module-level lazy singleton client | `adapters/outbound` | **Yes** → `adapters/outbound/cerebras-chat-provider.ts` as an injectable factory |
| `services/groq.ts` | 108 | Groq SDK adapter behind a module-level lazy singleton client | `adapters/outbound` | **Yes** → `adapters/outbound/groq-chat-provider.ts` as an injectable factory |

**13 of 13 production files classified. 12 require a move; only `config.ts` stays where it is.**

---

## 3. Violation register

Severity: **critical** blocks the layering outright · **high** · **medium** · **low**.

| ID | Severity | Violation | Evidence (file:line) | Boundary crossed | Closed by plan |
|---|---|---|---|---|---|
| V-01 | critical | **No domain or application layer exists.** All orchestration (eligibility → attempt → classify → cooldown → failover → normalize → log) lives inside the `Bun.serve()` `fetch` closure. Business rules are inseparable from HTTP transport and cannot run headless. | `index.ts:495-993` (chat), `index.ts:370-458` (transcription), `index.ts:176-351` (Gemini) | delivery ⇄ application | 03 |
| V-02 | critical | **God file.** `index.ts` fuses five concerns: error DTO factories, auth primitives, header helpers, the whole server, and the entrypoint. | `index.ts:32-55` (factories), `:58-87` (auth), `:89-113` (header helpers), `:116-999` (server), `:1002-1012` (entrypoint) | all | 03 |
| V-03 | high | **Dependency direction inverted — an inner module imports vendor SDKs.** Failure classification is routing *policy*, yet it is written against Cerebras/Groq `APIError` classes. | `routing/cooldown-manager.ts:2-3` (imports), used at `:70` (`instanceof`) | domain → vendor | 02 |
| V-04 | high | **Transport types leak into the port contract.** `CompletionOutcome.headers` is a WHATWG `Headers`; the routing policy then reads raw HTTP headers off it. (`ProviderAdapter.stream()` is fine — `AbortSignal` is runtime-agnostic; `Headers` is not.) | `types.ts:31-34` (`headers: Headers` at `:33`), `index.ts:89-93`, `routing/cooldown-manager.ts:102-126` | domain → HTTP | 02 |
| V-05 | high | **Hidden global mutable state; no repository port.** `let state` / `let roundRobinCursor` at module scope, shared by every concurrent request. `resetForTesting()` is exported from *production* code — the canonical missing-DI smell. | `routing/provider-state.ts:23-24`, `:105-108` | application ⇄ infrastructure | 02 (partial), 04 (final) |
| V-06 | high | **Multiple composition roots / import-time side effects.** Importing almost any module reads env, parses JSON, or can throw: the `config` const, the registry parse, the SDK singletons. | `config.ts:24`, `model-registry.ts:8-13`, `services/cerebras.ts:8,16`, `services/groq.ts:9,17`, `index.ts:1002-1012` | composition | 04 |
| V-07 | high | **Port and adapter in the same module.** `whisper-service.ts` declares the `WhisperService` interface *and* both concrete adapters *and* imports `config`. | `whisper-service.ts:4` (config), `:6-9` (interface), `:31-78` (HTTP adapter) | port ⇄ adapter | 02 |
| V-08 | medium | **Two wire contracts duplicate the same use case.** The Gemini shim and the OpenAI transcription route each re-implement auth → size check → transcribe → error map → log. Only `validateAudioFileSize` is shared. A third wire format would triple the copy. | `index.ts:176-351` vs `index.ts:370-458` | delivery ⇄ application | 03 |
| V-09 | medium | **Duplicated orchestration between streaming and non-streaming.** Two near-identical ~60-line provider-attempt loops (classify → recordFailure → advanceCursor → 429 cooldown → failover). | `index.ts:660-723` vs `index.ts:867-967` | application (DRY) | 03 |
| V-10 | medium | **Cross-cutting concerns hand-rolled inline.** `withRequestId` rebuilds every `Response`; the Bearer gate is a bare `if`; the logger is a free function closing over module state. No middleware pipeline. | `index.ts:135-139`, `:354-367`, `:24-29` | delivery | 03 |
| V-11 | medium | **Dispatch is an ordered `if`-chain and the order is load-bearing.** Eight sequential predicate blocks; the Gemini route *must* precede the Bearer gate (documented at `index.ts:172`). No route table; routes are not testable in isolation. | `index.ts:143,147,176,370,460,473,495,996` | delivery | 03 |
| V-12 | medium | **Orchestration returns HTTP `Response`.** `openaiError()` is called from inside the provider-attempt loops, so the use case cannot exist without the HTTP layer. | `index.ts:681`, `index.ts:925`, factories at `index.ts:32-55` | application → delivery | 03 |
| V-13 | medium | **`config` acts as a global service locator.** Imported directly by six modules spanning every would-be layer. | `index.ts:4`, `model-registry.ts:3`, `routing/provider-state.ts:2`, `services/cerebras.ts:5`, `services/groq.ts:6`, `whisper-service.ts:4` | all → infrastructure | 02 (partial), 04 (final) |
| V-14 | low | **Layout does not match the documented intent.** ROADMAP names `routes/`, `providers/`, `middleware/`, `schemas/`; none exist. `services/` holds provider adapters, while `whisper-service.ts` sits at the repo root beside that same `services/` directory. | tree vs ROADMAP §Scope | naming | 03 |
| V-15 | low | **Tests are coupled to physical file paths.** Moving `createServer` or `resetForTesting` breaks the suite immediately. | `tests/integration/server.test.ts:8,10`, `tests/integration/gemini-compat.test.ts:21` | test ⇄ structure | 04 |

### Citation corrections made during this audit

Two research citations had drifted by one line and were corrected rather than restated:

- **V-04**: research cited `types.ts:32-34`. The `CompletionOutcome` interface spans `:31-34` and the offending `headers: Headers` field is on `:33`. Corrected above.
- **V-07**: research cited `whisper-service.ts:31-77`. The `HttpWhisperService` class body spans `:31-78`. Corrected above.

All other 13 citations resolved exactly as recorded.

---

## 4. Severity rollup

**2 critical · 5 high · 6 medium · 2 low — 15 violations total.**

| Severity | Count | IDs |
|---|---:|---|
| critical | 2 | V-01, V-02 |
| high | 5 | V-03, V-04, V-05, V-06, V-07 |
| medium | 6 | V-08, V-09, V-10, V-11, V-12, V-13 |
| low | 2 | V-14, V-15 |

Distribution by owning plan: plan 02 closes 5 (V-03, V-04, V-05 partial, V-07, V-13 partial) · plan 03 closes 8 (V-01, V-02, V-08, V-09, V-10, V-11, V-12, V-14) · plan 04 closes 4 (V-05 final, V-06, V-13 final, V-15).

---

## 5. What is already correct — invariants the refactor must preserve

These are genuine hexagonal wins. They are **not** to be "cleaned up".

1. **`ProviderAdapter` is a real port** (`types.ts:51-55`). Two interchangeable implementations, injected into `createServer(adapters, ...)` (`index.ts:116-121`). The integration suite already substitutes mocks (`tests/integration/mock-adapters.ts`). The refactor renames and relocates it; it does not invent it.
2. **`WhisperService` is a real port** (`whisper-service.ts:6-9`) with `Noop` and `Http` implementations, injected through the same `createServer` seam.
3. **`createServer()` is already a partial composition seam.** Importing `index.ts` binds no port, and `import.meta.main` guards the entrypoint (`index.ts:1002`). This seam is what makes the whole refactor testable; widen it, never remove it.
4. **`response-normalizer.ts` is already pure** — its only import is `import type` from `./types`. It is the template every extracted domain module should follow.
5. **Allowlist-rebuild normalization** (never spread a raw upstream object, never `delete` a field) is the security-relevant invariant behind NORM-01..09. Preserve the construction style verbatim; a "simplification" to object spread is a security regression, not a cleanup.

---

## 6. Test coupling

The suite is the safety net, so what it imports constrains the order of the refactor.

| Test file | LOC | Pins |
|---|---:|---|
| `tests/integration/server.test.ts` | 688 | `createServer`, `config`, `resetForTesting`, `mock-adapters` |
| `tests/integration/gemini-compat.test.ts` | 243 | `createServer`, `WhisperService`, `AudioTranscriptionResult` |
| `tests/unit/response-normalizer.test.ts` | 208 | `normalizeResponse`, `normalizeChunk` |
| `request-schema.test.ts` (repo root) | 174 | `validateChatCompletion`, `isKnownAlias`, `resolveUpstreamModel` |
| `tests/routing/cooldown-manager.test.ts` | 165 | `calcCooldownMs`, `classifyError`, header parsers, both SDK `APIError` classes |
| `tests/unit/audio-schema.test.ts` | 90 | `validateAudioTranscription`, `validateAudioFileSize` |
| `tests/integration/mock-adapters.ts` | 89 | `CompletionOutcome`, `ProviderAdapter`, `StreamChunk` |
| `tests/routing/provider-state.test.ts` | 87 | `advanceCursor`, `chooseEligibleProviders`, `getStateSnapshot`, `isEligible` |
| `tests/services/http-whisper-service.test.ts` | 65 | `HttpWhisperService` |

**Exact import lines that pin production structure:**

- `tests/integration/server.test.ts:8` → `from '../../index'`, `:9` → `from '../../config'`, `:10` → `from '../../routing/provider-state'`, `:13` → `from './mock-adapters'`
- `tests/integration/gemini-compat.test.ts:21` → `from '../../index'`, `:22` → `from '../../whisper-service'`, `:23` → `from '../../types'`
- `request-schema.test.ts:4` → `from "./request-schema"`, `:5` → `from "./model-registry"`
- `tests/unit/response-normalizer.test.ts:5` → `from '../../response-normalizer'`
- `tests/services/http-whisper-service.test.ts:3` → `from '../../whisper-service'`
- `tests/routing/cooldown-manager.test.ts` and `tests/routing/provider-state.test.ts` → both import from `../../routing/*`

**Shim-first rule.** These import lines stay **untouched** through plans 02 and 03. Every module that moves leaves a re-export shim at its old path (`export * from './new/path'`). Only plan 04 rewrites the test imports and deletes the shims, and it does so as a mechanical import rewrite with **zero assertion edits**. A red suite during plans 02–03 therefore always means a real behavioral regression, never a bookkeeping artifact.

---

## 7. Remediation order and risk

| Plan | Closes | What it does | Single riskiest edit | Mitigation |
|---|---|---|---|---|
| **02** | V-03, V-04, V-07, V-05 (partial), V-13 (partial) | Carve out `domain/` and `application/ports/`; cut the vendor SDK out of routing policy via the `toUpstreamFailure` / `classifyUpstreamFailure` split; split the whisper port from its adapters. Shims at every old path. | Replacing `CompletionOutcome.headers: Headers` with a flattened `Record<string,string>` — `parseCerebrasHeaders` / `parseGroqHeaders` and their 165-line test file both read through it | `readHeader` already accepts a record shape (`routing/cooldown-manager.ts:107-123`), so the record path is pre-existing and pre-tested; keep `HeaderSource` accepting both until plan 04 |
| **03** | V-01, V-02, V-08, V-09, V-10, V-11, V-12, V-14 | Dissolve `index.ts` into `application/use-cases/` + `adapters/inbound/http/` (ordered router, middleware, presenters, schemas). Use cases stop returning `Response`. | Extracting the SSE relay: the generator carries abort wiring, terminal-usage-chunk suppression, the `hasVisibleChunkData` filter, and error-path `[DONE]` semantics | Move the async generator **verbatim** into `presenters/sse.ts`; do not "clean up" the usage-chunk or `firstChunkSent` logic. Preserve route order — Gemini and `/health` and `/ready` are matched *before* the Bearer gate (`index.ts:172`), proven by the `gemini-compat.test.ts` 401 assertions |
| **04** | V-05 (final), V-06, V-13 (final), V-15 | Collapse every module-level singleton into `composition/container.ts`; make SDK adapters injectable factories; delete all shims; rewire tests to real paths; update `CLAUDE.md` and `ARCHITECTURE.md`. | De-globalising the provider-state store while `tests/integration/server.test.ts` calls `resetForTesting()` in `beforeEach` — concurrency semantics change if the store becomes per-request | Hold exactly **one** store instance in the composition root, matching today's module-global lifetime. Keep `resetForTesting()` as a thin reset of *that* instance until the test rewrite lands in the same plan |

**Non-negotiable safety rules, all four plans:**

1. `bun test` exits 0 after **every task**, with no decrease from 111 passes.
2. **Move, then change — never both in one task.** A task either relocates code verbatim or alters a signature.
3. **Shims first, deletion last** (see §6).
4. **The wire contract is frozen**: same paths, methods, status codes, header names, JSON shapes, SSE framing, and the `data: [DONE]` sentinel. A diff there is a bug, not a refactor.
5. **Zero new npm packages.** Hand-written factory functions only — no DI container library.
6. The route-order invariant survives the router extraction and is proven by the existing 401 assertions in `gemini-compat.test.ts`.

---

## 8. Closure

All 15 registered violations are closed. **None left open.**

| ID | Sev | Closed by | How |
|---|---|---|---|
| V-01 | critical | 08-03 | Orchestration extracted into `application/use-cases/`; use cases return discriminated domain results and can run without an HTTP server |
| V-02 | critical | 08-03 | `index.ts` reduced from 1 012 LOC to 22 — entrypoint plus `export { createServer }`; the five fused concerns are now separate modules |
| V-03 | high | 08-02 | `classifyUpstreamFailure` in `domain/failure-classification.ts` has zero SDK imports; `adapters/outbound/sdk-error-mapper.ts` is the only production file naming a vendor error class |
| V-04 | high | 08-02 | `CompletionOutcome.headers` is `Record<string, string>`; both provider adapters flatten with `toHeaderRecord()` at their edge. No WHATWG `Headers` type remains in `domain/` |
| V-05 | high | 08-02 (partial), 08-04 (final) | `createProviderStateStore()` replaced the module globals in 08-02; 08-04 deleted the shim and `resetForTesting()`. Tests now construct a store and inject it via `createServer`'s `deps` parameter |
| V-06 | high | 08-04 | `composition/container.ts` is the single wiring point. Both SDK clients are built lazily inside their factory closures; the registry parse moved to the container. The guard rejects any top-level import-time construction |
| V-07 | high | 08-02 | `TranscriptionPort` is interface-only in `application/ports/`; `HttpWhisperService` and `NoopWhisperService` are separate adapter modules |
| V-08 | medium | 08-03 | One `transcribeAudio` use case backs both `POST /v1/audio/transcriptions` and the Gemini `:generateContent` route; each route maps only its own wire shapes |
| V-09 | medium | 08-03 | The provider-attempt loop exists once per mode, in `create-chat-completion.ts` and `stream-chat-completion.ts` |
| V-10 | medium | 08-03 | Request id, Bearer auth, both error presenters, SSE framing, the body reader, and the logger are all named modules |
| V-11 | medium | 08-03 | `adapters/inbound/http/router.ts` holds an ordered table with an explicit pre-auth segment before `requireBearer` |
| V-12 | medium | 08-03 | No use case constructs a `Response` — enforced by the boundary guard's use-case rule |
| V-13 | medium | 08-02 (partial), 08-04 (final) | `config.ts` exposes `loadConfig()` and is the single `process.env` ingress; the guard rejects a stray env read anywhere in `domain/`, `application/`, `adapters/`, or `composition/` (only `routes/health.ts` may read `BUILD_VERSION`) |
| V-14 | low | 08-03 | The tree matches the documented intent: `domain/`, `application/`, `adapters/`, `composition/`. `CLAUDE.md` §21 and its Architecture section were rewritten in 08-04 to describe what is on disk |
| V-15 | low | 08-04 | All 11 shims deleted; tests moved to `tests/domain/`, `tests/adapters/`, `tests/unit/` and import the real module paths |

**Phase-level outcome:** 111 tests at phase start → **119 passing, 0 failing** at close (8 added, all in
`tests/architecture/boundaries.test.ts`). One assertion was deliberately rewritten — the
`toBe(headers)` reference-identity check in the old `cooldown-manager` suite asserted behaviour of a
shim that no longer exists, and V-04 makes a flattened header record the contract. Every other
assertion across the suite is byte-identical to the phase-start version. Zero npm packages added.
The public wire contract is unchanged.

---

*Gap report for Phase 08. Target contract: `ARCHITECTURE.md` (repo root).*
