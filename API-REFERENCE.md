# API Reference — bun-ai-api (OpenAI-Compatible Proxy)

Exact wire contract as implemented. Use this to reimplement or test the API.

---

## Authentication

All endpoints except `GET /health` and `GET /` require:

```
Authorization: Bearer <PERSONAL_PROXY_API_KEY>
```

**Missing or invalid token → 401:**
```json
{
  "error": {
    "message": "No authorization provided or invalid credentials.",
    "type": "invalid_request_error",
    "code": "missing_auth",
    "param": null
  }
}
```

**Proxy not configured (no key set in env) → 503:**
```json
{
  "error": {
    "message": "Proxy authentication is not configured.",
    "type": "server_error",
    "code": "proxy_not_configured",
    "param": null
  }
}
```

Every response includes:
```
X-Request-ID: <uuid-v4>
```

---

## Error Shape

All errors use OpenAI format:

```json
{
  "error": {
    "message": "<human-readable>",
    "type": "<error_type>",
    "code": "<error_code>",
    "param": "<field_name_or_null>"
  }
}
```

| HTTP | type | code | when |
|------|------|------|------|
| 400 | `invalid_request_error` | `invalid_request_error` | validation failed |
| 400 | `invalid_request_error` | `model_not_found` | unknown model alias |
| 401 | `invalid_request_error` | `missing_auth` | bad credentials |
| 404 | `invalid_request_error` | `not_found` | unknown route or disabled endpoint |
| 503 | `server_error` | `proxy_not_configured` | `PERSONAL_PROXY_API_KEY` not set |
| 503 | `server_error` | `no_provider_available` | all providers on cooldown |
| 4xx/5xx | `invalid_request_error` | `upstream_error` | non-retryable upstream failure |

---

## Endpoints

### GET /health
### GET /

**Auth:** none required.

**Response 200:**
```
ok
```
Plain text, no JSON.

---

### GET /ready

**Auth:** none required.

**Response 200 (fully ready):**
```json
{
  "ready": true,
  "mode": "ok",
  "eligibleProviders": ["cerebras", "groq"],
  "unavailableProviders": []
}
```

**Response 200 (degraded — one provider down or cooling down):**
```json
{
  "ready": true,
  "mode": "degraded",
  "eligibleProviders": ["cerebras"],
  "unavailableProviders": ["groq"]
}
```

**Response 503 (not configured — no proxy key):**
```json
{
  "ready": false,
  "mode": "not_configured",
  "eligibleProviders": [],
  "unavailableProviders": ["cerebras", "groq"]
}
```

`mode` values: `"ok"` | `"degraded"` | `"not_configured"`

Eligibility is determined per-model against the first alias in the registry. A provider is eligible when: configured (API key present), enabled, not in cooldown, and healthy.

---

### GET /v1/models

**Auth:** required.

