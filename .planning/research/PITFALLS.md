# Pitfalls Research

**Domain:** OpenAI-compatible proxy middleware (Bun, Cerebras + Groq)
**Researched:** 2026-06-04
**Overall Confidence:** HIGH — most claims verified against official SDK docs and Bun docs

---

## Critical Pitfalls

### P-CRIT-1: SDK Built-In Retries Fight Proxy-Level Failover

**What goes wrong:** Both `groq-sdk` and `@cerebras/cerebras_cloud_sdk` retry automatically up to 2 times by default with exponential backoff on 429, 408, 409, and >=500 errors. When the proxy also tries to fail over to the alternate provider, the SDK silently retries the same failing provider first — delaying the failover by the full backoff window. A 429 from Groq can produce a 47-second delay before the proxy-level fallback fires, because the SDK consumed both retry slots internally.

**Root cause:** The SDK's `maxRetries` defaults to 2, and neither SDK exposes a callback to observe retry attempts. The proxy has no visibility into in-flight SDK retries.

**Consequence:** The spec requires `MAX_PROVIDER_ATTEMPTS_PER_REQUEST=2` (two total provider tries), but SDK retries burn time before the proxy's failover logic runs at all. Under quota pressure, a 429 that should trigger immediate failover causes a 30-60 second hang.

**Prevention:** Initialize both SDK clients with `maxRetries: 0`. The proxy owns retry policy; the SDK must not second-guess it.

```typescript
const groq = new Groq({ apiKey: ..., maxRetries: 0 });
const cerebras = new Cerebras({ apiKey: ..., maxRetries: 0 });
```

**Warning signs:** Tests showing 30-60 second delays on 429 errors; double-cooldown calculations.

**Phase:** Implement at adapter construction time (Phase 1, provider adapter setup).

---

### P-CRIT-2: SDK Default Timeout Is 1 Minute (Groq) — Mismatches Proxy Timeout

**What goes wrong:** `groq-sdk` defaults to a 1-minute request timeout. `@cerebras/cerebras_cloud_sdk` also has a default timeout. If `REQUEST_TIMEOUT_MS` is set to 120 seconds but the SDK fires its own timeout at 60 seconds, the proxy receives a timeout error from the SDK before the configured proxy timeout fires. The error will surface as `APIConnectionTimeoutError`, not as an HTTP status code, requiring adapter-level handling distinct from HTTP error handling.

**Prevention:** Set explicit `timeout` on SDK client construction equal to `REQUEST_TIMEOUT_MS` plus a small buffer (e.g., 5 seconds over proxy timeout) so the proxy timeout fires first via `AbortSignal`, not the SDK.

**Warning signs:** `APIConnectionTimeoutError` appearing instead of `AbortError` during timeout testing.

**Phase:** Adapter construction (Phase 1).

---

### P-CRIT-3: Streaming Failover After First Chunk Is Committed

**What goes wrong:** The spec correctly forbids failover after the first streaming chunk is delivered to the downstream client. However, the boundary is subtle: once any `data:` line is written into the `ReadableStream` controller and flushed to the client, the response headers and status 200 are already committed. If the upstream provider then errors mid-stream, the proxy cannot return a 500 — the connection must be closed without a structured error. Attempting to write an error JSON body after a streaming response has started will silently corrupt the stream or be ignored.

**Root cause:** HTTP does not allow changing the response status after headers are sent. SSE streams cannot be "un-started."

**Consequence:** Any attempt to transparently retry a failed mid-stream response produces a truncated output with no client-visible error. The client's parser may hang waiting for `data: [DONE]`.

**Prevention:**
1. Track a `firstChunkSent` boolean flag inside the stream relay.
2. Set it to `true` immediately after the first `controller.enqueue()` call.
3. Before the streaming loop starts, all provider selection and pre-flight happens. The point of no return is the first enqueue, not the `return new Response(stream)` call.
4. On mid-stream upstream error: close the stream (call `controller.close()` or `controller.error()`), which will cause the client connection to drop cleanly — no retry possible.

