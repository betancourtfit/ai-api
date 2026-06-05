---
phase: 03-full-compliance-tests
plan: "02"
subsystem: observability-and-compliance
tags: [observability, request-id, structured-logging, createServer, error-shape, norm-10, d-07]
dependency_graph:
  requires: [03-01]
  provides: [createServer-factory, X-Request-ID, structured-logs, NORM-10-sweep, D-07-passthrough, rewriteUpstreamModelIds]
  affects: [index.ts, model-registry.ts, routing/cooldown-manager.ts]
tech_stack:
  added: []
  patterns: [createServer-factory, withRequestId-rebuild, log-level-gating, d07-delek-rewrite]
key_files:
  created: []
  modified:
    - index.ts
    - model-registry.ts
    - routing/cooldown-manager.ts
decisions:
  - Task 2 and 3 implemented together in a single comprehensive rewrite — tightly coupled log() helper and withRequestId() function make a two-phase split artificial
  - log() helper module-level in index.ts (not separate logger.ts) — discretionary minimal-logger per RESEARCH Pattern 4
  - withRequestId rebuilds response unconditionally — avoids Bun header mutability pitfall; always safe
  - failoverReason set to 'status_NNN' pattern (e.g. 'status_429') at cooldown/failover sites before the loop ends
  - request_complete log emits after [DONE] yield for streaming (total stream duration, not TTFB) — Claude discretion per CONTEXT
  - input.messages in params construction (not a log site) — grep gate scoped to log() call sites; documented in summary
metrics:
  duration: "~20 minutes"
  completed: "2026-06-05T23:30:00Z"
  tasks_completed: 3
  tasks_total: 3
  files_changed: 3
  tests_added: 0
  tests_total: 53
requirements: [NORM-10, OBS-01, OBS-02, OBS-03, OBS-04, OBS-05]
---

# Phase 3 Plan 2: Observability and Compliance Sweep Summary

**One-liner:** createServer factory (D-02), X-Request-ID on every path (OBS-01), structured JSON logs with LOG_LEVEL gating (OBS-02..04), NORM-10 error shape sweep, D-07 upstream error de-leaking, and X-LLM-Provider opt-in header.

## What Was Built

### index.ts (refactored)

**Task 1 — createServer factory:**
- `export function createServer(adapters: Record<Provider, ProviderAdapter>, port?: number)` wraps the `Bun.serve()` call (D-02)
- `adapterMap` const removed; `adapters` parameter used throughout the fetch handler
- `if (import.meta.main)` entrypoint guard at module bottom — `bun index.ts` still boots; `import { createServer }` is side-effect-free for ports
- Plan 03-03 integration test seam ready

**Task 2 — Compliance sweep:**
- `const requestId = crypto.randomUUID()` at the very top of each fetch handler invocation
- `function withRequestId(response: Response): Response` helper — rebuilds response with `X-Request-ID` header (avoids Bun header mutability pitfall)
- `withRequestId(...)` applied at every non-streaming return site in the handler (17 sites)
- Streaming success Response: `'X-Request-ID': requestId` added directly to headers object at construction time
- `config.exposeProviderHeader`: when true, `'X-LLM-Provider': provider` added to both streaming and non-streaming success headers (OBS-05, default false)
- NORM-10: two flat `new Response('Not found', ...)` bodies replaced with `withRequestId(openaiError(..., 'not_found', null, 404))`:
  1. `/internal/providers/status` disabled branch
  2. Final 404 catch-all
- D-07 in streaming non-failover error path: `rewriteUpstreamModelIds(classified.message ?? fallback)`
- D-07 in non-streaming non-failover error path: same pattern

**Task 3 — Structured logging:**
- `function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void` — module-level, reads `config.logLevel`, maps to numeric (error=0, warn=1, info=2), gates via `entryLevel <= configuredLogLevel`, emits via `console.log(JSON.stringify({ level, ...data }))`
- `const requestStart = Date.now()` at top of fetch handler
- OBS-02 `request_complete` log events emitted at:
  - Non-streaming success: before returning 200 response
  - Non-streaming exhaustion (503): after provider loop
  - Non-streaming candidates=0 (503): before returning
  - Streaming exhaustion (503): before returning
  - Streaming success: after `data: [DONE]` yield (total stream duration)
  - Streaming stream_error_before_first_chunk catch path
