# AGENTS.md — Unified OpenAI-Compatible Proxy for Cerebras and Groq

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

# Whisper model provisioning (runtime volume)
# Model is provisioned into /models at boot by ensure-model.sh and is no
# longer part of the image (quick task 260724-mv1).

WHISPER_MODEL_PATH=/models/ggml-small.bin
WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
WHISPER_MODEL_SHA256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b
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

<!-- GSD:project-start source:PROJECT.md -->

## Project

**bun-ai-api — OpenAI-Compatible Proxy for Cerebras + Groq**

Personal middleware API that exposes a stable OpenAI-compatible endpoint (`/v1/chat/completions`, `/v1/models`) and routes requests across two upstream inference providers: Cerebras and Groq. Existing clients switch from direct OpenAI calls by changing only `base_url` and API key — no other code changes. The refactor transforms a prototype custom-endpoint server into a spec-compliant proxy with stateful round-robin routing, cooldown management, and full OpenAI wire compatibility.

**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.

### Constraints

- **Runtime**: Bun only — `Bun.serve()`, no Express; `bun test` for tests
- **SDK retention**: groq-sdk + cerebras_cloud_sdk stay; no raw HTTP proxy to upstream
- **Structure**: Files at root level (routes/, middleware/, etc. as directories at root)
- **Compatibility**: Public contract = intersection of reliable Cerebras + Groq capabilities
- **Secrets**: Never hardcode; never log; never expose to downstream clients

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 5.x - All source files (`index.ts`, `types.ts`, `services/*.ts`)
- None detected

## Runtime

- Bun 1.3.11 (pinned in `Dockerfile`, both stages) — matches CI and local dev
- ESNext target; module system: `"Preserve"` with bundler-mode resolution
- Bun (`bun install`)
- Lockfile: `bun.lock` present (lockfileVersion 1)

## Frameworks

- `Bun.serve()` (built-in) — HTTP server with SSE streaming; no Express or Hono
- `bun test` (built-in) — no test files exist yet
- `bun --watch run index.ts` — watch mode for development (hot-restart)
- `bun index.ts` — production start command
- No separate bundler; `dist/index.js` exists as a pre-built artifact but is not used in production

## Key Dependencies

- `@cerebras/cerebras_cloud_sdk` ^1.59.0 (resolved 1.59.0) — official Cerebras inference SDK; used in `services/cerebras.ts`
- `groq-sdk` ^0.37.0 (resolved 0.37.0) — official Groq SDK; used in `services/groq.ts`
- `cerebras` ^1.2.7 — a separate Cerebras CLI/native binary package listed alongside `@cerebras/cerebras_cloud_sdk`; only `@cerebras/cerebras_cloud_sdk` is imported in source code. The `cerebras` package installs platform-specific native binaries (`cerebras-darwin-arm64`, etc.) and a `cerebras` CLI binary. It appears unused at the application level.
- `@types/bun` latest (resolved 1.3.5) — TypeScript types for the Bun runtime API
- `typescript` ^5 — TypeScript compiler (not explicitly installed, provided by environment)

## Configuration

