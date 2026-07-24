---
phase: 08-hexagonal-architecture-audit-refactor
plan: 04
subsystem: architecture
tags: [hexagonal, composition-root, dependency-injection, shims, documentation]

requires:
  - phase: 08-hexagonal-architecture-audit-refactor
    provides: "plan 03's application layer, HTTP delivery layer, and the extended boundary guard"
provides:
  - Single composition root (composition/container.ts) wiring every adapter
  - Injectable provider factories with no import-time SDK construction
  - loadConfig(env) as the single process.env ingress
  - Zero compatibility shims; routing/ and services/ removed
  - Tests addressing the real module graph, resetting an injected store
  - Guard rules for stray env reads, import-time construction, and shim reintroduction
  - CLAUDE.md and ARCHITECTURE.md describing the tree that is actually on disk
affects: [future-phases]

tech-stack:
  added: []
  patterns:
    - "Composition root: buildContainer(cfg, overrides) is the only place adapters are constructed"
    - "Lazily memoized default container so all servers share one provider-state store"
    - "Optional deps parameter on createServer for test-time dependency injection"
    - "Guard rules that police composition, not just imports"

key-files:
  created:
    - adapters/outbound/cerebras-chat-provider.ts
    - adapters/outbound/groq-chat-provider.ts
    - composition/container.ts
    - tests/domain/provider-state.test.ts
    - tests/domain/rate-limits.test.ts
    - tests/adapters/http-whisper-service.test.ts
    - tests/unit/request-schema.test.ts
  modified:
    - config.ts
    - index.ts
    - adapters/inbound/http/server.ts
    - tests/architecture/boundaries.test.ts
    - tests/integration/server.test.ts
    - tests/integration/gemini-compat.test.ts
    - tests/integration/mock-adapters.ts
    - tests/unit/response-normalizer.test.ts
    - tests/unit/audio-schema.test.ts
    - CLAUDE.md
    - ARCHITECTURE.md
    - .planning/phases/08-hexagonal-architecture-audit-refactor/08-ARCHITECTURE-AUDIT.md

key-decisions:
  - "getDefaultContainer() memoizes one Container so every createServer() without injected deps shares a provider-state store — matching the pre-refactor module-global lifetime exactly"
  - "Registry and store methods are destructured into same-named locals in the moved tests, so assertion lines stay byte-identical across the relocation"
  - "The cooldown test's toBe(headers) reference-identity assertion was deliberately rewritten to toEqual({'retry-after':'2'}) — it asserted deleted-shim behaviour, and V-04 makes a flattened record the contract"
  - "The import-time-construction guard skips declaration lines, so 'export function createProviderStateStore(' is not mistaken for an import-time call"

patterns-established:
  - "Every adapter is constructed by a factory taking an explicit config slice, never reading config itself"
  - "Guard rules cover composition (env reads, import-time construction, shims) as well as imports"

requirements-completed: [HEX-12, HEX-13, HEX-14, HEX-15]

duration: 26 min
completed: 2026-07-24
---

# Phase 08 Plan 04: Composition Root and Shim Deletion Summary

**One `buildContainer()` call now performs every wiring step that used to happen at import time across six modules; all 11 compatibility shims are deleted, `routing/` and `services/` are gone, and the boundary guard polices composition as well as imports — 119 tests green, zero dependencies added.**

## Performance

- **Duration:** 26 min
- **Started:** 2026-07-24T02:10:00Z
- **Completed:** 2026-07-24T02:26:12Z
- **Tasks:** 6 completed
- **Files created:** 7
- **Files modified:** 12
- **Files deleted:** 11 shims + 4 relocated test files + 4 directories
- **Suite:** 116 → **119 pass / 0 fail** (3 new guard cases)

## Accomplishments

- **Built the single composition root (HEX-13).** `composition/container.ts` performs the registry JSON parse, store construction, logger/clock selection, both SDK provider factories, and whisper adapter selection. Verified: all six wiring calls appear in exactly one file.
- **Eliminated import-time side effects (V-06).** Both SDK clients are now created lazily inside their factory closures. Importing any module under `domain/`, `application/`, or `adapters/` constructs nothing and reads no env — and the guard enforces it.
- **Made config a single ingress (V-13).** `config.ts` exports `loadConfig(env)`, `AppConfig`, and the default `config`. Every key, default, and throw message is byte-identical.
- **Deleted every shim (V-15).** All 11 gone; `routing/`, `services/`, `tests/routing/`, `tests/services/`, and root `request-schema.test.ts` removed.
- **Removed the production test hatch (V-05 final, HEX-12).** `resetForTesting` exists nowhere outside `tests/`. `server.test.ts` constructs its own store and injects it via `createServer`'s new `deps` parameter.
- **Kept the assertions honest (HEX-14).** Across the entire plan exactly **one** `expect(...)` line changed, deliberately and for a documented reason. The relocated `request-schema.test.ts` body is byte-identical to the original below its import header — verified by `diff`.
- **Guarded composition itself (HEX-15).** Three new rules — no stray `process.env`, no top-level import-time construction, no re-export-only modules — each proven to fail on a deliberate violation and pass after revert.
- **Made the docs true (V-14).** `CLAUDE.md`'s Architecture and Conventions blocks described a prototype that has not existed since Phase 1 (`AIService`, `getNextService`, "No authentication", "No cooldown / failover"). Both now describe the real tree.

