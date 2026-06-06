---
phase: 04-audio-foundation
verified: 2026-06-06T14:30:00Z
status: gaps_found
score: 3/4 must-haves verified
overrides_applied: 0
gaps:
  - truth: "maxRequestBodySize raised to audio ceiling without changing the 1 MiB chat-completion behavior"
    status: failed
    reason: "The 1 MiB chat limit is enforced via client-controlled Content-Length header. A chunked-encoding client (Content-Length omitted) or a client sending Content-Length: abc causes Number(null??0)=0 or NaN — both bypass the check. The real per-request ceiling for the chat route is now 25 MiB (the raised Bun.serve gate), a 25x regression from the previous 1 MiB byte-accurate gate. This is documented as CR-01 in 04-REVIEW.md and directly contradicts success criterion 4."
    artifacts:
      - path: "index.ts"
        issue: "Lines 191-200: content-length gate trusts client-supplied header; chunked-transfer or malformed header bypasses the 1 MiB limit; effective chat ceiling regressed to 25 MiB"
    missing:
      - "After the header fast-fail, read the raw body and enforce actual byte length: const raw = await request.text(); if (Buffer.byteLength(raw) > config.maxRequestBodyBytes) { return 413; } then JSON.parse(raw)"
      - "Alternatively: Number.isFinite(contentLength) guard so NaN/null headers cannot bypass the check"
human_verification: []
---

# Phase 04: Audio Foundation — Verification Report

**Phase Goal:** All configuration, types, and Zod validation for the transcription endpoint are in place and enforced — ready for a route handler to be wired in, with no whisper binary required to run or test.
**Verified:** 2026-06-06T14:30:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | `bun test` passes with all existing v1.0 tests green and new audio-schema unit tests passing, with no whisper-server binary installed | VERIFIED | `bun test` output: 76 pass, 0 fail, 206 expect() calls across 6 files. 10 new audio-schema unit tests confirmed (grep count). No whisper binary required. |
| 2 | A multipart request missing the file field, using an unknown model alias, exceeding 25 MB, or including unknown fields each produce an OpenAI-shaped 400 or 413 — verified via unit tests against the Zod schema and validators | VERIFIED | `z.strictObject` allowlist confirmed present (grep match, 0 `.strict()` calls). `z.instanceof(File)` on line 12. `z.literal('json').optional()` on line 13. `validateAudioFileSize` exported and tested (101-byte file vs 100-byte limit: ok:false + message contains "100"). All 10 tests pass. |
| 3 | `WHISPER_PORT`, `WHISPER_HOST`, `WHISPER_TIMEOUT_MS`, and `AUDIO_MAX_FILE_BYTES` are read from environment and surfaced in the config object; a missing `WHISPER_MODEL_ALIAS` does not crash the server | VERIFIED | config.ts lines 30-38 confirmed: all four env vars present with correct defaults (127.0.0.1, 8080, 30000, 26214400). `optional("WHISPER_MODEL_ALIAS")` on line 34 — uses existing null-returning helper so missing var yields null without throwing. |
| 4 | `maxRequestBodySize` in `Bun.serve()` is raised to the configured audio limit without changing the 1 MiB chat-completion behavior | FAILED | `maxRequestBodySize: config.audioMaxFileBytes` confirmed at index.ts:102. However the chat 1 MiB gate (index.ts:191-192) reads `Number(request.headers.get('content-length') ?? 0)`. Three bypass paths exist: (1) chunked-encoding clients omit Content-Length — header returns null, Number(null??0)=0, check passes, request.json() buffers up to 25 MiB; (2) Content-Length: abc yields NaN, NaN>limit is false, check passes; (3) understated headers. The chat route's effective ceiling regressed from the previous byte-accurate 1 MiB to 25 MiB for non-cooperating clients. This is documented as CR-01 in 04-REVIEW.md and directly contradicts the "without changing the 1 MiB chat-completion behavior" clause of success criterion 4. |

