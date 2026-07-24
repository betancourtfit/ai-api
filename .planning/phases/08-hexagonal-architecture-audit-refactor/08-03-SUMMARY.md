---
phase: 08-hexagonal-architecture-audit-refactor
plan: 03
subsystem: architecture
tags: [hexagonal, use-cases, http-router, presenters, sse, middleware, god-file]

requires:
  - phase: 08-hexagonal-architecture-audit-refactor
    provides: "plan 02's pure domain layer, five ports, and the boundary guard"
provides:
  - Six transport-free use cases in application/use-cases/
  - HTTP delivery layer: ordered router, 7 route modules, 2 middleware, 3 presenters, server factory
  - index.ts reduced from 1 012 lines to 23
  - Boundary guard extended to application/use-cases/
affects: [08-04, future-phases]

tech-stack:
  added: []
  patterns:
    - "Ordered route table with an explicit pre-auth / post-auth segment boundary"
    - "Use cases return discriminated domain results; presenters map them to wire shapes"
    - "SSE framing owned entirely by a presenter; the use case yields StreamChunk objects"
    - "Live config reads via a getter where a value is mutated at runtime by tests"

key-files:
  created:
    - application/use-cases/create-chat-completion.ts
    - application/use-cases/stream-chat-completion.ts
    - application/use-cases/transcribe-audio.ts
    - application/use-cases/list-models.ts
    - application/use-cases/get-readiness.ts
    - application/use-cases/get-provider-status.ts
    - application/use-cases/chat-deps.ts
    - application/use-cases/provider-rate-limits.ts
    - adapters/inbound/http/server.ts
    - adapters/inbound/http/router.ts
    - adapters/inbound/http/context.ts
    - adapters/inbound/http/read-limited-body.ts
    - adapters/inbound/http/middleware/request-id.ts
    - adapters/inbound/http/middleware/bearer-auth.ts
    - adapters/inbound/http/presenters/openai-error.ts
    - adapters/inbound/http/presenters/gemini-error.ts
    - adapters/inbound/http/presenters/sse.ts
    - adapters/inbound/http/routes/health.ts
    - adapters/inbound/http/routes/ready.ts
    - adapters/inbound/http/routes/models.ts
    - adapters/inbound/http/routes/chat-completions.ts
    - adapters/inbound/http/routes/transcriptions.ts
    - adapters/inbound/http/routes/gemini-generate-content.ts
    - adapters/inbound/http/routes/providers-status.ts
    - adapters/outbound/console-logger.ts
    - adapters/outbound/system-clock.ts
    - domain/audio-limits.ts
  modified:
    - index.ts
    - request-schema.ts
    - audio-schema.ts
    - schema-utils.ts
    - tests/architecture/boundaries.test.ts

key-decisions:
  - "domain/audio-limits.ts holds the pure size rule so transcribe-audio can enforce it without importing the delivery-layer Zod module; audio-schema.ts delegates to it, keeping one implementation of the 413 message"
  - "toFailure is injected into the chat use cases rather than imported, because toUpstreamFailure lives in adapters/ and the application layer may not reach outward"
  - "ServerDeps.defaultModelAlias is a getter, not a captured value — server.test.ts mutates config.defaultModelAlias per test and the pre-refactor handler read it live"
  - "server.ts skips the withRequestId rebuild when a response already carries X-Request-ID, so streaming responses (which set it at construction) are never reconstructed"
  - "presenters/sse.ts emits the [DONE] sentinel from a finally block, so it survives a clean stream, a mid-stream error, and early consumer termination alike"

patterns-established:
  - "Route modules export a match/handle pair; the router owns order and the auth boundary"
  - "Every route handler receives one RouteContext; nothing reaches for module-level state"

requirements-completed: [HEX-09, HEX-10, HEX-11, HEX-14, HEX-15]

duration: 22 min
completed: 2026-07-24
---

# Phase 08 Plan 03: Application Layer and Thin HTTP Delivery Summary

**The 1 012-line `index.ts` god file is now 23 lines: provider orchestration became six headless use cases returning domain results, and HTTP became an ordered route table with the auth boundary expressed exactly once — with all 115 pre-existing tests passing unmodified.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-07-24T01:52:00Z
- **Completed:** 2026-07-24T02:09:45Z
- **Tasks:** 5 completed
- **Files created:** 27
- **Files modified:** 5 (4 production + the boundary guard)
- **Suite:** 115 pass → **116 pass / 0 fail** (+1 new guard case)
- **`index.ts`:** 1 012 LOC → **23 LOC**

## Accomplishments

