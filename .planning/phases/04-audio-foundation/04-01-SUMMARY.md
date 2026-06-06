---
phase: 04-audio-foundation
plan: 01
subsystem: audio-foundation
tags: [config, validation, zod, tdd, audio, types]
dependency_graph:
  requires: []
  provides: [audio-schema, audio-config, audio-types, body-size-gate]
  affects: [index.ts, config.ts, types.ts]
tech_stack:
  added: []
  patterns: [zod-strictobject, tdd-red-green, content-length-gate, explicit-size-validator]
key_files:
  created:
    - audio-schema.ts
    - tests/unit/audio-schema.test.ts
  modified:
    - config.ts
    - types.ts
    - index.ts
decisions:
  - "Use z.instanceof(File) not z.file() — matches RESEARCH.md Pattern 2 note"
  - "validateAudioFileSize takes maxBytes parameter so tests don't depend on env state"
  - "maxRequestBodySize raised to audio ceiling in Bun.serve; chat 1 MiB limit enforced at handler layer"
  - "Content-length pre-check placed before request.json() parse to avoid buffering oversized bodies"
metrics:
  duration_minutes: 10
  completed_date: "2026-06-06"
  tasks_completed: 3
  files_modified: 5
---

# Phase 04 Plan 01: Audio Foundation — Config, Schema, Types, Body Gate Summary

**One-liner:** Zod strict audio transcription schema with size validator, 6 whisper config fields using optional() helper, and Bun.serve maxRequestBodySize raised to 25 MiB with explicit 1 MiB chat content-length gate.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add whisper and audio size config fields | 8bc9625 | config.ts |
| 2 (RED) | Write failing audio-schema unit tests | 58bc4cd | tests/unit/audio-schema.test.ts |
| 2 (GREEN) | Implement audio-schema.ts + AudioTranscriptionResult | 0d385ad | audio-schema.ts, types.ts |
| 3 | Raise maxRequestBodySize, add chat 1 MiB gate | eadd96a | index.ts |

## Verification Results

- `bun test` — 76 pass, 0 fail (66 existing + 10 new audio-schema tests)
- `bun test tests/unit/audio-schema.test.ts` — 10 pass, 0 fail
- `WHISPER_MODEL_ALIAS= bun -e '...'` — prints `127.0.0.1 8080 30000 26214400 null`, exits 0
- `grep -n 'maxRequestBodySize: config.audioMaxFileBytes' index.ts` — line 102 confirmed
- Integration tests: 13 pass, 0 fail (createServer signature unchanged)

## Artifacts Produced

### audio-schema.ts
- `audioTranscriptionSchema` — `z.strictObject` with 3 fields: `model: z.string()`, `file: z.instanceof(File)`, `response_format: z.literal('json').optional()`
- `validateAudioTranscription(input)` — same discriminated-union shape as `validateChatCompletion`
- `validateAudioFileSize(file, maxBytes)` — explicit 413-path size check, takes maxBytes as param
- `AudioTranscriptionInput` — `z.infer<typeof audioTranscriptionSchema>`

### config.ts additions
- `whisperHost` (default: "127.0.0.1"), `whisperPort` (default: 8080), `whisperTimeoutMs` (default: 30000)
- `whisperModelAlias` — `optional("WHISPER_MODEL_ALIAS")` — yields null when unset, non-fatal
- `audioMaxFileBytes` (default: 26214400 / 25 MiB), `maxRequestBodyBytes` (default: 1048576 / 1 MiB)

### types.ts addition
- `AudioTranscriptionResult { text: string }` — AUDIO-06 OpenAI json transcription response shape

### index.ts changes
- `maxRequestBodySize: config.audioMaxFileBytes` in Bun.serve options (T-04-01 mitigation)
- Content-length gate before `request.json()` in `/v1/chat/completions` — returns 413 with `request_too_large` code when body exceeds `config.maxRequestBodyBytes` (T-04-02 mitigation)

## Deviations from Plan

None — plan executed exactly as written. All 8 plan requirement IDs satisfied (AUDIO-01..06, WHSP-04, WHSP-05).

## TDD Gate Compliance

- RED gate: `test(04-01)` commit 58bc4cd — tests failed with module-not-found as expected
- GREEN gate: `feat(04-01)` commit 0d385ad — all 10 tests pass

## Known Stubs

None — all exported symbols are fully functional. Phase 5 can import `validateAudioTranscription`, `validateAudioFileSize`, `AudioTranscriptionInput`, `AudioTranscriptionResult`, and all 6 config fields without modification.

## Threat Flags

None — all threat model mitigations (T-04-01..05) implemented as specified. No new surface beyond plan scope.

## Self-Check: PASSED

- FOUND: audio-schema.ts
- FOUND: tests/unit/audio-schema.test.ts
- FOUND: config.ts (modified)
- FOUND: types.ts (modified)
- FOUND: index.ts (modified)
- Commits verified: 8bc9625, 58bc4cd, 0d385ad, eadd96a