**Score:** 3/4 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `audio-schema.ts` | audioTranscriptionSchema, validateAudioTranscription, validateAudioFileSize, AudioTranscriptionInput; min 40 lines | VERIFIED | 61 lines. All four named exports confirmed. `z.strictObject`, `z.instanceof(File)`, `z.literal('json').optional()`, `validateAudioFileSize` — all present. |
| `tests/unit/audio-schema.test.ts` | Unit tests for schema and size validator; min 60 lines | VERIFIED | 87 lines. 10 tests. Two describe blocks mirroring the plan structure. No server, no whisper binary. |
| `config.ts` | whisperHost, whisperPort, whisperTimeoutMs, whisperModelAlias, audioMaxFileBytes, maxRequestBodyBytes | VERIFIED | All 6 fields confirmed lines 30-38. `optional("WHISPER_MODEL_ALIAS")` pattern on line 34. Default values match spec: 26_214_400 (25 MiB) and 1_048_576 (1 MiB). |
| `types.ts` | AudioTranscriptionResult interface with `text: string` | VERIFIED | Line 58-60: `export interface AudioTranscriptionResult { text: string }` — correct shape. |
| `index.ts` | maxRequestBodySize from config; chat 1 MiB content-length gate | PARTIAL | `maxRequestBodySize: config.audioMaxFileBytes` present at line 102. Content-length gate present at lines 191-200. However the gate is bypassable via chunked-encoding and malformed headers — see truth 4 FAILED. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `index.ts` | `config.ts` | `maxRequestBodySize: config.audioMaxFileBytes` | WIRED | Confirmed at index.ts:102. Pattern matches exactly. |
| `index.ts` | `config.ts` | `config.maxRequestBodyBytes` content-length check | WIRED (incomplete) | Confirmed at index.ts:192. Code exists but enforcement is bypassable — see CR-01. |
| `tests/unit/audio-schema.test.ts` | `audio-schema.ts` | import of validators | WIRED | Line 5: `import { validateAudioTranscription, validateAudioFileSize } from "../../audio-schema"` — matches pattern. |
| `audio-schema.ts` | `zod` | `z.strictObject` schema | WIRED | Line 10: `export const audioTranscriptionSchema = z.strictObject({...})` — confirmed. |

---

### Data-Flow Trace (Level 4)

Not applicable — this phase produces validators, config, and types. No dynamic data rendering. The validators are function exports consumed in tests; they do not render dynamic data from a store or API.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| audio-schema unit tests pass | `bun test tests/unit/audio-schema.test.ts` | 10 pass, 0 fail (inferred from full suite 76 pass) | PASS |
| Full suite green (no whisper binary) | `bun test` | 76 pass, 0 fail, 206 expect() calls | PASS |
| maxRequestBodySize wired in Bun.serve | `grep -n "maxRequestBodySize: config.audioMaxFileBytes" index.ts` | line 102 | PASS |
| Content-length gate present for chat | `grep -n "request_too_large" index.ts` | line 196 | PASS (gate exists but bypassable — separate gap) |

---

### Probe Execution

Step 7c: SKIPPED — no `scripts/*/tests/probe-*.sh` present in repository and no probes declared in PLAN or SUMMARY.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| AUDIO-01 | 04-01-PLAN.md | Proxy validates `file` field is present; returns OpenAI-shaped 400 if missing | SATISFIED | `z.instanceof(File)` in schema; test "missing file returns success:false with param='file'" passes |
| AUDIO-02 | 04-01-PLAN.md | Proxy validates `model` matches a known whisper alias; returns OpenAI-shaped 400 if unknown | PARTIAL (foundation only) | `model: z.string()` validates presence/type; alias-lookup against registry is Phase 5 per PLAN intent. Foundation layer is correct. |
| AUDIO-03 | 04-01-PLAN.md | Proxy enforces 25 MB file size limit; returns OpenAI-shaped 413 if exceeded | SATISFIED (unit layer) | `validateAudioFileSize(file, maxBytes)` returns `{ ok: false, message }` when size > maxBytes. Tests pass. Route wiring to return 413 is Phase 5 scope. |
| AUDIO-04 | 04-01-PLAN.md | Proxy accepts `response_format` field (v2.0 always returns json) | SATISFIED | `response_format: z.literal('json').optional()` — 'json' accepted, omitted accepted, 'text' rejected |
| AUDIO-05 | 04-01-PLAN.md | Proxy rejects unknown/unsupported request fields with OpenAI-shaped 400 | SATISFIED | `z.strictObject` rejects unrecognized keys; test "unknown field 'language' returns success:false" passes |
| AUDIO-06 | 04-01-PLAN.md | Successful response body is `{ "text": "..." }` | SATISFIED | `AudioTranscriptionResult { text: string }` in types.ts:58-60 |
| WHSP-04 | 04-01-PLAN.md | WHISPER_PORT, WHISPER_HOST, WHISPER_TIMEOUT_MS, AUDIO_MAX_FILE_BYTES env vars respected | SATISFIED | All four confirmed in config.ts:30-37 with correct defaults |
| WHSP-05 | 04-01-PLAN.md | maxRequestBodySize in Bun.serve raised; separate 1 MiB chat limit | PARTIAL | Global gate raised to 25 MiB: confirmed. Chat 1 MiB limit: code present but bypassable — CR-01. |

