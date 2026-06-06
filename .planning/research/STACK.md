# Stack Research: Local Audio Transcription

**Project:** bun-ai-api — POST /v1/audio/transcriptions milestone
**Researched:** 2026-06-06
**Scope:** New additions only — existing Bun/Zod/groq-sdk/cerebras_cloud_sdk stack is unchanged

---

## Recommended Whisper Backend

**whisper-server (built into whisper.cpp) via HTTP sidecar — not CLI subprocess**

This is the pivotal architectural choice. whisper.cpp ships a built-in HTTP server
(`whisper-server` binary) that exposes an OpenAI-compatible transcription endpoint.
Running it as a local sidecar process eliminates the need for per-request subprocess
spawning, temp-file management of WAV intermediates, and JSON-from-file parsing.

### Why whisper-server sidecar beats CLI subprocess

| Factor | CLI subprocess (whisper-cpp -f file.wav) | HTTP sidecar (whisper-server) |
|--------|------------------------------------------|-------------------------------|
| Per-request overhead | Fork + model load every call | Model loaded once at startup |
| Audio format | Only 16kHz mono WAV natively | Accepts any format with --convert |
| JSON output to stdout | NOT supported (open issue #2571, Nov 2024) | Native JSON response body |
| Temp file cleanup | Manual, error-prone | Server handles internally |
| Concurrent requests | Sequential (one proc at a time) | Serialized by mutex, safe |
| Integration surface | Bun.spawn, stdout parsing, file I/O | fetch() — identical to upstream calls |

**Install (macOS):**
```bash
brew install whisper-cpp   # version 1.8.6 as of research date
brew install ffmpeg        # required for --convert flag
```

**Start sidecar:**
```bash
whisper-server \
  --model "${WHISPER_MODEL_PATH}" \
  --host 127.0.0.1 \
  --port "${WHISPER_PORT:-8080}" \
  --inference-path "/v1/audio/transcriptions" \
  --threads 4 \
  --convert
```

The `--inference-path "/v1/audio/transcriptions"` flag remaps the server endpoint
to match the OpenAI spec exactly. The `--convert` flag invokes FFmpeg internally to
normalize any incoming audio to 16kHz mono PCM before inference — no ffmpeg subprocess
calls needed in application code.

**Confidence:** MEDIUM-HIGH — HTTP server functionality confirmed via official whisper.cpp
DeepWiki documentation and Voice Mode readthedocs. The `--inference-path` flag confirmed
in multiple independent sources.

---

## Subprocess Integration Pattern

Because the recommended approach is HTTP sidecar, the Bun server proxies to the local
whisper-server using `fetch()` — the same pattern already used for Cerebras/Groq upstream
calls. No `Bun.spawn` needed for the hot path.

**Proxy pattern (what the route handler does):**

```typescript
// routes/audio-transcriptions.ts
export async function handleAudioTranscription(req: Request): Promise<Response> {
  // 1. Parse multipart from downstream client (see FormData section below)
  const formData = await req.formData();
  const file = formData.get("file");       // Blob
  const model = formData.get("model");     // logical alias — validated but not forwarded
  const responseFormat = formData.get("response_format") ?? "json";
  const language = formData.get("language");

  // 2. Forward to local whisper-server — reconstruct FormData
  const upstream = new FormData();
  upstream.append("file", file as Blob, (file as File).name ?? "audio.wav");
  if (language) upstream.append("language", language as string);
  upstream.append("response_format", responseFormat as string);

  const whisperResp = await fetch(
    `http://127.0.0.1:${WHISPER_PORT}/v1/audio/transcriptions`,
    { method: "POST", body: upstream }
  );

  // 3. Normalize response — return { text: "..." } shape
  const body = await whisperResp.json();
  return Response.json({ text: body.text }, { status: whisperResp.status });
}
```

**Sidecar lifecycle:** whisper-server must be running before the Bun process serves
audio requests. The `/ready` endpoint should check whisper-server availability:

```typescript
// In readiness check
const whisperAlive = await fetch("http://127.0.0.1:8080/health")
  .then(r => r.ok)
  .catch(() => false);
```

**If subprocess spawning is ever needed (fallback/testing only):**

`Bun.spawn` signature for reference:

```typescript
const proc = Bun.spawn(["whisper-cpp", "-m", modelPath, "-f", inputWavPath], {
  stdout: "pipe",
  stderr: "pipe",
});
await proc.exited;
const text = await proc.stdout.text();
```

Note: `-oj` writes JSON to a file on disk, not stdout. The whisper.cpp CLI has an
open feature request (issue #2571, November 2024, unresolved) for stdout JSON output.
This confirms the CLI path requires temp-file I/O per request — another argument
against it.

---

## Multipart/FormData Parsing in Bun

Bun has native `Request.formData()` support — no third-party library needed.

**Working pattern:**

```typescript
const formData = await req.formData();
const file = formData.get("file");      // returns File (extends Blob) for file fields
const model = formData.get("model");    // returns string for text fields

