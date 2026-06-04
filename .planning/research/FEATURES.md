# Features Research: OpenAI-Compatible Proxy

**Domain:** OpenAI-compatible HTTP proxy middleware (Bun, Cerebras + Groq backends)
**Researched:** 2026-06-04
**Overall confidence:** HIGH — sourced from openai-node and openai-python official source code, Groq and Cerebras official docs

---

## Table Stakes

Features that break clients if missing. Verified against openai-node SDK source (`error.ts`, `completions.ts`) and openai-python SDK source (`_base_client.py`, `chat_completion.py`, `chat_completion_chunk.py`).

### 1. POST /v1/chat/completions — Non-Streaming Response Contract

**Why required:** Every OpenAI-compatible client (openai-node, openai-python, litellm, LangChain) parses this exact shape. Missing or mis-typed fields cause runtime errors.

**Exact required response shape:**

```json
{
  "id": "chatcmpl-<string>",
  "object": "chat.completion",
  "created": 1769729480,
  "model": "<logical-alias>",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<string or null>"
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

**Field-level rules:**
- `id` — must be a non-empty string; openai-node stores it directly
- `object` — must be exactly the string `"chat.completion"`; SDK and litellm branch on this literal
- `created` — Unix timestamp integer in seconds; openai-python stores it for metadata
- `model` — must be the logical proxy alias, not the upstream provider model ID; clients use this to identify which model responded
- `choices[0].index` — must be `0` for single-choice responses; openai-node indexes into this
- `choices[0].message.role` — must be `"assistant"` for all normal completions
- `choices[0].message.content` — string or `null`; clients check for null when tool_calls are present
- `choices[0].finish_reason` — must be one of `"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`, or `null` (null only during streaming mid-stream); clients gate behavior on this value
- `usage` — technically optional in the OpenAI spec, but litellm, LangChain, and cost-tracking clients fail or warn loudly when it is absent; treat as required for proxy purposes

**Complexity:** Low — normalization pass on upstream response

**Dependencies:** Response normalization layer; model alias rewrite

---

### 2. POST /v1/chat/completions — Streaming (SSE) Response Contract

**Why required:** The openai-node `stream()` helper and openai-python `stream()` context manager iterate `ChatCompletionChunk` objects. Any structural deviation causes silent data loss or hard exceptions.

**Wire format per chunk:**

```
data: {"id":"chatcmpl-<string>","object":"chat.completion.chunk","created":1769729480,"model":"<logical-alias>","choices":[{"index":0,"delta":{"role":"assistant","content":"<token>"},"finish_reason":null}]}

data: [DONE]
```

**Field-level rules:**
- `object` — must be exactly `"chat.completion.chunk"` on every chunk; openai-python Pydantic model uses `Literal["chat.completion.chunk"]` for validation
- `id` — must be the same string on every chunk; clients reconstruct the full ID from the first chunk
- `created` — must be the same integer on every chunk
- `model` — must be the logical proxy alias on every chunk; rewrite before relaying
- `choices[0].delta` — object containing incremental fields; on the first chunk `delta.role` = `"assistant"`, subsequent chunks omit `role`; `delta.content` is the text fragment (can be `null` or empty string)
- `choices[0].finish_reason` — `null` on all chunks except the last content chunk; on the final content chunk it must be `"stop"` (or `"length"` etc.)
- `data: [DONE]` — required sentinel on its own line; both SDKs break iteration on this literal; not a JSON object; no trailing newlines after the final `\n\n`

**HTTP headers required:**
- `Content-Type: text/event-stream` — required; openai-node checks for SSE content-type when deciding how to parse the body
- `Cache-Control: no-cache` — recommended; prevents proxies from buffering the stream
- `Transfer-Encoding: chunked` or HTTP/1.1 with no `Content-Length` — required for incremental delivery

**SSE formatting:**
- Each event: `data: <json>\n\n` (two newlines to terminate the event)
- No `event:` or `id:` prefix needed; data-only SSE
- No buffering — forward each chunk as received from upstream SDK

**Complexity:** Medium — SSE relay with per-chunk model field rewrite; no buffering

**Dependencies:** Stream relay; model alias rewrite; upstream SDK streaming iterable

---

### 3. GET /v1/models — Response Contract

