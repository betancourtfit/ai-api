# External Integrations

**Analysis Date:** 2026-06-04

## APIs & External Services

**AI Inference — Cerebras:**
- Service: Cerebras Inference (`https://api.cerebras.ai/v1`)
- SDK/Client: `@cerebras/cerebras_cloud_sdk` ^1.59.0
- Implementation: `services/cerebras.ts`
- Auth: `CEREBRAS_API_KEY` (Bearer token; SDK reads it from env automatically)
- Model in use: `qwen-3-32b`
- Usage: streaming chat completions via `cerebras.chat.completions.create({ stream: true })`
- Optional header: `X-Cerebras-Version-Patch: 2` (configurable via `CEREBRAS_VERSION_PATCH`)
- Rate-limit headers captured (per design spec): `x-ratelimit-limit-requests-day`, `x-ratelimit-limit-tokens-minute`, `x-ratelimit-remaining-requests-day`, `x-ratelimit-remaining-tokens-minute`, `x-ratelimit-reset-requests-day`, `x-ratelimit-reset-tokens-minute`

**AI Inference — Groq:**
- Service: GroqCloud (`https://api.groq.com/openai/v1`)
- SDK/Client: `groq-sdk` ^0.37.0
- Implementation: `services/groq.ts`
- Auth: `GROQ_API_KEY` (Bearer token; SDK reads it from env automatically)
- Model in use: `moonshotai/kimi-k2-instruct-0905`
- Usage: streaming chat completions via `groq.chat.completions.create({ stream: true })`
- Rate-limit headers captured (per design spec): `retry-after`, `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`

## Data Storage

**Databases:**
- None — this is a stateless proxy; all state is in-memory per design spec

**File Storage:**
- None

**Caching:**
- None currently implemented; design spec calls for in-memory provider state (cooldown tracking, round-robin cursor) — not a distributed cache

## Authentication & Identity

**Downstream (clients calling this proxy):**
- Proxy key: `PERSONAL_PROXY_API_KEY` (Bearer token)
- Clients must send `Authorization: Bearer ${PERSONAL_PROXY_API_KEY}`
- Missing or invalid credentials return HTTP `401`
- Constant-time comparison recommended per design spec

**Upstream (this proxy calling providers):**
- Cerebras: `Authorization: Bearer ${CEREBRAS_API_KEY}` — managed by `@cerebras/cerebras_cloud_sdk`
- Groq: `Authorization: Bearer ${GROQ_API_KEY}` — managed by `groq-sdk`
- Keys are never forwarded to downstream clients

## Monitoring & Observability

**Error Tracking:**
- None currently implemented

**Logs:**
- `console.log` used in `index.ts` (e.g., `console.log(\`Using service: ${service?.name}\`)`)
- Design spec (`refactor.md`) calls for structured logs including: request ID, timestamp, provider chosen, upstream model, status code, latency, failover reason, token usage, quota headers
- `X-Request-ID` response header planned per design spec
- Secrets and full prompts must never be logged

## CI/CD & Deployment

**Hosting:**
- Docker container — `Dockerfile` present, uses `oven/bun:1.1.29` base image
- Designed for EasyPanel or any reverse-proxy host (health check endpoint `/` and `/health` provided)
- Production port: `3001` (Dockerfile `ENV PORT=3001` and `EXPOSE 3001`)

**CI Pipeline:**
- None detected

## Environment Configuration

**Required env vars (currently wired in source):**
- `PORT` — HTTP server port (default `3000`; Dockerfile sets `3001`)
- `HOSTNAME` — bind address (default `0.0.0.0`)

**Required env vars (by design spec in `refactor.md`):**
- `CEREBRAS_API_KEY` — Cerebras Inference API key
- `GROQ_API_KEY` — GroqCloud API key
- `PERSONAL_PROXY_API_KEY` — downstream client authentication key
- `CEREBRAS_BASE_URL` — override Cerebras base URL (default `https://api.cerebras.ai/v1`)
- `GROQ_BASE_URL` — override Groq base URL (default `https://api.groq.com/openai/v1`)
- `LOG_LEVEL` — logging verbosity (recommended `info`)
- `REQUEST_TIMEOUT_MS` — upstream request timeout (recommended `120000`)
- `MAX_REQUEST_BODY_BYTES` — request body size limit (recommended `1048576`)
- `CEREBRAS_VERSION_PATCH` — Cerebras API version patch header value (default `2`)
- `ROUTING_STRATEGY` — routing algorithm (default `round_robin`)
- `PROVIDER_ORDER` — comma-separated provider order (default `cerebras,groq`)
- `DEFAULT_COOLDOWN_SECONDS` — fallback cooldown on 429 (default `60`)
- `MAX_PROVIDER_ATTEMPTS_PER_REQUEST` — max providers to try per request (default `2`)
- `MODEL_REGISTRY_JSON` — JSON map of logical alias to provider model IDs
- `EXPOSE_PROVIDER_HEADER` — whether to send `X-LLM-Provider` response header (default `false`)
- `ENABLE_INTERNAL_STATUS_ENDPOINT` — enable `GET /internal/providers/status` (default `true`)

**Secrets location:**
- `.env` and `.env.local` files present at repo root (gitignored)
- Bun loads these automatically at startup; no dotenv library used

## Webhooks & Callbacks

**Incoming:**
- None — this service is a pure HTTP request/response proxy

**Outgoing:**
- None — upstream calls to Cerebras and Groq are synchronous request/response with optional SSE streaming; no webhook pattern used

## Exposed HTTP API (This Service)

The proxy exposes (or plans to expose) the following endpoints per `refactor.md`:

| Method | Endpoint | Status |
|--------|----------|--------|
| `POST` | `/chat` | Implemented (current) — streams SSE from round-robin provider |
| `GET` | `/` | Implemented — health check returns `"ok"` |
| `GET` | `/health` | Implemented — health check returns `"ok"` |
| `POST` | `/v1/chat/completions` | Planned (OpenAI-compatible refactor) |
| `GET` | `/v1/models` | Planned |
| `GET` | `/ready` | Planned |
| `GET` | `/internal/providers/status` | Planned (protected by `PERSONAL_PROXY_API_KEY`) |

The design intent is a fully OpenAI-compatible proxy (`/v1/chat/completions`, `/v1/models`) that existing OpenAI SDK clients can target by changing only `base_url`, API key, and model alias.

---

*Integration audit: 2026-06-04*