## Task Commits

1. **Task 1: Provider SDK adapters as injectable factories** — `1e200d3` (refactor)
2. **Task 2: Loadable config and the composition root** — `5bfb703` (refactor)
3. **Task 3: Rewire production imports off every shim** — no commit required (see below)
4. **Task 4: Relocate/rewire tests, delete every shim** — `cc12f1a` (refactor)
5. **Task 5: Guard the composition rules** — `6f3e961` (test)
6. **Task 6: Documentation and final phase gate** — `7d4573f` (docs)

## Files Created/Modified

- `adapters/outbound/cerebras-chat-provider.ts` / `groq-chat-provider.ts` — injectable factories; clients built lazily in-closure
- `composition/container.ts` — `Container`, `buildContainer(cfg, overrides)`, `getDefaultContainer(cfg)`
- `config.ts` — `loadConfig(env)` + `AppConfig` + default instance
- `adapters/inbound/http/server.ts` — sources deps from the container; optional 5th `deps` parameter
- `index.ts` — 22 lines; builds the container and hands it through
- Tests relocated to their layer: `tests/domain/{provider-state,rate-limits}.test.ts`, `tests/adapters/http-whisper-service.test.ts`, `tests/unit/request-schema.test.ts`
- `tests/architecture/boundaries.test.ts` — three new rule families
- `CLAUDE.md`, `ARCHITECTURE.md`, `08-ARCHITECTURE-AUDIT.md` — documentation aligned with disk

## Decisions Made

- **The default container is memoized.** Building a fresh container per `createServer()` call gave each server its own provider-state store, which broke the round-robin determinism test immediately — the three servers in `server.test.ts` must observe one store. `getDefaultContainer()` returns a lazily-built singleton, reproducing the pre-refactor module-global lifetime, while callers passing `deps` still get their own graph.
- **Moved tests destructure rather than re-address.** `const { isKnownAlias, resolveUpstreamModel } = createModelRegistry({…})` and the equivalent for the store keep every assertion line spelled exactly as before, so the relocation is provably behaviour-preserving rather than merely claimed to be.
- **The guard distinguishes a declaration from a call.** `export function createProviderStateStore(` sits at column 0 in `domain/provider-state.ts` and would otherwise trip the import-time-construction rule. The check skips lines containing `function <construct>`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Per-call container construction broke provider-state isolation**
- **Found during:** Task 2
- **Issue:** `createServer` initially called `buildContainer(config, deps)` unconditionally, giving each of the three servers in `server.test.ts` its own store. `TEST-12b: determinism proof — second test also starts from cerebras (no cursor leak)` failed, because the cursor the test reset was not the cursor the requests advanced.
- **Fix:** Added `getDefaultContainer(cfg)`, a lazily memoized singleton used whenever no `deps` are injected, so all servers in a process share one store exactly as the module globals did.
- **Files modified:** `composition/container.ts`, `adapters/inbound/http/server.ts`, `routing/provider-state.ts` (then deleted in Task 4)
- **Verification:** Full suite green; the determinism, cooldown, recovery, and exhaustion tests all pass unmodified
- **Committed in:** `5bfb703`

**2. [Rule 1 - Bug] Boundary guard flagged a factory declaration as import-time construction**
- **Found during:** Task 5
- **Issue:** The new column-0 rule reported `domain/provider-state.ts:34: top-level 'createProviderStateStore('` — but that line is `export function createProviderStateStore(deps: …)`, a declaration, not a call. The guard failed against a clean tree.
- **Fix:** Skip any line containing `function <construct>` before flagging.
- **Files modified:** `tests/architecture/boundaries.test.ts`
- **Verification:** Guard passes clean (8/8) and still fails on an injected top-level `JSON.parse(` in `adapters/outbound/system-clock.ts`
- **Committed in:** `6f3e961`

**3. [Rule 4-adjacent - Deliberate, pre-authorised] One assertion rewritten**
- **Found during:** Task 4
- **Issue:** `tests/domain/rate-limits.test.ts` (formerly `cooldown-manager.test.ts:164`) asserted `expect(apiResult.headers).toBe(headers)` — **reference identity** with the original `Headers` object. That identity was only preserved by the `routing/cooldown-manager.ts` shim's `rawSdkErrorHeaders` passthrough, which this plan deletes. The plan's own interfaces block mandates `classifyError(err)` → `classifyUpstreamFailure(toUpstreamFailure(err))`, which by construction returns a flattened record — making the old assertion impossible to satisfy.
- **Fix:** Rewrote it to `expect(apiResult.headers).toEqual({ "retry-after": "2" })`, asserting that the same header data survives the flattening, with an inline comment recording why. Plan 03's summary flagged this exact assertion as carry-forward constraint #3: "must be rewritten deliberately, not incidentally."
- **Files modified:** `tests/domain/rate-limits.test.ts`
- **Verification:** All 13 cases in that file pass; the surrounding unknown-error assertion is untouched
- **Committed in:** `cc12f1a`