**Response 200:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-oss-120b-balanced",
      "object": "model",
      "created": 0,
      "owned_by": "personal-proxy"
    }
  ]
}
```

Returns **logical proxy aliases only** — never upstream provider model IDs.

Available aliases are driven by `MODEL_REGISTRY_JSON` env var (default: `{"gpt-oss-120b-balanced":{"cerebras":"gpt-oss-120b","groq":"openai/gpt-oss-120b"}}`).

---

### POST /v1/chat/completions

**Auth:** required.  
**Content-Type:** `application/json`

#### Request schema

Strict allowlist — any field not in this list returns 400.

```ts
{
  model: string,                        // required — must be a known logical alias
  messages: Array<{                     // required — min 1 item
    role: "user" | "assistant" | "system",
    content: string
    // "name" field is NOT allowed
  }>,
  temperature?: number,                 // 0–2, optional
  top_p?: number,                       // 0–1, optional
  max_completion_tokens?: number,       // positive integer, optional (default: 4096)
  stream?: boolean,                     // optional
  stop?: string | string[],            // optional
  seed?: integer,                       // optional
  n?: 1,                               // optional; if present MUST be exactly 1
}
```

**Rejected fields** (return 400 with the offending field as `param`):
- `logprobs`, `log_probs`, `logit_bias`, `top_logprobs`
- `frequency_penalty`, `presence_penalty`
- `tools`, `tool_choice`, `parallel_tool_calls`
- `response_format`
- `messages[].name`
- `n` ≠ 1
- Any unrecognized field

**Body not valid JSON → 400:**
```json
{
  "error": {
    "message": "Request body must be valid JSON.",
    "type": "invalid_request_error",
    "code": "invalid_request_error",
    "param": null
  }
}
```

**Unknown model alias → 400:**
```json
{
  "error": {
    "message": "Unknown model 'some-alias'.",
    "type": "invalid_request_error",
    "code": "model_not_found",
    "param": "model"
  }
}
```

---

#### Response — non-streaming (`stream` omitted or `false`)

**200:**
```json
{
  "id": "<upstream-completion-id>",
  "object": "chat.completion",
  "created": 1748985600,
  "model": "gpt-oss-120b-balanced",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<response text>"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 87,
    "total_tokens": 99
  },
  "system_fingerprint": "<optional, present only when upstream returns it>"
}
```

**Normalization rules (non-streaming):**
- `model` is always rewritten to the logical alias (never the upstream provider model ID)
- `object` is always `"chat.completion"`
- `choices[].message` contains only `role` and `content` — `reasoning` and other provider-specific fields are stripped
- `choices[]` contains only `index`, `message`, `finish_reason` — `reasoning_logprobs` stripped
- `usage` is always present; synthesized as `{prompt_tokens:0, completion_tokens:0, total_tokens:0}` if upstream omits it
- `system_fingerprint` is omitted when upstream does not include it (key absent, not `undefined`)
- Provider-specific top-level fields (`time_info`, `x_groq`, `usage_breakdown`) are never present

**Optional response header (when `EXPOSE_PROVIDER_HEADER=true`):**
```
X-LLM-Provider: cerebras
```
or
```
X-LLM-Provider: groq
```
Default: header not sent.

---

#### Response — streaming (`stream: true`)

**200 headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Request-ID: <uuid>
X-LLM-Provider: <provider>   (only when EXPOSE_PROVIDER_HEADER=true)
```

**SSE body — each chunk:**
```
data: {"id":"<id>","object":"chat.completion.chunk","created":1748985600,"model":"gpt-oss-120b-balanced","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n

data: {"id":"<id>","object":"chat.completion.chunk","created":1748985600,"model":"gpt-oss-120b-balanced","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n

data: {"id":"<id>","object":"chat.completion.chunk","created":1748985600,"model":"gpt-oss-120b-balanced","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n

data: [DONE]\n\n
```

**Normalization rules (streaming):**
- `model` rewritten to logical alias
- `object` always `"chat.completion.chunk"`
- `delta.role` present only when defined in the upstream chunk
- `delta.content` present (including explicit `null`) only when `content` key exists in upstream delta
- `delta.reasoning` and other provider-specific delta fields stripped
- Chunks where `choices[]` has no visible data (no `finish_reason`, no `role`, no `content`) are silently skipped

**Streaming behavior:**
- Chunks forwarded incrementally — never buffered
- Client disconnect aborts the upstream request via `AbortController`
- No failover after the first chunk is sent to the client
- `[DONE]` sentinel always sent at the end

---

### GET /internal/providers/status

**Auth:** required.  
**Enabled by:** `ENABLE_INTERNAL_STATUS_ENDPOINT=true` (default: true)

**Response 200:**
```json
{
  "providers": [
    {
      "provider": "cerebras",
      "enabled": true,
      "configured": true,
      "healthy": true,
      "cooldownUntil": null,
      "lastSelectedAt": null,
      "lastSuccessAt": 1748985600000,
      "lastFailureAt": null,
      "lastStatusCode": 200,
      "consecutiveFailures": 0,
      "rateLimitSnapshot": {
        "remainingRequestsDay": "999",
        "remainingTokensMinute": "20000"
      }
    },
    {
      "provider": "groq",
      "enabled": true,
      "configured": true,
      "healthy": false,
      "cooldownUntil": 1748985720000,
      "lastSelectedAt": 1748985600000,
      "lastSuccessAt": null,
      "lastFailureAt": 1748985600000,
      "lastStatusCode": 429,
      "consecutiveFailures": 1,
      "rateLimitSnapshot": {
        "remainingRequests": "0",
        "remainingTokens": "6000",
        "retryAfterSeconds": "120"
      }
    }
  ]
}
```

`cooldownUntil` is a Unix timestamp in milliseconds or `null`.

**When disabled → 404:**
```json
{
  "error": {
    "message": "The requested endpoint does not exist.",
    "type": "invalid_request_error",
    "code": "not_found",
    "param": null
  }
}
```

---

### Unknown routes

Any unmatched route → 404:
```json
{
  "error": {
    "message": "The requested endpoint does not exist.",
    "type": "invalid_request_error",
    "code": "not_found",
    "param": null
  }
}
```