if (!(file instanceof Blob)) {
  return Response.json({ error: "file field required" }, { status: 400 });
}

// Get bytes for further processing if needed
const bytes = new Uint8Array(await file.arrayBuffer());
const filename = file instanceof File ? file.name : "upload";

// Or write directly to disk (for CLI approach)
await Bun.write("/tmp/whisper-upload.wav", file);
```

**Known Bun FormData limitations (verified via open issues):**

1. Binary file content truncates at first null byte (0x00) for files <= 8 bytes.
   Audio files are always larger — this edge case does not apply.
2. Intermittent parse failures under high concurrency have been reported (issue #19097).
   For a personal proxy with low RPS this is unlikely to matter.
3. Large file uploads (100MB+) are fine; Bun streams the body.

**OpenAI multipart field names to accept:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `file` | File blob | Yes | Audio file |
| `model` | string | Yes | Validate as known alias; do not forward raw |
| `language` | string | No | BCP-47 code e.g. "en" |
| `response_format` | string | No | "json" or "text"; "verbose_json"/"srt"/"vtt" if whisper-server supports |
| `temperature` | string | No | Parse as float; forward if whisper-server accepts |
| `prompt` | string | No | Context hint; forward if whisper-server accepts |
| `timestamp_granularities[]` | string | No | Defer to post-MVP |

Reject unknown fields with a 400 to match the existing proxy's strict validation
posture (same pattern as `request-schema.ts` for chat completions).

---

## Audio Format Handling

**whisper.cpp native requirement:** 16kHz mono 16-bit PCM WAV only.

**whisper-server with `--convert`:** Delegates to FFmpeg automatically. This means
any format FFmpeg understands is accepted — which covers the full OpenAI-supported set.

### Format support matrix

| Format | OpenAI accepts | whisper-server --convert | Raw whisper.cpp CLI |
|--------|---------------|--------------------------|---------------------|
| wav (16kHz mono) | Yes | Yes (passthrough) | Yes |
| wav (44.1/48kHz stereo) | Yes | Yes (resampled) | No — must convert |
| mp3 | Yes | Yes | No |
| mp4 | Yes | Yes | No |
| mpeg / mpga | Yes | Yes | No |
| m4a | Yes | Yes | No |
| ogg | Yes | Yes | No |
| webm | Yes | Yes | No |
| flac | Yes | Yes | No |

**Conclusion:** With `--convert`, application code needs zero ffmpeg invocations.
FFmpeg is a system dependency (`brew install ffmpeg`) but not a runtime npm/Bun package.

**Size limit:** Enforce OpenAI's 25MB limit at the Bun layer before forwarding:

```typescript
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
if ((file as Blob).size > MAX_AUDIO_BYTES) {
  return Response.json(
    { error: { message: "File too large. Max 25 MB.", type: "invalid_request_error" } },
    { status: 413 }
  );
}
```

---

## Model Management

### Where to store model files

```
${WHISPER_MODEL_DIR}/              # env var; default: ./whisper-models/
  ggml-large-v3-turbo.bin          # recommended default (~1.5 GB)
  ggml-base.en.bin                 # fast English-only option (~141 MB)
  ggml-small.en.bin                # balanced option (~466 MB)
```

Models are NOT downloaded automatically. One-time setup:

```bash
mkdir -p ./whisper-models
curl -L \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
  -o ./whisper-models/ggml-large-v3-turbo.bin
```

Homebrew installs do not bundle models — they must be downloaded separately from
https://huggingface.co/ggerganov/whisper.cpp/tree/main

### Environment variable pattern (matches existing config.ts style)

```bash
# Required for audio transcription feature
WHISPER_MODEL_PATH=./whisper-models/ggml-large-v3-turbo.bin

# Optional
WHISPER_PORT=8080
WHISPER_HOST=127.0.0.1
WHISPER_THREADS=4
```

### Model size recommendations

| Model | Size | Speed (Apple M1) | WER | Use Case |
|-------|------|-----------------|-----|----------|
| tiny | 75 MB | Fastest | Highest error | Testing only |
| base.en | 141 MB | Very fast | High error | English dev testing |
| small | 466 MB | Fast | Moderate | Quick personal use |
| large-v3-turbo | 1.5 GB | 129.5x real-time | 13.40% | **Recommended default** |
| large-v3 | 3.1 GB | 55.3x real-time | 13.20% | Translation tasks only |

**Recommendation: large-v3-turbo.** Benchmarked at 129.5x real-time on M-series hardware.
Fits in 1.5 GB VRAM. Less than 0.2% WER difference from large-v3 for transcription.
large-v3 is only needed if translation (not just transcription) is required — out of MVP scope.

### Cross-platform note (Apple Silicon vs Linux/Docker)

For Metal GPU acceleration on Apple Silicon, set before starting whisper-server:

```bash
export GGML_METAL_PATH_RESOURCES="$(brew --prefix whisper-cpp)/share/whisper-cpp"
```

For Linux or Docker, build from source:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp && make
```

