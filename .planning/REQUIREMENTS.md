# Requirements: bun-ai-api OpenAI-Compatible Proxy

**Defined:** 2026-06-04
**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.

## v1 Requirements

### Infrastructure & Dependencies

- [ ] **INFRA-01**: groq-sdk upgraded to ^1.2.1 (current pin ^0.37.0 is a major version behind)
- [ ] **INFRA-02**: `cerebras` CLI binary package removed from dependencies (~40MB dead weight, not imported)
- [ ] **INFRA-03**: Both SDK clients initialized with `maxRetries: 0` (SDK auto-retries fight proxy failover)
- [ ] **INFRA-04**: Zod v4 (`^4.4.3`) installed for request validation
- [ ] **INFRA-05**: Config module loads all env vars with validation and typed exports — no process.env spread across files

### Authentication

- [ ] **AUTH-01**: Proxy rejects requests missing `Authorization: Bearer <key>` header with 401 and OpenAI-shaped error body
- [ ] **AUTH-02**: Proxy rejects requests with invalid proxy key with 401 and OpenAI-shaped error body
- [ ] **AUTH-03**: Key comparison uses constant-time comparison (`crypto.timingSafeEqual`) not string equality
- [ ] **AUTH-04**: Auth middleware never logs or echoes the Authorization header value

### OpenAI-Compatible Endpoints

- [ ] **EP-01**: `POST /v1/chat/completions` accepts and processes non-streaming chat completion requests
- [ ] **EP-02**: `POST /v1/chat/completions` accepts and processes streaming chat completion requests (`"stream": true`)
- [ ] **EP-03**: `GET /v1/models` returns logical proxy aliases in OpenAI list format (`{ "object": "list", "data": [...] }`)
- [ ] **EP-04**: `GET /health` returns liveness response (no auth required)
- [ ] **EP-05**: `GET /ready` returns readiness status supporting degraded mode (one provider down → `"mode": "degraded"`)
- [ ] **EP-06**: `GET /internal/providers/status` returns provider state (auth required, controlled by env flag)
- [ ] **EP-07**: Old `/chat` endpoint removed

### Request Contract & Validation

- [ ] **VALID-01**: `model` field validated against logical model registry; unknown aliases return 400
- [ ] **VALID-02**: `messages` field required; missing returns 400
- [ ] **VALID-03**: Allowlisted fields forwarded: `model`, `messages`, `temperature`, `top_p`, `max_completion_tokens`, `stream`, `stop`, `seed`
- [ ] **VALID-04**: Unsupported fields rejected with 400 before reaching any upstream provider: `logprobs`, `logit_bias`, `top_logprobs`
- [ ] **VALID-05**: `messages[].name` field rejected with 400
- [ ] **VALID-06**: `n != 1` (or `n > 1`) rejected with 400
- [ ] **VALID-07**: Unknown/unlisted request fields rejected with 400 (strict allowlist, no silent pass-through)

### Logical Model Registry

- [ ] **REG-01**: Model registry loaded from `MODEL_REGISTRY_JSON` env var
- [ ] **REG-02**: Initial alias `gpt-oss-120b-balanced` maps to `gpt-oss-120b` (Cerebras) and `openai/gpt-oss-120b` (Groq)
- [ ] **REG-03**: A logical alias only routes to providers where that alias has a mapping
- [ ] **REG-04**: `GET /v1/models` returns logical alias IDs only — never raw provider model IDs

### Provider Routing & State

- [ ] **ROUTE-01**: In-memory `ProviderState` tracks per-provider: enabled, configured, healthy, cooldownUntil, consecutiveFailures, lastStatusCode, rateLimitSnapshot
- [ ] **ROUTE-02**: Provider eligibility check: configured AND enabled AND not in cooldown AND alias maps to provider
- [ ] **ROUTE-03**: Stateful round-robin selects among eligible providers; cursor advances after each selection
- [ ] **ROUTE-04**: On provider failure, try next eligible provider before returning error to client
- [ ] **ROUTE-05**: Failover attempted for: 408, 429, 498, 500, 502, 503, 504
- [ ] **ROUTE-06**: No failover for: 400, 401, 403, 404, 413, 422 (these indicate client or config errors)
- [ ] **ROUTE-07**: When no eligible provider exists, return 503 with OpenAI-shaped error body
- [ ] **ROUTE-08**: Provider state module exports `resetForTesting()` for test isolation

### Rate-Limit & Cooldown

