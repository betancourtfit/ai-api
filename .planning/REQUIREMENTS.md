# Requirements: bun-ai-api OpenAI-Compatible Proxy

**Defined:** 2026-06-04
**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.

## v1 Requirements

### Infrastructure & Dependencies

- [x] **INFRA-01**: groq-sdk upgraded to ^1.2.1 (current pin ^0.37.0 is a major version behind)
- [x] **INFRA-02**: `cerebras` CLI binary package removed from dependencies (~40MB dead weight, not imported)
- [x] **INFRA-03**: Both SDK clients initialized with `maxRetries: 0` (SDK auto-retries fight proxy failover)
- [x] **INFRA-04**: Zod v4 (`^4.4.3`) installed for request validation
- [x] **INFRA-05**: Config module loads all env vars with validation and typed exports — no process.env spread across files

### Authentication

- [x] **AUTH-01**: Proxy rejects requests missing `Authorization: Bearer <key>` header with 401 and OpenAI-shaped error body
- [x] **AUTH-02**: Proxy rejects requests with invalid proxy key with 401 and OpenAI-shaped error body
- [x] **AUTH-03**: Key comparison uses constant-time comparison (`crypto.timingSafeEqual`) not string equality
- [x] **AUTH-04**: Auth middleware never logs or echoes the Authorization header value

### OpenAI-Compatible Endpoints

- [x] **EP-01**: `POST /v1/chat/completions` accepts and processes non-streaming chat completion requests
- [x] **EP-02**: `POST /v1/chat/completions` accepts and processes streaming chat completion requests (`"stream": true`)
- [x] **EP-03**: `GET /v1/models` returns logical proxy aliases in OpenAI list format (`{ "object": "list", "data": [...] }`)
- [x] **EP-04**: `GET /health` returns liveness response (no auth required)
- [x] **EP-05**: `GET /ready` returns readiness status supporting degraded mode (one provider down → `"mode": "degraded"`)
- [x] **EP-06**: `GET /internal/providers/status` returns provider state (auth required, controlled by env flag)
- [x] **EP-07**: Old `/chat` endpoint removed

### Request Contract & Validation

- [x] **VALID-01**: `model` field validated against logical model registry; unknown aliases return 400
- [x] **VALID-02**: `messages` field required; missing returns 400
- [x] **VALID-03**: Allowlisted fields forwarded: `model`, `messages`, `temperature`, `top_p`, `max_completion_tokens`, `stream`, `stop`, `seed`
- [x] **VALID-04**: Unsupported fields rejected with 400 before reaching any upstream provider: `logprobs`, `logit_bias`, `top_logprobs`
- [x] **VALID-05**: `messages[].name` field rejected with 400
- [x] **VALID-06**: `n != 1` (or `n > 1`) rejected with 400
- [x] **VALID-07**: Unknown/unlisted request fields rejected with 400 (strict allowlist, no silent pass-through)

### Logical Model Registry

- [x] **REG-01**: Model registry loaded from `MODEL_REGISTRY_JSON` env var
- [x] **REG-02**: Initial alias `gpt-oss-120b-balanced` maps to `gpt-oss-120b` (Cerebras) and `openai/gpt-oss-120b` (Groq)
- [x] **REG-03**: A logical alias only routes to providers where that alias has a mapping
- [x] **REG-04**: `GET /v1/models` returns logical alias IDs only — never raw provider model IDs

### Provider Routing & State

- [x] **ROUTE-01**: In-memory `ProviderState` tracks per-provider: enabled, configured, healthy, cooldownUntil, consecutiveFailures, lastStatusCode, rateLimitSnapshot
- [x] **ROUTE-02**: Provider eligibility check: configured AND enabled AND not in cooldown AND alias maps to provider
- [x] **ROUTE-03**: Stateful round-robin selects among eligible providers; cursor advances after each selection
- [x] **ROUTE-04**: On provider failure, try next eligible provider before returning error to client
- [x] **ROUTE-05**: Failover attempted for: 408, 429, 498, 500, 502, 503, 504
- [x] **ROUTE-06**: No failover for: 400, 401, 403, 404, 413, 422 (these indicate client or config errors)
- [x] **ROUTE-07**: When no eligible provider exists, return 503 with OpenAI-shaped error body
- [x] **ROUTE-08**: Provider state module exports `resetForTesting()` for test isolation

### Rate-Limit & Cooldown

