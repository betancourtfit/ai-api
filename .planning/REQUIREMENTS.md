# Requirements: bun-ai-api

**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.

---

## Milestone v2.0 — Local Audio Transcription

### Endpoint

- [x] **EP2-01**: User can POST multipart/form-data to `/v1/audio/transcriptions` with a `file` (audio) and `model` (string) field
- [x] **EP2-02**: User can GET `/v1/models` and see the whisper alias when whisper-server is configured
- [x] **EP2-03**: User can GET `/ready` and see a `whisperAvailable` boolean field reflecting sidecar health

### Audio Handling

- [x] **AUDIO-01**: Proxy validates `file` field is present in multipart body; returns OpenAI-shaped 400 if missing
- [x] **AUDIO-02**: Proxy validates `model` matches a known whisper alias; returns OpenAI-shaped 400 if unknown
- [x] **AUDIO-03**: Proxy enforces 25 MB file size limit; returns OpenAI-shaped 413 if exceeded
- [x] **AUDIO-04**: Proxy accepts `response_format` field in request (v2.0 always returns json format)
- [x] **AUDIO-05**: Proxy rejects unknown/unsupported request fields with OpenAI-shaped 400
- [x] **AUDIO-06**: Successful response body is `{ "text": "..." }` — OpenAI json transcription shape

### Whisper Integration

- [x] **WHSP-01**: Proxy forwards validated transcription request to local whisper-server via HTTP fetch
- [x] **WHSP-02**: Whisper model alias configured via `WHISPER_MODEL_ALIAS` env var; maps to sidecar model
- [x] **WHSP-03**: When whisper-server is unreachable, proxy returns OpenAI-shaped 503; chat completions remain unaffected
- [x] **WHSP-04**: `WHISPER_PORT`, `WHISPER_HOST`, `WHISPER_TIMEOUT_MS`, `AUDIO_MAX_FILE_BYTES` env vars respected by config
- [x] **WHSP-05**: `maxRequestBodySize` in Bun.serve raised to accommodate audio files separate from 1 MiB chat limit

### Auth & Security

- [x] **AUTH2-01**: POST /v1/audio/transcriptions requires valid Bearer token; returns 401 if missing or invalid (reuses existing auth middleware)
- [x] **AUTH2-02**: Proxy never logs audio file content, filenames, or transcribed text

### Observability

- [x] **OBS2-01**: Every transcription response carries `X-Request-ID` header (reuses existing middleware)
- [x] **OBS2-02**: Structured log per transcription request: requestId, latencyMs, fileSize, modelAlias, status — no audio content logged

### Tests

- [x] **TEST2-01**: 401 returned on missing or invalid auth token
- [x] **TEST2-02**: 400 returned when `file` field is absent
- [x] **TEST2-03**: 400 returned when `model` is an unknown alias
- [x] **TEST2-04**: 413 returned when file exceeds 25 MB
- [x] **TEST2-05**: 400 returned when request contains unknown fields
- [x] **TEST2-06**: 200 with `{ text: "..." }` returned when mock whisper service returns a transcript
- [x] **TEST2-07**: 503 returned when whisper service reports unavailable

---

## Out of Scope (v2.0)

| Feature | Reason |
|---|---|
| `verbose_json` and `text` response formats | Defer to v2.1; json covers current use cases |
| `language`, `temperature`, `prompt` forwarding | Defer; adds complexity without blocking drop-in compat |
| `srt`/`vtt` subtitle formats | Rarely used by OpenAI clients |
| Audio format validation (mp3/wav filtering) | whisper-server with `--convert` handles natively |
| `POST /v1/audio/translations` endpoint | Out of scope |
| Audio-specific rate-limit header capture | Local sidecar; no rate limits |

---

## v2.0 Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUDIO-01 | Phase 4 | Complete |
| AUDIO-02 | Phase 4 | Complete |
| AUDIO-03 | Phase 4 | Complete |
| AUDIO-04 | Phase 4 | Complete |
| AUDIO-05 | Phase 4 | Complete |
| AUDIO-06 | Phase 4 | Complete |
| WHSP-04 | Phase 4 | Complete |
| WHSP-05 | Phase 4 | Complete |
| EP2-01 | Phase 5 | Complete |
| AUTH2-01 | Phase 5 | Complete |
| AUTH2-02 | Phase 5 | Complete |
| OBS2-01 | Phase 5 | Complete |
| OBS2-02 | Phase 5 | Complete |
| TEST2-01 | Phase 5 | Complete |
| TEST2-02 | Phase 5 | Complete |
| TEST2-03 | Phase 5 | Complete |
| TEST2-04 | Phase 5 | Complete |
| TEST2-05 | Phase 5 | Complete |
| TEST2-06 | Phase 5 | Complete |
| TEST2-07 | Phase 5 | Complete |
| EP2-02 | Phase 6 | Complete |
| EP2-03 | Phase 6 | Complete |
| WHSP-01 | Phase 6 | Complete |
| WHSP-02 | Phase 6 | Complete |
| WHSP-03 | Phase 6 | Complete |

---

## v1.0 Validated Requirements

All 76 v1.0 requirements validated:

- ✓ Round-robin routing between Cerebras and Groq — Validated Phase 1–3
- ✓ Streaming SSE responses from providers — Validated Phase 2
- ✓ Provider SDK integration (groq-sdk, cerebras_cloud_sdk) — Validated Phase 1
- ✓ Bearer auth middleware — 401 on missing/invalid credentials — Validated Phase 1
- ✓ `POST /v1/chat/completions` — OpenAI wire-compatible, non-streaming + streaming — Validated Phase 1–2
- ✓ `GET /v1/models` — returns logical proxy aliases only — Validated Phase 1
- ✓ Allowlist-based field validation (Cerebras + Groq intersection) — Validated Phase 1
- ✓ Stateful round-robin among currently eligible providers — Validated Phase 2
- ✓ Failover to alternate provider on 408, 429, 498, 500–504 — Validated Phase 2
- ✓ Parse Cerebras + Groq rate-limit headers, `retry-after` — Validated Phase 2
- ✓ On 429: cooldown from reset headers, try alternate; recovery after expiry — Validated Phase 2
- ✓ Rewrite `model` to logical alias; strip provider-specific fields — Validated Phase 3
- ✓ Structured JSON logs per request; `X-Request-ID` on every response — Validated Phase 3
- ✓ Integration test suite (TEST-01..12) — Validated Phase 3

---

*Requirements initialized: 2026-06-04 (v1.0)*
*Updated: 2026-06-06 — v2.0 Local Audio Transcription (25 requirements across 7 categories, traceability table added)*