- [ ] **RL-01**: Cerebras rate-limit headers parsed from each response: `x-ratelimit-remaining-requests-day`, `x-ratelimit-remaining-tokens-minute`, `x-ratelimit-reset-requests-day`, `x-ratelimit-reset-tokens-minute` (float seconds format)
- [ ] **RL-02**: Groq rate-limit headers parsed from each response: `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens` (duration string format e.g. `"2m59.56s"`), `retry-after` (seconds, 429 only)
- [ ] **RL-03**: Groq and Cerebras use separate header parsers (formats differ — cannot share a generic parser)
- [ ] **RL-04**: On 429, cooldown calculated as `max(retryAfter, resetTokensSeconds, DEFAULT_COOLDOWN_SECONDS)` and provider marked unavailable until then
- [ ] **RL-05**: Provider returns to eligible rotation automatically when `Date.now() >= cooldownUntil`
- [ ] **RL-06**: Groq 498 ("Flex Tier Capacity Exceeded") treated as failover trigger (same as 429)
- [ ] **RL-07**: Cooldown events logged with provider, reason, and expiration time

### Streaming Relay

- [ ] **STREAM-01**: `POST /v1/chat/completions` with `"stream": true` returns `Content-Type: text/event-stream`
- [ ] **STREAM-02**: SSE relay implemented as async generator — no response buffering
- [ ] **STREAM-03**: `server.timeout(req, 0)` called before returning streaming Response (prevents Bun 10s idle timeout killing quiet LLM streams)
- [ ] **STREAM-04**: `firstChunkSent` flag set before first chunk yield; no failover attempted after first chunk sent
- [ ] **STREAM-05**: Upstream abort signal connected to downstream client disconnect
- [ ] **STREAM-06**: Final `data: [DONE]\n\n` sentinel preserved in relay
- [ ] **STREAM-07**: Each chunk normalized inline (model rewrite, reasoning strip) before yielding — not post-stream

### Response Normalization

- [ ] **NORM-01**: `model` field rewritten to logical proxy alias in non-streaming responses
- [ ] **NORM-02**: `model` field rewritten to logical proxy alias in every streaming chunk
- [ ] **NORM-03**: Cerebras `choices[*].message.reasoning` stripped from non-streaming responses
- [ ] **NORM-04**: Cerebras `choices[*].reasoning_logprobs` stripped
- [ ] **NORM-05**: Cerebras `time_info` top-level field stripped
- [ ] **NORM-06**: Cerebras `delta.reasoning` stripped from streaming chunks
- [ ] **NORM-07**: Groq provider-specific fields stripped (`x_groq`, `usage_breakdown`)
- [ ] **NORM-08**: `usage` present in non-streaming responses (`prompt_tokens`, `completion_tokens`, `total_tokens`)
- [ ] **NORM-09**: `object` field exact: `"chat.completion"` non-streaming, `"chat.completion.chunk"` streaming
- [ ] **NORM-10**: Error responses always shaped as `{ "error": { "message", "type", "code", "param" } }` — never flat

### Observability

- [ ] **OBS-01**: `X-Request-ID` header returned on every response (UUID generated per request)
- [ ] **OBS-02**: Structured JSON log per request: request ID, timestamp, route, logical alias, chosen provider, upstream model ID, attempt number, streaming enabled, status code, latency, failover reason
- [ ] **OBS-03**: Cooldown and failover events logged with provider and reason
- [ ] **OBS-04**: API keys, Authorization headers, full prompts, full responses, reasoning content never logged
- [ ] **OBS-05**: Optional `X-LLM-Provider` response header (controlled by `EXPOSE_PROVIDER_HEADER` env, default false)

### Tests

- [ ] **TEST-01**: Alternating provider selection — consecutive requests alternate Cerebras/Groq
- [ ] **TEST-02**: Cooldown behavior — 429 from provider triggers cooldown, subsequent requests go to alternate
- [ ] **TEST-03**: Provider recovery — provider returns to rotation after cooldown expires
- [ ] **TEST-04**: Failover on transient errors — 500/502/503/504 trigger failover to alternate
- [ ] **TEST-05**: Both-provider exhaustion — returns 503 with OpenAI error body when no eligible provider
- [ ] **TEST-06**: Invalid auth — missing or wrong key returns 401 with OpenAI error body
- [ ] **TEST-07**: Unknown alias — unknown model name returns 400 with OpenAI error body
- [ ] **TEST-08**: Unsupported field rejection — `logprobs`, `n=2`, `messages[].name` return 400
- [ ] **TEST-09**: Non-streaming completion — end-to-end response shape validated (id, object, model, choices, usage)
- [ ] **TEST-10**: Streaming relay — SSE format validated, `data: [DONE]` present, no buffering
- [ ] **TEST-11**: Model field normalization — upstream provider model ID rewritten to logical alias in responses
- [ ] **TEST-12**: Provider state reset between tests (`resetForTesting()` called in `beforeEach`)

## v2 Requirements

### Extended Request Fields

- **EXT-01**: `frequency_penalty` forwarded after cross-provider compatibility confirmed
- **EXT-02**: `presence_penalty` forwarded after cross-provider compatibility confirmed
- **EXT-03**: `tools` / `tool_choice` / `parallel_tool_calls` forwarded after cross-provider tests
- **EXT-04**: `response_format` forwarded after cross-provider tests