- **Killed the god file (V-02).** `index.ts` is now an entrypoint plus `export { createServer }`. It contains no `pathname`, no `openaiError`, and no `Bun.serve`.
- **Created a real application layer (V-01, V-12).** Six use cases — `createChatCompletion`, `streamChatCompletion`, `transcribeAudio`, `listModels`, `getReadiness`, `getProviderStatus` — return discriminated domain results and never construct a `Response`. Provider routing can now be exercised without an HTTP server.
- **Removed the duplicated provider loop (V-09).** The attempt loop exists once for non-streaming and once for streaming, each in its own module, instead of twice inline in one function.
- **Unified the transcription flow (V-08).** One `transcribeAudio` use case backs both `POST /v1/audio/transcriptions` and `POST /v1beta/models/{model}:generateContent`; each route maps only its own wire shapes. A third wire format now costs one route module.
- **Made dispatch an ordered, inspectable table (V-11).** `PRE_AUTH_ROUTES` = `health`, `ready`, `geminiGenerateContent`; then `requireBearer`; then `POST_AUTH_ROUTES` = `transcriptions`, `providersStatus`, `models`, `chatCompletions`; then the catch-all 404. The load-bearing ordering carries a prominent comment naming the tests that prove it.
- **Named the cross-cutting concerns (V-10).** Request-id, Bearer auth, both error presenters, SSE framing, the byte-counted body reader, and the structured logger are all modules now.
- **Extended the guard (HEX-15).** A new case rejects HTTP types, SSE framing, the `[DONE]` sentinel, `Bun.serve`, zod, vendor SDKs, `process.env`, and adapter/config imports inside `application/use-cases/`. Proven to bite on four separate constructs, then reverted.
- **Wire contract unchanged (HEX-14).** Across the whole plan `git diff tests/` touches only `tests/architecture/boundaries.test.ts`. **Zero `expect()` edits. Zero dependency changes.**

## Task Commits

1. **Task 1: Extract presenters, middleware, logger adapter; relocate Zod schemas** — `6f59ab8` (refactor)
2. **Task 2: Extract shared transcribeAudio use case, split both transcription routes** — `7689a7a` (refactor)
3. **Task 3: Extract the chat-completion use cases** — `dba701c` (refactor)
4. **Task 4: Ordered router, remaining routes, index.ts reduced to entrypoint** — `0200b4c` (refactor)
5. **Task 5: Extend the boundary guard to the application layer** — `4c4bbf6` (test)

## Files Created/Modified

**Application (6 use cases + 2 shared modules):** `create-chat-completion.ts`, `stream-chat-completion.ts`, `transcribe-audio.ts`, `list-models.ts`, `get-readiness.ts`, `get-provider-status.ts`, plus `chat-deps.ts` (shared dependency set) and `provider-rate-limits.ts` (ProviderId dispatch to the domain parsers).

**HTTP delivery:** `server.ts` (Bun.serve + port composition), `router.ts` (ordered table), `context.ts` (RouteContext/ServerDeps), `read-limited-body.ts`, `middleware/{request-id,bearer-auth}.ts`, `presenters/{openai-error,gemini-error,sse}.ts`, `routes/{health,ready,models,chat-completions,transcriptions,gemini-generate-content,providers-status}.ts`, `schemas/{request-schema,audio-schema,schema-utils}.ts`.

**Outbound adapters:** `console-logger.ts` (Logger port), `system-clock.ts` (Clock port).

**Domain:** `audio-limits.ts` — the pure size rule.

**Shims (deleted in plan 04):** `request-schema.ts`, `audio-schema.ts`, `schema-utils.ts` at repo root.

## Decisions Made