**Why required:** openai-node and openai-python both call this endpoint when constructing clients with `client.models.list()`. LiteLLM validates models at startup. More importantly, any client using model auto-discovery will 404 or fail silently on a missing endpoint.

**Exact required response shape:**

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

**Field-level rules:**
- `object` — must be `"list"` at the top level
- `data[]` — array; can be empty but must exist
- `data[].id` — must be the logical alias string
- `data[].object` — must be `"model"` per-item
- `data[].created` — integer; acceptable to return `0` for synthetic aliases
- `data[].owned_by` — string; any non-empty value is fine; `"personal-proxy"` or `"proxy"` is conventional

**Complexity:** Low — static response from model registry

**Dependencies:** Model registry

---

### 4. OpenAI-Shaped Error Responses

**Why required:** The openai-node SDK (`core/error.ts`) specifically unwraps `response.error.message`, `response.error.type`, `response.error.code`, and `response.error.param` from the response body. The openai-python SDK (`_base_client.py`) attempts to parse the body as JSON and wraps it in a typed exception. Non-conforming error bodies cause clients to show generic or misleading error messages; worse, typed error subclasses (`AuthenticationError`, `RateLimitError`, etc.) are only instantiated when the SDK recognises the shape.

**Required error shape:**

```json
{
  "error": {
    "message": "Human-readable description of what went wrong",
    "type": "invalid_request_error",
    "code": null,
    "param": null
  }
}
```

**Status-to-type mapping** (follow OpenAI conventions so SDK subclasses map correctly):

| HTTP Status | `type` value | SDK exception class |
|-------------|--------------|---------------------|
| 400 | `"invalid_request_error"` | `BadRequestError` |
| 401 | `"authentication_error"` | `AuthenticationError` |
| 403 | `"permission_denied_error"` | `PermissionDeniedError` |
| 404 | `"not_found_error"` | `NotFoundError` |
| 422 | `"invalid_request_error"` | `UnprocessableEntityError` |
| 429 | `"rate_limit_error"` | `RateLimitError` |
| 500+ | `"api_error"` | `InternalServerError` |

**Field-level rules:**
- Response must be `Content-Type: application/json`
- Top-level key must be `"error"` — the Node SDK does `response?.['error']` unwrap
- `message` — required string; becomes the exception message in both SDKs
- `type` — required string; used by Node SDK for display; openai-python uses HTTP status for class selection
- `code` — `null` is acceptable; present when the error has a machine-readable code
- `param` — `null` is acceptable; present when the error references a specific request parameter

**Complexity:** Low — standardised error utility function

**Dependencies:** Auth middleware, request validation, routing errors

---

### 5. Bearer Authentication — 401 on Invalid/Missing Credentials

**Why required:** openai-node and openai-python both send `Authorization: Bearer <key>` and expect a `401` on failure, which maps to `AuthenticationError` in both SDKs. Clients that have retry logic (e.g., litellm fallback chains) will wrongly retry 401s if they receive a non-standard status code.

**Exact behavior:**
- Missing `Authorization` header → `401` with `{"error": {"message": "Missing API key", "type": "authentication_error", ...}}`
- Invalid key → `401` with same shape
- Never reveal whether the key was close, expired, or simply wrong
- Use constant-time comparison to prevent timing-based key enumeration

**Complexity:** Low — middleware that runs before all protected routes

**Dependencies:** Error response utility

---

### 6. Request Field Allowlist — Reject Unsupported Fields with 400

**Why required:** The proxy contract is the intersection of Cerebras and Groq capabilities. Forwarding unsupported fields to either provider causes that provider to return 400, which the proxy would have to handle anyway. Reject early for deterministic client feedback.

**Fields that must cause 400 if present (Groq explicitly rejects these):**
- `logprobs`
- `logit_bias`
- `top_logprobs`
- `messages[].name`
- `n` with a value other than `1`

**Fields to silently strip before forwarding (provider-specific extras the proxy adds or normalises):**
- None in MVP — strict allowlist means unrecognised fields return 400, not silent strip

**MVP allowlisted passthrough fields:**
- `model` (required)
- `messages` (required)
- `temperature`
- `top_p`
- `max_completion_tokens`
- `stream`
- `stop`
- `seed`
- `stream_options` (pass through; both providers support `include_usage`)