**Warning signs:** Missing `data: [DONE]` at end of stream; clients hanging after partial output.

**Phase:** Stream relay implementation.

---

### P-CRIT-4: Cooldown Calculation Off-By-One With Provider Reset Headers

**What goes wrong:** The spec formula is:
```
cooldownUntil = now + max(retryAfterSeconds, resetTokensSeconds, fallbackCooldownSeconds)
```

The reset headers from Groq (`x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`) are **duration strings** like `"2m59.56s"` or `"7.66s"` — not seconds as floats and not Unix timestamps. Treating them as raw numbers will produce wildly incorrect cooldowns (e.g., parsing `"7.66s"` as `7.66` seconds works accidentally, but `"2m59.56s"` parsed as a float returns `NaN` or `2` if truncated, causing a 2-second cooldown for a limit that resets in 3 minutes).

Cerebras reset headers (`x-ratelimit-reset-requests-day`, `x-ratelimit-reset-tokens-minute`) **are** seconds as floats (`33011.38...`), not duration strings.

Groq `retry-after` is a plain integer in seconds (`"2"`).

**Prevention:** Parse all three formats explicitly:
- Groq reset: duration string parser — extract minutes and seconds from patterns like `"2m59.56s"`, `"7.66s"`, `"120ms"`.
- Cerebras reset: `parseFloat(value)` in seconds — values like `33011.38` mean seconds until daily reset (do not use the day-level value as a cooldown; use token-minute reset instead).
- Groq `retry-after`: `parseInt(value, 10)` seconds.

```typescript
function parseGroqDuration(s: string): number {
  // "2m59.56s" -> 179.56 seconds
  // "7.66s" -> 7.66 seconds
  // "120ms" -> 0.12 seconds
  const minuteMatch = s.match(/(\d+)m/);
  const secondMatch = s.match(/(\d+\.?\d*)s/);
  const msMatch = s.match(/(\d+\.?\d*)ms/);
  const minutes = minuteMatch ? parseFloat(minuteMatch[1]) : 0;
  const seconds = secondMatch ? parseFloat(secondMatch[1]) : 0;
  const ms = msMatch ? parseFloat(msMatch[1]) / 1000 : 0;
  return minutes * 60 + seconds + ms;
}
```

**Warning signs:** Cooldown values in the thousands of seconds; providers recovering in 2 seconds when they should take 3 minutes.

**Phase:** Cooldown manager implementation.

---

## Streaming Pitfalls

### P-STREAM-1: Bun's Default 10-Second Idle Timeout Kills Quiet SSE Connections

**What goes wrong:** Bun introduced a default `idleTimeout` of 10 seconds in v1.1.26 (later reverted to 0 in v1.1.27). The Dockerfile pins `oven/bun:1.1.29` which is well past v1.1.26 but the behavior depends on the exact version deployed. More importantly, any future Bun update may re-enable an idle timeout. A quiet SSE connection — for example, during Cerebras processing a large prompt before returning the first token — will be dropped after 10 seconds of silence.

**Prevention:** Explicitly call `server.timeout(req, 0)` for all SSE responses in the route handler to disable the idle timeout for that specific request. Do not rely on the global default.

```typescript
routes: {
  "/v1/chat/completions": async (req, server) => {
    if (isStreamingRequest) {
      server.timeout(req, 0);
    }
    // ...
  }
}
```

**Warning signs:** Streaming requests silently disconnecting after exactly 10 seconds with no upstream error.

**Phase:** Streaming relay implementation.

---

### P-STREAM-2: Async Generator Returning Function Reference Instead of Iterable

**What goes wrong:** Already present as a bug in `services/cerebras.ts`. The pattern:
```typescript
return (async function* () { ... });  // BUG: returns function
```
instead of:
```typescript
return (async function* () { ... })();  // correct: invokes it
```
`new Response(fn, ...)` receives a function reference, not an async iterable. Bun's `Response` constructor silently accepts the function but produces an empty or broken body.

