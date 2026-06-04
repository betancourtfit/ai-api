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

### Active

**Authentication & Security**
- [ ] Bearer auth middleware — reject missing/invalid credentials with 401
- [ ] Constant-time key comparison; never log secrets or Authorization headers

**OpenAI-Compatible Endpoints**
- [ ] `POST /v1/chat/completions` — OpenAI wire-compatible, non-streaming
- [ ] `POST /v1/chat/completions` — streaming (SSE relay, `Content-Type: text/event-stream`)
- [ ] `GET /v1/models` — returns logical proxy aliases only (not raw provider model IDs)
- [ ] `GET /ready` — readiness check supporting degraded mode (one provider down)
- [ ] `GET /internal/providers/status` — protected diagnostics endpoint (optional, behind same auth)

**Request Contract**
- [ ] Allowlist-based field validation (intersection of Cerebras + Groq capabilities)
- [ ] Reject `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, `n != 1`
- [ ] Logical model alias resolution (`gpt-oss-120b-balanced` → provider-specific ID)
- [ ] Return 400 for unknown logical aliases

**Routing & State**
- [ ] Stateful round-robin among currently eligible providers (not blind alternation)
- [ ] Provider eligibility: configured + enabled + not in cooldown + alias maps to provider
- [ ] Failover to alternate provider on 408, 429, 498, 500–504
- [ ] No failover after first streaming chunk sent — preserve stream integrity

**Rate-Limit & Cooldown**
- [ ] Parse Cerebras rate-limit headers (day/minute limits)
- [ ] Parse Groq rate-limit headers + `retry-after`
- [ ] On 429: calculate cooldown from reset headers, mark provider unavailable, try alternate
- [ ] Provider returns to rotation after cooldown expires

**Response Normalization**
- [ ] Rewrite `model` field to logical proxy alias in all responses
- [ ] Strip Cerebras-specific fields: `choices[*].message.reasoning`, `choices[*].reasoning_logprobs`, `time_info`
- [ ] Strip Groq provider-specific telemetry
- [ ] Optional `X-LLM-Provider` header (env-controlled, default off)

**Observability**
- [ ] Structured JSON logs per request: request ID, provider chosen, latency, status, failover reason
- [ ] Return `X-Request-ID` response header (UUID)
- [ ] Never log: API keys, Authorization headers, full prompts, full responses, reasoning

**Tests**
- [ ] Alternating provider selection
- [ ] Cooldown behavior after 429
- [ ] Provider recovery after cooldown expires
- [ ] Failover to alternate on transient errors
- [ ] Both-provider exhaustion error
- [ ] Invalid auth returns 401
- [ ] Unknown alias returns 400
- [ ] Non-streaming completion end-to-end
- [ ] Streaming relay end-to-end

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
*Last updated: 2026-06-04 after initialization*