- **The pure size rule moved to `domain/audio-limits.ts`.** The plan told the use case to "import the pure size check" from `validateAudioFileSize`, but that function lives in the Zod module in the delivery layer — an application→adapters import the guard forbids. Extracting the rule into domain keeps a single implementation of the exact 413 message, which both the use case and `audio-schema.ts` now share.
- **`toFailure` is injected, not imported.** `toUpstreamFailure` performs the vendor `instanceof` checks and lives in `adapters/outbound/`. Passing it in as a dependency keeps `create-chat-completion.ts` and `stream-chat-completion.ts` free of any adapter import while still using the exact same mapping.
- **`X-Request-ID` presence decides whether to rebuild a response.** The pre-refactor code set the header at construction time for streaming and via a wrapper for everything else. `server.ts` reproduces that by skipping the rebuild when the header is already present, so a streaming `ReadableStream` body is never reconstructed.
- **The `[DONE]` sentinel is emitted from a `finally` block.** CR-03 required it after both clean completion and mid-stream errors; `finally` additionally covers early consumer termination, which the original inline generator did not.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Route ordering would have transcribed audio for an unknown model alias**
- **Found during:** Task 2
- **Issue:** The plan's route description lists the 413 mapping before the unknown-alias 400. Implementing it literally meant calling `transcribeAudio` (which performs the size check internally) *before* the alias comparison — so a request naming an unknown model but carrying a valid-size file would have hit the whisper sidecar before being rejected. The pre-refactor order (`index.ts:402-423`) is size check → alias check → transcribe.
- **Fix:** The route performs the transport-level size rejection itself with `validateAudioFileSize`, then the alias check, then calls the use case. The use case's internal size check remains as defense in depth.
- **Files modified:** `adapters/inbound/http/routes/transcriptions.ts`
- **Verification:** Transcription tests in `server.test.ts` pass unmodified, including the oversize 413 and unknown-model 400 cases
- **Committed in:** `7689a7a`

**2. [Rule 1 - Bug] `defaultModelAlias` captured at construction broke a documented live-read contract**
- **Found during:** Task 4
- **Issue:** `ServerDeps` initially captured `config.defaultModelAlias` when `createServer()` ran. `tests/integration/server.test.ts:491` documents in a comment that this value is *read live per request* and mutates it around individual cases — the DEFAULT_MODEL_ALIAS fallback test failed with 400 instead of 200 because the server had been constructed in `beforeAll` with the original value.
- **Fix:** Declared the field as a getter (`get defaultModelAlias() { return config.defaultModelAlias; }`) so every request re-reads it, matching the pre-refactor handler exactly.
- **Files modified:** `adapters/inbound/http/server.ts`
- **Verification:** Full suite back to 115 pass / 0 fail; the fallback test passes unmodified
- **Committed in:** `0200b4c`

**3. [Rule 3 - Blocking] `presenters/sse.ts` had to be created in Task 3, not Task 4**
- **Found during:** Task 3
- **Issue:** The plan schedules `presenters/sse.ts` in Task 4, but Task 3 makes the streaming use case yield `StreamChunk` objects instead of SSE text. Without a presenter, Task 3 could not end with a green suite — the streaming route would have had nothing to frame the chunks with.
- **Fix:** Created `presenters/sse.ts` during Task 3 with the exact framing and header set the plan specifies for Task 4. Task 4 then consumed it unchanged.
- **Files modified:** `adapters/inbound/http/presenters/sse.ts`
- **Verification:** SSE format tests pass unmodified; `data: {json}\n\n` per chunk and a trailing `data: [DONE]\n\n`
- **Committed in:** `dba701c`

**4. [Rule 3 - Blocking] A shared `RouteContext` module was needed but not in the plan's file list**
- **Found during:** Task 2
- **Issue:** The plan specifies that route handlers take a context object but assigns the type no home. Putting it in `router.ts` would make routes import the router that imports them — a cycle.
- **Fix:** Added `adapters/inbound/http/context.ts` holding `RouteContext` and `ServerDeps`, grown across Tasks 2-4 as more routes landed.
- **Files modified:** `adapters/inbound/http/context.ts`
- **Verification:** No import cycle; boundary guard passes; suite green at every task boundary
- **Committed in:** `7689a7a`, `0200b4c`

**5. [Rule 1 - Doc defect] Two comments tripped the plan's own literal grep criteria**
- **Found during:** Task 3
- **Issue:** `stream-chat-completion.ts` described the presenter as owning "`data: …` framing", which matched the plan's forbidden-substring check for `data: ` in a use-case file. `chat-deps.ts` used an inline `import('../../domain/types').CompletionParams` type that the guard's specifier regex could not see.
- **Fix:** Reworded the comment to say "Server-Sent-Events framing"; converted the inline type import to a normal `import type`.
- **Files modified:** `application/use-cases/stream-chat-completion.ts`, `application/use-cases/chat-deps.ts`
- **Verification:** Guard's use-case case passes; all specifiers are now visible to the checker
- **Committed in:** `dba701c`

---

**Total deviations:** 5 auto-fixed (3 × Rule 1, 2 × Rule 3)
**Impact on plan:** No scope change. Deviation 1 was a genuine behavioural bug caught before commit — implementing the plan literally would have sent unknown-model requests to the whisper sidecar. Deviation 2 was caught by the test suite doing exactly its job as the wire-contract oracle. Deviations 3 and 4 were ordering/structure gaps in the plan, resolved without changing what gets built. Every guard, status code, log event name, and field set enumerated in the plan's `<interfaces>` block was reproduced exactly.

