# Research Summary: v2.0 Local Audio Transcription

**Synthesized:** 2026-06-06
**Milestone:** POST /v1/audio/transcriptions — local Whisper, OpenAI-compatible

---

## Executive Summary

This milestone adds `POST /v1/audio/transcriptions` to the existing Bun proxy. The core
architectural question resolved by research is: **local CLI subprocess vs. local HTTP sidecar
(whisper-server)**. The stack researcher and pitfalls researcher both point toward the HTTP
sidecar as the cleaner production pattern — model loaded once at startup, fetch()-based
integration identical to existing upstream calls, no temp-file management in the hot path.
The architecture researcher reached the opposite conclusion (subprocess per-request) on the
grounds that a sidecar adds operational complexity for a low-traffic personal proxy. Both
positions are defensible; the recommendation below resolves this in favor of the sidecar.

The scope clarification that matters most: **Groq's cloud audio API is out of scope**.
The user has explicitly chosen local/free inference. The feature table stakes from OpenAI's
API contract still apply — the local route must satisfy the same wire contract.

Zero new npm/Bun packages are required. The entire route uses native `Request.formData()`,
native `fetch()`, and the existing Zod v4 + config pattern. The only external additions are
two system packages (`whisper-cpp`, `ffmpeg` via Homebrew) and a downloaded model file.

---

## Stack Additions

### System dependencies (not npm/bun packages)

| Dependency | Install | Version | Purpose |
|---|---|---|---|
| `whisper-cpp` | `brew install whisper-cpp` | 1.8.6 | whisper-server binary + whisper-cli binary |
| `ffmpeg` | `brew install ffmpeg` | system latest | Audio conversion; called internally by whisper-server --convert |

### Model file

```bash
mkdir -p ./whisper-models
curl -L \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
  -o ./whisper-models/ggml-large-v3-turbo.bin
```

**Recommended model: `ggml-large-v3-turbo.bin` (~1.5 GB)**
- 129.5x real-time on Apple M-series; 13.40% WER
- large-v3 (~3.1 GB) only needed for translation — out of scope

### New environment variables

```bash
WHISPER_MODEL_PATH=./whisper-models/ggml-large-v3-turbo.bin   # required if feature enabled
WHISPER_PORT=8080
WHISPER_HOST=127.0.0.1
WHISPER_THREADS=4
WHISPER_MODEL_ALIAS=whisper-large-v3-turbo
WHISPER_TIMEOUT_MS=300000                                       # 5 min
AUDIO_MAX_FILE_BYTES=26214400                                   # 25 MB — SEPARATE from 1 MB chat limit
```

**CRITICAL:** `AUDIO_MAX_FILE_BYTES` must be separate from `MAX_REQUEST_BODY_BYTES`. The
existing 1 MiB global body limit will reject audio uploads before the fetch handler runs.

### Do NOT add

- `nodejs-whisper`, `whisper-node`, `smart-whisper` — NAPI addons with uncertain Bun compat
- `mlx-whisper`, `faster-whisper`, `openai-whisper` — Python subprocess; wrong runtime
- `multer`, `busboy` — Bun native `Request.formData()` handles multipart

---

## Feature Table Stakes

| ID | Feature | Notes |
|---|---|---|
| AUDIO-01 | Multipart form data parsing | Bun native; wrap in try/catch — see Pitfall P2 |
| AUDIO-02 | Request field allowlist validation | Zod strictObject; reject unknown fields |
| AUDIO-03 | Model alias resolution | `whisper-large-v3-turbo` → whisper-server; 400 on unknown alias |
| AUDIO-04 | Forward to local whisper-server via fetch() | Reconstruct FormData; relay raw response |
| AUDIO-05 | Audio format validation | Accept mp3/mp4/mpeg/mpga/m4a/wav/webm; 400 on others |
| AUDIO-06 | File size limit (25 MB) | Check blob.size before forwarding; OpenAI-shaped 413 |
| AUDIO-07 | Bearer auth (existing middleware) | Route MUST be after auth gate |
| AUDIO-08 | OpenAI-shaped error responses | Reuse existing `openaiError()` helper for all error paths |

### Supported request fields

| Field | Type | Required | Forward? |
|---|---|---|---|
| `file` | File (multipart) | Yes | Yes |
| `model` | string | Yes | Resolve alias; do not forward raw |
| `language` | string | No | Yes |
| `response_format` | string | No | json/verbose_json/text only; reject srt/vtt |
| `temperature` | number | No | Yes |
| `prompt` | string | No | Yes if whisper-server accepts |
| `timestamp_granularities[]` | string[] | No | Yes with verbose_json only |

### Reject with 400

`stream: true`, `response_format: srt/vtt`, `include`, `chunking_strategy`,
`known_speaker_names`, `n != 1`, `logprobs`, `logit_bias`

---

## Feature Differentiators

| ID | Feature | Complexity |
|---|---|---|
| AUDIO-D1 | Inject `model` field into verbose_json response | Low |
| AUDIO-D2 | Structured logging (requestId, latencyMs, fileSize, format) | Low |
| AUDIO-D3 | X-Request-ID on all responses | None — already in middleware |
| AUDIO-D4 | Whisper aliases in `/v1/models` | Low |
| AUDIO-D5 | `whisperAvailable` field in `/ready` | Low |

---

## Architecture Changes

### Decision: whisper-server HTTP sidecar (over CLI subprocess)