**Prevention:** TypeScript `AIService` interface should declare `chat()` return type as `Promise<AsyncIterable<string>>`, not `Promise<AsyncGenerator<string>>`. The calling code should `for await (const chunk of await service.chat(...))` which will throw immediately if the generator is not invoked — producing a clear type error.

**Warning signs:** Empty response body from Cerebras; no runtime error thrown.

**Phase:** Already a known bug to fix in refactor Phase 1.

---

### P-STREAM-3: Yielding Raw Delta Content Strings Breaks OpenAI SSE Wire Format

**What goes wrong:** Current Groq and Cerebras services yield raw content strings (`yield chunk.choices[0]?.delta?.content || ''`). The OpenAI SSE wire format requires each event to be:
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[...]}\n\n
```
not just the content string. An OpenAI SDK client parsing the stream will fail silently or throw because it expects to parse the `data:` prefixed JSON, not raw text.

**Prevention:** The stream relay must serialize full `ChatCompletionChunk` objects as `data: <JSON>\n\n` lines, not raw content. The final sentinel must be exactly `data: [DONE]\n\n`.

**Warning signs:** `openai` npm client throwing JSON parse errors when consuming the proxy's stream; curl showing plain text instead of `data:` prefixed lines.

**Phase:** Stream relay implementation.

---

### P-STREAM-4: Groq Streaming Usage Is in a Separate Extra Final Chunk

**What goes wrong:** When `stream_options: { include_usage: true }` is passed to Groq, an extra chunk is appended before `data: [DONE]` with `choices: []` (empty) and a populated `usage` field. This does not match OpenAI's streaming format, where the final content chunk includes `finish_reason: "stop"`. Forwarding this extra chunk verbatim to clients expecting standard OpenAI streaming will produce a chunk with empty `choices` that some clients fail to parse.

**Prevention:** Detect the Groq-specific pattern (empty `choices`, populated `usage`) in the stream relay's normalization pass. Merge the usage into the preceding `finish_reason: "stop"` chunk before forwarding, or drop the extra chunk if usage is not needed in stream output.

**Warning signs:** Client parsing error on a chunk with `choices: []`; usage appearing in an unexpected position.

**Phase:** Stream relay + response normalization.

---

### P-STREAM-5: Cerebras Usage and time_info Only in Final Streaming Chunk

**What goes wrong:** Cerebras sends `usage` and `time_info` only in the final streaming chunk (not in every chunk). If the stream relay yields content from `delta.content || ''` on every chunk, including the final one, it will also yield an empty string for the final metadata-only chunk. This empty yield becomes an extra `data: {"choices":[{"delta":{"content":""}}]}\n\n` event sent to the client. While not technically incorrect, it wastes bandwidth and can confuse strict parsers.

**Secondary issue:** The `time_info` field must be stripped from all forwarded chunks since it is Cerebras-specific and not in the OpenAI spec.

**Prevention:** Filter chunks with empty `delta.content` from the forward path. Strip `time_info` from all chunks before forwarding.

**Phase:** Stream relay + response normalization.

---

### P-STREAM-6: Upstream Abort Is Not Automatic on Client Disconnect

**What goes wrong:** If the downstream client disconnects mid-stream (user closes browser tab, timeout on their end, etc.), the upstream provider call continues consuming tokens and quota. The Bun `ReadableStream` `cancel()` callback fires when the client disconnects — but only if the stream is constructed correctly as a `ReadableStream` with a `cancel` method, or if the async generator's `for await` loop is inside the response body generator.

**Prevention:** Use Bun's native async generator response body pattern, which automatically cancels the generator when the client disconnects. If using `ReadableStream`, implement the `cancel()` callback to call `stream.controller.abort()` on the upstream SDK stream. Pass an `AbortController.signal` to each SDK call.

```typescript
const ac = new AbortController();
const upstreamStream = await groq.chat.completions.create(
  { ...params, stream: true },
  { signal: ac.signal }
);
// In ReadableStream cancel: ac.abort();
```

**Warning signs:** Provider quota draining unexpectedly; upstream requests still running after client disconnects (visible via provider dashboards).

**Phase:** Stream relay implementation.

---

## Provider Compatibility Pitfalls

### P-COMPAT-1: Cerebras Returns 400 (Not 422) for Unsupported Fields

**What goes wrong:** Cerebras returns HTTP 400 (not 422) for unsupported parameters like `frequency_penalty` and `presence_penalty`. The proxy's error routing table treats 400 as "invalid payload; do not fail over." This is correct — a 400 from Cerebras means the request itself is invalid (likely a field not in the intersection contract slipped through), not that the provider is unhealthy.

However, if the proxy forwards a request containing an unsupported field before validating at the proxy level, the 400 is unretryable and the request fails. The intersection validation (allowlist) must happen at the proxy before any upstream call.

**Prevention:** The proxy's allowlist validation must fire before provider selection, not after. A 400 from upstream is a code defect (missed validation), not a routing decision.

**Warning signs:** Upstream 400 errors appearing in logs for fields the proxy should have rejected; intermittent 400s when Cerebras receives a field that Groq silently accepts.

**Phase:** Request validation (Phase 1).

---

### P-COMPAT-2: Groq's `temperature = 0` Silently Mutates to `1e-8`

**What goes wrong:** Groq converts `temperature: 0` to `1e-8` internally. This means requests sent with `temperature: 0` for exact determinism may not produce fully deterministic results on Groq. The proxy passes `temperature` through without noting this behavior. Clients expecting deterministic outputs at `temperature: 0` will observe variance on Groq-routed requests.

**Prevention:** Document in the proxy's API contract that `temperature: 0` is not guaranteed deterministic across providers. Optionally intercept `temperature: 0` and warn in logs. Do not block the request — this is a known Groq behavior, not an error.

**Warning signs:** Client regression tests that assert exact output at `temperature: 0` failing non-deterministically depending on which provider handles the request.

**Phase:** Document in API contract; add to observability logging (Phase 2).

---

### P-COMPAT-3: Cerebras Streaming Chunks Contain `delta.reasoning` Field

**What goes wrong:** When a reasoning model is used (or reasoning is not explicitly disabled), Cerebras emits a `delta.reasoning` field in streaming chunks. This field is not in the OpenAI streaming spec. Forwarding it verbatim exposes chain-of-thought content to downstream clients, which the spec (section 26, rule 12) explicitly forbids. The reasoning content appears interleaved with `delta.content` chunks and must be stripped chunk-by-chunk, not just from the final response.

**Prevention:** In the stream relay, for each chunk, delete `choices[i].delta.reasoning` and `choices[i].reasoning_logprobs` before forwarding. Checking only the final non-streaming response is insufficient — reasoning leaks through stream chunks.

**Warning signs:** Downstream clients receiving `delta.reasoning` keys in streaming response; internal chain-of-thought visible to proxy users.

**Phase:** Stream relay normalization.

---

### P-COMPAT-4: Model Field in Streaming Chunks Uses Provider-Specific ID

**What goes wrong:** Both Groq and Cerebras populate the `model` field in streaming chunks with the upstream provider-specific model ID (e.g., `"openai/gpt-oss-120b"` from Groq, `"gpt-oss-120b"` from Cerebras), not the logical proxy alias. The normalization step that rewrites `model` to the logical alias must apply to every chunk, not just the final non-streaming response.

**Prevention:** In the stream relay's normalization pass, rewrite `chunk.model` to the logical alias for every forwarded chunk. This is straightforward since the logical alias is known at request time.

**Warning signs:** Clients seeing provider-specific model IDs in streaming responses; alias leakage in chunk-level logs.

**Phase:** Stream relay normalization.

---

### P-COMPAT-5: Groq 498 Error Is Not Documented as Standard HTTP

**What goes wrong:** Groq returns HTTP 498 for "Flex Tier Capacity Exceeded." This is a non-standard HTTP status code not defined in any RFC. TypeScript's `fetch` API, Groq's SDK, and any HTTP middleware will handle it as a generic 4xx error. The proxy's error routing table must explicitly handle 498 as "fail over to alternate provider" — it should not be treated as a client error (which would suppress failover).

**Prevention:** Add explicit `case 498` in the error routing logic alongside `429`.

**Warning signs:** Requests failing permanently when Groq returns 498 instead of routing to Cerebras.

**Phase:** Error routing implementation.

---

### P-COMPAT-6: Intersection Contract Drift When Provider Fields Are Silently Accepted

**What goes wrong:** Groq may silently accept fields that Cerebras rejects (e.g., `frequency_penalty`). If a field is in the request and Groq succeeds, but Cerebras returns 400 on the next round-robin call, the behavior is non-deterministic from the client's perspective. The client gets alternating success/failure with no explanation.

**Prevention:** Strict allowlist at proxy entry. Any field not on the explicit allowlist is rejected with 400 before it reaches any provider. The allowlist definition must be the intersection — fields accepted by both providers, tested.

**Warning signs:** Alternating 200/400 responses for the same request payload.

**Phase:** Request validation (Phase 1).

---

## Security Pitfalls

### P-SEC-1: SDK Error Objects May Include Provider Configuration Details

**What goes wrong:** Catching `Cerebras.APIError` or `Groq.APIError` and propagating `err.message` or `err.headers` to the downstream client can expose provider base URLs, upstream auth error messages (e.g., "Invalid API key for https://api.groq.com"), internal request IDs, or rate-limit state. Both SDKs attach the HTTP response headers to error objects via `err.headers`.

**Prevention:** In each adapter's catch block, log `err.status`, `err.headers`, and `err.message` to the structured server log (which never reaches the client), then return a sanitized OpenAI-style error to the client:
```json
{ "error": { "type": "upstream_error", "message": "Provider unavailable", "code": 503 } }
```
Never serialize the raw SDK error into the response body.

**Warning signs:** Downstream clients receiving error messages containing provider URLs or SDK stack traces.

**Phase:** Error handling in adapters (Phase 1).

---

### P-SEC-2: Logging Infrastructure Accidentally Captures Prompts

**What goes wrong:** Structured logging libraries that serialize entire objects will capture `messages` array content when the request body is logged at DEBUG level. Even when `Authorization` headers are excluded, the prompt content itself is sensitive. Template string interpolation like `` logger.debug(`Request: ${JSON.stringify(body)}`) `` will capture full prompts.

**Prevention:**
1. Log only the fields enumerated in spec section 19: `requestId`, `provider`, `model`, `latency`, `status`, `failoverReason`, `tokenUsage`, `quotaHeaders`. No payload fields.
2. Use a structured logger that accepts named fields (not `JSON.stringify(body)`). Pass fields individually.
3. Add an explicit test that asserts the log output for a known request does not contain the `content` field from any message.

**Warning signs:** Logs containing message content strings; prompt text visible in console output.

**Phase:** Logger implementation (Phase 1); test coverage (Phase 3).

---

### P-SEC-3: Non-Constant-Time Key Comparison Enables Timing Attacks

**What goes wrong:** Simple string comparison (`inputKey === PERSONAL_PROXY_API_KEY`) returns early on the first differing byte. A network-local attacker can measure response time to enumerate the correct key character by character. This is especially relevant for single-character prefix attacks.

**Prevention:** Use `crypto.timingSafeEqual` (available in Bun via Node.js crypto compatibility):
```typescript
import { timingSafeEqual } from "node:crypto";

