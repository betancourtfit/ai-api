---
status: testing
phase: 08-hexagonal-architecture-audit-refactor
source: [08-VERIFICATION.md]
started: 2026-07-24T02:30:00Z
updated: 2026-07-24T02:30:00Z
---

## Current Test

number: 1
name: Real non-streaming completion end-to-end
expected: |
  Server starts with real provider keys. A normal completion returns 200 with an
  OpenAI-shaped body whose `model` is the logical alias `gpt-oss-120b-balanced`
  (not the upstream ID), non-empty `choices[0].message.content`, and no
  provider-specific fields (`time_info`, `x_groq`, `reasoning`).
awaiting: user response

## Tests

### 1. Real non-streaming completion end-to-end
expected: 200; `model` is `gpt-oss-120b-balanced`; `choices[0].message.content` non-empty; no `time_info` / `x_groq` / `reasoning` key present. Command in 08-VERIFICATION.md §Human Verification item 1.
result: [pending]

### 2. Real streaming completion — SSE framing and sentinel
expected: a sequence of `data: {...}` frames followed by exactly one `data: [DONE]`. Stream closes promptly on Ctrl-C (this is the path the code-review fix W-1 touched). Command in 08-VERIFICATION.md item 2.
result: [pending]

### 3. Provider alternation and diagnostics against real quota
expected: consecutive completions alternate providers; `GET /internal/providers/status` shows both providers `configured: true` with plausible `lastSelectedAt`/`lastSuccessAt`, and no key material anywhere in the payload. Command in 08-VERIFICATION.md item 3.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