---

## Routing behavior

### Round-robin with cooldown

Providers are tried in order `PROVIDER_ORDER` (default: `cerebras,groq`), offset by a cursor that advances after each request.

```
Request 1 → cerebras (cursor advances)
Request 2 → groq (cursor advances)
Request 3 → cerebras
Groq returns 429 → groq enters cooldown
Request 4 → cerebras only
Request 5 → cerebras only
Groq cooldown expires → eligible again
Request 6 → groq
```

Per request, at most `MAX_PROVIDER_ATTEMPTS_PER_REQUEST` (default: 2) providers are tried.

### Failover policy

| Upstream status | Failover? |
|---|---|
| 400, 401, 403, 404, 413, 422 | No — return error to client immediately |
| 408, 429, 498, 500, 502, 503, 504 | Yes — try next eligible provider |

On 429 or 498: parse rate-limit headers, compute cooldown, mark provider unavailable.

**Cooldown duration:**
```
cooldownMs = max(DEFAULT_COOLDOWN_SECONDS, retryAfterSeconds, resetTokensSeconds) × 1000
```
Default: 60 seconds when no header data available.

When all providers exhausted → 503 `no_provider_available`.

**Upstream error message de-leaking:** upstream model IDs in error messages are replaced with the logical alias before forwarding to the client.

---

## Structured log format

Every completed request emits one JSON line to stdout:

```json
{
  "level": "info",
  "event": "request_complete",
  "requestId": "<uuid>",
  "timestamp": "2026-06-05T00:00:00.000Z",
  "route": "POST /v1/chat/completions",
  "logicalAlias": "gpt-oss-120b-balanced",
  "provider": "cerebras",
  "upstreamModelId": "gpt-oss-120b",
  "attempt": 1,
  "streaming": false,
  "statusCode": 200,
  "latencyMs": 843,
  "failoverReason": null,
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 87,
    "total_tokens": 99
  }
}
```

`provider` and `upstreamModelId` are `null` when no provider was reached.  
`failoverReason` is `"status_429"`, `"status_503"`, etc. when a provider was skipped.

Provider cooldown events emit:
```json
{
  "level": "warn",
  "event": "provider_cooldown",
  "requestId": "<uuid>",
  "provider": "groq",
  "status": 429,
  "cooldownUntil": "2026-06-05T00:02:00.000Z"
}
```

**Never logged:** API keys, Authorization headers, prompt text, response text, reasoning content.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PERSONAL_PROXY_API_KEY` | — | Required. Downstream client auth key |
| `CEREBRAS_API_KEY` | — | Cerebras provider key |
| `GROQ_API_KEY` | — | Groq provider key |
| `PORT` | `3000` | HTTP listen port |
| `HOSTNAME` | `0.0.0.0` | HTTP bind address |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` |
| `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` | Cerebras endpoint |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Groq endpoint |
| `CEREBRAS_VERSION_PATCH` | `2` | Sent as `X-Cerebras-Version-Patch` |
| `DEFAULT_MAX_COMPLETION_TOKENS` | `4096` | Injected when client omits field |
| `DEFAULT_COOLDOWN_SECONDS` | `60` | Fallback cooldown on 429 |
| `MAX_PROVIDER_ATTEMPTS_PER_REQUEST` | `2` | Max providers tried per request |
| `PROVIDER_ORDER` | `cerebras,groq` | Round-robin order |
| `MODEL_REGISTRY_JSON` | `{"gpt-oss-120b-balanced":{"cerebras":"gpt-oss-120b","groq":"openai/gpt-oss-120b"}}` | Alias→upstream map |
| `EXPOSE_PROVIDER_HEADER` | `false` | Emit `X-LLM-Provider` header |
| `ENABLE_INTERNAL_STATUS_ENDPOINT` | `true` | Enable `/internal/providers/status` |

---

## curl examples

```bash
# Health (no auth)
curl http://localhost:3000/health

# Readiness (no auth)
curl http://localhost:3000/ready

# List models
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $PERSONAL_PROXY_API_KEY"

# Non-streaming completion
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $PERSONAL_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-120b-balanced",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_completion_tokens": 100
  }'

# Streaming completion
curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $PERSONAL_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-120b-balanced",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true,
    "max_completion_tokens": 100
  }'

# Provider status
curl http://localhost:3000/internal/providers/status \
  -H "Authorization: Bearer $PERSONAL_PROXY_API_KEY"
```
