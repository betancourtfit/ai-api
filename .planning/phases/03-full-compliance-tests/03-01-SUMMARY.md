---
phase: 03-full-compliance-tests
plan: "01"
subsystem: response-normalization
tags: [normalization, response-shape, allowlist-rebuild, streaming, tdd]
dependency_graph:
  requires: []
  provides: [response-normalizer, usage-optional-types]
  affects: [index.ts, services/cerebras.ts, services/groq.ts, types.ts]
tech_stack:
  added: []
  patterns: [allowlist-rebuild, conditional-spread, raw-usage-passthrough]
key_files:
  created:
    - response-normalizer.ts
    - tests/unit/response-normalizer.test.ts
  modified:
    - types.ts
    - index.ts
    - services/cerebras.ts
    - services/groq.ts
decisions:
  - allowlist-rebuild over spread-and-delete: new object built field-by-field; provider fields excluded by construction not removal
  - usage made optional in ChatCompletionResult: enables adapters to signal missing upstream usage for raw passthrough to normalizer
  - zero-usage synthesis in normalizer not adapters: single place to enforce NORM-08 guarantee downstream
metrics:
  duration: "~10 minutes"
  completed: "2026-06-05T22:57:00Z"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 6
  tests_added: 14
  tests_total: 53
requirements: [NORM-01, NORM-02, NORM-03, NORM-04, NORM-05, NORM-06, NORM-07, NORM-08, NORM-09]
---

# Phase 3 Plan 1: Response Normalizer (Allowlist-Rebuild) Summary

**One-liner:** Central allowlist-rebuild normalizer for both response paths — provider fields (time_info, x_groq, usage_breakdown, reasoning) excluded by construction, model always shows logical alias.

## What Was Built

### response-normalizer.ts (new, 78 lines)

Two pure named-export functions using allowlist-rebuild pattern (D-06):

- `normalizeResponse(raw, logicalAlias)` — non-streaming path: rewrites model to alias, fixes object literal to 'chat.completion', maps choices field-by-field (stripping reasoning), synthesizes zero-usage when upstream omits it, conditionally includes system_fingerprint only when present in raw (NORM-01,03-05,07-09)
- `normalizeChunk(raw, logicalAlias)` — streaming path: rewrites model to alias, fixes object literal to 'chat.completion.chunk', builds delta conditionally (role only when defined, content only when key present, reasoning excluded) (NORM-02,06,09)

Neither function spreads `raw` or uses `delete` — provider fields are absent by construction (T-03-01).

### types.ts (modified)

`ChatCompletionResult.usage` changed from required to optional (`usage?:`) so adapters can signal "upstream omitted usage" without synthesizing zeros themselves. The normalizer holds the zero-synthesis guarantee (D-08 prerequisite).

### index.ts (modified)

- Added import for `normalizeChunk`, `normalizeResponse` from `./response-normalizer`
- Streaming path (line 296): `{ ...chunk, model: input.model }` replaced with `normalizeChunk(chunk, input.model)`
- Non-streaming path (line 340): `result.model = input.model` mutation replaced with `const normalized = normalizeResponse(result, input.model)` + serialize `normalized`
- Inline model rewrites fully removed; all normalization flows through the central module (T-03-02)

### services/cerebras.ts and services/groq.ts (modified)

Usage construction changed from per-field `?? 0` synthesis to raw passthrough:
```typescript
usage: completion.usage ? {
    prompt_tokens: completion.usage.prompt_tokens ?? 0,
    ...
} : undefined,
```
Both files updated stale comments to reflect that response-normalizer.ts now owns field stripping and model rewrite.

### tests/unit/response-normalizer.test.ts (new, 14 tests)

TDD RED/GREEN: failing tests committed first, then implementation.

Covers all NORM-01..09 behaviors:
- model rewrite for both non-streaming and streaming
- object literal enforcement for both
- provider-specific field injection via cast (reasoning, time_info, x_groq, usage_breakdown, reasoning_logprobs) — verified absent from output
- usage synthesis when undefined
- usage preservation when present
- system_fingerprint absent key vs. present key (Object.hasOwn)
- delta.role conditional (present/absent)
- delta.content conditional with explicit null pass-through
- delta.reasoning exclusion

## TDD Gate Compliance

- RED commit: `696bb89` — `test(03-01): add failing tests for response-normalizer (RED)`
- GREEN commit: `620c3a2` — `feat(03-01): implement response-normalizer with allowlist-rebuild (GREEN)`

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `696bb89` | test | Add failing tests for response-normalizer (RED) |
| `620c3a2` | feat | Implement response-normalizer with allowlist-rebuild (GREEN) |
| `a5d6af5` | feat | Wire normalizer into index.ts; adapters pass usage through raw |

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

None — the response-normalizer.ts module directly mitigates T-03-01 (information disclosure via provider fields) and T-03-02 (provider topology leak via model field). No new threat surface was introduced.

## Known Stubs

None — the normalizer is fully wired into both response paths.

## Self-Check

### Files exist:
- response-normalizer.ts: FOUND
- tests/unit/response-normalizer.test.ts: FOUND
- types.ts (contains `usage?:`): FOUND

### Commits exist:
- 696bb89: FOUND (RED)
- 620c3a2: FOUND (GREEN)
- a5d6af5: FOUND (Task 2)

### Test results:
- `bun test tests/unit/response-normalizer.test.ts`: 14 pass, 0 fail
- `bun test` (full suite): 53 pass, 0 fail

## Self-Check: PASSED
