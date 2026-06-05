---
phase: 02-routing-streaming
plan: "01"
subsystem: routing
tags: [routing, round-robin, cooldown, failover, diagnostics]
dependency_graph:
  requires:
    - "Phase 1 foundation: auth, validation, logical model registry, non-streaming adapters"
  provides:
    - "routing/cooldown-manager.ts — provider-specific header parsing, cooldown calculation, error classification"
    - "routing/provider-state.ts — ProviderState storage, eligibility, round-robin cursor, cooldown lifecycle, resetForTesting"
    - "index.ts non-streaming router loop — round-robin candidate selection, failover, cooldown entry, 503 exhaustion path"
    - "GET /ready — unauthenticated readiness with ok/degraded modes"
    - "GET /internal/providers/status — auth-gated provider state diagnostics"
    - "CompletionOutcome contract — adapters return parsed result plus raw headers"
  affects:
    - "config.ts"
    - "types.ts"
    - "services/cerebras.ts"
    - "services/groq.ts"
    - "index.ts"
tech_stack:
  added: []
  removed: []
  patterns:
    - "Pure routing utilities with bun:test coverage"
    - "Provider SDK .withResponse() to capture headers without dropping SDK abstractions"
    - "One cursor advance per request, outside candidate selection"
key_files:
  created:
    - routing/cooldown-manager.ts
    - routing/provider-state.ts
    - tests/routing/cooldown-manager.test.ts
    - tests/routing/provider-state.test.ts
  modified:
    - config.ts
    - types.ts
    - services/cerebras.ts
    - services/groq.ts
    - index.ts
commits:
  - "31d7dbe feat(02-01): cooldown manager parsers and config vars"
  - "56eb990 feat(02-01): provider state eligibility and cursor"
  - "a9b0a7f feat(02-01): stateful router and provider diagnostics"
status: complete
---

# Plan 02-01 Summary

## Outcome

Plan `02-01` is complete. The Phase 1 first-eligible provider loop has been replaced with a stateful non-streaming router that:

- chooses eligible providers via a rotating cursor,
- classifies upstream failures into failover vs terminal responses,
- places providers into cooldown on `429` and Groq `498`,
- exposes `/ready` without auth and `/internal/providers/status` behind the proxy Bearer gate,
- keeps `/v1/models` unchanged and logical-alias only.

The adapters now return both the normalized completion payload and upstream response headers via `CompletionOutcome`, which is the bridge Phase `02-02` will reuse for streaming failover-before-response behavior.

## Files and Contracts

### New routing modules

- `routing/cooldown-manager.ts`
  - `parseCerebrasHeaders(headers)`
  - `parseGroqHeaders(headers)`
  - `calcCooldownMs(parsed, defaultCooldownSeconds)`
  - `classifyError(err)`
- `routing/provider-state.ts`
  - `isEligible(provider, logicalModel)`
  - `chooseEligibleProviders(logicalModel)`
  - `advanceCursor()`
  - `setCooldown(provider, untilMs, snapshot?)`
  - `setRateLimitSnapshot(provider, snapshot)`
  - `recordSuccess(provider, statusCode)`
  - `recordFailure(provider, statusCode)`
  - `getStateSnapshot()`
  - `resetForTesting()`

### Updated contracts

- `types.ts`
  - adds `CompletionOutcome { result, headers }`
  - changes `ProviderAdapter.complete()` to return `Promise<CompletionOutcome>`
- `services/cerebras.ts` and `services/groq.ts`
  - now use `.withResponse()` and return raw `response.headers` alongside the normalized result
- `index.ts`
  - imports the routing modules
  - uses `chooseEligibleProviders()` + one `advanceCursor()` call per request
  - returns `503 no_provider_available` when the candidate list is exhausted
  - adds `/ready` before auth and `/internal/providers/status` after auth

## Verification

### Commands

- `bunx tsc --noEmit`
  - PASS
- `bun --env-file=.env.test test`
  - PASS
  - 37 tests passing across:
    - `request-schema.test.ts`
    - `tests/routing/cooldown-manager.test.ts`
    - `tests/routing/provider-state.test.ts`

### Acceptance checks

- `grep -c "advanceCursor()" index.ts`
  - `1`
- `rg -n "chooseEligibleProviders\\(|/ready|/internal/providers/status|enableInternalStatusEndpoint|no_provider_available|withResponse\\(" index.ts services/cerebras.ts services/groq.ts types.ts`
  - PASS
- `rg -n "console\\.(log|error)\\(.*(headers|token|Authorization)" index.ts`
  - no matches

## Requirements Covered

- `ROUTE-01` to `ROUTE-08`
- `RL-01` to `RL-07`
- `EP-01`
- `EP-03`
- `EP-05`
- `EP-06`

## Deviations from Plan

None - plan executed as written.

## Next Plan Readiness

Phase `02-02` can build directly on this plan. The important reuse points are:

- `index.ts` already has pre-response provider-attempt logic, which the streaming branch should mirror before constructing the SSE `Response`.
- `CompletionOutcome` and `.withResponse()` are in place, so adapters already expose the header access pattern the router expects.
- `routing/provider-state.ts` and `routing/cooldown-manager.ts` are stable and fully unit-tested; streaming should import and reuse them instead of duplicating failover logic.

## Remaining Human Verification

Optional live smoke remains:

- two real `POST /v1/chat/completions` requests with valid keys to observe alternation and inspect `/internal/providers/status`,
- one `GET /ready` check with real env configuration.
