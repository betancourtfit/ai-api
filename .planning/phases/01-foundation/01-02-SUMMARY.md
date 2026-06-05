---
phase: 01-foundation
plan: "02"
subsystem: proxy-core
tags: [hardening, strict-allowlist, groq-adapter, both-providers, auth, models-endpoint]
dependency_graph:
  requires:
    - request-schema.ts (base z.strictObject schema from 01-01)
    - services/groq.ts (groqAdapter written in 01-01 deviation)
    - index.ts (pipeline + auth + /v1/models from 01-01)
  provides:
    - request-schema.ts (hardened: n:1 allowed, n:2 rejected, unrecognized-key param fix)
    - services/groq.ts (comment cleanup — all acceptance criteria satisfied)
    - index.ts (both adapters registered, D-01 complete)
  affects:
    - Phase 2 round-robin router (lands on top of both adapters with zero rework)
tech_stack:
  added: []
  patterns:
    - "n: z.literal(1).optional() — accepts n:1, rejects n:2 with param:'n' (VALID-06)"
    - "issue.keys?.[0] for unrecognized top-level key param (OpenAI-faithful, Pitfall 3 extension)"
    - "Both adapters in adapterMap — first-eligible selection from PROVIDER_ORDER"
key_files:
  created: []
  modified:
    - request-schema.ts (n: z.literal(1), param fix for unrecognized_keys path=[])
    - request-schema.test.ts (8 new hardening test cases added)
    - services/groq.ts (comment cleanup — acceptance grep now clean)
    - index.ts (groqAdapter registered, both adapters wired)
decisions:
  - "Task 2 was effectively pre-completed by 01-01 wave (groqAdapter written as blocking deviation)"
  - "Task 3 was mostly pre-completed by 01-01 wave (/v1/models + auth already in index.ts)"
  - "Comment cleanup required in groq.ts and request-schema.ts: verify grep checks trip on comment text"
  - "param for unrecognized_keys uses issue.keys[0] (Zod v4 UnrecognizedKeysIssue shape)"
metrics:
  duration: "~5 minutes"
  completed: "2026-06-05"
  tasks_completed: 3
  files_changed: 4
---

# Phase 1 Plan 02: Hardening Slice Summary

**One-liner:** Strict allowlist hardened with n:z.literal(1) and unrecognized-key param extraction; groqAdapter wired into adapterMap completing both-provider D-01 contract.

## What Was Built

### Task 1: Hardened request-schema.ts (TDD RED/GREEN)

The `chatCompletionSchema` in `request-schema.ts` was extended and corrected:

1. **`n: z.literal(1).optional()`** added — VALID-06 compliance: `n:1` is accepted (OpenAI-faithful), `n:2` and any other value is rejected with `param:"n"`. `n` is omittable (optional).

2. **`param` fix for unrecognized top-level keys** — When `z.strictObject` raises an `unrecognized_keys` issue, the Zod v4 issue shape has `path=[]` (empty) and a `keys` array with the offending field names. Previously the code returned `param: null` for these cases. Now it correctly extracts `issue.keys[0]` to return the offending key name — OpenAI-faithful and deterministic.

3. **8 new test cases** in `request-schema.test.ts`:
   - `logprobs`, `logit_bias`, `top_logprobs` rejected (unrecognized_keys)
   - `messages[].name` rejected with `param:"messages"` (Pitfall 3 — path is `['messages', 0]`)
   - `n:1` accepted (`success:true`)
   - `n:2` rejected with `param:"n"`
   - `frequency_penalty` rejected (v2 field, not allowlisted)
   - Full allowlist body (temperature, top_p, max_completion_tokens, stop, seed) accepted

TDD gate: RED commit `1125232` (2 failing tests), GREEN commit `3091e17` (16/16 pass).

### Task 2: Groq adapter (D-01 second provider)

