---
phase: 04-audio-foundation
fixed_at: 2026-06-06T00:00:00Z
review_path: .planning/phases/04-audio-foundation/04-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-06-06
**Source review:** `.planning/phases/04-audio-foundation/04-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01, CR-02, CR-03, WR-01, WR-02, WR-03, WR-04)
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-01 + WR-03: NaN from invalid numeric env vars / unsafe PROVIDER_ORDER cast

**Files modified:** `config.ts`
**Commit:** `0e48793`
**Applied fix:** Added `requiredPositiveInt(name, fallback)` helper that throws a descriptive error on NaN or non-positive values. Applied it to `audioMaxFileBytes`, `maxRequestBodyBytes`, `defaultCooldownSeconds`, `maxProviderAttemptsPerRequest`, `whisperPort`, and `whisperTimeoutMs`. Also replaced the unsafe `as Array<"cerebras" | "groq">` cast on `PROVIDER_ORDER` with runtime validation (IIFE) that rejects unknown provider names and throws if the resulting list is empty.

---

### CR-02: 429 without headers skips DEFAULT_COOLDOWN_SECONDS cooldown

**Files modified:** `index.ts`
**Commit:** `75df7e3`
**Applied fix:** Both the streaming error-handling loop (line ~329) and the non-streaming loop (line ~536) now always call `setCooldown` when status is 429 or 498. `parseRateLimitHeaders` and `toRateLimitSnapshot` are only invoked when `classified.headers` is truthy; otherwise both default to empty objects so `calcCooldownMs` falls back to `defaultCooldownSeconds`. The snapshot is passed as `undefined` when empty so `setCooldown` receives no spurious empty object.

---

### CR-03: Mid-stream error after first chunk is silently swallowed

**Files modified:** `index.ts`
**Commit:** `30dd915`
**Applied fix:** Removed the `if (!firstChunkSent)` guard from the streaming generator's catch block. The error log now always fires (using `firstChunkSent` only to choose the event name between `stream_error_before_first_chunk` and `stream_error_after_first_chunk`), the `request_complete` log always fires, and `yield 'data: [DONE]\n\n'` always executes so SSE clients receive the mandatory closing sentinel even on mid-stream failure.

---

### WR-01: recordSuccess called before stream data consumed

**Files modified:** `index.ts`
**Commit:** `632a0f3`
**Applied fix:** Removed the `recordSuccess(chosenProvider, 200)` call at the pre-stream site. Inside the generator, `recordSuccess(finalProvider, 200)` is now called on the first iteration that passes `hasVisibleChunkData` (i.e., real data received). An additional call after the loop handles the empty-but-complete stream case (`!firstChunkSent` after loop exit). This ensures the provider state only reflects success once actual data has been received, not merely after the stream connection was opened.

---

### WR-02: streamUsage dead variable — always null in logs

**Files modified:** `index.ts`
**Commit:** `6c2f716`
**Applied fix:** Added usage capture at the top of the chunk loop, before `normalizeChunk`. When a chunk has `choices: []` (empty array) and a non-null `usage` field, the usage is captured into `streamUsage` and the loop continues without forwarding the chunk downstream. This captures the terminal usage chunk that Cerebras and Groq both emit at the end of a stream. The captured value flows into the `request_complete` log's `usage` field.

---

### WR-04: TEST-03 cooldown-expiry assertion vacuous due to resetForTesting()

**Files modified:** `tests/integration/server.test.ts`
**Commit:** `3430de1`
**Applied fix:** Removed `resetForTesting()` from inside TEST-03. The test now preserves routing state (including the active cooldown) across the `setSystemTime` call. Only mock implementations are reset via `resetMockAdapter`. With routing state intact, cerebras being selected on the second request proves that `isEligible()` correctly evaluates `Date.now() > cooldownUntil` rather than finding a freshly-initialized provider state.

---

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-06-06_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