- `target`: ESNext
- `module`: Preserve (bundler mode)
- `moduleResolution`: bundler
- `strict`: true
- `noUncheckedIndexedAccess`: true
- `noImplicitOverride`: true
- `allowImportingTsExtensions`: true
- `verbatimModuleSyntax`: true
- `noEmit`: true (Bun runs TS directly — no tsc emit step)
- Bun auto-loads `.env` and `.env.local` — no dotenv library needed
- `.env` and `.env.local` both present (contents secret; never read)
- Key env vars referenced in source: `HOSTNAME`, `PORT`
- Key env vars required per `refactor.md` design spec: `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `PERSONAL_PROXY_API_KEY`, `PORT`, `HOSTNAME`, `LOG_LEVEL`, `REQUEST_TIMEOUT_MS`, `MAX_REQUEST_BODY_BYTES`, `CEREBRAS_BASE_URL`, `GROQ_BASE_URL`, `CEREBRAS_VERSION_PATCH`, `ROUTING_STRATEGY`, `PROVIDER_ORDER`, `DEFAULT_COOLDOWN_SECONDS`, `MAX_PROVIDER_ATTEMPTS_PER_REQUEST`, `MODEL_REGISTRY_JSON`, `EXPOSE_PROVIDER_HEADER`, `ENABLE_INTERNAL_STATUS_ENDPOINT`
- No `tsconfig.build.json` or separate build config; Bun transpiles TypeScript natively at runtime
- `Dockerfile` uses `oven/bun:1.3.11` base image

## Platform Requirements

- Bun >= 1.3.11 (earlier versions cannot read the text `bun.lock` format)
- No Node.js required
- Docker container via `oven/bun:1.3.11`
- Port: `3001` (Dockerfile default); `3000` (code default); overridable via `PORT` env var
- Hostname: `0.0.0.0` (all interfaces) or overridable via `HOSTNAME` env var
- Deployment target: EasyPanel (mentioned in code comment) or any reverse-proxy-compatible host

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- kebab-case for service files: `services/groq.ts`, `services/cerebras.ts`
- camelCase for entrypoint and shared types: `index.ts`, `types.ts`
- No barrel `index.ts` inside directories — each service file is imported directly
- camelCase: `getNextService`, `chat`
- Verb + noun pattern for helpers: `getNextService()`
- camelCase for local variables and module-level state: `currentServiceIndex`, `chatCompletion`
- `const` preferred; `let` used only when mutation is required (e.g., `let currentServiceIndex`)
- Descriptive camelCase: `groqService`, `cerebrasService`
- Named exports used exclusively (no default exports in services): `export const groqService`
- PascalCase: `ChatMessage`, `AIService`
- Defined in a dedicated `types.ts` file at the root
- Interface keyword used (not `type` alias) for object shapes

## Code Style

- No formatter config detected (no `.prettierrc`, `biome.json`, or `.editorconfig`)
- 4-space indentation observed throughout all source files
- Single quotes for SDK imports in `services/groq.ts` (`'groq-sdk'`), double quotes elsewhere — inconsistent
- Trailing newlines present in service files
- No ESLint or Biome config detected
- TypeScript strict mode is the primary enforcement mechanism (see `tsconfig.json`)
- `strict: true` — all strict checks enabled
- `noUncheckedIndexedAccess: true` — array/index access returns `T | undefined`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`
- `verbatimModuleSyntax: true` — requires `import type` for type-only imports
- `noUnusedLocals: false`, `noUnusedParameters: false` — unused identifiers are not flagged
- Target: `ESNext`; Module: `Preserve` (Bun bundler mode)

## Import Organization

- `import type { ... }` used for type-only imports in `services/cerebras.ts` — consistent with `verbatimModuleSyntax: true`
- Value imports use plain `import { ... }` in `services/groq.ts` (types imported as values — diverges from verbatimModuleSyntax requirement)
- Relative paths only; no path aliases configured

## Error Handling

- No explicit error handling in any source file — all async operations are un-wrapped (`await` with no try/catch)
- Errors propagate naturally to `Bun.serve()`'s unhandled rejection path
- The `refactor.md` spec requires OpenAI-style error responses and upstream status code mapping, but this is not yet implemented
- `as any` cast used in `services/cerebras.ts` line 11 to bypass type mismatch — suppresses TypeScript errors on the `messages` argument

## Logging

- Single log per request in `index.ts`: `console.log(`Using service: ${service?.name}`)`
- Template literals used for interpolation
- No structured logging, no request IDs, no timestamps
- `refactor.md` spec requires structured metadata logging (request ID, provider, latency, status code, etc.) — not yet implemented

## Comments

- Inline comments in Spanish for business context: `// healthcheck para EasyPanel / reverse proxies` (`index.ts` line 26)
- No JSDoc or TSDoc present anywhere in the codebase
- Section comments used only where intent might be unclear

## Function Design

- `chat(messages: ChatMessage[])` — typed array parameter
- `getNextService()` — no parameters, accesses module-level state
- `chat()` returns `Promise<AsyncIterable<string>>` per the `AIService` interface
- Async generator pattern used via IIFE: `(async function* () { ... })()`
- Note: `services/cerebras.ts` returns the generator function itself (not the invoked result), diverging from the interface contract — this is a bug
- `currentServiceIndex` in `index.ts` is mutable module-level state managing round-robin routing
- Services (Groq client, Cerebras client) are instantiated once at module load as module-level singletons

## Module Design

- Named exports only: `export const groqService`, `export const cerebrasService`
- No default exports

## Bun-Specific Conventions