- Fields: `requestId, timestamp, route, logicalAlias, provider, upstreamModelId, attempt, streaming, statusCode, latencyMs, failoverReason, usage`
- OBS-03: `provider_cooldown`, `provider_failover`, and `stream_error_before_first_chunk` events converted to `log('warn', ...)` and each include `requestId`
- D-08: `if (result.usage === undefined) log('warn', { event: 'usage_missing', provider, requestId })` before normalizeResponse in non-streaming success path — only event/provider/requestId logged, no result object

### model-registry.ts (new export)

`export function rewriteUpstreamModelIds(text: string): string`:
- Collects all (upstreamId, alias) pairs from registry
- Sorts by descending upstream ID length (prefix collision safety)
- Replaces each upstreamId with alias via `split(upstreamId).join(alias)` (no regex escaping)
- Consumed by index.ts in both upstream-error non-failover paths (D-07)

### routing/cooldown-manager.ts (widened return)

`classifyError` return type widened to include `message: string | undefined`:
- `err instanceof GroqAPIError || err instanceof CerebrasAPIError` → returns `err.message`
- Unknown error fallback → returns `undefined`
- All three return sites in the function updated

## OBS-04 Redaction Audit

No log call sites reference: Authorization headers, API keys (config.cerebrasApiKey/groqApiKey/personalProxyApiKey), input.messages (params construction is not a log site — verified by `grep 'log(' index.ts | grep messages` returning 0), choices content, reasoning fields, classified.headers, or err.headers. The `input.messages` occurrence in the file is line 225 in `const params = { messages: input.messages, ... }` — params construction, scoped grep to log() call sites confirms zero sensitive logging.

## Deviations from Plan

### Adjusted gate — OBS-04 input.messages grep

**Plan criterion:** `grep -v '^\s*//' index.ts | grep -c 'input.messages'` outputs 0

**Actual:** outputs 1 — because `params = { messages: input.messages, ... }` (params construction, not a log site)

**Resolution:** The plan's note says "if the params construction uses input.messages, scope the grep to console.log/log( lines instead and document the adjusted gate in the summary." Adjusted gate: `grep -n 'log(' index.ts | grep -i 'messages'` returns 0. Criterion satisfied with documented adjustment.

### Tasks 2 and 3 implemented together

Tasks 2 and 3 were written in a single comprehensive index.ts rewrite. The `log()` helper is used by both the OBS-01/NORM-10 changes (Task 2) and the OBS-02..04 logging (Task 3). Splitting them into two separate file edits would have created a temporary inconsistent state. Result: two commits for three tasks (Task 1 separate, Tasks 2+3 together).

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. Mitigations implemented:
- T-03-03 (OBS-04 redaction): all log sites verified; no secrets, messages, content, or headers logged
- T-03-04 (D-07 passthrough): `rewriteUpstreamModelIds()` applied before any upstream error text reaches client; `classified.headers` never forwarded
- T-03-06 (X-LLM-Provider): gated behind `config.exposeProviderHeader` (default false)

## Known Stubs

None — all functionality is fully wired.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `2c35247` | feat | Extract createServer factory with import.meta.main guard (Task 1) |
| `9e3ea63` | feat | X-Request-ID, NORM-10, D-07 error passthrough, X-LLM-Provider, structured logs (Tasks 2+3) |

## Self-Check

### Files exist:
- index.ts (contains `export function createServer(`): FOUND
- model-registry.ts (contains `export function rewriteUpstreamModelIds(`): FOUND
- routing/cooldown-manager.ts (contains `message: string | undefined`): FOUND

### Commits exist:
- 2c35247: Task 1
- 9e3ea63: Tasks 2+3

### Test results:
- `bun test`: 53 pass, 0 fail (unchanged count — no new tests in this plan)
- `bun -e "await import('./index.ts')"`: exits 0 silently (no server boot)
- `grep -v '^\s*//' index.ts | grep -c "new Response('Not found'"`: 0 (NORM-10 clean)
- `grep -c 'rewriteUpstreamModelIds(classified.message' index.ts`: 2 (both upstream-error paths)

## Self-Check: PASSED
