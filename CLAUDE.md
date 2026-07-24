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

## 21. Architecture

> **Superseded by [`ARCHITECTURE.md`](./ARCHITECTURE.md) (repo root), which is the authoritative
> layering contract as of Phase 8.** The concern list below is still accurate; the `src/…` module
> sketch that followed it was never built and has been replaced by the hexagonal layout
> (`domain/`, `application/`, `adapters/`, `composition/` — no `src/`). Every concern named here
> survives, relocated: `routes/` → `adapters/inbound/http/routes/`, `middleware/` →
> `adapters/inbound/http/middleware/`, `providers/` → `adapters/outbound/`, `schemas/` →
> `adapters/inbound/http/schemas/`, `routing/` → `domain/provider-state.ts` +
> `domain/rate-limits.ts` + `domain/failure-classification.ts`.

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

Actual module layout (see `ARCHITECTURE.md` §4 for the annotated tree):

```text
domain/          types · errors · normalization · model-registry · rate-limits
                 failure-classification · provider-state · audio-limits
application/
  ports/         chat-provider · transcription · provider-state-store · clock · logger
  use-cases/     create-chat-completion · stream-chat-completion · transcribe-audio
                 list-models · get-readiness · get-provider-status
adapters/
  inbound/http/  server · router · read-limited-body · middleware/ · routes/ · presenters/ · schemas/
  outbound/      cerebras-chat-provider · groq-chat-provider · sdk-error-mapper
                 http-whisper · noop-whisper · console-logger · system-clock
composition/     container.ts
config.ts        loadConfig() + the default instance
index.ts         entrypoint + `export { createServer }`
tests/           architecture/ · domain/ · adapters/ · unit/ · integration/
```

Keep provider-specific behavior isolated inside adapters. `adapters/outbound/sdk-error-mapper.ts`
is the only module permitted to name a vendor SDK error class.

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

- `@cerebras/cerebras_cloud_sdk` ^1.59.0 (resolved 1.59.0) — official Cerebras inference SDK; used in `adapters/outbound/cerebras-chat-provider.ts`
- `groq-sdk` ^0.37.0 (resolved 0.37.0) — official Groq SDK; used in `adapters/outbound/groq-chat-provider.ts`
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

- kebab-case for every module file: `create-chat-completion.ts`, `sdk-error-mapper.ts`, `read-limited-body.ts`
- Layer directories are top-level and lowercase: `domain/`, `application/`, `adapters/`, `composition/`
- No barrel `index.ts` inside directories — every module is imported by its real path
- Factory functions are `create*` / `build*`: `createModelRegistry`, `createProviderStateStore`,
  `createCerebrasChatProvider`, `buildContainer`
- Use-case modules export a single factory named after the use case: `createChatCompletion`,
  `transcribeAudio`, `getReadiness`
- Route modules export a `match*` / `handle*` pair: `matchModels` / `handleModels`
- Ports are `*Port` interfaces: `ChatProviderPort`, `TranscriptionPort`; other interfaces are
  PascalCase nouns: `Container`, `ProviderStateStore`, `Clock`, `Logger`, `UpstreamFailure`
- `const` preferred; `let` only where mutation is required, and only inside a closure
- Named exports exclusively — no default exports anywhere
- `interface` for object shapes; `type` for unions and aliases

## Code Style