## Issues Encountered

**Pass count is 116, not the 115 the acceptance criterion names.** Task 5's action instructs extending the guard with a new `application/use-cases/**/*.ts` case, and its own action text acknowledges "guard cases inside the existing file". A new `test()` block necessarily increments the count by one. 115 → 116 is exactly that one case; no pre-existing test was added, removed, skipped, or renamed.

**Pre-existing `tsc --noEmit` errors persist and one was inherited by a moved file.** The `index.ts:373` undici `FormData` mismatch travelled with the transcription route into `routes/transcriptions.ts`, and the `index.ts:766` `StreamChunk` → `Record<string, unknown>` cast travelled into `stream-chat-completion.ts` (where it now reads `as unknown as Record<string, unknown>`). These were pre-existing before the phase and there is no typecheck gate in `package.json`; `bun test` does not typecheck.

## User Setup Required

None — no external service configuration required. Zero dependencies added.

## Next Phase Readiness

**Ready for 08-04.** The final plan collapses the remaining module-level singletons into `composition/container.ts`, makes the SDK adapters injectable factories, deletes all shims, rewires tests to real paths, and updates the docs. What plan 03 hands it:

- **`adapters/inbound/http/server.ts` is the only remaining composition site outside `index.ts`.** It currently builds `providerStore` and `modelRegistry` by wrapping the shim's free functions — that wrapping is exactly what `composition/container.ts` replaces.
- **The two remaining module-level singletons** are the `defaultStore` inside `routing/provider-state.ts` and the lazy SDK clients in `services/{cerebras,groq}.ts`.
- **Six shims are ready for deletion:** `types.ts`, `response-normalizer.ts`, `model-registry.ts`, `whisper-service.ts`, `routing/cooldown-manager.ts`, `routing/provider-state.ts`, plus the three schema shims `request-schema.ts`, `audio-schema.ts`, `schema-utils.ts` (nine in total).
- **`index.ts` keeps `export { createServer }` permanently** — it is the documented public entry and `tests/integration/*.test.ts` import from it.

**Carry-forward constraints for plan 04:**
1. Deleting `routing/provider-state.ts` requires updating `tests/integration/server.test.ts:10` and `tests/routing/provider-state.test.ts:12`, and `resetForTesting()` must keep resetting *the same* instance the server uses, or the `beforeEach` isolation breaks.
2. `server.ts` reads `config.defaultModelAlias` through a getter; whatever the container does must preserve the live read or `server.test.ts`'s fallback block fails.
3. `cooldown-manager.test.ts:155` asserts SDK header reference identity via `toBe()` — when that shim is deleted, that test must be rewritten deliberately, not incidentally.
4. The `X-Request-ID`-presence check in `server.ts` is what keeps streaming responses from being rebuilt; keep it when the server moves into the container.

## Self-Check: PASSED

| Check | Result |
|---|---|
| All 27 created files exist on disk | PASS |
| `git log --grep="08-03"` returns ≥1 commit | PASS (5) |
| Task 1-5 automated `<verify>` commands | PASS (all) |
| `index.ts` < 40 lines, no `pathname ===`, no `openaiError`, no `Bun.serve` | PASS (23 LOC, all 0) |
| HEX-09: no `Response`/`text/event-stream`/`[DONE]`/zod/vendor SDK in `application/` | PASS (grep empty) |
| HEX-10: both transcription routes call `transcribeAudio`; neither calls the port directly | PASS |
| HEX-11: router lists health, ready, gemini pre-auth; 4 routes post-auth; catch-all last | PASS |
| Gemini `approxBytes` guard still precedes `Buffer.from` (line 101 < 108) | PASS |
| Constant-time `verifyToken` intact — padded buffers, unconditional `timingSafeEqual` | PASS |
| `readLimitedBody` counts actual bytes and calls `reader.cancel()`; no `content-length` read | PASS |
| HEX-15: guard covers `domain/`, `application/`, `application/use-cases/`, 5 non-empty-glob asserts | PASS |
| Guard bites on injected use-case violation, reverted cleanly | PASS (4 constructs flagged) |
| HEX-14: `git diff tests/` = boundary guard only, 0 `expect(` edits | PASS |
| Zero new npm packages | PASS (0 diff lines) |
| `bun test` exit 0 — 116 pass / 0 fail | PASS |

---
*Phase: 08-hexagonal-architecture-audit-refactor*
*Completed: 2026-07-24*
