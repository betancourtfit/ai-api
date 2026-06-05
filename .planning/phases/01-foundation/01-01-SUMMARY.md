---
phase: 01-foundation
plan: "01"
subsystem: proxy-core
tags: [walking-skeleton, auth, validation, model-registry, cerebras-adapter, dependency-cleanup]
dependency_graph:
  requires: []
  provides:
    - config.ts (centralized env config, typed exports)
    - types.ts (ProviderAdapter, CompletionParams, ChatCompletionResult interfaces)
    - model-registry.ts (alias resolution + list)
    - request-schema.ts (Zod v4 strict validation + first-error validator)
    - services/cerebras.ts (non-streaming Cerebras ProviderAdapter)
    - services/groq.ts (non-streaming Groq ProviderAdapter — wired in Phase 2)
    - index.ts (Bun.serve router with full auth/validation/alias/completion pipeline)
  affects: []
tech_stack:
  added:
    - "groq-sdk ^1.2.1 (upgraded from ^0.37.0)"
    - "zod ^4.4.3 (already present, first use)"
    - "node:crypto timingSafeEqual (Bun built-in)"
  removed:
    - "cerebras ^1.2.7 (dead CLI package)"
  patterns:
    - ProviderAdapter interface (non-streaming completion contract)
    - z.strictObject + safeParse + issues[0] first-error pattern
    - timingSafeEqual with length pre-check for constant-time auth
    - Field-by-field ChatCompletionResult construction (strips time_info, reasoning, x_groq)
    - config.ts required() helper — throws at startup on missing env vars
key_files:
  created:
    - config.ts
    - model-registry.ts
    - request-schema.ts
    - request-schema.test.ts
    - .env.test
  modified:
    - package.json (groq-sdk bump, cerebras removal)
    - bun.lock
    - types.ts (full replacement)
    - index.ts (full rewrite)
    - services/cerebras.ts (full rewrite)
    - services/groq.ts (full rewrite)
decisions:
  - "D-03: adapters stay in services/ (in-place rewrite preserves import convention)"
  - "D-04: max_completion_tokens defaults to config.defaultMaxCompletionTokens (4096) when omitted"
  - "D-05: first-error only — path[0] maps to OpenAI error.param"
  - "Phase 1 wires only cerebrasAdapter in adapterMap; groqAdapter exists but routes in Phase 2"
  - "ChatCompletionCreateParamsNonStreaming imported from @cerebras/cerebras_cloud_sdk/resources/chat (not top-level index)"
  - "Response cast to ChatCompletion.ChatCompletionResponse to narrow union type returned by create()"
metrics:
  duration: "~9 minutes"
  completed: "2026-06-05"
  tasks_completed: 3
  files_changed: 11
---

# Phase 1 Plan 01: Walking Skeleton Summary

**One-liner:** Non-streaming proxy pipeline with Bearer auth, Zod allowlist validation, logical alias registry, and Cerebras completion returning OpenAI-shaped responses.

## What Was Built

The walking skeleton proves the complete downstream->upstream->downstream path works:

1. `config.ts` — All `process.env` reads centralized here; `required()` helper throws on startup for missing mandatory keys (PERSONAL_PROXY_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY).
2. `types.ts` — Old streaming `AIService` interface replaced with `ProviderAdapter`, `CompletionParams`, `ChatCompletionResult`. Adapters now return typed non-streaming completions.
3. `model-registry.ts` — Parses `MODEL_REGISTRY_JSON` once at load; exposes `resolveUpstreamModel`, `isKnownAlias`, `listAliases`.
4. `request-schema.ts` — Zod v4 `z.strictObject` schema rejects all non-allowlisted fields before any upstream call. `validateChatCompletion` returns first-error with `param` field.
5. `services/cerebras.ts` — Rewrites the prototype streaming adapter as a clean non-streaming `ProviderAdapter`. Removes `as any` cast (uses `ChatCompletionCreateParamsNonStreaming`). Strips `time_info` and `reasoning` structurally via field-by-field construction.
6. `services/groq.ts` — Also rewritten as `ProviderAdapter` with groq-sdk v1.2.1 and `maxRetries:0`. Not yet wired in index.ts (Phase 2 round-robin will wire it).
7. `index.ts` — Full rewrite: `openaiError` helper, `extractBearerToken` + `verifyToken` with `timingSafeEqual`, pipeline (auth -> Zod -> alias check -> default inject -> adapter -> alias rewrite), `/health` (no auth), `/v1/models` (auth), `/v1/chat/completions` (full pipeline), 404 catch-all.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ChatCompletionCreateParamsNonStreaming not exported at top-level of cerebras SDK**
- **Found during:** Task 3 (TypeScript typecheck)
- **Issue:** `import type { ChatCompletionCreateParamsNonStreaming } from '@cerebras/cerebras_cloud_sdk'` fails — the type is only re-exported from `@cerebras/cerebras_cloud_sdk/resources/chat`, not the package root.
- **Fix:** Changed import to subpath: `from '@cerebras/cerebras_cloud_sdk/resources/chat'`. Also added import of `ChatCompletion` to narrow the union return type of `create()` via `as ChatCompletion.ChatCompletionResponse` cast.
- **Files modified:** `services/cerebras.ts`
- **Note:** The RESEARCH.md pattern used `from "@cerebras/cerebras_cloud_sdk"` which is incorrect for SDK v1.64.1. The subpath import is the working form.

