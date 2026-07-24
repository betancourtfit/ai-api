---
phase: 08-hexagonal-architecture-audit-refactor
plan: 02
subsystem: architecture
tags: [hexagonal, domain-layer, ports, dependency-inversion, boundaries, bun-test]

requires:
  - phase: 08-hexagonal-architecture-audit-refactor
    provides: "plan 01's ARCHITECTURE.md layer contract and the V-01..V-15 violation register"
provides:
  - Pure domain/ layer (7 modules) with zero vendor, zod, config, env, or HTTP-transport dependencies
  - application/ports/ with five implementation-free interfaces
  - adapters/outbound/ with the sole vendor-aware error mapper plus both whisper adapters
  - Six compatibility shims keeping every legacy import path resolving
  - tests/architecture/boundaries.test.ts — the executable form of ARCHITECTURE.md
affects: [08-03, 08-04, future-phases]

tech-stack:
  added: []
  patterns:
    - "De-vendoring seam: toUpstreamFailure (adapter) flattens SDK errors; classifyUpstreamFailure (domain) decides failover"
    - "Injectable store factory: createProviderStateStore({ order, clock, configured, resolveUpstreamModel })"
    - "Structural port satisfaction: domain returns a shape the port describes, without importing the port"
    - "Boundary guard as a bun test — forbidden imports fail the suite, not a linter"

key-files:
  created:
    - domain/types.ts
    - domain/errors.ts
    - domain/normalization.ts
    - domain/model-registry.ts
    - domain/rate-limits.ts
    - domain/failure-classification.ts
    - domain/provider-state.ts
    - application/ports/chat-provider.ts
    - application/ports/transcription.ts
    - application/ports/provider-state-store.ts
    - application/ports/clock.ts
    - application/ports/logger.ts
    - adapters/outbound/sdk-error-mapper.ts
    - adapters/outbound/http-whisper.ts
    - adapters/outbound/noop-whisper.ts
    - tests/architecture/boundaries.test.ts
  modified:
    - types.ts
    - response-normalizer.ts
    - model-registry.ts
    - whisper-service.ts
    - routing/cooldown-manager.ts
    - routing/provider-state.ts
    - services/cerebras.ts
    - services/groq.ts
    - tests/integration/mock-adapters.ts

key-decisions:
  - "ProviderState was declared in domain/types.ts rather than in application/ports/provider-state-store.ts, because domain/provider-state.ts needs the shape and domain may not import from application/. The port re-exports it, so the port file still provides the type."
  - "domain/provider-state.ts declares its own structural return type instead of importing ProviderStateStore from application/ports — TypeScript is structural, so the store satisfies the port without an inward-pointing dependency."
  - "createProviderStateStore takes an injected resolveUpstreamModel function. The plan's deps list omitted it, but isEligible() calls it and the only alternative was importing the config-bound model-registry shim, which would break HEX-04."
  - "The classifyError shim returns the SDK error's original header object by reference (via rawSdkErrorHeaders), because cooldown-manager.test.ts:155 asserts reference identity with toBe(). Flattening there would have failed an unmodifiable test."
  - "The boundary guard uses word-boundary regexes instead of naive substrings: 'Response(' also matches the legitimate domain function normalizeResponse(, and 'Headers' matches ParsedGroqHeaders."

patterns-established:
  - "Shim-first migration: every moved module leaves a ≤8-line re-export at its old path, so a red suite can only mean a behavioural regression"
  - "One vendor-aware module: adapters/outbound/sdk-error-mapper.ts is the only production file naming an SDK error class"

requirements-completed: [HEX-04, HEX-05, HEX-06, HEX-07, HEX-08, HEX-15, HEX-14]

duration: 24 min
completed: 2026-07-24
---

# Phase 08 Plan 02: Domain Layer, Ports, and De-vendoring Summary

**Routing policy no longer knows Cerebras or Groq exist: failure classification and rate-limit parsing are now pure functions over a provider-agnostic failure shape, with all vendor knowledge confined to one adapter file — and a boundary test that fails `bun test` if anyone reintroduces the coupling.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-07-24T01:40:00Z (approx., immediately after plan 01 close-out)
- **Completed:** 2026-07-24T01:51:36Z
- **Tasks:** 6 completed
- **Files created:** 16
- **Files modified:** 9 (8 production shims/adapters + 1 test fixture line)
- **Suite:** 111 pass → **115 pass / 0 fail** (4 new guard tests, zero regressions)

## Accomplishments