**Complexity:** Low-Medium — schema validation at route entry; Zod or manual check

**Dependencies:** Schema definitions; error response utility

---

### 7. Model Alias Resolution — 400 on Unknown Alias

**Why required:** Upstream providers will return 404 or a confusing model-not-found error for unknown model IDs. The proxy must own the validation and return an intelligible 400 before the upstream call is made. openai-node clients surface `BadRequestError` for 400s, which is the correct semantics.

**Behavior:**
- Lookup `request.model` in the registry
- If not found: `400 {"error": {"message": "Unknown model: <alias>", "type": "invalid_request_error", "code": "model_not_found", "param": "model"}}`
- If found but no eligible provider for that alias at this moment: return 503 with a provider-unavailable error shape

**Complexity:** Low — registry lookup before provider selection

**Dependencies:** Model registry; provider state

---

### 8. X-Request-ID Response Header

**Why required:** openai-node SDK automatically reads the `x-request-id` response header and exposes it as `response._request_id` on all response objects. openai-python does the same. Downstream clients (LangChain traces, litellm logging, custom instrumentation) log this for request correlation. Absence is non-fatal but breaks standard SDK observability patterns.

**Behavior:**
- Generate a UUID v4 per request at middleware entry
- Return `X-Request-ID: <uuid>` on all responses including error responses
- Log the same UUID in structured logs for correlation

**Complexity:** Low — UUID generation in request-ID middleware

**Dependencies:** Request-ID middleware runs before routing

---

### 9. Response Normalization — Strip Provider-Specific Fields

**Why required:** Cerebras and Groq both return fields not in the OpenAI spec. Forwarding these to clients causes schema validation failures in strictly-typed clients (openai-python Pydantic, litellm validators) and may leak implementation details.

**Fields to remove before returning to client:**

Cerebras:
- `choices[*].message.reasoning` — chain-of-thought; must never be exposed
- `choices[*].reasoning_logprobs`
- `time_info` — Cerebras-specific telemetry object

