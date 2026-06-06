# CLAUDE.md — Unified OpenAI-Compatible Proxy for Cerebras and Groq

## 1. Project objective

Build a personal middleware API that exposes a stable OpenAI-compatible endpoint and routes requests across two upstream inference providers:

1. Cerebras Inference
2. GroqCloud

The middleware exists to let existing clients switch from direct OpenAI calls by changing only:

1. `base_url`
2. API key
3. logical model alias, when required

The middleware must keep the real provider API keys server-side and must never expose them to downstream clients.

---

## 2. Core design principle

Do **not** rebuild the complete OpenAI API.

Both Cerebras and Groq already expose APIs designed to be mostly compatible with OpenAI client libraries:

| Provider | OpenAI-compatible upstream base URL |
|---|---|
| Cerebras | `https://api.cerebras.ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |

The middleware should be a small compatibility and routing layer:

1. authenticate downstream requests with a personal proxy key;
2. validate a strict common subset of supported OpenAI Chat Completions fields;
3. resolve a logical proxy model alias into a provider-specific model ID;
4. choose an eligible provider using round-robin routing;
5. forward the request;
6. normalize provider-specific response fields;
7. relay streaming responses incrementally;
8. observe rate-limit headers;
9. temporarily disable providers that hit quota or transient failures;
10. return OpenAI-style errors.

Prefer the smallest reliable implementation possible.

---

## 3. Important routing correction

Do not interpret “alternate requests until free tier is exhausted” as a blind permanent sequence.

Free-tier capacity is not a single static balance. Providers apply limits across rolling or replenishing windows, such as:

- requests per minute;
- requests per day;
- tokens per minute;
- tokens per day;
- model-specific limits.

A provider can become temporarily unavailable because one threshold was reached while remaining usable again after its quota replenishes.

### Correct MVP behavior

Use **stateful round-robin among currently eligible providers**.

Example:

```text
Request 1 -> Cerebras
Request 2 -> Groq
Request 3 -> Cerebras
Request 4 -> Groq
Groq returns 429 -> mark Groq unavailable until its reset time
Request 5 -> Cerebras
Request 6 -> Cerebras
Groq cooldown expires -> Groq becomes eligible again
Request 7 -> Groq
```

Do not fail a request merely because the provider selected first is temporarily unavailable. Try the next compatible eligible provider before returning an error.

---

## 4. MVP scope

### Required public endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | Main OpenAI-compatible text-generation endpoint |
| `GET` | `/v1/models` | List stable logical proxy models |
| `GET` | `/health` | Basic liveness check |
| `GET` | `/ready` | Verify configuration and provider availability |
| `GET` | `/internal/providers/status` | Optional protected diagnostics endpoint |

### Explicitly out of scope for MVP

Do not implement these unless requested later:

- `/v1/responses`
- `/v1/embeddings`
- `/v1/audio/*`
- `/v1/images/*`
- `/v1/files`
- `/v1/batches`
- legacy `/v1/completions`
- OpenAI built-in tools
- Groq built-in tools
- Groq Compound systems
- persistent conversation storage
- semantic provider selection
- quality-based routing
- billing
- multi-user administration
- automatic key rotation
- multiple keys per provider
- distributed coordination across multiple proxy replicas

### Why `/v1/responses` remains excluded

OpenAI recommends Responses API for new OpenAI-native applications. Groq documents a beta OpenAI-compatible Responses API. Cerebras documents direct OpenAI compatibility around Chat Completions. Supporting `/v1/responses` uniformly across both providers would require an additional adaptation layer and provider-specific capability branching.

Keep the MVP centered on `/v1/chat/completions`.

---

## 5. Upstream providers

## 5.1 Cerebras

### Base URL

```text
https://api.cerebras.ai/v1
```

### Authentication

```http
Authorization: Bearer ${CEREBRAS_API_KEY}
```

### Main upstream endpoints

| Method | Endpoint |
|---|---|
| `POST` | `https://api.cerebras.ai/v1/chat/completions` |
| `GET` | `https://api.cerebras.ai/v1/models` |

### Optional version patch header

```http
X-Cerebras-Version-Patch: 2
```

Make it configurable.

---

## 5.2 Groq

### Base URL

```text
https://api.groq.com/openai/v1
```

### Authentication

```http
Authorization: Bearer ${GROQ_API_KEY}
```

### Main upstream endpoints

| Method | Endpoint |
|---|---|
| `POST` | `https://api.groq.com/openai/v1/chat/completions` |
| `GET` | `https://api.groq.com/openai/v1/models` |

---

## 6. Downstream authentication

Clients calling this middleware must send a personal proxy key:

```http
Authorization: Bearer ${PERSONAL_PROXY_API_KEY}
```

Minimum requirements:

1. reject missing credentials with HTTP `401`;
2. reject invalid credentials with HTTP `401`;
3. do not reveal upstream credential state;
4. do not log secrets;
5. use constant-time comparison when practical.

For the MVP, a single shared personal proxy key is sufficient.

---

## 7. Environment variables

```bash
# Required
CEREBRAS_API_KEY=
GROQ_API_KEY=
PERSONAL_PROXY_API_KEY=

# Recommended
PORT=3000
LOG_LEVEL=info
REQUEST_TIMEOUT_MS=120000
MAX_REQUEST_BODY_BYTES=1048576

# Upstream endpoints
CEREBRAS_BASE_URL=https://api.cerebras.ai/v1
GROQ_BASE_URL=https://api.groq.com/openai/v1

# Cerebras compatibility patch
CEREBRAS_VERSION_PATCH=2

# Routing
ROUTING_STRATEGY=round_robin
PROVIDER_ORDER=cerebras,groq
DEFAULT_COOLDOWN_SECONDS=60
MAX_PROVIDER_ATTEMPTS_PER_REQUEST=2

# Stable logical proxy models
MODEL_REGISTRY_JSON={"gpt-oss-120b-balanced":{"cerebras":"gpt-oss-120b","groq":"openai/gpt-oss-120b"}}

# Optional diagnostics
EXPOSE_PROVIDER_HEADER=false
ENABLE_INTERNAL_STATUS_ENDPOINT=true
```

Do not hardcode secrets.

---

## 8. Logical model registry

Provider-specific model IDs differ.

Example:

| Logical proxy model | Cerebras upstream model | Groq upstream model |
|---|---|---|
| `gpt-oss-120b-balanced` | `gpt-oss-120b` | `openai/gpt-oss-120b` |

Expose stable logical aliases to downstream clients. Do not require clients to understand provider-specific IDs.

### Registry shape

```json
{
  "gpt-oss-120b-balanced": {
    "cerebras": "gpt-oss-120b",
    "groq": "openai/gpt-oss-120b"
  }
}
```

### Rules

1. A logical alias may route only to providers configured for that alias.
2. Never route a request to a materially different model merely because another provider has spare quota.
3. Do not silently replace a 120B model with a smaller model.
4. Add additional aliases explicitly when needed.
5. Validate configured model IDs against upstream `/models` endpoints during startup or readiness checks.
6. Cache upstream model lists briefly; do not assume availability is permanent.

### Recommended initial alias

Use a single initial alias:

```text
gpt-oss-120b-balanced
```

This maps to GPT OSS 120B on both providers and minimizes behavioral drift.

---

## 9. Public `GET /v1/models`

Return logical proxy models, not the raw union of provider model IDs.

Example:

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

Optional diagnostics should live outside the OpenAI-compatible payload:

```http
GET /internal/providers/status
```

Do not leak provider keys.

---

## 10. Public `POST /v1/chat/completions`

### Minimal request

```json
{
  "model": "gpt-oss-120b-balanced",
  "messages": [
    {
      "role": "user",
      "content": "Explain why low-latency inference matters."
    }
  ],
  "max_completion_tokens": 300
}
```

### Minimal normalized response

```json
{
  "id": "chatcmpl-upstream-or-proxy-id",
  "object": "chat.completion",
  "created": 1769729480,
  "model": "gpt-oss-120b-balanced",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

Return the logical downstream model alias in `model`, not the upstream provider-specific model ID.

---

## 11. Common request contract

The public proxy contract must be the **intersection** of behavior reliably supported by both providers.

### MVP fields to support

| Field | MVP behavior |
|---|---|
| `model` | Required logical alias |
| `messages` | Required |
| `temperature` | Forward |
| `top_p` | Forward |
| `max_completion_tokens` | Forward and encourage explicit values |
| `stream` | Forward |
| `stop` | Forward |
| `seed` | Forward when supported |
| `frequency_penalty` | Allow only after provider compatibility tests |
| `presence_penalty` | Allow only after provider compatibility tests |
| `tools` | Allow only after provider compatibility tests |
| `tool_choice` | Allow only after provider compatibility tests |
| `parallel_tool_calls` | Allow only after provider compatibility tests |
| `response_format` | Allow only after provider compatibility tests |

### Reject by default

Reject fields not explicitly allowlisted.

Important Groq compatibility limitations documented for OpenAI-style usage include:

- `logprobs` unsupported;
- `logit_bias` unsupported;
- `top_logprobs` unsupported;
- `messages[].name` unsupported;
- if `n` is supplied, it must equal `1`;
- `temperature = 0` is converted to `1e-8`.

Therefore, the unified MVP should reject:

```text
logprobs
logit_bias
top_logprobs
messages[].name
n != 1
```

Do not silently ignore unsupported fields.

---

## 12. Routing algorithm

### Provider state

Maintain in-memory state for each provider:

```ts
type ProviderState = {
  provider: "cerebras" | "groq";
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  cooldownUntil: number | null;
  lastSelectedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastStatusCode: number | null;
  consecutiveFailures: number;
  rateLimitSnapshot?: Record<string, string>;
};
```

### Eligibility

A provider is eligible only when:

1. it is configured;
2. it is enabled;
3. the requested logical alias maps to an upstream model for that provider;
4. it is not inside a cooldown window;
5. it has not been marked unhealthy by repeated transient failures.

### Stateful round-robin

Pseudocode:

```ts
function chooseEligibleProviders(
  logicalModel: string,
  state: RouterState
): Provider[] {
  const candidates = providers
    .filter((provider) => isEligible(provider, logicalModel))
    .sortByRoundRobinCursor();

  advanceCursorAfterSelection();
  return candidates;
}
```

For each request:

```ts
for (const provider of chooseEligibleProviders(model, state)) {
  const result = await tryProvider(provider, request);

  if (result.ok) {
    return normalizeAndReturn(result);
  }

  if (result.retryableForAlternateProvider) {
    markProviderState(provider, result);
    continue;
  }

  return mapError(result);
}

return noProviderAvailableError();
```

### Do not retry the same provider blindly

For quota distribution, fail over first to the alternate provider. Retry the same provider only after respecting cooldown or retry headers.

---

## 13. Rate-limit handling

## 13.1 Cerebras headers

Capture Cerebras rate-limit headers:

```text
x-ratelimit-limit-requests-day
x-ratelimit-limit-tokens-minute
x-ratelimit-remaining-requests-day
x-ratelimit-remaining-tokens-minute
x-ratelimit-reset-requests-day
x-ratelimit-reset-tokens-minute
```

Cerebras may reject a request before processing if its estimated token consumption exceeds available token quota. Set `max_completion_tokens` deliberately.

## 13.2 Groq headers

Capture Groq rate-limit headers:

```text
retry-after
x-ratelimit-limit-requests
x-ratelimit-limit-tokens
x-ratelimit-remaining-requests
x-ratelimit-remaining-tokens
x-ratelimit-reset-requests
x-ratelimit-reset-tokens
```

Groq documents that `retry-after` is returned with a `429`, while the other quota headers are normally included in responses.

## 13.3 Cooldown policy

When a provider returns `429`:

1. inspect provider-specific reset headers;
2. inspect `retry-after` when available;
3. calculate a cooldown;
4. mark the provider unavailable until cooldown expiration;
5. immediately attempt the next eligible provider;
6. do not permanently disable the provider;
7. log the quota event.

If reset data is unavailable, use:

```text
DEFAULT_COOLDOWN_SECONDS
```

### Recommended behavior

```ts
cooldownUntil = now + max(
  retryAfterSeconds,
  resetTokensSeconds,
  fallbackCooldownSeconds
);
```

Do not treat every `429` as proof that the entire free tier has been permanently exhausted. The request may have hit only a short-lived RPM or TPM limit.

---

## 14. Error and failover policy

| Upstream status | Fail over to alternate provider? | Notes |
|---|---:|---|
| `400` | No | Invalid payload; fix request |
| `401` | Usually no | Provider key or configuration error |
| `403` | Usually no | Permission problem |
| `404` | Usually no | Model mapping may be stale |
| `408` | Yes | Transient timeout |
| `413` | No | Payload too large |
| `422` | Usually no | Semantic request problem |
| `429` | Yes | Cooldown provider |
| `498` from Groq | Yes | Flex-tier capacity exceeded |
| `500` | Yes | Transient upstream failure |
| `502` | Yes | Transient upstream failure |
| `503` | Yes | Transient upstream failure |
| `504` | Yes | Transient upstream failure |

### Important rule

Do not retry or fail over a streamed request after partial output has already reached the downstream client.

Once streaming begins, preserve stream integrity over transparent failover.

---

## 15. Response normalization

Preserve standard fields when present:

- `id`
- `object`
- `created`
- `model`
- `choices`
- `usage`
- `system_fingerprint`

Rewrite:

```text
model -> logical proxy alias
```

Remove provider-specific fields from the default downstream body:

- Cerebras `choices[*].message.reasoning`
- Cerebras `choices[*].reasoning_logprobs`
- Cerebras `time_info`
- Groq provider-specific telemetry
- internal routing metadata

### Optional diagnostics header

When explicitly enabled:

```http
X-LLM-Provider: cerebras
```

or:

```http
X-LLM-Provider: groq
```

Default:

```text
EXPOSE_PROVIDER_HEADER=false
```

Do not expose provider selection unless debugging requires it.

---

## 16. Streaming

When:

```json
{
  "stream": true
}
```

the middleware must preserve Server-Sent Events behavior.

Requirements:

1. forward chunks incrementally;
2. do not buffer the complete response;
3. preserve `Content-Type: text/event-stream`;
4. preserve the final sentinel:

```text
data: [DONE]
```

5. abort upstream work if the downstream client disconnects;
6. do not fail over after the first streamed chunk has been sent;
7. normalize streamed model IDs into the logical alias when practical;
8. preserve low latency.

---

## 17. Tool calling and structured outputs

Keep these disabled until tested across both providers with the selected shared model alias.

### Tool calling rules

When enabled:

1. support function tools only in the unified contract;
2. pass through `tools`, `tool_choice`, and `parallel_tool_calls` only after tests;
3. validate tool definitions;
4. return tool calls to the calling application;
5. never execute tools inside the proxy unless deliberately added later;
6. treat generated tool arguments as untrusted input.

### Structured-output rules

When enabled:

1. prefer strict JSON Schema mode;
2. validate schemas before forwarding;
3. reject combinations that differ across providers unless explicitly handled;
4. test streaming and structured-output interactions independently.

The proxy is a router and adapter, not an autonomous agent runtime.

---

## 18. Internal diagnostics endpoint

Optional protected endpoint:

```http
GET /internal/providers/status
Authorization: Bearer ${PERSONAL_PROXY_API_KEY}
```

Example:

```json
{
  "providers": [
    {
      "provider": "cerebras",
      "configured": true,
      "healthy": true,
      "cooldownUntil": null,
      "lastStatusCode": 200,
      "rateLimitSnapshot": {
        "remainingRequestsDay": "999",
        "remainingTokensMinute": "20000"
      }
    },
    {
      "provider": "groq",
      "configured": true,
      "healthy": false,
      "cooldownUntil": "2026-06-04T18:41:03Z",
      "lastStatusCode": 429,
      "rateLimitSnapshot": {
        "remainingRequests": "0",
        "remainingTokens": "6000",
        "retryAfter": "2"
      }
    }
  ]
}
```

Never expose secret values.

---

## 19. Observability

Log structured metadata:

- request ID;
- timestamp;
- downstream route;
- logical model alias;
- chosen provider;
- upstream model ID;
- provider attempt number;
- streaming enabled or disabled;
- status code;
- latency;
- failover reason;
- cooldown expiration;
- token usage;
- captured quota headers;
- upstream request ID when available.

Do not log by default:

- API keys;
- Authorization headers;
- full prompts;
- full responses;
- reasoning content;
- personal or sensitive payloads.

Return:

```http
X-Request-ID: <uuid>
```

---

## 20. Readiness behavior

`GET /ready` should return success only when:

1. the personal proxy key exists;
2. at least one upstream provider key exists;
3. at least one configured logical model alias has at least one eligible provider mapping;
4. required configuration is valid.

It should not require both providers to be available.

Example degraded but ready response:

```json
{
  "ready": true,
  "mode": "degraded",
  "eligibleProviders": ["cerebras"],
  "unavailableProviders": ["groq"]
}
```

---

## 21. Suggested architecture

```text
Client
  |
  | Authorization: Bearer PERSONAL_PROXY_API_KEY
  v
Unified OpenAI-Compatible Proxy
  |-- downstream auth
  |-- request ID
  |-- common request validation
  |-- logical model resolver
  |-- round-robin provider router
  |-- provider state and cooldown manager
  |-- Cerebras adapter
  |-- Groq adapter
  |-- response normalizer
  |-- SSE relay
  |-- structured logs
  v
  +------------------------------+
  |                              |
  v                              v
Cerebras                       Groq
https://api.cerebras.ai/v1     https://api.groq.com/openai/v1
```

Recommended modules:

```text
src/
  app.*
  config.*
  routes/
    health.*
    ready.*
    models.*
    chat-completions.*
    providers-status.*
  middleware/
    auth.*
    request-id.*
  routing/
    provider-router.*
    provider-state.*
    cooldown-manager.*
  providers/
    provider-adapter.*
    cerebras-adapter.*
    groq-adapter.*
  services/
    model-registry.*
    response-normalizer.*
    stream-relay.*
  schemas/
    chat-completions.*
  utils/
    errors.*
    logger.*
tests/
  unit/
  integration/
```

Keep provider-specific behavior isolated inside adapters.

---

## 22. Acceptance criteria

The MVP is complete when all of these pass:

1. An OpenAI-compatible SDK can call the proxy by changing `base_url`, API key, and model alias.
2. `POST /v1/chat/completions` works through Cerebras.
3. `POST /v1/chat/completions` works through Groq.
4. Consecutive valid requests alternate providers when both are eligible.
5. A Cerebras `429` temporarily removes Cerebras from rotation.
6. A Groq `429` temporarily removes Groq from rotation.
7. A provider returns to rotation after its cooldown expires.
8. Requests continue through the alternate provider while one provider is cooling down.
9. The proxy returns an OpenAI-style error when no provider is eligible.
10. `GET /v1/models` returns stable logical aliases only.
11. The upstream keys never reach downstream clients.
12. Invalid downstream credentials return `401`.
13. Unknown logical aliases return `400`.
14. Upstream model IDs are rewritten into logical aliases in normalized responses.
15. Streaming works for both providers without buffering.
16. Streaming requests are never transparently replayed after partial output.
17. Unsupported common-contract fields are rejected before reaching upstream providers.
18. Structured logs record provider selection and failover reason without secrets.
19. `GET /ready` supports degraded mode.
20. Automated tests cover alternating, cooldown, recovery, timeouts, invalid configuration, provider failure, and both-provider exhaustion.

---

## 23. Initial implementation sequence

Implement in this order:

1. configuration loader;
2. `/health`;
3. `/ready`;
4. downstream Bearer auth;
5. provider-adapter interface;
6. Cerebras adapter;
7. Groq adapter;
8. logical model registry;
9. non-streaming `/v1/chat/completions`;
10. response normalization;
11. in-memory provider state;
12. stateful round-robin router;
13. quota-header parsing;
14. cooldown behavior after `429`;
15. alternate-provider failover;
16. `/v1/models`;
17. optional internal diagnostics endpoint;
18. streaming relay;
19. automated tests;
20. minimal README.

Do not expand scope until these pass.

---

## 24. Basic curl examples

### List logical models

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer ${PERSONAL_PROXY_API_KEY}"
```

### Non-streaming completion

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer ${PERSONAL_PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-120b-balanced",
    "messages": [
      {
        "role": "user",
        "content": "Explain the value of low-latency inference in one paragraph."
      }
    ],
    "max_completion_tokens": 300
  }'
```

### Streaming completion

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer ${PERSONAL_PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-120b-balanced",
    "messages": [
      {
        "role": "user",
        "content": "Write three concise product ideas."
      }
    ],
    "stream": true,
    "max_completion_tokens": 300
  }'
```

### Provider status

```bash
curl http://localhost:3000/internal/providers/status \
  -H "Authorization: Bearer ${PERSONAL_PROXY_API_KEY}"
```

---

## 25. Official documentation links

### Cerebras

- Overview: https://inference-docs.cerebras.ai/
- Quickstart: https://inference-docs.cerebras.ai/quickstart
- Authentication: https://inference-docs.cerebras.ai/api-reference/authentication
- OpenAI compatibility: https://inference-docs.cerebras.ai/resources/openai
- Chat Completions: https://inference-docs.cerebras.ai/api-reference/chat-completions
- Models: https://inference-docs.cerebras.ai/api-reference/models/list-models
- Public models: https://inference-docs.cerebras.ai/api-reference/models/public-models
- Streaming: https://inference-docs.cerebras.ai/capabilities/streaming
- Tool calling: https://inference-docs.cerebras.ai/capabilities/tool-use
- Structured outputs: https://inference-docs.cerebras.ai/capabilities/structured-outputs
- Rate limits: https://inference-docs.cerebras.ai/support/rate-limits
- Versions: https://inference-docs.cerebras.ai/api-reference/versions
- Deprecations: https://inference-docs.cerebras.ai/support/deprecation
- Full docs index: https://inference-docs.cerebras.ai/llms.txt

### Groq

- Overview: https://console.groq.com/docs/overview
- Quickstart: https://console.groq.com/docs/quickstart
- OpenAI compatibility: https://console.groq.com/docs/openai
- Chat Completions guide: https://console.groq.com/docs/text-chat
- API reference: https://console.groq.com/docs/api-reference
- Models: https://console.groq.com/docs/models
- Rate limits: https://console.groq.com/docs/rate-limits
- Error codes: https://console.groq.com/docs/errors
- Structured outputs: https://console.groq.com/docs/structured-outputs
- Tool use: https://console.groq.com/docs/tool-use
- Responses API beta: https://console.groq.com/docs/responses-api

### OpenAI

- API authentication: https://developers.openai.com/api/reference/overview#authentication
- Chat Completions: https://developers.openai.com/api/reference/resources/chat
- Models API: https://developers.openai.com/api/reference/resources/models/methods/list
- Text generation guide: https://developers.openai.com/api/docs/guides/text
- Responses migration guide: https://developers.openai.com/api/docs/guides/migrate-to-responses

---

## 26. Working rules for the coding agent

1. Read this file before modifying the project.
2. Keep the MVP narrow.
3. Build a shared public contract from the intersection of reliable provider capabilities.
4. Keep Cerebras-specific and Groq-specific behavior isolated behind adapters.
5. Use stable logical model aliases.
6. Do not silently route to a materially different model.
7. Use stateful round-robin among eligible providers.
8. Treat `429` as a temporary provider cooldown unless evidence shows otherwise.
9. Preserve streaming integrity over transparent failover.
10. Prefer explicit validation over silent fallbacks.
11. Never expose or log secrets.
12. Never expose chain-of-thought or provider reasoning fields.
13. Add tests before expanding scope.
14. Update this file whenever routing, model mappings, endpoints, or assumptions change.
15. Verify provider behavior against the official documentation links above before adding compatibility claims.