- **Built a provably pure `domain/`.** Seven modules — types, errors, normalization, model-registry, rate-limits, failure-classification, provider-state — with no npm SDK, no `zod`, no `config`, no `process.env`, no `Bun.*`, and no WHATWG transport type. Verified by grep and enforced by the new guard.
- **Cut the vendor SDK out of routing policy (V-03).** `classifyUpstreamFailure(UpstreamFailure)` in `domain/` holds the failover set `{408,429,498,500,502,503,504}` and terminal set `{400,401,403,404,413,422}`. `adapters/outbound/sdk-error-mapper.ts` is now the **only** production file containing `instanceof GroqAPIError` / `instanceof CerebrasAPIError`.
- **Removed the transport leak from the port contract (V-04).** `CompletionOutcome.headers` went from `Headers` to `Record<string, string>`; both SDK adapters flatten at their edge with `toHeaderRecord()`.
- **Split the whisper port from its adapters (V-07).** `TranscriptionPort` is an interface-only file; `HttpWhisperService` and `NoopWhisperService` are separate adapter modules.
- **Made provider state injectable (V-05, substantially).** `createProviderStateStore({ order, clock, configured, resolveUpstreamModel })` returns an instance. The module-level `let` and the production `resetForTesting()` export survive only inside a shim marked for deletion in plan 04.
- **Made the layer rules executable (HEX-15).** `tests/architecture/boundaries.test.ts` (4 tests) walks both inner layers with `Bun.Glob`, checks every import specifier against the layer allowlist, and sweeps for forbidden tokens. Proven to bite: injecting `import { config } from '../config'` into `domain/rate-limits.ts` failed it naming that exact file; the edit was reverted.
- **Kept the suite honest.** Across the entire plan, `git diff tests/` is **one fixture line** (`headers: new Headers()` → `headers: {}`) plus the new guard file. **Zero `expect()` edits. Zero new npm packages.**

## Task Commits