**4. [Rule 3 - Blocking] `validateAudioFileSize` was unreachable from the application layer**
- **Found during:** plan 03 Task 1, carried into this plan's structure
- **Issue:** noted here for completeness — `domain/audio-limits.ts` exists because the use case could not import the delivery-layer Zod module. Recorded in the 08-03 summary.
- **Files modified:** n/a (pre-existing from 08-03)

---

**Total deviations:** 3 auto-fixed in this plan (2 × Rule 1, 1 deliberate pre-authorised assertion change)
**Impact on plan:** No scope change and no weakened control. Deviation 1 was caught by the regression suite doing exactly its job. Deviation 2 was a defect in a new verification mechanism, not in the code under test. Deviation 3 was explicitly anticipated by the previous plan's carry-forward notes and is the only assertion change in the entire phase.

## Issues Encountered

**Task 3 required no code changes.** By the time Tasks 1-2 completed, no file under `adapters/`, `application/`, `domain/`, `composition/`, or `index.ts` imported a shim — plan 03's Task 4 and this plan's Tasks 1-2 had already rewired every production import. Verified with a resolving checker (not a substring grep, which false-positives on `domain/./types`): 49 production files scanned, zero resolve to a shim. The task's `<done>` condition was already true, so there was nothing to commit.

**The plan's Task 3 verify command has a false positive.** Its grep `from '\./(types|…)'` matches `domain/normalization.ts`'s `from './types'`, which resolves to `domain/types.ts` — the real module, not the root shim. A path-resolving check is the correct instrument and is what was used.

**Pre-existing `tsc --noEmit` errors remain.** Still no typecheck step in `package.json`; `bun test` does not typecheck. Unchanged in kind from the phase start.

## User Setup Required

None — no external service configuration required. Zero dependencies added across the entire phase.

## Next Phase Readiness

**Phase 8 is complete.** The architecture is now enforced rather than described:

- **The guard is the durable artifact.** `tests/architecture/boundaries.test.ts` (8 cases) fails `bun test` on a forbidden layer import, a vendor/zod/transport construct in an inner layer, a stray `process.env` read, a top-level import-time construction, or a re-export-only shim. A future phase cannot quietly reintroduce V-03, V-06, or V-13.
- **`ARCHITECTURE.md` §6 and the guard agree** — the rule table was rewritten to match what the test actually checks.
- **Adding a provider** now means: one file in `adapters/outbound/`, one entry in `buildContainer`, one registry alias. Nothing in `domain/` or `application/` changes.
- **Adding a wire format** means one route module plus one presenter; the use cases are already shared.

**Known follow-ups (not blockers, not in this phase's scope):**
1. `bunx tsc --noEmit` reports 7 pre-existing errors (undici `FormData` typing in `routes/transcriptions.ts`, two `Record<string, unknown>` casts, `Headers` casts in tests). Wiring a typecheck gate would be a natural Phase 9 hygiene item.
2. `dist/index.js` is a stale build artifact from before Phase 1 and no longer reflects any source.
3. The use cases are now unit-testable headlessly but have no direct unit tests — all coverage still arrives through the integration suite.

## Self-Check: PASSED

| Check | Result |
|---|---|
| All 7 created files exist on disk | PASS |
| `git log --grep="08-04"` returns ≥1 commit | PASS (5) |
| Task 1-6 automated `<verify>` commands | PASS (all) |
| HEX-13: 6 wiring calls confined to `composition/container.ts` | PASS |
| HEX-13: no stray `process.env` outside `config.ts` (health.ts excepted) | PASS (guard enforces) |
| HEX-13: no top-level import-time construction | PASS (guard enforces) |
| HEX-12: `resetForTesting` absent from production | PASS |
| All 11 shims deleted; `routing/`, `services/`, `tests/routing/`, `tests/services/` gone | PASS |
| HEX-14: exactly one deliberate `expect(` change phase-wide | PASS (documented) |
| `request-schema.test.ts` body byte-identical after move | PASS (`diff` clean) |
| HEX-15: 3 new guard rules each fail on violation, pass after revert | PASS |
| `git status --porcelain -- domain/ application/ adapters/ composition/` clean after negative tests | PASS |
| `CLAUDE.md` describes the real tree; references `ARCHITECTURE.md` | PASS |
| Audit Closure section covers all 15 violations, none open | PASS |
| `index.ts` 22 lines (< 40) | PASS |
| Zero new npm packages vs phase start (`2d19cc5..HEAD`) | PASS (0 diff lines) |
| `bun test` exit 0 — 119 pass / 0 fail (≥111 baseline) | PASS |

---
*Phase: 08-hexagonal-architecture-audit-refactor*
*Completed: 2026-07-24*