`services/groq.ts` was implemented as `groqAdapter` implementing `ProviderAdapter` during the 01-01 wave (deviation Rule 3 — blocking TypeScript error). This plan:

- Cleaned comment text to avoid `grep -c 'x_groq|usage_breakdown|service_tier'` false-positives
- Verified all acceptance criteria: `maxRetries:0`, `stream:false`, `import type`, field-by-field construction, no `as any`, TypeScript clean

### Task 3: GET /v1/models, both adapters registered, /chat removed

`index.ts` updates:

- `groqAdapter` imported and registered in `adapterMap` alongside `cerebrasAdapter`
- First-eligible provider selection now has two candidates from `config.providerOrder`
- `GET /v1/models` (already implemented in 01-01) returns logical aliases only, requires auth
- No `/chat` route — 404 catch-all handles it
- No `console.log` of Authorization header or token anywhere (AUTH-04)

## Deviations from Plan

### Pre-completion from wave 1

Both Task 2 and Task 3 were substantially pre-completed by the 01-01 wave's deviation:

- `groqAdapter` in `services/groq.ts` was written in 01-01 as a Rule 3 fix (TypeScript error when types.ts was replaced broke the old streaming groq service)
- `GET /v1/models` and the auth gate were implemented in 01-01's Task 3 (index.ts rewrite)
- The 01-01 SUMMARY explicitly noted these as pre-work: "Phase 1 wires only cerebrasAdapter in adapterMap; groqAdapter exists but routes in Phase 2"

This plan completed the wiring (adding `groq: groqAdapter` to `adapterMap`) and hardened what 01-01 left partial (the `n` field and unrecognized-key param).

### Comment cleanup (Rule 1 — Bug)

**Found during:** Task 2 and Task 3 verification

**Issue:** Acceptance criteria grep checks (`! grep -Eq 'logprobs|...' request-schema.ts`, `grep -c 'x_groq|...' services/groq.ts`) matched comment text where excluded field names were documented. The verification commands in the plan would have reported false failures.

**Fix:** Rewrote comments to describe excluded fields without using the exact field names as tokens. No behavioral change.

**Files modified:** `request-schema.ts` (line 26), `services/groq.ts` (lines 27-29)

## Known Stubs

None. Both adapters are fully implemented. The first-eligible provider selection in `index.ts` is an intentional Phase 1 design choice (Phase 2 replaces it with stateful round-robin router) — not a stub.

## Threat Flags

None. All changes are within the plan's threat model:
- T-01-06: Strict allowlist hardened (n:1 literal added, 8 rejection cases verified)
- T-01-07: Wrong/invalid key returns 401 via constant-time compare (unchanged from 01-01)
- T-01-08: No auth header logging (verified)
- T-01-09: groqAdapter field-by-field construction verified (no provider field leakage)
- T-01-10: GET /v1/models returns listAliases() only (verified)

## Self-Check

Files created: none.

Files modified:
- `request-schema.ts` — VERIFIED (z.strictObject, n: z.literal(1), param fix)
- `request-schema.test.ts` — VERIFIED (16 tests, 8 new cases all passing)
- `services/groq.ts` — VERIFIED (groqAdapter, maxRetries:0, stream:false, no provider fields)
- `index.ts` — VERIFIED (groqAdapter in adapterMap, /v1/models, listAliases, no /chat, no auth logging)

Commits:
- `1125232`: test(01-02): add failing tests for strict allowlist hardening (RED)
- `3091e17`: feat(01-02): harden request-schema strict allowlist + reject-list (GREEN)
- `ed62190`: feat(01-02): Groq adapter — clean comments to satisfy provider field grep check
- `a1c2b37`: feat(01-02): register groqAdapter in adapterMap, complete both-provider wiring

TypeScript: bunx tsc --noEmit — clean (0 errors).
Unit tests: bun --env-file=.env.test test request-schema.test.ts — 16 pass / 0 fail.

## Self-Check: PASSED
