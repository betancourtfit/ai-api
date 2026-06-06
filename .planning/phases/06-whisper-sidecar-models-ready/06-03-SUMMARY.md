---
phase: 06-whisper-sidecar-models-ready
plan: 03
status: complete
completed: 2026-06-06
requirements: [WHSP-01, WHSP-03]
checkpoint: human-verify
---

# Plan 06-03 Summary — Live Smoke Test

## Result: PASSED

Manual UAT against real `whisper-server` (whisper-cpp 1.8.6) + `ggml-tiny.bin` on `127.0.0.1:8080`.

| Check | HTTP | Notes |
|-------|------|-------|
| Transcription (sidecar up) | 200 | Body shape `{ "text": "..." }` |
| Transcription (sidecar down) | 503 | OpenAI error `service_unavailable` |
| Chat (sidecar down) | 200 | Independent of whisper path |
| GET /ready (sidecar up) | 200 | `whisperAvailable: true`, chat fields unchanged |
| GET /ready (sidecar down) | 200 | `whisperAvailable: false`, `mode: ok` |
| GET /v1/models | 200 | `whisper-1` + chat alias present |
| bun.lock | unchanged | Zero new npm packages |

## Self-Check: PASSED

ROADMAP criterion 3 confirmed end-to-end.