function isValidKey(input: string, expected: string): boolean {
  const a = Buffer.from(input.padEnd(expected.length));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```
Note: padding to equal length is required; `timingSafeEqual` throws if lengths differ.

**Warning signs:** Auth check using `===` or `.startsWith()`.

**Phase:** Auth middleware (Phase 1).

---

### P-SEC-4: X-LLM-Provider Header Enables Provider Fingerprinting

**What goes wrong:** When `EXPOSE_PROVIDER_HEADER=true`, the response includes `X-LLM-Provider: cerebras` or `X-LLM-Provider: groq`. This tells attackers which upstream provider processed the request, enabling targeted rate-limit exhaustion attacks (spam the proxy when you know Cerebras is handling it to drain Cerebras quota while Groq remains available).

**Prevention:** Default is `EXPOSE_PROVIDER_HEADER=false`. Do not enable in production environments where the proxy is exposed to untrusted networks. Document this risk in comments.

**Warning signs:** `EXPOSE_PROVIDER_HEADER=true` in production env files.

**Phase:** Response normalization (Phase 2); environment config documentation.

---

### P-SEC-5: Internal Status Endpoint Leaking rateLimitSnapshot Values

**What goes wrong:** The `GET /internal/providers/status` response includes `rateLimitSnapshot` with remaining quota values. These are not secrets themselves, but they reveal capacity information that makes quota exhaustion attacks more precise. More critically, if the endpoint is accidentally left unprotected (middleware ordering bug), it exposes provider health state to unauthenticated clients.

**Prevention:** The auth middleware must apply to `/internal/*` routes explicitly. Do not assume route ordering provides security. Test that `GET /internal/providers/status` without credentials returns 401.

**Warning signs:** Status endpoint accessible without `Authorization` header; rate-limit remaining counts visible to unauthenticated probes.

**Phase:** Auth middleware route coverage (Phase 1).

---

## Testing Pitfalls

### P-TEST-1: Provider State Is Global Mutable — Tests Pollute Each Other

**What goes wrong:** The round-robin router and cooldown state are in-memory module-level variables. In `bun test`, all test files in a run share the same module instances unless `--isolate` is used. A test that triggers a 429 and sets a cooldown will affect subsequent tests that expect both providers to be eligible. This is especially insidious because test order is non-deterministic by default.

**Prevention:**
1. Encapsulate all provider state in a class with a `reset()` method.
2. Call `router.reset()` in `beforeEach` or `afterEach` in every test file that exercises routing.
3. Alternatively, run `bun test --isolate` to give each test file a fresh module context (slower but eliminates cross-file pollution).

**Warning signs:** Tests passing individually but failing when run together; cooldown tests affecting routing tests.

**Phase:** Test infrastructure setup (Phase 3).

---

### P-TEST-2: Streaming Cannot Be Tested With Standard Response Assertion

**What goes wrong:** Asserting `const body = await response.text()` on a streaming response waits for the full stream to complete before returning. This correctly captures all output but does not verify incremental delivery (i.e., that chunks were sent progressively and not buffered). A response that buffers everything and sends it all at once would pass a `response.text()` assertion.

More critically, unit-testing the stream relay with a mock SDK that returns an `AsyncIterable` requires the test to `for await` over the response body — which requires converting the Response body back to an async iterator, a non-obvious pattern in Bun.

**Prevention:**
1. For unit tests, test the stream relay function directly by passing a mock `AsyncIterable<SDKChunk>` and collecting yielded values into an array.
2. For integration tests, assert chunk order and `data: [DONE]` termination by consuming the stream iteratively.
3. Do not rely solely on `response.text()` for streaming correctness.

**Warning signs:** All streaming tests pass but end-to-end behavior produces buffered responses; missing `data: [DONE]` not caught by tests.

**Phase:** Test design (Phase 3).

---

### P-TEST-3: Groq SDK Internal Retries Obscure 429 Test Timing

**What goes wrong:** If `maxRetries: 0` is not set on the Groq client in test environments, a mock returning 429 will be retried twice internally before the error reaches the adapter. Test assertions about "provider entered cooldown after 429" will time out waiting for the SDK to exhaust its retries, or the cooldown will be applied with a multi-second delay.

**Prevention:** Ensure the test setup initializes SDK clients with `maxRetries: 0` (same as production). If using mock SDK clients, mock the full `APIError` response directly rather than mocking at the HTTP layer.

**Warning signs:** 429 handling tests running for 30+ seconds; intermittent test failures when SDK retry timing varies.

**Phase:** Test infrastructure / adapter setup (Phase 3).

---

### P-TEST-4: Bun Module Mocking Is Not Automatically Cleaned Up

**What goes wrong:** `mock.module()` in Bun patches modules in-place and does not automatically restore them between test files. A test file that mocks `./providers/groq-adapter` will affect other test files unless `mock.restore()` is called explicitly. Unlike Jest, there is no auto-restore option.

**Prevention:** Use `afterEach(() => { mock.restore(); })` in every test file that calls `mock.module()`. For provider adapter tests, create fresh adapter instances with injected mock SDK clients rather than patching modules.

**Warning signs:** Tests that pass in isolation but fail when run as a suite; unexpected mock implementations active in unrelated tests.

**Phase:** Test infrastructure (Phase 3).

---

## Phase-Specific Warnings

| Phase | Topic | Likely Pitfall | Mitigation |
|-------|-------|---------------|------------|
| Phase 1 — Adapters | SDK client init | SDK default retries fight failover | `maxRetries: 0` on all SDK clients |
| Phase 1 — Adapters | Error handling | SDK error objects leak provider details | Sanitize at adapter boundary |
| Phase 1 — Auth | Key comparison | Timing attack via string equality | `crypto.timingSafeEqual` |
| Phase 1 — Validation | Field passthrough | Unsupported fields reach Cerebras → 400 | Strict allowlist before provider call |
| Phase 2 — Cooldowns | Header parsing | Groq duration strings vs Cerebras float seconds | Provider-specific parsers |
| Phase 2 — Routing | Failover | 498 not in routing table | Explicit `case 498` alongside `429` |
| Phase 2 — Stream relay | SSE format | Raw content strings, not `data: JSON` format | Full chunk serialization |
| Phase 2 — Stream relay | Idle timeout | Bun 10s default kills quiet streams | `server.timeout(req, 0)` for SSE |
| Phase 2 — Stream relay | Failover guard | Failover attempted after first chunk sent | `firstChunkSent` flag check |
| Phase 2 — Normalization | Reasoning leakage | `delta.reasoning` forwarded in stream | Strip per-chunk in relay |
| Phase 2 — Normalization | Model field | Provider ID forwarded in chunks | Rewrite `chunk.model` per chunk |
| Phase 3 — Tests | State isolation | Router state pollutes test order | `router.reset()` in `beforeEach` |
| Phase 3 — Tests | Stream assertions | `response.text()` misses chunk-order bugs | Direct async iterable testing |

---

## Sources

- Bun SSE and idleTimeout: https://bun.sh/docs/runtime/http/server and https://github.com/oven-sh/bun/issues/13712
- Bun test isolation: https://github.com/oven-sh/bun/blob/main/docs/test/runtime-behavior.mdx
- groq-sdk retries default: https://github.com/groq/groq-typescript/blob/main/README.md
- cerebras-cloud-sdk retries default: https://github.com/cerebras/cerebras-cloud-sdk-node/blob/main/README.md
- Groq rate-limit header format: https://console.groq.com/docs/rate-limits
- Cerebras rate-limit headers: https://inference-docs.cerebras.ai/support/rate-limits
- Cerebras streaming chunk structure: https://context7.com/cerebras/cerebras-cloud-sdk-node/llms.txt
- Groq streaming usage extra chunk: https://github.com/BerriAI/litellm/issues/17136
- Cerebras unsupported fields: https://inference-docs.cerebras.ai/resources/openai
- LiteLLM Groq failover delay bug: https://github.com/BerriAI/litellm/issues/3274
- Groq error codes including 498: https://console.groq.com/docs/errors