- Use `Bun.serve()` for HTTP — no Express
- Use `bun:sqlite` for SQLite — no `better-sqlite3`
- Use `Bun.redis` for Redis — no `ioredis`
- Use `Bun.sql` for Postgres — no `pg`
- Use `Bun.file` over `node:fs` readFile/writeFile
- Bun auto-loads `.env` — do not use `dotenv`
- Use `bun test` — not Jest or Vitest
- Use `bun build` — not webpack or esbuild

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| HTTP Server | Request routing, SSE response relay, health check | `index.ts` |
| Round-robin router | Stateless service index cycling (`getNextService`) | `index.ts` |
| Groq service | Wraps groq-sdk, streams completions from Groq Cloud | `services/groq.ts` |
| Cerebras service | Wraps cerebras SDK, streams completions from Cerebras | `services/cerebras.ts` |
| Type definitions | Shared `AIService` interface, `ChatMessage` type | `types.ts` |

## Pattern Overview

- `Bun.serve()` native HTTP server — no Express or external framework
- Round-robin provider selection via module-level mutable index (`currentServiceIndex`)
- All provider responses are async generator streams forwarded as SSE (`text/event-stream`)
- Providers conform to a shared `AIService` interface defined in `types.ts`
- SDK clients instantiated once at module load time (module-level singletons)

## Layers

- Purpose: Receive HTTP requests, apply routing logic, return responses
- Location: `index.ts`
- Contains: `Bun.serve()` config, route handlers, round-robin selector
- Depends on: service singletons from `services/`, types from `types.ts`
- Used by: downstream HTTP clients
- Purpose: Encapsulate provider SDK calls and normalize output to async generator streams
- Location: `services/groq.ts`, `services/cerebras.ts`
- Contains: SDK client instances, `AIService` implementations, async generator adapters
- Depends on: `groq-sdk`, `@cerebras/cerebras_cloud_sdk`, `types.ts`
- Used by: `index.ts`
- Purpose: Define shared data contracts between layers
- Location: `types.ts`
- Contains: `ChatMessage` interface, `AIService` interface
- Depends on: nothing
- Used by: all other modules

## Data Flow

### Streaming Chat Request Path

### Health Check Path

## Key Abstractions

- Purpose: Common contract all provider adapters must satisfy
- Definition: `types.ts:6-9`
- Pattern: `{ name: string; chat: (messages: ChatMessage[]) => Promise<AsyncIterable<string>> }`
- Used by: `index.ts` to invoke providers uniformly
- Purpose: Typed message shape matching OpenAI's chat format
- Definition: `types.ts:1-4`
- Pattern: `{ role: "user" | "assistant" | "system"; content: string }`
- Purpose: Stateful round-robin across all registered providers
- Location: `index.ts:5-16`
- Pattern: Module-level mutable `currentServiceIndex`, wraps with modulo
- Note: State is process-local and resets on restart; no persistence or cooldown logic

## Entry Points

- Location: `index.ts:18`
- Triggers: `bun index.ts` or `bun run start`
- Responsibilities: Binds to `process.env.HOSTNAME ?? "0.0.0.0"` and `process.env.PORT ?? 3000`, registers all routes
- Location: `dist/index.js`
- Purpose: Compiled output artifact (not used by `bun run start`; likely from a prior build step)
- Note: Runtime uses `index.ts` directly via Bun's native TypeScript execution

## Architectural Constraints

- **Threading:** Single-threaded Bun event loop. No worker threads. All concurrency is async/await.
- **Global state:** Module-level mutable `currentServiceIndex` in `index.ts:10` is shared across all concurrent requests. Concurrent requests may observe non-deterministic provider ordering under load.
- **Circular imports:** None detected.
- **SDK initialization:** `groq` and `cerebras` client instances are module-level singletons. They read API keys from environment at import time (`services/groq.ts:4`, `services/cerebras.ts:5`).
- **No authentication:** The current implementation has no downstream auth. The `refactor.md` spec requires `Authorization: Bearer PERSONAL_PROXY_API_KEY` — this is not yet implemented.
- **No cooldown / failover:** Current round-robin is naive (blind index cycling). No rate-limit handling, no provider cooldown, no failover on 429.

## Anti-Patterns

### Mutable Module-Level State for Routing

### Type Assertion Bypass on Cerebras Messages

### Non-OpenAI-Compatible Route Structure

## Error Handling

- Unhandled provider errors will propagate as unhandled promise rejections and crash or produce an empty response
- 404 catch-all returns `new Response("Not found", { status: 404 })` for unknown routes (`index.ts:45`)
- No OpenAI-style error JSON bodies returned on failure

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.Codex/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-Codex-profile` -- do not edit manually.
<!-- GSD:profile-end -->
