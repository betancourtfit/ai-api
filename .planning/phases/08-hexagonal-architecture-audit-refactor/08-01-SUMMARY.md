---
phase: 08-hexagonal-architecture-audit-refactor
plan: 01
subsystem: architecture
tags: [hexagonal, clean-architecture, audit, documentation, boundaries]

requires:
  - phase: 07-gemini-compatible-transcription-shim
    provides: the 111-test green suite and the second wire contract that makes the port case concrete
provides:
  - Gap report classifying all 13 production .ts files into hexagonal target layers
  - Violation register V-01..V-15 with severity, verified file:line evidence, and an owning plan per row
  - Durable repo-root ARCHITECTURE.md contract with per-layer import allowlists
  - Explicit allowed/forbidden port-signature primitive lists
  - Recorded regression baseline (111 pass / 0 fail) used as the safety gate by plans 02-04
affects: [08-02, 08-03, 08-04, boundary-guard-test, future-phases]

tech-stack:
  added: []
  patterns:
    - "Layer import allowlist enforced by an executable guard test rather than convention"
    - "Adapter/domain split for vendor error classification (toUpstreamFailure / classifyUpstreamFailure)"
    - "Shim-first migration: re-export at old paths until the final plan rewrites test imports"

key-files:
  created:
    - .planning/phases/08-hexagonal-architecture-audit-refactor/08-ARCHITECTURE-AUDIT.md
    - ARCHITECTURE.md
  modified: []

key-decisions:
  - "Corrected the production-file census to 13 files / 1 990 LOC — 08-RESEARCH.md §1's '16 files / 1 355 LOC' rollup was wrong, and the audit records measured values rather than restating it"
  - "Corrected two drifted citations (V-04 types.ts:32-34 → :31-34 with Headers at :33; V-07 whisper-service.ts:31-77 → :31-78) rather than softening the claims"
  - "Layers are top-level directories with no src/, honouring the standing project decision; ARCHITECTURE.md states explicitly that this supersedes the illustrative src/ sketch in CLAUDE.md §21"
  - "Security invariants (wire contract, constant-time key comparison, no secret logging, allowlist-rebuild normalization, zero new deps) are recorded as outranking every layering rule"

patterns-established:
  - "Violation IDs V-NN are stable identifiers: plans 02-04 close them by ID, so verification is a lookup not a judgement call"
  - "Every gate in this phase is 'bun test exits 0 AND pass count does not decrease from 111', never a stale literal"

requirements-completed: [HEX-01, HEX-02, HEX-03]

duration: 9 min
completed: 2026-07-24
---

# Phase 08 Plan 01: Architecture Audit + Target Contract Summary

**Turned "this isn't hexagonal" into a 15-row violation register with verified `file:line` evidence and an owning plan per row, plus a repo-root import contract that the plan-02 boundary test will enforce mechanically — with zero TypeScript touched.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-24T01:34:21Z
- **Completed:** 2026-07-24T01:39:51Z
- **Tasks:** 4 completed
- **Files created:** 2 (both markdown)
- **Files modified:** 0 source files

## Accomplishments

- **Measured the real baseline and corrected two stale figures.** `bun test` → 111 pass / 0 fail / 287 assertions / 8 files. The ROADMAP's "104 existing tests" and `08-RESEARCH.md` §1's "16 files / 1 355 LOC" are both wrong; the audit records 111 tests and 13 production files / 1 990 LOC, and names the 111-test suite as the regression harness for plans 02-04.
- **Classified every production file (HEX-01).** All 13 `.ts` files mapped to exactly one of the six allowed target layers, with the required move stated per row. 12 of 13 move; only `config.ts` stays put.
- **Registered every violation with evidence (HEX-02).** V-01..V-15 carry severity, a `file:line` citation, the boundary crossed, and the plan that closes it. Every citation was opened and confirmed against the current tree before being written down.
- **Wrote the durable contract (HEX-03).** `ARCHITECTURE.md` states per-layer import allowlists and forbidden lists, the allowed/forbidden port-signature primitives, the target tree, the de-vendoring seam with both status sets, the boundary-guard enforcement rule, and the invariants that outrank layering.
- **Proved zero code drift.** `git status --porcelain -- '*.ts'` empty at every task boundary; suite still 111 pass / 0 fail.