- [x] **RL-01**: Cerebras rate-limit headers parsed from each response: `x-ratelimit-remaining-requests-day`, `x-ratelimit-remaining-tokens-minute`, `x-ratelimit-reset-requests-day`, `x-ratelimit-reset-tokens-minute` (float seconds format)
- [x] **RL-02**: Groq rate-limit headers parsed from each response: `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens` (duration string format e.g. `"2m59.56s"`), `retry-after` (seconds, 429 only)
- [x] **RL-03**: Groq and Cerebras use separate header parsers (formats differ — cannot share a generic parser)
- [x] **RL-04**: On 429, cooldown calculated as `max(retryAfter, resetTokensSeconds, DEFAULT_COOLDOWN_SECONDS)` and provider marked unavailable until then
- [x] **RL-05**: Provider returns to eligible rotation automatically when `Date.now() >= cooldownUntil`
- [x] **RL-06**: Groq 498 ("Flex Tier Capacity Exceeded") treated as failover trigger (same as 429)
- [x] **RL-07**: Cooldown events logged with provider, reason, and expiration time

### Streaming Relay

- [x] **STREAM-01**: `POST /v1/chat/completions` with `"stream": true` returns `Content-Type: text/event-stream`
- [x] **STREAM-02**: SSE relay implemented as async generator — no response buffering
- [x] **STREAM-03**: `server.timeout(req, 0)` called before returning streaming Response (prevents Bun 10s idle timeout killing quiet LLM streams)
- [x] **STREAM-04**: `firstChunkSent` flag set before first chunk yield; no failover attempted after first chunk sent
- [x] **STREAM-05**: Upstream abort signal connected to downstream client disconnect
- [x] **STREAM-06**: Final `data: [DONE]\n\n` sentinel preserved in relay
- [x] **STREAM-07**: Each chunk normalized inline (model rewrite, reasoning strip) before yielding — not post-stream

### Response Normalization

- [x] **NORM-01**: `model` field rewritten to logical proxy alias in non-streaming responses
- [x] **NORM-02**: `model` field rewritten to logical proxy alias in every streaming chunk
- [x] **NORM-03**: Cerebras `choices[*].message.reasoning` stripped from non-streaming responses
- [x] **NORM-04**: Cerebras `choices[*].reasoning_logprobs` stripped
- [x] **NORM-05**: Cerebras `time_info` top-level field stripped
- [x] **NORM-06**: Cerebras `delta.reasoning` stripped from streaming chunks
- [x] **NORM-07**: Groq provider-specific fields stripped (`x_groq`, `usage_breakdown`)
- [x] **NORM-08**: `usage` present in non-streaming responses (`prompt_tokens`, `completion_tokens`, `total_tokens`)
- [x] **NORM-09**: `object` field exact: `"chat.completion"` non-streaming, `"chat.completion.chunk"` streaming
- [x] **NORM-10**: Error responses always shaped as `{ "error": { "message", "type", "code", "param" } }` — never flat

### Observability

- [x] **OBS-01**: `X-Request-ID` header returned on every response (UUID generated per request)
- [x] **OBS-02**: Structured JSON log per request: request ID, timestamp, route, logical alias, chosen provider, upstream model ID, attempt number, streaming enabled, status code, latency, failover reason
- [x] **OBS-03**: Cooldown and failover events logged with provider and reason
- [x] **OBS-04**: API keys, Authorization headers, full prompts, full responses, reasoning content never logged
- [x] **OBS-05**: Optional `X-LLM-Provider` response header (controlled by `EXPOSE_PROVIDER_HEADER` env, default false)

### Tests