Or use the official Docker image `ggerganov/whisper.cpp`. The sidecar HTTP pattern
works identically on both platforms — only the startup command differs.

---

## What NOT to Add

### Do not add nodejs-whisper or whisper-node npm packages

Both `nodejs-whisper` (v0.3.0) and `whisper-node` are thin wrappers that:
- Shell out to the whisper.cpp CLI binary anyway (no performance gain vs direct CLI)
- Require NAPI native build steps with uncertain Bun compatibility
- Bun implements ~95% of Node-API but has known libuv incompatibilities
- Add an abstraction layer that obscures error handling
- Provide no benefit over direct `fetch()` to whisper-server

### Do not add smart-whisper or whisper.cpp-wrapper

Same reasons — NAPI addons, stale release cadence (whisper.cpp-wrapper last released
>1 year ago), no verified Bun compatibility.

### Do not add mlx-whisper (Python)

mlx-whisper is fastest on Apple Silicon but:
- Requires Python runtime as an additional system dependency
- Subprocess with stdout/JSON-RPC parsing adds friction
- Only works on macOS with Apple Silicon — no Linux/Docker path
- whisper.cpp with Metal acceleration is nearly as fast with fewer moving parts

### Do not add faster-whisper (Python/CTranslate2)

- Also Python subprocess with same cross-language friction
- Slower than mlx-whisper on Apple Silicon (~50% slower per benchmark)
- No simpler than the HTTP sidecar approach

### Do not add openai-whisper (original Python package)

- Slowest Python implementation
- Requires PyTorch, adding hundreds of MB of dependency overhead
- whisper.cpp offers 2-5x faster inference on the same models

### Do not add multer or busboy

Bun's native `Request.formData()` handles multipart parsing. No middleware needed.

### Do not expand to /v1/audio/speech (TTS)

Out of MVP scope per CLAUDE.md. Neither Cerebras nor Groq exposes TTS in the
unified contract.

---

## Summary of New Dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `brew install whisper-cpp` | System (Homebrew) | whisper-server binary + whisper-cpp CLI |
| `brew install ffmpeg` | System (Homebrew) | Audio format conversion (used internally by whisper-server --convert) |
| ggml model file (~1.5 GB) | Static asset | large-v3-turbo model weights downloaded from Hugging Face |

**Zero new npm/bun packages.** The audio transcription route uses:
- Native `Request.formData()` for upload parsing
- Native `fetch()` to forward to whisper-server
- Existing `config.ts` pattern for env vars
- Existing Zod v4 for request schema validation

---

## Sources

- [whisper.cpp GitHub](https://github.com/ggml-org/whisper.cpp)
- [whisper-cpp Homebrew formula v1.8.6](https://formulae.brew.sh/formula/whisper-cpp)
- [whisper.cpp HTTP Server — DeepWiki](https://deepwiki.com/ggml-org/whisper.cpp/3.2-http-server)
- [Voice Mode whisper.cpp setup docs](https://voice-mode.readthedocs.io/en/stable/whisper.cpp/)
- [whisper.cpp audio format support discussion #1399](https://github.com/ggml-org/whisper.cpp/discussions/1399)
- [whisper.cpp stdout JSON feature request #2571](https://github.com/ggml-org/whisper.cpp/issues/2571)
- [Bun file uploads guide](https://bun.com/docs/guides/http/file-uploads)
- [Bun.spawn documentation](https://bun.com/docs/runtime/child-process)
- [Bun Node-API compatibility](https://bun.com/docs/runtime/node-api)
- [Bun FormData concurrency issue #19097](https://github.com/oven-sh/bun/issues/19097)
- [Bun FormData null byte issue #26740](https://github.com/oven-sh/bun/issues/26740)
- [Whisper large-v3-turbo benchmark](https://whispernotes.app/blog/introducing-whisper-large-v3-turbo)
- [MLX vs faster-whisper Apple Silicon comparison](https://medium.com/@GenerationAI/streaming-with-whisper-in-mlx-vs-faster-whisper-vs-insanely-fast-whisper-37cebcfc4d27)
- [Apple Silicon Whisper speed benchmark](https://github.com/anvanvan/mac-whisper-speedtest)
- [OpenAI audio transcriptions API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