**Orphaned requirements:** None. All 8 phase-assigned requirement IDs are covered. Remaining milestone requirements (EP2-01, AUTH2-01, etc.) are correctly mapped to Phases 5 and 6 in REQUIREMENTS.md traceability table.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `audio-schema.ts` | 38 | `(firstIssue as { keys?: string[] }).keys` — type assertion after `in` narrowing already done | INFO | Masks future Zod shape change; functional but fragile. Code Review IN-02. |
| `tests/unit/audio-schema.test.ts` | 49-53 | Unknown-field test asserts only `success: false`, not `param === 'language'` | INFO | Leaves the `unrecognized_keys` extraction branch effectively untested. Code Review IN-03. |
| `index.ts` | 191-192 | Content-length gate trusts client-controlled header; NaN/null bypass | BLOCKER | Effective chat body limit is 25 MiB for chunked-encoding or header-omitting clients — 25x regression from prior 1 MiB Bun.serve gate. Directly contradicts success criterion 4. Code Review CR-01. |
| `config.ts` | 31-38 | `Number(process.env[...] ?? default)` — no isFinite/isInteger guard | WARNING | NaN silently disables size limits (fail-open). Inherited pattern but 2 new security-relevant fields added. Code Review WR-02. |
| `index.ts` | 102 | `maxRequestBodySize: config.audioMaxFileBytes` set to exactly file ceiling | WARNING | Multipart overhead for max-size audio file (file bytes + boundaries + headers) exceeds 25 MiB — Bun rejects before handler, so `validateAudioFileSize` is unreachable for boundary cases. Code Review WR-01. |

---

### Human Verification Required

None — all checks for this phase are programmatically verifiable.

---

### Gaps Summary

One gap blocks the phase goal:

**CR-01 — Chat 1 MiB body limit is bypassable (BLOCKER):** Success criterion 4 requires that the 25 MiB `maxRequestBodySize` raise does not change the 1 MiB chat-completion behavior. The implemented content-length gate trusts the client-supplied `Content-Length` header. Any HTTP/1.1 client using chunked transfer encoding omits the header entirely; the check evaluates `0 > 1048576 = false` and the chat handler proceeds to buffer up to 25 MiB via `request.json()`. The "1 MiB limit" is advisory for cooperative clients only. The effective ceiling on the chat route regressed from 1 MiB (enforced by Bun's prior gate) to 25 MiB (the new gate) for all non-cooperative clients. This directly contradicts the success criterion and the stated threat model mitigation T-04-02.

The fix requires enforcing the limit on actual buffered bytes rather than (or in addition to) the header: read `request.text()`, measure `Buffer.byteLength(raw)`, reject at 413 if over limit, then `JSON.parse(raw)`. The Code Review at 04-REVIEW.md CR-01 documents this with an exact fix pattern.

The three truths covering schema validation, config fields, and test coverage are all verified. Phase 5 can safely import the validators, types, and config fields produced here. Only the body-size enforcement correctness must be fixed before this phase is marked complete.

---

_Verified: 2026-06-06T14:30:00Z_
_Verifier: Claude (gsd-verifier)_