- [x] **TEST-01**: Alternating provider selection — consecutive requests alternate Cerebras/Groq
- [x] **TEST-02**: Cooldown behavior — 429 from provider triggers cooldown, subsequent requests go to alternate
- [x] **TEST-03**: Provider recovery — provider returns to rotation after cooldown expires
- [x] **TEST-04**: Failover on transient errors — 500/502/503/504 trigger failover to alternate
- [x] **TEST-05**: Both-provider exhaustion — returns 503 with OpenAI error body when no eligible provider
- [x] **TEST-06**: Invalid auth — missing or wrong key returns 401 with OpenAI error body
- [x] **TEST-07**: Unknown alias — unknown model name returns 400 with OpenAI error body
- [x] **TEST-08**: Unsupported field rejection — `logprobs`, `n=2`, `messages[].name` return 400
- [x] **TEST-09**: Non-streaming completion — end-to-end response shape validated (id, object, model, choices, usage)
- [x] **TEST-10**: Streaming relay — SSE format validated, `data: [DONE]` present, no buffering
- [x] **TEST-11**: Model field normalization — upstream provider model ID rewritten to logical alias in responses
- [x] **TEST-12**: Provider state reset between tests (`resetForTesting()` called in `beforeEach`)

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
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| INFRA-04 | Phase 1 | Complete |
| INFRA-05 | Phase 1 | Complete |
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 1 | Complete |
| AUTH-04 | Phase 1 | Complete |
| EP-04 | Phase 1 | Complete |
| EP-07 | Phase 1 | Complete |
| VALID-01 | Phase 1 | Complete |
| VALID-02 | Phase 1 | Complete |
| VALID-03 | Phase 1 | Complete |
| VALID-04 | Phase 1 | Complete |
| VALID-05 | Phase 1 | Complete |
| VALID-06 | Phase 1 | Complete |
| VALID-07 | Phase 1 | Complete |
| REG-01 | Phase 1 | Complete |
| REG-02 | Phase 1 | Complete |
| REG-03 | Phase 1 | Complete |
| REG-04 | Phase 1 | Complete |
| ROUTE-01 | Phase 2 | Complete |
| ROUTE-02 | Phase 2 | Complete |
| ROUTE-03 | Phase 2 | Complete |
| ROUTE-04 | Phase 2 | Complete |
| ROUTE-05 | Phase 2 | Complete |
| ROUTE-06 | Phase 2 | Complete |
| ROUTE-07 | Phase 2 | Complete |
| ROUTE-08 | Phase 2 | Complete |
| RL-01 | Phase 2 | Complete |
| RL-02 | Phase 2 | Complete |
| RL-03 | Phase 2 | Complete |
| RL-04 | Phase 2 | Complete |
| RL-05 | Phase 2 | Complete |
| RL-06 | Phase 2 | Complete |
| RL-07 | Phase 2 | Complete |
| STREAM-01 | Phase 2 | Complete |
| STREAM-02 | Phase 2 | Complete |
| STREAM-03 | Phase 2 | Complete |
| STREAM-04 | Phase 2 | Complete |
| STREAM-05 | Phase 2 | Complete |
| STREAM-06 | Phase 2 | Complete |
| STREAM-07 | Phase 2 | Complete |
| EP-01 | Phase 2 | Complete |
| EP-02 | Phase 2 | Complete |
| EP-03 | Phase 2 | Complete |
| EP-05 | Phase 2 | Complete |
| EP-06 | Phase 2 | Complete |
| NORM-01 | Phase 3 | Complete |
| NORM-02 | Phase 3 | Complete |
| NORM-03 | Phase 3 | Complete |
| NORM-04 | Phase 3 | Complete |
| NORM-05 | Phase 3 | Complete |
| NORM-06 | Phase 3 | Complete |
| NORM-07 | Phase 3 | Complete |
| NORM-08 | Phase 3 | Complete |
| NORM-09 | Phase 3 | Complete |
| NORM-10 | Phase 3 | Complete |
| OBS-01 | Phase 3 | Complete |
| OBS-02 | Phase 3 | Complete |
| OBS-03 | Phase 3 | Complete |
| OBS-04 | Phase 3 | Complete |
| OBS-05 | Phase 3 | Complete |
| TEST-01 | Phase 3 | Complete |
| TEST-02 | Phase 3 | Complete |
| TEST-03 | Phase 3 | Complete |
| TEST-04 | Phase 3 | Complete |
| TEST-05 | Phase 3 | Complete |
| TEST-06 | Phase 3 | Complete |
| TEST-07 | Phase 3 | Complete |
| TEST-08 | Phase 3 | Complete |
| TEST-09 | Phase 3 | Complete |
| TEST-10 | Phase 3 | Complete |
| TEST-11 | Phase 3 | Complete |
| TEST-12 | Phase 3 | Complete |
| EXT-01 | v2 | Pending |
| EXT-02 | v2 | Pending |
| EXT-03 | v2 | Pending |
| EXT-04 | v2 | Pending |

**Coverage:**

- Total requirements: 80 (76 v1 + 4 v2)
- Mapped to implementation buckets: 80
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-04*
*Last updated: 2026-06-05 after Phase 2 completion — traceability updated*