1. **Task 1: Move DTOs and normalization into domain/** — `24be684` (refactor)
2. **Task 2: Declare five ports, split whisper port from adapters** — `0cff3af` (refactor)
3. **Task 3: Make the model registry a pure factory** — `d886f71` (refactor)
4. **Task 4: De-vendor failure classification and rate-limit parsing** — `596d2c0` (refactor)
5. **Task 5: Turn provider state into an injectable store** — `960afcc` (refactor)
6. **Task 6: Add the executable boundary guard** — `e20fac5` (test)

## Files Created/Modified

**Domain (pure):**
- `domain/types.ts` — DTOs plus new `ProviderId`, `ProviderState`, `UpstreamFailure`; `CompletionOutcome.headers` is now a flat record
- `domain/errors.ts` — three error classes, zero imports
- `domain/normalization.ts` — verbatim move of the allowlist-rebuild normalizer
- `domain/model-registry.ts` — `createModelRegistry(map)`; no `JSON.parse`, no `config`
- `domain/rate-limits.ts` — parsers over `Record<string,string>` + `calcCooldownMs`
- `domain/failure-classification.ts` — `classifyUpstreamFailure`, both status sets, zero SDK imports
- `domain/provider-state.ts` — `createProviderStateStore` factory, closure state, injected clock

**Ports (interface-only):** `chat-provider.ts`, `transcription.ts`, `provider-state-store.ts`, `clock.ts`, `logger.ts`

**Adapters:**
- `adapters/outbound/sdk-error-mapper.ts` — `toUpstreamFailure`, `toHeaderRecord`, `rawSdkErrorHeaders`; sole `instanceof` site
- `adapters/outbound/http-whisper.ts` / `noop-whisper.ts` — whisper implementations moved verbatim

**Shims (deleted in plan 04):** `types.ts`, `response-normalizer.ts`, `model-registry.ts`, `whisper-service.ts`, `routing/cooldown-manager.ts`, `routing/provider-state.ts`

**Adapters touched (2 lines each):** `services/cerebras.ts`, `services/groq.ts` — import + flattened header return

**Test:** `tests/architecture/boundaries.test.ts` (new), `tests/integration/mock-adapters.ts` (1 fixture line)

## Decisions Made

- **`ProviderState` lives in `domain/types.ts`, not in the port file.** The plan placed it in `application/ports/provider-state-store.ts`, but `domain/provider-state.ts` needs the shape and domain may not import from `application/` — the guard enforces exactly that. Declaring it inward and re-exporting from the port satisfies both the plan's artifact expectation and the layer rule.
- **The domain store satisfies its port structurally.** `domain/provider-state.ts` declares its own return interface rather than importing `ProviderStateStore`. TypeScript's structural typing makes the store assignable to the port at the composition edge with no inward dependency.
- **The legacy `classifyError` returns raw headers by reference.** `cooldown-manager.test.ts:155` asserts `expect(apiResult.headers).toBe(headers)` — object identity. A flattened copy fails that. The shim uses `rawSdkErrorHeaders(err)` for the legacy return while the domain path uses the flattened record; both disappear when plan 04 deletes the shim.
- **The guard matches constructs, not spellings.** Naive substrings from the plan produced false positives on legitimate identifiers. Word-boundary regexes still cover every concept ARCHITECTURE.md §6 names.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `createProviderStateStore` needs an injected alias resolver**
- **Found during:** Task 5
- **Issue:** The plan specified `deps: { order, clock, configured }`, but `isEligible()` calls `resolveUpstreamModel(logicalModel, provider)`. The only in-repo source is `model-registry.ts`, which imports `config` — importing it from `domain/` would violate HEX-04 and fail the Task-6 guard.
- **Fix:** Extended `deps` with `resolveUpstreamModel(alias, provider)`. The shim passes the existing bound function, so behaviour is identical.
- **Files modified:** `domain/provider-state.ts`, `routing/provider-state.ts`
- **Verification:** `tests/routing/provider-state.test.ts` passes unmodified, including the "rejects aliases that are not mapped for a provider" case that exercises this path
- **Committed in:** `960afcc`

**2. [Rule 3 - Blocking] `ProviderState` in the port file would force a domain → application import**
- **Found during:** Task 5
- **Issue:** The plan put `ProviderState` in `application/ports/provider-state-store.ts`. `domain/provider-state.ts` builds and returns those objects, so it would have had to import from `application/` — forbidden by ARCHITECTURE.md §2 and by the guard's domain rule.
- **Fix:** Declared `ProviderState` in `domain/types.ts`; the port imports and re-exports it. The port file still *provides* `ProviderState` to its consumers exactly as the plan's artifact table specifies.
- **Files modified:** `domain/types.ts`, `application/ports/provider-state-store.ts`, `domain/provider-state.ts`
- **Verification:** Boundary guard passes; `routing/provider-state.ts` still exports `ProviderState`
- **Committed in:** `960afcc`

**3. [Rule 1 - Bug] `classifyError` shim would have broken an unmodifiable identity assertion**
- **Found during:** Task 4
- **Issue:** `tests/routing/cooldown-manager.test.ts:155` asserts `expect(classifyError(groqError(429, headers)).headers).toBe(headers)` — reference identity. Returning `classifyUpstreamFailure(toUpstreamFailure(err))` directly would hand back a freshly flattened record and fail that test, which the plan forbids modifying.
- **Fix:** Added `rawSdkErrorHeaders(err)` to the error mapper (same file, same single `instanceof` helper) and had the shim return the original header object while the domain path keeps the flattened record.
- **Files modified:** `adapters/outbound/sdk-error-mapper.ts`, `routing/cooldown-manager.ts`
- **Verification:** All 5 `classifyError` cases pass unmodified, including the plain-object and unknown-error branches
- **Committed in:** `596d2c0`

**4. [Rule 1 - Bug] Guard's literal substring list false-positived on legitimate domain code**
- **Found during:** Task 6
- **Issue:** The plan's forbidden list included the raw substrings `Response(` and `: Headers`. `Response(` matches `normalizeResponse(` in `domain/normalization.ts`, so the guard failed against a clean tree.
- **Fix:** Replaced the substring list with labelled word-boundary regexes (`\bnew Response\b|:\s*Response\b|<\s*Response\b`, etc.), covering every concept ARCHITECTURE.md §6 names — including `FormData`, which the plan's list omitted — without matching identifier substrings.
- **Files modified:** `tests/architecture/boundaries.test.ts`
- **Verification:** Guard passes on the clean tree (4 pass); negative test still fails correctly when `../config` is injected into `domain/rate-limits.ts`
- **Committed in:** `e20fac5`

**5. [Rule 1 - Doc defect] Doc comments tripped the plan's own literal grep criteria**
- **Found during:** Tasks 2 and 5
- **Issue:** `application/ports/chat-provider.ts` enumerated "Headers, Request, Response, FormData" in a comment, and `domain/provider-state.ts` said "no direct Date.now()" — both made the plan's plain-substring acceptance checks report violations against otherwise-clean files.
- **Fix:** Reworded both comments to reference `ARCHITECTURE.md` §3 instead of spelling out the forbidden tokens.
- **Files modified:** `application/ports/chat-provider.ts`, `domain/provider-state.ts`
- **Verification:** All literal grep criteria for Tasks 2 and 5 now report zero
- **Committed in:** `0cff3af`, `960afcc`

---

**Total deviations:** 5 auto-fixed (3 × Rule 1, 2 × Rule 3)
**Impact on plan:** No scope change and no weakened control. Deviations 1 and 2 were unavoidable consequences of the layer rule the plan itself established — the plan's own boundary guard would have rejected the literal instructions. Deviation 3 preserved an existing test the plan explicitly forbade editing. Deviations 4 and 5 corrected defects in verification-mechanism spelling, not in behaviour. Every status set, threshold, regex, and side effect named in the plan's `<interfaces>` block was moved verbatim.

## Issues Encountered

**Pre-existing `tsc --noEmit` errors (not introduced, not fixed).** Running `bunx tsc --noEmit` reports 7 errors, all in `index.ts` (undici `FormData` mismatch at `:373`, a `StreamChunk` → `Record<string, unknown>` cast at `:766`) and in two test files (`Headers` casts, `Record<string, unknown>` casts). `git diff 2d19cc5..HEAD -- index.ts tests/` confirms none of those files were touched by this plan for those lines. There is no typecheck step in `package.json` and `bun test` does not typecheck, so this is not a phase gate — but plan 03 rewrites `index.ts` and should expect to encounter the `:373` and `:766` sites.

**Transient type gap between Tasks 1 and 2 (by design).** The plan's Task 1 shrinks `types.ts` to `export * from './domain/types'`, temporarily dropping the `ProviderAdapter` export that Task 2 restores as a port re-export. Because these are `import type` sites, Bun erases them and the suite stayed green; the gap closed within one commit.

## User Setup Required

None — no external service configuration required. Zero dependencies added.

## Next Phase Readiness

**Ready for 08-03.** Plan 03 dissolves `index.ts` into `application/use-cases/` and `adapters/inbound/http/`. What plan 02 hands it:

- **Use-case dependencies are all named ports now.** `ChatProviderPort`, `TranscriptionPort`, `ProviderStateStore`, `Clock`, and `Logger` exist and are implementation-free, so use cases can be written against them without touching a vendor SDK.
- **Orchestration primitives are pure and callable headless:** `classifyUpstreamFailure`, `calcCooldownMs`, `parseCerebrasHeaders`/`parseGroqHeaders`, `normalizeResponse`/`normalizeChunk`, and the provider-state store.
- **`domain/errors.ts` is declared but unused** — plan 03 wires use cases to return/throw `UpstreamRejectedError`, `NoProviderAvailableError`, and `TranscriptionUnavailableError`, and maps them to the existing OpenAI/Gemini error bodies in presenters. This is the mechanism that closes V-12 (orchestration returning `Response`).
- **The guard now covers `application/`**, so the use cases plan 03 adds are checked the moment they land — including the rule that they may not import `adapters/` or `config`.

**Carry-forward constraints for plan 03:**
1. `index.ts` still imports from every shim path; do not delete a shim in plan 03 — that is plan 04's job.
2. Route order is load-bearing: `/health`, `/ready`, and the Gemini route are matched **before** the Bearer gate (`index.ts:172`), proven by the 401 assertions in `gemini-compat.test.ts`.
3. The SSE generator (`index.ts:758-845`) must move **verbatim** — the terminal-usage-chunk suppression, the `hasVisibleChunkData` filter, the `firstChunkSent` success recording, and the error-path `[DONE]` emission are each covered by tests.
4. Use cases must not import `config` or return `Response`; presenters own both.

## Self-Check: PASSED

| Check | Result |
|---|---|
| All 16 created files exist on disk | PASS |
| `git log --grep="08-02"` returns ≥1 commit | PASS (6) |
| Task 1-6 automated `<verify>` commands | PASS (all) |
| HEX-04: no vendor/zod/env/Bun/Headers token in `domain/` or `application/` | PASS (grep empty) |
| HEX-05: `instanceof *APIError` only in `adapters/outbound/sdk-error-mapper.ts` | PASS |
| HEX-07/08: 5 port files, zero `class ` occurrences | PASS |
| HEX-15: guard fails on injected forbidden import, passes after revert | PASS (verified both directions) |
| HEX-14: `git diff tests/` = 1 fixture line + 1 new file, 0 `expect(` edits | PASS |
| Zero new npm packages (`git diff package.json bun.lock` empty) | PASS |
| `bun test` exit 0 — 115 pass / 0 fail (≥112 required) | PASS |
| No leftover negative-test edit (`git status --porcelain -- domain/` empty) | PASS |

---
*Phase: 08-hexagonal-architecture-audit-refactor*
*Completed: 2026-07-24*