## Task Commits

1. **Task 1: Record the verified baseline** — no commit (measurement only, zero files changed by design)
2. **Task 2: Write 08-ARCHITECTURE-AUDIT.md** — `ec38822` (docs)
3. **Task 3: Write ARCHITECTURE.md** — `787b8a9` (docs)
4. **Task 4: Cross-link and confirm zero code drift** — no commit (cross-link lines were authored inline in Tasks 2 and 3; this task was verification only)

## Files Created/Modified

- `.planning/phases/08-hexagonal-architecture-audit-refactor/08-ARCHITECTURE-AUDIT.md` — 7-section gap report: measured baseline, 13-row layer classification, 15-row violation register, severity rollup, preserved-invariants list, test-coupling map with exact import lines, and the four-plan remediation order with per-plan riskiest edit
- `ARCHITECTURE.md` — 7-section durable contract at repo root: why hexagonal here, 5-row layer table, port primitive allow/deny lists, target tree, de-vendoring seam, boundary-guard enforcement, and the invariants that outrank the architecture

## Decisions Made

- **Recorded measured facts over research figures.** The plan's `<interfaces>` block quoted "16 files, 1 355 LOC" from research. The measured census is 13 files / 1 990 LOC, and the plan's own acceptance criteria required exactly 13 classification rows. The audit records the measured values and states explicitly which prior figures are stale and why — this is the whole point of Task 1 existing.
- **Corrected drifted citations rather than the claims.** Two of the 15 citations were off by one line. Per the plan's instruction, line numbers were corrected and the corrections are documented in a dedicated subsection so a reviewer can see exactly what changed.
- **Named the CLAUDE.md §21 reconciliation explicitly.** `CLAUDE.md` §21 sketches `src/routes|providers|middleware|schemas`. The project has a standing "no `src/`" decision. `ARCHITECTURE.md` §4 states that the layer vocabulary supersedes that sketch while every concern it names survives, relocated — so the two documents do not silently contradict each other. `CLAUDE.md` itself is deliberately left unedited until plan 04, when the tree actually exists.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Incorrect input data] Research file/LOC rollup was wrong**
- **Found during:** Task 1 (Record the verified baseline)
- **Issue:** The plan's `<interfaces>` block and `08-RESEARCH.md` §1 both state "16 `.ts` (excl. tests), 1 355 LOC production". The measured census is 13 production files totalling 1 990 LOC. Research §2's own module map lists exactly 13 files whose line counts sum to 1 990, so only the §1 rollup was miscounted.
- **Fix:** Recorded the measured values in the audit's §1 and added an explicit "Corrections to previously recorded figures" subsection covering both this and the ROADMAP's stale "104 tests". No violation in the register depends on the rollup, so nothing downstream changed.
- **Files modified:** `08-ARCHITECTURE-AUDIT.md`
- **Verification:** `find` + `wc -l` census reproduced in the document; classification table has exactly 13 rows as the plan's acceptance criteria require
- **Committed in:** `ec38822`

**2. [Rule 1 - Stale citation] Two violation citations had drifted by one line**
- **Found during:** Task 2 (Write 08-ARCHITECTURE-AUDIT.md)
- **Issue:** V-04 cited `types.ts:32-34`, but the `CompletionOutcome` interface spans `:31-34` with the offending `headers: Headers` field on `:33`. V-07 cited `whisper-service.ts:31-77`, but the `HttpWhisperService` class body spans `:31-78`.
- **Fix:** Corrected both line numbers (the plan explicitly directs correcting the number rather than the claim) and documented both corrections in a "Citation corrections made during this audit" subsection.
- **Files modified:** `08-ARCHITECTURE-AUDIT.md`
- **Verification:** All 15 citations opened and confirmed; the other 13 resolved exactly as recorded
- **Committed in:** `ec38822`

