---
phase: 07-gemini-compatible-transcription-shim
plan: 01
subsystem: api
tags: [gemini, generateContent, transcription, whisper, openai-compat, bun, sse-out-of-scope]

# Dependency graph
requires:
  - phase: 06-whisper-sidecar-models-ready
    provides: Injected WhisperService.transcribe + validateAudioFileSize + whisperModelAlias config
provides:
  - "POST /v1beta/models/{model}:generateContent — Gemini-wire-compatible audio transcription route"
  - "geminiError(code, message, status) helper emitting { error: { code, message, status } } (no OpenAI type field)"
  - "?key= / x-goog-api-key auth path (pre-Bearer-gate) reusing constant-time verifyToken"
affects: [gemini-streaming, n8n-migration, future-multimodal-routes]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-auth-gate route branch for non-Bearer (Gemini ?key=/x-goog-api-key) authentication"
    - "Native Buffer + File base64→File decode (zero deps) for inline_data audio ingestion"
    - "Per-route error shape factory (geminiError mirrors openaiError) to keep wire formats isolated"

key-files:
  created: []
  modified:
    - index.ts
    - tests/integration/gemini-compat.test.ts

key-decisions:
  - "Route placed before the global Bearer gate (D-01) — Gemini uses ?key=/x-goog-api-key, not Bearer"
  - "Do NOT require URL {model} == whisperModelAlias (D-08) — preserves URL-swap migration"
  - "All error paths use Gemini shape (no OpenAI type/param leakage) including unset-config 401 (D-04)"
  - "Estimated usageMetadata tokens (ceil(text.length/4)); modelVersion echoes the URL model (D-10/D-11)"

patterns-established:
  - "Pre-gate alternate-auth route: validate provider-specific credential before the shared Bearer gate"
  - "Gemini-shaped error factory distinct from openaiError, selected per-route"

requirements-completed: [GEM-01, GEM-02, GEM-03, GEM-04, GEM-05, GEM-06, GEM-07, GEM-08, GEM-09, GEM-10, GEM-11, GEM-12, GEM-13, GEM-14, GEM-15]

# Metrics
duration: 3 min
completed: 2026-06-17
---

# Phase 7 Plan 1: Gemini-Compatible Transcription Shim Summary

**Additive `POST /v1beta/models/{model}:generateContent` route that accepts Google generateContent audio requests (?key=/x-goog-api-key + inline_data base64), transcribes via the existing whisper sidecar, and returns Gemini-shaped candidates / errors — zero new npm packages, all OpenAI /v1/* routes untouched.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-06-17T03:50:00Z
- **Completed:** 2026-06-17T03:53:17Z
- **Tasks:** 4
- **Files modified:** 2

## Accomplishments
- New Gemini-wire-compatible transcription route placed before the global Bearer gate, authenticating via `x-goog-api-key` header then `?key=` query param with constant-time `verifyToken`.
- `geminiError()` helper emitting `{ error: { code, message, status } }` (UNAUTHENTICATED / INVALID_ARGUMENT / UNAVAILABLE) with no OpenAI `type`/`param` fields.
- Native `Buffer` + `File` base64 decode of the first `inline_data` audio part, reusing `validateAudioFileSize` and `whisperService.transcribe(file, whisperModelAlias ?? model)` — zero new dependencies.
- `file_data` Files-API parts and missing-inline-audio → Gemini-shaped 400; transcribe failure → Gemini-shaped 503; out-of-scope endpoints (`:streamGenerateContent`, multi-candidate) documented in-code (GEM-15).
- Full `bun test` suite green (104 pass / 0 fail across 8 files); no logging of base64 data, decoded bytes, or transcript text.

## Task Commits

1. **Task 1: Un-skip Phase 7 TARGET spec (TDD red)** - `303a038` (test)
2. **Task 2: Add geminiError() helper** - `62a6abb` (feat)
3. **Task 3: Add :generateContent route branch (+ GEM-15 out-of-scope comment, + legacy-assertion deviation)** - `197dd75` (feat)
4. **Task 4: Full green gate + out-of-scope docs** - no separate commit (GEM-15 comment bundled into Task 3; Task 4 was the verification gate only)

## Files Created/Modified
- `index.ts` - Added `geminiError()` helper and the `POST /v1beta/models/{model}:generateContent` route branch (pre-Bearer-gate); no other route, helper, or `import.meta.main` touched.
- `tests/integration/gemini-compat.test.ts` - Un-skipped the Phase 7 TARGET acceptance block; flipped one stale legacy assertion (see Deviations).

## Decisions Made
- Followed plan decisions D-01..D-13 as specified. Oversize audio uses HTTP 400 with `INVALID_ARGUMENT` (plan's stated default among the 400/413 discretion).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Flipped one stale legacy assertion in the URL-swap migration block**
- **Found during:** Task 3 / Task 4 (full green gate)
- **Issue:** The plan asserted the entire legacy "URL-swap migration check" block only exercised the unchanged `/v1/audio/transcriptions` route and must stay green untouched. In fact one legacy test (`'Gemini request (path + ?key= auth) is rejected at the proxy (401/404)'`) hits the very `/v1beta/models/...:generateContent` path this phase now serves. With the additive route present and a valid `?key=`, it correctly returns 200, so the original 401/404 expectation became factually wrong — a stale assertion, not a regression of behavior.
- **Fix:** Updated that single assertion to expect `200` (the now-compatible result), with a comment citing the test file's own header note ("the assertions here will flip and must be updated"). The other 3 legacy tests (all on `/v1/audio/transcriptions`) were left byte-for-byte unchanged.
- **Files modified:** `tests/integration/gemini-compat.test.ts`
- **Verification:** `bun test` → 104 pass / 0 fail; the 3 untouched legacy tests still green; the 6 Phase 7 TARGET tests green.
- **Committed in:** `197dd75` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 stale-assertion fix)
**Impact on plan:** No scope creep. The fix was required because the plan's "leave legacy block untouched" constraint and its "all prior tests stay green" constraint were mutually exclusive for exactly one test once the (intended, additive) route exists. The test file header explicitly sanctions this flip. All code-behavior constraints honored.

## Issues Encountered
None beyond the single legacy-assertion conflict documented above.

## User Setup Required
None - no external service configuration required. The route reuses the already-wired whisper sidecar and `PERSONAL_PROXY_API_KEY`.

## Next Phase Readiness
- The Gemini transcription shim is wire-compatible and additive; an n8n Gemini node can migrate by changing only base URL + API key value.
- Deferred for a future milestone (GEM-15): `:streamGenerateContent` (Gemini SSE streaming) — currently falls through to the 404 handler; `file_data` Files-API URI ingestion; multi-candidate responses; accurate token counting.

## Self-Check: PASSED

- FOUND: index.ts (geminiError + route branch)
- FOUND: tests/integration/gemini-compat.test.ts
- FOUND: .planning/phases/07-gemini-compatible-transcription-shim/07-01-SUMMARY.md
- FOUND commits: 303a038, 62a6abb, 197dd75
- `bun test` → 104 pass / 0 fail across 8 files
- `bun build index.ts --target=bun` → OK

---
*Phase: 07-gemini-compatible-transcription-shim*
*Completed: 2026-06-17*
