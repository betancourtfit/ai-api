---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: milestone
status: executing
last_updated: "2026-07-24T02:09:46.213Z"
last_activity: 2026-07-24 -- Phase 08 execution started
progress:
  total_phases: 8
  completed_phases: 7
  total_plans: 20
  completed_plans: 18
  percent: 88
---

# State: bun-ai-api OpenAI-Compatible Proxy Refactor

## Project Reference

**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.
**Mode:** mvp
**Granularity:** Coarse

## Current Position

Phase: 08 (hexagonal-architecture-audit-refactor) — EXECUTING
Plan: 4 of 4
Status: Ready to execute
Last activity: 2026-07-24 -- Phase 08 execution started

Progress bar: █████████░ 88% (7/8 phases)

## Performance Metrics

- Plans completed: 7 (v1.0) + 8 (v2.0)
- Plans total: 7 (v1.0) + 8 (v2.0)
- Requirements mapped: 76/76 (v1.0) + 25/25 (v2.0)
- Phases complete: 3/3 (v1.0) + 3/3 (v2.0)

## Accumulated Context

### Roadmap Evolution

- Phase 8 added (2026-07-23): Hexagonal Architecture Audit + Refactor — architect audit of Clean/Hexagonal compliance, gap diagnosis, and refactor to target guidelines
- Phase 8 planned (2026-07-23): 4 sequential plans; requirements HEX-01..15 derived and added to REQUIREMENTS.md as milestone v3.1

### Key Decisions

- Keep provider SDKs (groq-sdk, cerebras_cloud_sdk) — wrapping is safer than reimplementing HTTP auth + error handling
- Flat root-level structure (no src/) — user preference; simpler for a single-service project
- Remove old /chat endpoint — clean break; only /v1/* routes
- Tests in same phase as implementation — spec requires coverage before expanding scope
- Stateful round-robin (not blind alternation) — free-tier quotas replenish; temporary cooldown is correct behavior
- Intersection contract only (reject unlisted fields) — prevents silent provider-specific behavior divergence
- Zod v4 for validation — explicit dependency on INFRA-04
- Missing secrets should not crash startup — configuration gaps surface via `/ready` and protected-route errors instead
- Stream relay should suppress normalized no-op chunks and tolerate SDK error headers exposed as plain objects
- **v2.0:** whisper-server HTTP sidecar (not subprocess) — cleaner lifecycle, no SIGCHLD handling, avoids binary bundling
- **v2.0:** Zero new npm packages — all sidecar communication via native `fetch()` + `FormData`
- **v2.0:** Phase 4 gates: all tests pass without whisper binary installed — schema/config work is self-contained
- **v2.0:** Phase 5 gates: 100% TEST2-xx coverage against mocked WhisperService before touching real binary
- **v2.0:** maxRequestBodySize raised to audio limit in Bun.serve(); chat-completion 1 MiB limit enforced at validation layer
- **Phase 6:** HttpWhisperService activates only when WHISPER_MODEL_ALIAS is set; lives in whisper-service.ts; inline entrypoint wiring; boot never blocked by sidecar health
- **Phase 8 (planned):** Layers are top-level directories (`domain/ application/ adapters/ composition/`) — honours the no-`src/` preference; ports may use `AbortSignal`/`File`/`Uint8Array`/`AsyncIterable` but never `Headers`/`Request`/`Response`/vendor SDK types; SDK `APIError` knowledge confined to `adapters/outbound/sdk-error-mapper.ts`; refactor proceeds shim-first (old paths keep re-exporting until plan 04) so the 111-test suite is the regression harness with zero assertion edits
- **Phase 7:** Gemini-compat `POST /v1beta/models/{model}:generateContent` route placed BEFORE the global Bearer gate (uses `?key=`/`x-goog-api-key`, not Bearer); reuses injected WhisperService; per-route `geminiError()` factory keeps wire shapes isolated; URL `{model}` not required to equal WHISPER_MODEL_ALIAS (preserves n8n URL-swap migration); zero new npm packages (native Buffer+File base64 decode)

### Todos

None

### Blockers

None

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260617-g3v | Embed whisper-server sidecar in Docker container (single image, two processes) for EasyPanel deploy | 2026-06-17 | 43008ea | Verified | [260617-g3v-embed-whisper-server-sidecar-in-docker-c](./quick/260617-g3v-embed-whisper-server-sidecar-in-docker-c/) |
| Phase 08 P01 | 9 min | 4 tasks | 2 files |
| Phase 08 P02 | 24 min | 6 tasks | 18 files |
| Phase 08 P03 | 22 min | 5 tasks | 27 files |

## Session Continuity

**Last action:** Phase 8 planned — architecture research + audit written to `08-RESEARCH.md` (15 violations V-01..V-15, 2 critical / 5 high / 6 medium / 2 low), 15 HEX requirements derived into REQUIREMENTS.md, 4 sequential plans created. Measured baseline: `bun test` 111 pass / 0 fail (ROADMAP's "104 tests" was stale). No CONTEXT.md — planned from ROADMAP scope + research.
**Next action:** Execute Phase 8 — `/gsd-execute-phase 8`.
**Resume file:** None

---

*State initialized: 2026-06-04*
*Last updated: 2026-06-06 — Phase 6 context gathered*

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 07 P01 | 3 min | 4 tasks | 2 files |