- No formatter config detected (no `.prettierrc`, `biome.json`, or `.editorconfig`)
- 4-space indentation throughout
- Quote style is not enforced; single quotes dominate in newer modules
- TypeScript strict mode is the primary enforcement mechanism (see `tsconfig.json`)
- `strict: true` — all strict checks enabled
- `noUncheckedIndexedAccess: true` — array/index access returns `T | undefined`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`
- `verbatimModuleSyntax: true` — requires `import type` for type-only imports
- `noUnusedLocals: false`, `noUnusedParameters: false` — unused identifiers are not flagged
- Target: `ESNext`; Module: `Preserve` (Bun bundler mode)

## Import Organization

- `import type { … }` for every type-only import — required by `verbatimModuleSyntax`
- Value imports first, then type imports, roughly grouped by layer distance
- Relative paths only; no path aliases configured
- **Import direction is enforced by `tests/architecture/boundaries.test.ts`** — see
  `ARCHITECTURE.md` §2 and §6. An import that crosses a layer boundary the wrong way fails `bun test`.

## Error Handling

- Domain errors are declared in `domain/errors.ts`; use cases return discriminated results
  (`{ ok: false, kind: … }`) rather than throwing across a layer boundary
- Vendor SDK errors are flattened to `UpstreamFailure` at the adapter edge by
  `adapters/outbound/sdk-error-mapper.ts` — the only module that names an SDK error class
- Presenters own the mapping from a domain result to a wire error shape; no use case builds a `Response`
- Every route returns a structured error body; the SSE stream always closes with `data: [DONE]`
- No `as any` casts in production modules; narrowing uses typed `unknown` guards

## Logging

- Structured JSON via the `Logger` port (`adapters/outbound/console-logger.ts`), gated by `LOG_LEVEL`
- Stable event names: `request_complete`, `provider_cooldown`, `provider_failover`, `usage_missing`,
  `stream_error_before_first_chunk`, `stream_error_after_first_chunk`, `transcription_complete`,
  `transcription_failed`, `gemini_transcription_complete`, `gemini_transcription_failed`
- **Never logged:** API keys, `Authorization` headers, prompt or response content, base64 audio,
  decoded bytes, filenames, transcript text

## Comments

- Comments explain *why*, and cite the requirement or decision ID that motivated the code
  (`WR-01`, `CR-02`, `NORM-03`, `HEX-05`, `V-04`, `T-08-03-01`)
- Load-bearing invariants carry a prominent warning comment — see the pre-auth segment in
  `adapters/inbound/http/router.ts`
- Some inline comments are in Spanish for business context; both languages appear

## Function Design

- Dependencies arrive through an explicit `deps` object, never through module-level imports of
  concrete implementations
- Use cases are curried factories: `createChatCompletion(deps)` returns `run(input)`
- Async generator pattern used via IIFE: `(async function* () { … })()`
- No module-level mutable state in `domain/`, `application/`, or `adapters/`; the single
  `Container` instance is memoized in `composition/container.ts`
- SDK clients are constructed lazily inside their factory closure, never at import time

## Module Design

- Named exports only; no default exports
- No re-export-only modules — the boundary guard rejects them (the Phase 8 shims are gone)

## Bun-Specific Conventions

- Use `Bun.serve()` for HTTP — no Express
- Use `bun:sqlite` for SQLite — no `better-sqlite3`
- Use `Bun.redis` for Redis — no `ioredis`
- Use `Bun.sql` for Postgres — no `pg`
- Use `Bun.file` over `node:fs` readFile/writeFile
- Bun auto-loads `.env` — do not use `dotenv`
- Use `bun test` — not Jest or Vitest

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

> **The authoritative layering contract is [`ARCHITECTURE.md`](./ARCHITECTURE.md) at the repo root.**
> It defines the per-layer import allowlists, the allowed/forbidden port primitives, the
> de-vendoring seam, and the five enforcement rules. This section is a map; that file is the law.
> Established in Phase 8; the gap report that motivated it is
> `.planning/phases/08-hexagonal-architecture-audit-refactor/08-ARCHITECTURE-AUDIT.md`.

## System Overview

Hexagonal / ports-and-adapters. Dependencies point inward only: adapters know ports, ports never
know adapters. Layers are top-level directories — there is no `src/`.

```text
Client
  |  Authorization: Bearer PERSONAL_PROXY_API_KEY   (or x-goog-api-key / ?key= on the Gemini route)
  v
adapters/inbound/http/          delivery: ordered router, middleware, routes, presenters, Zod schemas
  v
application/use-cases/          orchestration: eligibility -> attempt -> classify -> cooldown -> failover
  |                             (returns domain results; never an HTTP Response)
  v
domain/                         pure policy: normalization, rate limits, failure classification,
                                provider state, model registry
  ^
application/ports/              5 interfaces the outer layers implement
  ^
adapters/outbound/              Cerebras + Groq SDK providers, whisper HTTP/noop, logger, clock,
                                sdk-error-mapper (the ONLY vendor-aware module)
  ^
composition/container.ts        the single wiring point; config.ts is the single env ingress
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Entrypoint | `import.meta.main` guard; builds the container, starts the server | `index.ts` (23 lines) |
| Composition root | Builds every adapter and injects it; parses `MODEL_REGISTRY_JSON` | `composition/container.ts` |
| Config | The only module reading `process.env` for configuration | `config.ts` |
| HTTP server | `Bun.serve()`, request id, delegates to the router | `adapters/inbound/http/server.ts` |
| Router | Ordered table: pre-auth segment, Bearer gate, post-auth segment, 404 | `adapters/inbound/http/router.ts` |
| Routes | One module per endpoint; wire shapes only | `adapters/inbound/http/routes/*.ts` |
| Presenters | OpenAI error, Gemini error, SSE framing | `adapters/inbound/http/presenters/*.ts` |
| Middleware | Request id, Bearer auth (constant-time) | `adapters/inbound/http/middleware/*.ts` |
| Chat orchestration | Provider selection, failover, cooldown, normalization | `application/use-cases/{create,stream}-chat-completion.ts` |
| Transcription | One use case behind both the OpenAI and Gemini routes | `application/use-cases/transcribe-audio.ts` |
| Provider state | Injectable store: eligibility, cooldowns, round-robin cursor | `domain/provider-state.ts` |
| Failure policy | `classifyUpstreamFailure` — failover vs terminal status sets | `domain/failure-classification.ts` |
| Vendor error mapping | `toUpstreamFailure` — the only `instanceof APIError` site | `adapters/outbound/sdk-error-mapper.ts` |
| Provider adapters | Cerebras / Groq SDK factories, clients built lazily inside the closure | `adapters/outbound/{cerebras,groq}-chat-provider.ts` |