## Out of Scope

| Feature | Reason |
|---------|--------|
| `/v1/responses` | Requires provider-specific adaptation layer; Cerebras doesn't document it |
| `/v1/embeddings` | Not needed for current use case |
| `/v1/audio/*`, `/v1/images/*` | Not needed |
| `/v1/files`, `/v1/batches` | Not needed |
| Legacy `/v1/completions` | Clients use Chat Completions |
| Tool calling (v1) | Defer until tested across both providers |
| Structured outputs (v1) | Defer until tested across both providers |
| Persistent conversation storage | Stateless proxy is sufficient |
| Quality-based / semantic routing | MVP uses round-robin only |
| Billing, multi-user admin | Personal use — single proxy key |
| Multiple keys per provider | Out of MVP scope |
| Distributed coordination across replicas | Single instance |
| Automatic key rotation | Out of MVP scope |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Pending |
| INFRA-02 | Phase 1 | Pending |
| INFRA-03 | Phase 1 | Pending |
| INFRA-04 | Phase 1 | Pending |
| INFRA-05 | Phase 1 | Pending |
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 1 | Pending |
| AUTH-04 | Phase 1 | Pending |
| EP-04 | Phase 1 | Pending |
| EP-07 | Phase 1 | Pending |
| VALID-01 | Phase 1 | Pending |
| VALID-02 | Phase 1 | Pending |
| VALID-03 | Phase 1 | Pending |
| VALID-04 | Phase 1 | Pending |
| VALID-05 | Phase 1 | Pending |
| VALID-06 | Phase 1 | Pending |
| VALID-07 | Phase 1 | Pending |
| REG-01 | Phase 1 | Pending |
| REG-02 | Phase 1 | Pending |
| REG-03 | Phase 1 | Pending |
| REG-04 | Phase 1 | Pending |
| ROUTE-01 | Phase 2 | Pending |
| ROUTE-02 | Phase 2 | Pending |
| ROUTE-03 | Phase 2 | Pending |
| ROUTE-04 | Phase 2 | Pending |
| ROUTE-05 | Phase 2 | Pending |
| ROUTE-06 | Phase 2 | Pending |
| ROUTE-07 | Phase 2 | Pending |
| ROUTE-08 | Phase 2 | Pending |
| RL-01 | Phase 2 | Pending |
| RL-02 | Phase 2 | Pending |
| RL-03 | Phase 2 | Pending |
| RL-04 | Phase 2 | Pending |
| RL-05 | Phase 2 | Pending |
| RL-06 | Phase 2 | Pending |
| RL-07 | Phase 2 | Pending |
| STREAM-01 | Phase 2 | Pending |
| STREAM-02 | Phase 2 | Pending |
| STREAM-03 | Phase 2 | Pending |
| STREAM-04 | Phase 2 | Pending |
| STREAM-05 | Phase 2 | Pending |
| STREAM-06 | Phase 2 | Pending |
| STREAM-07 | Phase 2 | Pending |
| EP-01 | Phase 2 | Pending |
| EP-02 | Phase 2 | Pending |
| EP-03 | Phase 2 | Pending |
| EP-05 | Phase 2 | Pending |
| EP-06 | Phase 2 | Pending |
| NORM-01 | Phase 3 | Pending |
| NORM-02 | Phase 3 | Pending |
| NORM-03 | Phase 3 | Pending |
| NORM-04 | Phase 3 | Pending |
| NORM-05 | Phase 3 | Pending |
| NORM-06 | Phase 3 | Pending |
| NORM-07 | Phase 3 | Pending |
| NORM-08 | Phase 3 | Pending |
| NORM-09 | Phase 3 | Pending |
| NORM-10 | Phase 3 | Pending |
| OBS-01 | Phase 3 | Pending |
| OBS-02 | Phase 3 | Pending |
| OBS-03 | Phase 3 | Pending |
| OBS-04 | Phase 3 | Pending |
| OBS-05 | Phase 3 | Pending |
| TEST-01 | Phase 3 | Pending |
| TEST-02 | Phase 3 | Pending |
| TEST-03 | Phase 3 | Pending |
| TEST-04 | Phase 3 | Pending |
| TEST-05 | Phase 3 | Pending |
| TEST-06 | Phase 3 | Pending |
| TEST-07 | Phase 3 | Pending |
| TEST-08 | Phase 3 | Pending |
| TEST-09 | Phase 3 | Pending |
| TEST-10 | Phase 3 | Pending |
| TEST-11 | Phase 3 | Pending |
| TEST-12 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 76 total (file header said 56 — body count is authoritative)
- Mapped to phases: 76
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-04*
*Last updated: 2026-06-04 after roadmap creation — traceability populated*
