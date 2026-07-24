---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: milestone
status: complete
last_updated: "2026-07-24T03:25:00.000Z"
last_activity: 2026-07-24 -- Phase 08 verified, secured, and marked complete
progress:
  total_phases: 8
  completed_phases: 8
  total_plans: 20
  completed_plans: 20
  percent: 100
---

# State: bun-ai-api OpenAI-Compatible Proxy Refactor

## Project Reference

**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.
**Mode:** mvp
**Granularity:** Coarse

## Current Position

Phase: 08 (hexagonal-architecture-audit-refactor) — COMPLETE
Plan: 4 of 4
Status: Verified (15/15 requirements, 119/119 tests, UAT 3/3 live) and secured (24/24 threats closed). Milestone v2.0 has no phases remaining.
Last activity: 2026-07-24 -- Completed quick task 260724-p04: CI minimum (6 tsc errors fixed, typecheck script, .github/workflows/ci.yml green on master)

Progress bar: ██████████ 100% (8/8 phases)

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
| 260724-p04 | CI minimum: fix 6 tsc errors + `.github/workflows/ci.yml` (install, typecheck, test, secret-env guard) | 2026-07-24 | 7b6fa6f | Verified | [260724-p04-ci-minimo-fix-errores-tsc-en-tests-workf](./quick/260724-p04-ci-minimo-fix-errores-tsc-en-tests-workf/) |
| Phase 08 P01 | 9 min | 4 tasks | 2 files |
| Phase 08 P02 | 24 min | 6 tasks | 18 files |
| Phase 08 P03 | 22 min | 5 tasks | 27 files |
| Phase 08 P04 | 26 min | 6 tasks | 24 files |

## Session Continuity

**Last action:** Phase 8 closed out. Executed (4 plans, 24 commits, `index.ts` 1,012 → 22 LOC, layers at `domain/ application/ adapters/ composition/`, 48 modules, 8 executable boundary guards, zero new deps, 111 → 119 tests). Verified 15/15 requirements. UAT 3/3 walked against **live** Cerebras and Groq — non-streaming, streaming SSE with a single `[DONE]`, and A-B-A-B round-robin alternation with no key material in `/internal/providers/status`. Security audit SECURED: 24/24 threats closed, `threats_open: 0`.
**Then:** Quick task 260724-p04 wired the CI minimum — `bunx tsc --noEmit` 6 errors → 0 (one production line: a `FormData` annotation in `adapters/inbound/http/routes/transcriptions.ts`), a `typecheck` script, and `.github/workflows/ci.yml` running install → typecheck → test → tracked-secret-env guard. Green on three real Actions runs on master, and `verify` is now a required check via repository ruleset `require-ci-on-master` (admin bypass on, so direct pushes by the owner still work).
**Next action:** Milestone v2.0 has no phases remaining — `/gsd-complete-milestone` to archive, or `/gsd-new-milestone` to open the next one. Deploy-side follow-up available: escalón 2 of the CI/CD proposal (build the image in CI → GHCR → EasyPanel pulls it), which also resolves the Dockerfile Bun drift noted in carried-forward debt.
**Resume file:** None

### Carried-forward debt (from Phase 8)

- Upstream abort on client disconnect is unverified — UAT confirmed the server survives a mid-stream disconnect, not that the provider request is actually cancelled. Wastes quota if broken; no data exposure.
- The 429 cooldown / failover path never ran against a real provider; covered by mock-based tests only.
- ~~`bunx tsc --noEmit` reports 7 pre-existing errors and no typecheck gate is wired into CI.~~ **CLEARED by quick task 260724-p04** (it was 6 errors, not 7; all fixed, and `.github/workflows/ci.yml` now gates install/typecheck/test/secret-env on every push to master and every PR). `verify` is required on master by repository ruleset `require-ci-on-master` (id 19711116), with repository-admin bypass so direct pushes by the owner still work. One item remains open from that task: the `Dockerfile` still pins `oven/bun:1.1.29`, which predates the text `bun.lock` format (Bun v1.1.39+) — its `RUN bun install --frozen-lockfile` is at risk on a clean EasyPanel build, which is why CI pins 1.3.11 instead.
- `dist/index.js` is a stale pre-Phase-1 build artifact still in the tree.
- The new use cases are headlessly testable but have no direct unit tests yet.

---

*State initialized: 2026-06-04*
*Last updated: 2026-06-06 — Phase 6 context gathered*

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 07 P01 | 3 min | 4 tasks | 2 files |
