# bun-ai-api — OpenAI-Compatible Proxy for Cerebras + Groq

## What This Is

Personal middleware API that exposes a stable OpenAI-compatible endpoint (`/v1/chat/completions`, `/v1/models`) and routes requests across two upstream inference providers: Cerebras and Groq. Existing clients switch from direct OpenAI calls by changing only `base_url` and API key — no other code changes. The refactor transforms a prototype custom-endpoint server into a spec-compliant proxy with stateful round-robin routing, cooldown management, and full OpenAI wire compatibility.

## Core Value

Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.

## Requirements

### Validated

- ✓ Round-robin routing between Cerebras and Groq — existing
- ✓ Streaming SSE responses from providers — existing
- ✓ Provider SDK integration (groq-sdk, cerebras_cloud_sdk) — existing
- ✓ Basic liveness endpoint (`/health`) — existing
- ✓ Bearer auth middleware — 401 on missing/invalid credentials — Validated in Phase 1: Foundation
- ✓ Constant-time key comparison; secrets never logged — Validated in Phase 1: Foundation
- ✓ `POST /v1/chat/completions` — OpenAI wire-compatible, non-streaming (live-tested via Cerebras) — Validated in Phase 1: Foundation
- ✓ `GET /v1/models` — returns logical proxy aliases only — Validated in Phase 1: Foundation (delivered early; EP-03 was Phase 2)
- ✓ Allowlist-based field validation (Cerebras + Groq intersection) — Validated in Phase 1: Foundation
- ✓ Reject `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, `n != 1` — Validated in Phase 1: Foundation
- ✓ Logical model alias resolution (`gpt-oss-120b-balanced` → provider-specific ID) — Validated in Phase 1: Foundation
- ✓ Return 400 for unknown logical aliases — Validated in Phase 1: Foundation
- ✓ `POST /v1/chat/completions` — streaming (SSE relay, `Content-Type: text/event-stream`) — Validated in Phase 2: Routing & Streaming
- ✓ `GET /ready` — readiness check supporting degraded mode — Validated in Phase 2: Routing & Streaming
- ✓ `GET /internal/providers/status` — protected diagnostics endpoint — Validated in Phase 2: Routing & Streaming
- ✓ Stateful round-robin among currently eligible providers — Validated in Phase 2: Routing & Streaming
- ✓ Provider eligibility: configured + enabled + not in cooldown + alias maps to provider — Validated in Phase 2: Routing & Streaming
- ✓ Failover to alternate provider on 408, 429, 498, 500–504 — Validated in Phase 2: Routing & Streaming
- ✓ No failover after first streaming chunk sent — Validated in Phase 2: Routing & Streaming
- ✓ Parse Cerebras + Groq rate-limit headers, `retry-after` — Validated in Phase 2: Routing & Streaming
- ✓ On 429: cooldown from reset headers, try alternate; recovery after expiry — Validated in Phase 2: Routing & Streaming
- ✓ Rewrite `model` to logical alias; strip Cerebras `reasoning`/`reasoning_logprobs`/`time_info` and Groq telemetry (allowlist-rebuild normalizer) — Validated in Phase 3: Full Compliance + Tests
- ✓ Optional `X-LLM-Provider` header (env-controlled, default off) — Validated in Phase 3: Full Compliance + Tests
- ✓ Structured JSON logs per request: request ID, provider, latency, status, failover reason — Validated in Phase 3: Full Compliance + Tests
- ✓ `X-Request-ID` response header (UUID) on every response — Validated in Phase 3: Full Compliance + Tests
- ✓ Never log: API keys, Authorization headers, prompts, responses, reasoning — Validated in Phase 3: Full Compliance + Tests
- ✓ Integration test suite (TEST-01..12): alternation, cooldown, recovery, failover, exhaustion, 401, 400, non-streaming + streaming end-to-end — Validated in Phase 3: Full Compliance + Tests

### Active

(none — all v1 requirements validated; milestone ready for completion)

### Out of Scope

- `/v1/responses`, `/v1/embeddings`, `/v1/audio/*`, `/v1/images/*`, `/v1/files`, `/v1/batches` — not needed, adds complexity
- Legacy `/v1/completions` — clients use Chat Completions
- Tool calling, `parallel_tool_calls`, `response_format` — defer until tested across both providers
- Structured outputs — same reason
- `frequency_penalty`, `presence_penalty` — defer until compatibility confirmed
- Persistent conversation storage — stateless proxy is sufficient
- Quality-based / semantic provider selection — out of MVP scope
- Billing, multi-user admin, multiple keys per provider — personal use only
- Distributed coordination across replicas — single instance

## Context

**Existing codebase:** `index.ts` (single file) with naive round-robin using index mod, custom `/chat` endpoint (not OpenAI-compatible), direct SDK calls. Two service files: `services/groq.ts`, `services/cerebras.ts`. No auth, no request validation, no cooldown.

**Refactor approach:** Wrap groq-sdk + cerebras_cloud_sdk behind OpenAI-compatible routes. Keep provider SDKs — they handle auth and HTTP to upstream. The compatibility layer lives in the proxy: route validation, round-robin state, response normalization, SSE relay.

**Structure:** Flat root-level files (no `src/` directory). The old `/chat` endpoint is removed.

**Model registry:** Single initial alias `gpt-oss-120b-balanced` → `gpt-oss-120b` (Cerebras) / `openai/gpt-oss-120b` (Groq). Configured via `MODEL_REGISTRY_JSON` env var.

## Constraints

- **Runtime**: Bun only — `Bun.serve()`, no Express; `bun test` for tests
- **SDK retention**: groq-sdk + cerebras_cloud_sdk stay; no raw HTTP proxy to upstream
- **Structure**: Files at root level (routes/, middleware/, etc. as directories at root)
- **Compatibility**: Public contract = intersection of reliable Cerebras + Groq capabilities
- **Secrets**: Never hardcode; never log; never expose to downstream clients

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep provider SDKs (groq-sdk, cerebras_cloud_sdk) | Wrapping is safer than reimplementing HTTP auth + error handling | — Pending |
| Flat root-level structure (no src/) | User preference; simpler for a single-service project | — Pending |
| Remove old /chat endpoint | Clean break; only /v1/* routes | — Pending |
| Tests in same phase as implementation | Spec requires coverage before expanding scope | — Pending |
| Stateful round-robin (not blind alternation) | Free-tier quotas replenish; temporary cooldown is correct behavior | — Pending |
| Intersection contract only (reject unlisted fields) | Prevents silent provider-specific behavior divergence | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-05 after Phase 3 (Full Compliance + Tests) completion — all v1 phases complete*
