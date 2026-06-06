---
status: complete
phase: 04-audio-foundation
source:
  - .planning/phases/04-audio-foundation/04-01-SUMMARY.md
  - .planning/phases/04-audio-foundation/04-02-SUMMARY.md
started: 2026-06-06T00:00:00Z
updated: 2026-06-06T00:00:00Z
---

## Current Test

number: 6
name: bun test passes green
expected: |
  `bun test` completes with 79 pass, 0 fail across all 6 files.
result: complete

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server. Start the proxy from scratch with `bun index.ts`. Server boots without errors. `GET /health` returns 200.
result: pass

### 2. /ready reports eligible providers
expected: |
  `GET /ready` returns 200 with `ready: true` and at least one provider listed in
  `eligibleProviders`. Config loads all new audio/whisper fields without crashing.
result: pass

### 3. Normal chat request still works (no regression)
expected: |
  A valid chat completion request under 1 MiB returns 200 with `model: gpt-oss-120b-balanced`
  in the response body. The body-gate changes in index.ts did not break the happy path.
result: pass

### 4. Chat body > 1 MiB returns 413
expected: |
  A POST to `/v1/chat/completions` with an actual body larger than 1 MiB returns HTTP 413
  with an OpenAI-style error body containing `code: request_too_large`. The Buffer.byteLength
  gate fires regardless of what Content-Length header the client sends.
result: pass

### 5. Understated Content-Length still rejected (body gate)
expected: |
  A request with `Content-Length: 1` but an actual body larger than 1 MiB still returns 413.
  The gate measures actual bytes (`Buffer.byteLength(raw)`), not the header value.
  This was TEST-15 in the integration suite.
result: issue
reported: "Got 400 invalid_request_error (JSON parse failure) instead of 413 request_too_large. Bun honors Content-Length: 1, reads only 1 byte, JSON.parse fails before Buffer.byteLength gate runs. Security property holds (request rejected) but wrong status code."
severity: minor

### 6. bun test passes green
expected: |
  Running `bun test` from the project root completes with 79 pass, 0 fail across all 6 files.
  This confirms the audio-schema unit tests, body-gate integration tests, and all prior
  regression tests are intact.
result: pass

## Summary

total: 6
passed: 5
issues: 1
pending: 0
skipped: 0

## Gaps

- truth: "POST /v1/chat/completions with understated Content-Length: 1 and body > 1 MiB returns 413 request_too_large"
  status: failed
  reason: "User reported: Got 400 invalid_request_error instead. Bun honors Content-Length: 1, reads 1 byte, JSON.parse fails before Buffer.byteLength gate runs."
  severity: minor
  test: 5
  artifacts: [index.ts]
  missing: [pre-read size check before request.text() when Content-Length is understated]
