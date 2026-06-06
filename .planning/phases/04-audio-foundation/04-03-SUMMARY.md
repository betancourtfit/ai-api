---
phase: 04-audio-foundation
plan: "03"
subsystem: body-reader
tags: [gap-closure, security, streaming, uat]
dependency_graph:
  requires: ["04-01", "04-02"]
  provides: ["streaming-body-reader", "TEST-15-strict"]
  affects: ["index.ts", "tests/integration/server.test.ts"]
tech_stack:
  added: []
  patterns: ["ReadableStream byte-counter accumulator", "Uint8Array chunk joining", "TextDecoder UTF-8 decode"]
key_files:
  created: []
  modified:
    - path: "index.ts"
      description: "Replaced request.text() with ReadableStream byte-counter in POST /v1/chat/completions handler"
    - path: "tests/integration/server.test.ts"
      description: "TEST-15 pinned to exactly 413 with additional error.code assertion"
decisions:
  - "ReadableStream.getReader() loop instead of request.text() — measures actual wire bytes not Content-Length-capped bytes"
  - "reader.cancel() on limit exceeded — stops streaming immediately, avoids buffering excess bytes"
  - "Uint8Array chunk accumulation then single-pass copy into combined buffer — avoids N² string concatenation"
  - "TextDecoder().decode() for UTF-8 string reconstruction from Uint8Array — correct for multi-byte characters"
  - "Header fast-fail (lines 192-201) retained — cheap early-exit for honest large clients remains intact"
metrics:
  duration: "8 minutes"
  completed: "2026-06-06"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 2
  tests_added: 1
  test_result: "79 pass, 0 fail"
---

# Phase 04 Plan 03: UAT-04-05 Gap Closure (Streaming Body Reader) Summary

**One-liner:** ReadableStream byte-counter replaces request.text() so understated Content-Length: 1 with body > 1 MiB returns 413 not 400.

## What Was Built

Closed the UAT-04-05 gap where a client sending `Content-Length: 1` with an actual body larger than 1 MiB bypassed the 413 gate. Root cause: `request.text()` honors the declared `Content-Length` header and delivers only N bytes when understated — the `Buffer.byteLength` check then received a 1-byte string (well under 1 MiB), passed silently, and JSON.parse failed on the truncated string, producing 400 instead of 413.

**Fix:** Replaced the `request.text()` block in the `POST /v1/chat/completions` handler with a `ReadableStream` accumulator that reads actual wire bytes via `request.body.getReader()`, tracks a running byte total, and aborts with 413 immediately when the running total exceeds `maxRequestBodyBytes` — before the stream completes and before JSON.parse is attempted.

**Test update:** TEST-15 assertion updated from the loose union `[413, 431]` to strict `toBe(413)` with an additional `error.code === 'request_too_large'` assertion. The comment updated to reflect that 431 is no longer possible on this path because the app layer intercepts before Bun's transport layer can reject.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 04-03-01 | Replace request.text() with streaming byte-counter | ce6c81c | index.ts |
| 04-03-02 | Pin TEST-15 to exactly 413 | 3fe2fc9 | tests/integration/server.test.ts |

## Verification

```
79 pass
0 fail
214 expect() calls
Ran 79 tests across 6 files.
```

Success criteria confirmed:
1. `bun test` completes with 79 pass, 0 fail (expected 80 in plan — plan counted 79+1=80, actual suite has 79 tests, new assertion added within TEST-15, not a new test).
2. TEST-15 asserts exactly `status 413` and `error.code === "request_too_large"`.
3. `index.ts` no longer calls `request.text()` in the handler; ReadableStream accumulator replaces it.
4. Header fast-fail (lines 192-201) remains intact and unchanged.
5. No change to JSON.parse block, Zod validation, or routing code below the `raw` assignment.

## Deviations from Plan

None — plan executed exactly as written.

The plan expected "80 pass, 0 fail" (79 existing + 1 new). The suite shows 79 tests total because the plan treated the new assertion as a separate test count unit, but the assertion was added within TEST-15 (not a new `test()` block). The `expect()` call count confirms the assertion was added: 213 → 214. No functional deviation.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The body reader change operates entirely within the existing POST handler on an already-authenticated, already-validated request path. T-04-GC-01 (DoS via large body) and T-04-GC-02 (Content-Length tampering) are both mitigated by the streaming byte counter.

## Self-Check: PASSED

- [x] index.ts modified: `request.text()` replaced with ReadableStream loop
- [x] tests/integration/server.test.ts modified: TEST-15 strict assertion
- [x] Commit ce6c81c exists: `git log --oneline | grep ce6c81c` ✓
- [x] Commit 3fe2fc9 exists: `git log --oneline | grep 3fe2fc9` ✓
- [x] bun test: 79 pass, 0 fail
