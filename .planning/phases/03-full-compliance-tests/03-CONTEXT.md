# Phase 3: Full Compliance + Tests - Context

**Gathered:** 2026-06-05
**Status:** Ready for planning

<domain>
## Phase Boundary

All provider-specific fields are stripped from every response (NORM-01..10), every response carries correct OpenAI field shapes plus observability headers and structured logs (OBS-01..05), and the full 12-case test suite passes with isolated state (TEST-01..12). This is the final phase of v1 — after it, all 76 requirements are complete.

**Explicitly NOT this phase:** new endpoints, tool calling, structured outputs, `frequency_penalty`/`presence_penalty`, `/v1/responses` — all out of MVP scope per PROJECT.md.

</domain>

<decisions>
## Implementation Decisions

### Test harness
- **D-01: Real server + mocked adapters.** Integration suite boots a real `Bun.serve()` instance (random port) and asserts via `fetch()` — full HTTP path including headers, SSE wire format, and status codes exactly as clients see them. Provider adapters are mocked; SDKs never hit the network.
- **D-02: `createServer(adapters)` factory seam.** Refactor `index.ts` to export a `createServer(adapters)` factory returning the server (or `Bun.serve` config); the entrypoint calls it with real adapters. Tests call it with mock adapters on port 0. This also fixes the "server starts on import" problem.
- **D-03: `setSystemTime()` for cooldown expiry.** TEST-03 uses `bun:test`'s `setSystemTime()` fake clock to jump past `cooldownUntil` — deterministic, no real waiting. Cooldown logic already reads `Date.now()`, no refactor needed.
- **D-04: Mocked only — no live tests in suite.** `bun test` is 100% deterministic: no quota burn, runs offline. Live verification against real Cerebras/Groq stays manual (curl, as in Phase 1/2 verification).

### Normalization architecture
- **D-05: Central normalizer module.** New `response-normalizer.ts` (spec §21): one function for non-streaming bodies, one for streaming chunks. Adapters return raw SDK output; normalizer applied at the route layer. Single place to test NORM-01..09; both providers share one path. Fold the existing inline model-rewrite in `index.ts` stream relay and the inline Cerebras stripping into this module.
- **D-06: Allowlist-rebuild.** Normalizer constructs a clean response containing ONLY known OpenAI fields (`id`, `object`, `created`, `model`, `choices`, `usage`, `system_fingerprint`; choices: `index`, `message`/`delta`, `finish_reason`; message/delta: `role`, `content`, `tool_calls`). Unknown or future provider fields can never leak — satisfies success criterion 1 by construction.
- **D-07: Upstream error passthrough + ID rewrite.** Upstream provider error messages pass through (wrapped in OpenAI error shape per NORM-10), but known upstream model IDs in the message text are rewritten back to the logical alias before sending. Preserves "no raw provider model IDs appear in any response."
- **D-08: Missing usage → synthesize zeros + warn log.** If upstream omits `usage` on a non-streaming response, emit `{prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}` and log a warning. NORM-08 always holds; anomaly visible in logs.

### Claude's Discretion
- **Test file layout** — current state is mixed (`request-schema.test.ts` co-located at root; `tests/routing/*.test.ts` mirror dir). Planner picks a consistent convention; spec §21 suggests `tests/unit` + `tests/integration` but consolidation extent is discretionary.
- **X-Request-ID semantics** — generate per request (OBS-01 says UUID per request); whether to honor an inbound `X-Request-ID` is discretionary.
- **Logger shape** — keep `console.log(JSON.stringify(...))` or extract a small logger util with `LOG_LEVEL` gating; either is fine as long as OBS-02..04 fields/redactions hold.
- **Stream latency definition** in logs (TTFB vs total duration) — pick one and log it consistently.
- **Mock adapter design** — scriptable per-test responses (200/429 with headers/500/SSE chunk sequences) shaped however fits the `createServer` seam.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project spec & requirements
- `CLAUDE.md` — full proxy spec. Phase 3 relevant sections: §14 error/failover policy (error shape), §15 response normalization (preserve/rewrite/remove lists), §16 streaming (chunk integrity, [DONE] sentinel), §19 observability (log fields, never-log list, X-Request-ID), §22 acceptance criteria, §26 working rules (never expose reasoning).
- `.planning/REQUIREMENTS.md` — Phase 3 requirement IDs: NORM-01..10 (lines 83–92), OBS-01..05 (lines 96–100), TEST-01..12 (lines 104–115). Authoritative wording.
- `.planning/ROADMAP.md` §"Phase 3: Full Compliance + Tests" — goal + 4 success criteria.

### Prior phase decisions
- `.planning/phases/01-foundation/01-CONTEXT.md` — D-05 (OpenAI error shape adopted since Phase 1), D-03 (minimal structure).
- `.planning/STATE.md` §Accumulated Context — "stream relay suppresses normalized no-op chunks" (Phase 2 decision; keep when folding rewrite into normalizer).

### Codebase maps
- `.planning/codebase/TESTING.md` — bun:test patterns, mock()/spyOn(), priority test areas. Note: written pre-refactor; file paths stale but patterns valid.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `routing/provider-state.ts` — `resetForTesting()` already exists (TEST-12 hook); `tests/routing/provider-state.test.ts` + `cooldown-manager.test.ts` already pass.
- `request-schema.test.ts` (root) — 13 validation unit tests already cover TEST-07/TEST-08 behaviors at unit level; integration variants still needed per success criterion 3.
- `index.ts:22 openaiError()` — error shape helper already exists; NORM-10 verification + sweep, not greenfield.
- `index.ts:295` — inline chunk model rewrite + `hasVisibleChunkData()` no-op suppression; fold into normalizer module (D-05).
- `services/cerebras.ts:48-49` — inline reasoning/time_info stripping comments; superseded by central normalizer.

### Established Patterns
- `bun:test` with `describe`/`beforeEach`/`mock` — already in use in 3 test files.
- Structured-ish JSON logs via `console.log(JSON.stringify({...}))` at index.ts:260, 269, 307, 366, 375 — extend with request ID, latency, consistent field set (OBS-02).
- 4-space indent, named exports, kebab-case service files.

### Integration Points
- `index.ts` `Bun.serve()` at module level + `adapterMap` const — the `createServer(adapters)` refactor (D-02) wraps both; entrypoint behavior unchanged.
- Normalizer slots between adapter result and Response construction (non-streaming) and inside the SSE relay generator (streaming).
- `X-Request-ID` must attach to EVERY response path: success, validation 400, auth 401, exhaustion 503, stream responses.

</code_context>

<specifics>
## Specific Ideas

- Allowlist-rebuild chosen explicitly so "responses never contain `reasoning`/`x_groq`/etc." holds by construction, not by chasing fields.
- Upstream error text is valued for debugging — don't replace with generic messages, just de-leak model IDs (D-07).
- `.env.test` exists but suite must not depend on real keys (D-04 — mocked only).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 3-Full Compliance + Tests*
*Context gathered: 2026-06-05*