**2. [Rule 3 - Blocking] services/groq.ts broke TypeScript after types.ts replacement**
- **Found during:** Task 3 (TypeScript typecheck)
- **Issue:** `services/groq.ts` still imported `AIService` and `ChatMessage` which no longer exist in `types.ts`. TypeScript would not compile.
- **Fix:** Rewrote `services/groq.ts` in-place as a `groqAdapter` implementing `ProviderAdapter`. This was already in the plan scope (D-01: both adapters) but assigned to Task 2 implementation; moving it here resolved the blocking error.
- **Files modified:** `services/groq.ts`

**3. [Rule 3 - Blocking] Unit tests needed env vars for config.ts to load**
- **Found during:** Task 2 (TDD GREEN phase)
- **Issue:** `config.ts` `required()` throws at module load when env vars are missing. Tests importing `model-registry` (which imports `config`) failed with "Required env var PERSONAL_PROXY_API_KEY is not set". The worktree does not copy gitignored `.env` from the main checkout.
- **Fix:** Created `.env.test` with dummy placeholder values; tests run with `bun --env-file=.env.test test`. Unit tests don't make real upstream calls so fake values are safe.
- **Files created:** `.env.test`

## TDD Gate Compliance

Task 2 followed TDD (RED/GREEN):
- RED commit: `31749aa` — `test(01-01): add failing tests for model registry and request validation` — 0 pass / 1 fail (module not found as expected)
- GREEN commit: `e318a88` — `feat(01-01): model registry, Zod validation, Cerebras adapter` — 8 pass / 0 fail

## Known Stubs

None. `groqAdapter` in `services/groq.ts` is a complete implementation intentionally not wired into `index.ts` `adapterMap` for Phase 1. Phase 2 round-robin router will add it. This is by design (D-01 + plan task 3 discretion).

## Threat Flags

None. All endpoints match the plan's threat model. No new auth paths, file access patterns, or schema changes at trust boundaries introduced beyond what the threat register covers.

## Self-Check

Files created: config.ts, model-registry.ts, request-schema.ts, request-schema.test.ts, .env.test — all FOUND.

Files modified: package.json (groq-sdk ^1.2.1, no cerebras), bun.lock, types.ts (ProviderAdapter/CompletionParams/ChatCompletionResult), index.ts (timingSafeEqual + /v1/chat/completions + isKnownAlias + no getNextService), services/cerebras.ts (maxRetries:0 + typed cast + no as any), services/groq.ts (groqAdapter ProviderAdapter) — all VERIFIED.

Commits:
- 1976a79: feat(01-01): dependency cleanup, config module, core types
- 31749aa: test(01-01): add failing tests for model registry and request validation
- e318a88: feat(01-01): model registry, Zod validation, Cerebras adapter
- 9e49be6: feat(01-01): wire end-to-end pipeline in index.ts, fix cerebras/groq adapters

TypeScript: bunx tsc --noEmit — clean (0 errors).
Unit tests: bun --env-file=.env.test test request-schema.test.ts — 8 pass / 0 fail.

## Self-Check: PASSED