## Pattern Overview

- `Bun.serve()` native HTTP server — no Express or external framework
- Ordered route table; the pre-auth segment (`/health`, `/ready`, Gemini `:generateContent`) is
  matched **before** the Bearer gate and that ordering is load-bearing
- Use cases return discriminated results (`{ ok: true, … } | { ok: false, … }`); presenters map
  them to wire shapes. No use case constructs a `Response`
- Dependency injection via hand-written factory functions — no DI container library
- Stateful round-robin with per-provider cooldown, held in one injected store instance
- SSE framing lives entirely in `presenters/sse.ts`; the streaming use case yields `StreamChunk`
  objects and never throws, so the sentinel is always emitted

## Layers

- **Domain** (`domain/`) — pure policy. May import only other `domain/` modules. No npm SDK, no
  `zod`, no `Bun.*`, no `Request`/`Response`/`Headers`, no `process.env`, no `config`.
- **Application** (`application/use-cases/`, `application/ports/`) — orchestration and the port
  interfaces. May import `domain/` and `application/ports/`. No adapters, no `config`, no transport types.
- **Adapters** (`adapters/inbound/**`, `adapters/outbound/**`) — everything that talks to the
  outside world. May import ports, `domain/`, and their own vendor SDK.
- **Composition** (`composition/`, `config.ts`, `index.ts`) — may import everything; the only
  layer allowed to read `process.env` and construct concrete adapters.

## Key Abstractions

- `ChatProviderPort` (`application/ports/chat-provider.ts`) — `complete()` / `stream()`; two
  interchangeable implementations, mocked directly in the integration suite
- `TranscriptionPort` (`application/ports/transcription.ts`) — `transcribe()` / `health()`
- `ProviderStateStore` (`application/ports/provider-state-store.ts`) — eligibility, cooldown,
  cursor, snapshot, reset; created by `createProviderStateStore({ order, clock, configured, resolveUpstreamModel })`
- `Clock` and `Logger` — injected so domain and application code never read the wall clock or
  `console` directly
- `UpstreamFailure` (`domain/types.ts`) — the provider-agnostic failure shape that replaces vendor
  `APIError` inside routing policy

## Entry Points

- `index.ts` — `bun index.ts` or `bun run start`. Builds the container, calls `createServer`, logs
  the bound URL. Also re-exports `createServer` for tests and embedders.
- `adapters/inbound/http/server.ts` — `createServer(adapters?, port?, whisperService?, audioMaxFileBytes?, deps?)`.
  The optional `deps` parameter accepts a `Partial<Container>` so tests inject their own store.

## Architectural Constraints

- **Threading:** Single-threaded Bun event loop. No worker threads. All concurrency is async/await.
- **Global state:** None in the layer directories. The single `Container` instance is memoized in
  `composition/container.ts` and shared by every `createServer()` call that does not inject its own.
- **Import-time side effects:** None. Importing any module under `domain/`, `application/`, or
  `adapters/` constructs nothing and reads no env — enforced by the boundary guard.
- **Circular imports:** None detected.
- **SDK initialization:** Both provider clients are created lazily inside their factory closures,
  never at module load.

## Enforcement

`tests/architecture/boundaries.test.ts` is executable architecture. It fails `bun test` on: a
forbidden layer import, a vendor/zod/transport construct in an inner layer, a stray `process.env`
read outside `config.ts`, a top-level import-time construction, or a re-export-only shim module.
See `ARCHITECTURE.md` §6 for the full rule table.

## Error Handling

- All error paths return a structured body: OpenAI shape `{ error: { message, type, code, param } }`
  everywhere except the Gemini route, which returns `{ error: { code, message, status } }` with no
  `type` key
- Upstream messages pass through `rewriteUpstreamModelIds()` so provider model IDs never leak
- Streaming errors are logged and the SSE stream is closed with `data: [DONE]` — clients never hang
- 404 catch-all returns the OpenAI error shape (NORM-10)

## Cross-Cutting Concerns

- **Request ID:** generated per request, attached to every response as `X-Request-ID`
- **Auth:** constant-time Bearer comparison with padded buffers; never logged or echoed
- **Logging:** structured JSON metadata only — never keys, prompts, responses, audio, or transcripts
- **Size limits:** enforced on actual buffered bytes, never on a declared `Content-Length`

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
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
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