**3. [Rule 3 - Blocking] `May **NOT** import` markdown bold broke the plan's own verify command**
- **Found during:** Task 3 (Write ARCHITECTURE.md)
- **Issue:** The layer table header was written as `May **NOT** import`. The plan's automated verify is `grep -q "May NOT import" ARCHITECTURE.md` and the artifact must-have is `contains: "may not import"` — the bold markers made both fail. Separately, the tree nested `inbound/http/` under `adapters/`, so the literal `adapters/inbound/http/` required by the acceptance criteria never appeared.
- **Fix:** Removed the bold from the header cell, added the phrase "what an inner layer may not import is not a style preference — it is the boundary" to the prose beneath the table, and annotated the tree line with its full path `(= adapters/inbound/http/ …)`.
- **Files modified:** `ARCHITECTURE.md`
- **Verification:** `test -f ARCHITECTURE.md && grep -q "May NOT import" ARCHITECTURE.md && grep -q "boundaries.test.ts" ARCHITECTURE.md` → passes; all six target-tree directory names now grep-resolve
- **Committed in:** `787b8a9`

---

**Total deviations:** 3 auto-fixed (2 × Rule 1, 1 × Rule 3)
**Impact on plan:** None on scope. Two were corrections to inherited figures/citations — exactly the verification work Tasks 1 and 2 exist to perform. The third was a self-inflicted formatting defect caught by running the plan's own acceptance criteria before declaring the task done. No source file was touched and no violation was added, removed, or re-severitised.

## Issues Encountered

None. The suite was green at plan start and green at plan end, with an identical 111 / 0 / 287 signature.

## User Setup Required

None — no external service configuration required. This plan added two markdown files and zero dependencies.

## Next Phase Readiness

**Ready for 08-02.** Plan 02 carves out `domain/` and `application/ports/` and closes V-03, V-04, V-07, plus partial V-05 and V-13. Everything it needs is now written down:

- The target paths for every module it creates are fixed by `ARCHITECTURE.md` §4.
- The de-vendoring seam it implements (`toUpstreamFailure` / `classifyUpstreamFailure`) is specified in §5, including the failover set `{408, 429, 498, 500, 502, 503, 504}` and terminal set `{400, 401, 403, 404, 413, 422}`.
- The boundary-guard test it must add has its forbidden-substring list fixed by §6.
- The audit's §6 lists the exact test import lines that must stay untouched until plan 04, so plan 02 knows precisely where to leave shims.

**Carry-forward note for plan 02:** `readHeader` in `routing/cooldown-manager.ts:102-126` already accepts a plain record shape, so replacing `CompletionOutcome.headers: Headers` with `Record<string, string>` exercises a pre-existing, already-tested code path rather than a new one. Keep `HeaderSource` accepting both forms until plan 04 removes the shims.

## Self-Check: PASSED

| Check | Result |
|---|---|
| `08-ARCHITECTURE-AUDIT.md` exists on disk | PASS |
| `ARCHITECTURE.md` exists on disk | PASS |
| `git log --grep="08-01"` returns ≥1 commit | PASS (4) |
| Task 2 acceptance: 15 `V-` rows, 13 classification rows, 7 sections | PASS |
| Task 3 acceptance: 5-row layer table, both primitive lists, 6 tree dirs, both status sets, 4 invariants | PASS |
| Task 3 automated verify (`grep -q "May NOT import"` + `boundaries.test.ts`) | PASS |
| Task 4 acceptance: bidirectional cross-links present | PASS |
| Plan verification: `bun test` exit 0, 111 pass / 0 fail (unchanged) | PASS |
| Plan verification: `git status --porcelain -- '*.ts'` empty | PASS |
| `CLAUDE.md` unmodified | PASS |

---
*Phase: 08-hexagonal-architecture-audit-refactor*
*Completed: 2026-07-24*
