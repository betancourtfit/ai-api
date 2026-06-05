---
status: complete
phase: 03-full-compliance-tests
source: [03-01-SUMMARY.md, 03-02-SUMMARY.md, 03-03-SUMMARY.md]
started: 2026-06-05T23:34:17Z
updated: 2026-06-05T23:45:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server. Start fresh with `bun index.ts`. Server boots without errors. Hit GET /health — returns 200 OK.
result: pass

### 2. X-Request-ID on every response
expected: Any request (success, error, 404) includes an `X-Request-ID` header with a UUID value. Run `curl -i http://localhost:3000/health -H "Authorization: Bearer $PERSONAL_PROXY_API_KEY"` and inspect headers — `X-Request-ID` is present.
result: pass

### 3. Model alias in response body
expected: POST /v1/chat/completions with model `gpt-oss-120b-balanced` returns a body where `body.model === "gpt-oss-120b-balanced"` — not the raw upstream ID (`gpt-oss-120b` or `openai/gpt-oss-120b`).
result: pass

### 4. Provider fields absent from response
expected: The same completion response contains none of: `time_info`, `x_groq`, `usage_breakdown`, `choices[0].message.reasoning`. These are provider-specific fields that must be stripped by the normalizer.
result: pass

### 5. Usage always present
expected: The completion response always includes `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens` as numbers — even if the upstream omitted usage. Values should be non-negative integers.
result: pass

### 6. Unknown route returns OpenAI error shape (NORM-10)
expected: `curl http://localhost:3000/unknown-path -H "Authorization: Bearer $PERSONAL_PROXY_API_KEY"` returns a JSON body with `error.message`, `error.type`, `error.code` fields — not a plain "Not found" string. Status 404. X-Request-ID present.
result: pass

### 7. Unknown model returns 400
expected: POST /v1/chat/completions with `"model": "does-not-exist"` returns HTTP 400 with `error.code === "model_not_found"` and X-Request-ID in headers.
result: pass

### 8. Streaming response shape
expected: POST /v1/chat/completions with `"stream": true` returns `Content-Type: text/event-stream`. Chunks arrive incrementally. Each chunk's `object === "chat.completion.chunk"` and `model === "gpt-oss-120b-balanced"`. No chunk contains `delta.reasoning`. Last data line is `data: [DONE]`.
result: pass

### 9. Full test suite passes
expected: `bun test` from project root exits 0 with 66 tests passing, 0 failing.
result: pass

## Summary

total: 9
passed: 9
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none yet]