Resolves STACK.md vs ARCHITECTURE.md conflict in favor of the sidecar:
1. Model loads once — no per-request cold-start (2–30 second penalty on subprocess)
2. `--convert` flag handles all ffmpeg work internally — zero audio preprocessing code
3. `fetch()` integration mirrors existing upstream calls — no Bun.spawn complexity
4. Eliminates most subprocess-specific critical pitfalls

The `WhisperService` interface makes swapping to subprocess transparent if needed.

### New files

```
routes/audio-transcriptions.ts    — POST /v1/audio/transcriptions handler
schemas/audio-transcriptions.ts   — Zod validation for multipart fields
services/whisper.ts               — WhisperService interface + HTTP sidecar implementation
```

### Modified files

| File | Change |
|---|---|
| `config.ts` | Add WHISPER_* and AUDIO_MAX_FILE_BYTES env vars; startup validation |
| `index.ts` | Register route; raise maxRequestBodySize; extend /ready |
| `types.ts` | Add WhisperResult, WhisperTranscribeOptions, WhisperService interfaces |
| `model-registry.ts` | Add whisper alias when WHISPER_MODEL_PATH is configured |

### WhisperService interface (injectable for testability)

```typescript
export interface WhisperService {
    transcribe(
        file: File,
        options: WhisperTranscribeOptions,
        signal?: AbortSignal
    ): Promise<WhisperResult>;
    isAvailable(): boolean;
}
```

### Request lifecycle

```
POST /v1/audio/transcriptions
  → auth gate (existing Bearer check)
  → server.timeout(request, 0)           ← REQUIRED — prevents idle timeout
  → request.formData()                   ← try/catch; 400 on parse error
  → schemas/audio-transcriptions.ts      ← Zod validation; 400 on fail
  → blob.size check                      ← 413 if > AUDIO_MAX_FILE_BYTES
  → services/whisper.ts transcribe()
      → reconstruct FormData
      → fetch("http://127.0.0.1:8080/v1/audio/transcriptions")
      → relay raw response body
  → map response_format → Content-Type
  → return with X-Request-ID header
  → structured log (no audio content logged)
```

### Whisper sidecar startup (external to Bun)

```bash
whisper-server \
  --model "${WHISPER_MODEL_PATH}" \
  --host "${WHISPER_HOST:-127.0.0.1}" \
  --port "${WHISPER_PORT:-8080}" \
  --inference-path "/v1/audio/transcriptions" \
  --threads "${WHISPER_THREADS:-4}" \
  --convert
```

The `/ready` endpoint pings `http://127.0.0.1:8080/health` and reports `whisperAvailable`.
Proxy remains fully functional for chat completions if whisper-server is down.

---

## Critical Pitfalls

### P1: maxRequestBodySize 1 MiB blocks audio before handler runs

Bun returns a bare 413 before the handler runs if body exceeds `maxRequestBodySize`.
**Prevention:** Set `maxRequestBodySize` on `Bun.serve` to `Math.max(MAX_REQUEST_BODY_BYTES, AUDIO_MAX_FILE_BYTES)`.

### P2: Bun formData() throws on malformed Content-Type boundary

Missing boundary parameter causes unhandled TypeError, returning bare 502.
**Prevention:** Wrap `await request.formData()` in try/catch; return OpenAI-style 400.

### P3: New route must be placed AFTER the auth gate in index.ts

A route inserted above the auth guard is unauthenticated.
**Prevention:** Write a 401 test for the new route immediately after registering it.

### P4: server.timeout(request, 0) required — idle timeout fires during transcription

Default idleTimeout closes connections with no byte activity during inference (30+ seconds).
**Prevention:** `server.timeout(request, 0)` as the first line of the audio route handler.

### P5: response_format determines Content-Type — wrong mapping breaks SDK parsers

openai-python inspects Content-Type to decide how to parse the response.
**Prevention:** `json`/`verbose_json` → `application/json`; `text` → `text/plain`.
Error responses always use `application/json` regardless of response_format.

---

## Recommended Build Order

### Phase 4 — Foundation (no I/O, no binary)
Config, types, Zod schema, maxRequestBodySize fix. All tests pass in CI with zero whisper dependencies.

### Phase 5 — Route handler with mock service
Full request/response lifecycle, auth coverage, Content-Type mapping, error shapes. TranscriptionService injected as mock. Full test coverage without whisper binary.

### Phase 6 — Whisper service + integration
HTTP sidecar fetch client, isAvailable() health check, /v1/models extension, /ready whisperAvailable field. Integration tests gated on WHISPER_AVAILABLE env var.

---

## Open Questions

1. **srt/vtt formats** — whisper-server likely supports them natively. Include or defer from v2.0 MVP?
2. **Whisper model alias naming** — `whisper-1` (OpenAI compat) vs `whisper-large-v3-turbo` (descriptive)?
3. **ffmpeg requirement** — with sidecar + `--convert` it's internal; confirm deployment env has ffmpeg.
4. **Concurrency limit** — WHISPER_CONCURRENCY_LIMIT=1 serializes transcriptions; confirm acceptable.

---

## Confidence

**Overall: MEDIUM-HIGH**

| Area | Confidence |
|---|---|
| Stack (sidecar binary + brew) | HIGH |
| Bun FormData parsing behavior | HIGH |
| OpenAI wire contract | HIGH |
| whisper-server HTTP API shape | MEDIUM-HIGH — verify with curl before Phase 6 |
| whisper output JSON format | MEDIUM — verify against installed version |