Groq:
- `x_groq` — Groq request metadata object (contains Groq's internal request ID)
- `usage_breakdown` — Groq compound-system token breakdown; not in OpenAI spec

**Behavior for streaming:**
- Strip the same fields from each chunk delta where applicable
- Rewrite `model` field in every chunk to the logical alias

**Complexity:** Low — object key deletion pass in normalizer

**Dependencies:** Response normalizer; streaming relay

---

## Differentiators

Features that add value without breaking clients if absent.

### 1. X-LLM-Provider Diagnostic Header (opt-in)

**Value proposition:** Debugging aid for developers who want to know which backend served a request without looking at logs. Controlled by `EXPOSE_PROVIDER_HEADER=true` env var, default off.

```http
X-LLM-Provider: cerebras
```

Default off ensures no provider leakage in production. Turn on during development.

**Complexity:** Low — conditional header in response normalizer

---

### 2. GET /ready — Degraded-Mode Readiness Check

**Value proposition:** Health check that distinguishes "nothing configured" from "one provider temporarily down." Container orchestrators (EasyPanel, Kubernetes) can use this to avoid routing to an unconfigured instance while allowing a degraded-but-functional instance to continue serving.

```json
{
  "ready": true,
  "mode": "degraded",
  "eligibleProviders": ["cerebras"],
  "unavailableProviders": ["groq"]
}
```

**Complexity:** Low — query provider state, check model registry

---

### 3. GET /internal/providers/status — Protected Diagnostics

**Value proposition:** Rate-limit snapshot, cooldown expiry, consecutive failure counts without requiring log access. Protected by the same `PERSONAL_PROXY_API_KEY`.

**Complexity:** Low — serialize provider state to JSON

---

### 4. Structured JSON Logging (per request)

**Value proposition:** Debugging provider selection, failover, and quota events without adding external monitoring. Correlatable via `X-Request-ID`.

**Log fields:** request ID, timestamp, logical model alias, chosen provider, upstream model ID, attempt number, streaming flag, status code, latency ms, failover reason, cooldown expiry, token usage, captured rate-limit headers.

**Complexity:** Low-Medium — logger utility wrapping `console.log` with JSON serialisation; LOG_LEVEL env var for verbosity gating

---

### 5. stream_options.include_usage Passthrough

**Value proposition:** Clients that set `stream_options: {"include_usage": true}` will receive a final usage chunk before `[DONE]`. Both Groq and Cerebras appear to support this. Passing it through lets cost-tracking clients get token counts in streaming mode without making a separate non-streaming call.

**Complexity:** Low — add `stream_options` to the allowlisted fields; relay as-is

---

### 6. Provider Cooldown Recovery Logging

**Value proposition:** Logs when a provider re-enters rotation after cooldown expiry. Useful for diagnosing quota patterns on free-tier accounts.

**Complexity:** Low — add log emission in cooldown manager when `Date.now() > cooldownUntil`

---

## Anti-Features

Deliberately excluded from this proxy. Rationale included for future reference.

### 1. Tool Calling / Function Calling

**Why excluded:** Both providers support tools but with diverging edge cases (streaming tool calls, parallel tool calls, `tool_choice` semantics). The shared model (`gpt-oss-120b`) has not been tested across both providers for tool-calling compatibility. Enabling untested features violates the "intersection contract only" principle. A broken tool call mid-stream is harder to debug than a clean 400 at validation.

**What to do instead:** Add to allowlist only after explicit cross-provider testing with the registered model alias.

---

### 2. response_format (JSON mode / JSON schema)

**Why excluded:** Same reason as tools — diverging provider behaviour for structured outputs under streaming and non-streaming paths. Cerebras has more complete JSON schema support; Groq has beta structured outputs. Needs explicit compatibility testing per model.

---

### 3. logprobs / top_logprobs

**Why excluded:** Groq explicitly rejects these fields with a 400. Passing them to Groq would always fail half the round-robin. Cerebras supports logprobs, but offering them from the proxy would require Groq-path fallback handling that contradicts the intersection contract.

---

### 4. n > 1 (Multiple Completions per Request)

**Why excluded:** Groq requires `n = 1`. Groq would return 400 for `n > 1`. The intersection contract means this cannot be offered.

---

### 5. Legacy /v1/completions Endpoint

**Why excluded:** No modern client uses the non-chat completions endpoint for LLM work. Adding it would be dead code that increases surface area without value.

---

### 6. /v1/embeddings, /v1/audio/*, /v1/images/*

**Why excluded:** Out of scope for inference routing. Neither Cerebras nor Groq are used here for embeddings or media. Adding stubs would create confusion about what the proxy actually does.

---

### 7. Persistent Conversation Storage

**Why excluded:** Clients own conversation state. The proxy is stateless by design. Adding storage would add a database dependency and change the operational profile of what is intentionally a thin routing layer.

---

### 8. Frequency Penalty / Presence Penalty (for now)

**Why deferred:** Cerebras accepts these fields. Groq compatibility is undocumented at the intersection level. Per refactor.md spec: "allow only after provider compatibility tests." Not an anti-feature permanently — re-evaluate after testing.

---

### 9. reasoning_effort Passthrough

**Why excluded:** This is a Cerebras-specific parameter (for `gpt-oss-120b`). Groq does not support it. Passing it through would fail on Groq. Strip if present in incoming requests; return 400 with a clear message.

---

## Client Compatibility Notes

### openai-node (TypeScript/JavaScript)

**Error parsing (HIGH confidence — source verified):**
- The SDK calls `(errorResponse as Record<string, any>)?.['error']` to unwrap the error object
- Then reads `.message`, `.type`, `.code`, `.param` from the unwrapped object
- If `error.message` is present and non-null, it becomes the exception message
- If the body is not valid JSON or lacks an `error` key, the SDK falls back to a generic message with the HTTP status code
- Implication: always return `{"error": {...}}` — a flat `{"message": "..."}` at root level will NOT be parsed correctly as an `AuthenticationError` or `RateLimitError`

**Request ID (HIGH confidence — source verified):**
- Reads `x-request-id` response header and exposes as `response._request_id`
- Available on all response objects and error objects as `err.request_id`

**Streaming iteration (HIGH confidence — source verified):**
- Uses async iteration over `ChatCompletionChunk` objects
- `chunk.choices[0]?.delta?.content` is the standard access pattern
- `chunk.choices[0]?.finish_reason` signals end-of-stream content (but `[DONE]` terminates the loop)
- `chunk.object` must be `"chat.completion.chunk"` — the TypeScript type is `Literal`

**temperature = 0 warning:**
- Groq silently converts `temperature: 0` to `1e-8`; this is transparent to clients but means exact zero-temperature reproducibility is not guaranteed on the Groq path

### openai-python

**Error parsing (HIGH confidence — source verified):**
- `_make_status_error_from_response` parses the body as JSON opaquely (no field-level validation at the base client level)
- The Python SDK uses HTTP status code to select the exception class (`AuthenticationError` on 401, `RateLimitError` on 429, etc.)
- The `body` property on exceptions holds the parsed JSON dict
- Implication: correct HTTP status codes matter more than the `type` field for Python exception routing; the `type` field in the body is advisory for Python clients

**Streaming (HIGH confidence — source verified):**
- `ChatCompletionChunk` is a Pydantic model with `Literal["chat.completion.chunk"]` on `object`
- Pydantic will raise a `ValidationError` if `object` is not exactly `"chat.completion.chunk"` when using strict mode
- `choices` is typed as `List[Choice]` — an empty `choices` array is valid only on the final usage chunk when `stream_options.include_usage` is true

### LiteLLM

**Model field (MEDIUM confidence — docs + community sources):**
- LiteLLM reads the `model` field from the response to track which model was used
- Returning the upstream provider model ID instead of the logical alias will cause LiteLLM's tracking to show the wrong model

**Usage field (MEDIUM confidence):**
- LiteLLM reads `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` for cost calculation
- Missing `usage` causes LiteLLM to log a warning and skip cost attribution; not a crash but degrades observability

**Error codes (MEDIUM confidence):**
- LiteLLM maps HTTP status codes to retry behavior; 429 triggers backoff, 401 does not retry
- Standard OpenAI error shapes ensure LiteLLM's error handler recognises the response correctly

### General SSE / Streaming Clients (curl, fetch-based clients)

**[DONE] sentinel (HIGH confidence — multiple sources):**
- Must be sent as `data: [DONE]\n\n` (the exact bytes)
- Clients that manually parse SSE check for this literal string to stop processing
- Some clients also terminate on stream close, but the sentinel is the canonical signal

**Chunk buffering (HIGH confidence):**
- Must not buffer the entire response before flushing; clients that display partial output require incremental delivery
- Bun's `Bun.serve()` supports streaming responses via `ReadableStream` — use this, not string concatenation

---

## Feature Dependencies

```
Bearer auth middleware
  → runs before all protected routes
  → required by: /v1/chat/completions, /v1/models, /internal/providers/status

Request-ID middleware
  → runs before all routes
  → produces: X-Request-ID header, log correlation ID

Model registry
  → required by: model alias resolution, /v1/models response, provider routing
  → feeds: provider router (which providers serve this alias)

Provider router + state
  → required by: chat completions dispatch
  → feeds: cooldown manager, failover logic

Response normalizer
  → required by: non-streaming completion, each streaming chunk
  → strips: provider-specific fields
  → rewrites: model field to logical alias

Stream relay
  → required by: streaming chat completions
  → depends on: response normalizer (per-chunk), upstream SDK async iterator

Error response utility
  → required by: auth middleware, request validation, model resolver, provider errors, routing errors
  → must produce: {"error": {"message", "type", "code", "param"}} shape
```

---

## Sources

- openai-node source `src/resources/chat/completions/completions.ts` — ChatCompletion, ChatCompletionChunk, Delta types: https://github.com/openai/openai-node
- openai-node source `src/core/error.ts` — error body parsing, field extraction: https://github.com/openai/openai-node
- openai-python source `src/openai/types/chat/chat_completion_chunk.py` — ChatCompletionChunk Pydantic model: https://github.com/openai/openai-python
- openai-python source `src/openai/_base_client.py` — `_make_status_error_from_response`: https://github.com/openai/openai-python
- Groq OpenAI compatibility docs (unsupported fields): https://console.groq.com/docs/openai
- Groq API reference (x_groq field, usage_breakdown): https://console.groq.com/docs/api-reference
- Cerebras chat completions API reference: https://inference-docs.cerebras.ai/api-reference/chat-completions
- Context7 openai-node docs (streaming, Delta type, events): /openai/openai-node
- Context7 openai-python docs (ChatCompletionChunk, stream events): /openai/openai-python
