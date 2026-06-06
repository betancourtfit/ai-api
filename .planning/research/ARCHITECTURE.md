# Architecture Research: Audio Transcription Integration

**Project:** bun-ai-api — POST /v1/audio/transcriptions milestone
**Researched:** 2026-06-06
**Overall confidence:** HIGH (Bun docs verified via official docs; whisper.cpp patterns verified via production examples)

---

## Context: What Already Exists

The proxy has a flat root-level structure with these directories at the repo root:

```
index.ts            — Bun.serve() createServer factory
config.ts           — env loader
types.ts            — shared interfaces
model-registry.ts   — alias registry
request-schema.ts   — Zod validation (chat completions)
response-normalizer.ts
routing/            — provider-state.ts, cooldown-manager.ts
services/           — groq.ts, cerebras.ts (ProviderAdapter implementations)
tests/              — integration/ and routing/ subdirectories
```

The `createServer(adapters)` factory pattern is already established. Auth, request-ID, and structured logging are cross-cutting and already apply to every route.

---

## New Components

### `routes/audio-transcriptions.ts`

**Responsibility:** Handle `POST /v1/audio/transcriptions`. Parse multipart form data, validate fields, delegate to the Whisper service, return OpenAI-compatible JSON.

This is a route handler, not a provider adapter. It bypasses the LLM provider router entirely — Whisper is local, not a remote API with cooldowns and rate limits.

```typescript
// Minimal shape
export async function handleAudioTranscriptions(
    request: Request,
    requestId: string
): Promise<Response>
```

### `services/whisper.ts`

**Responsibility:** Encapsulate all Whisper subprocess logic. Write temp file, spawn `Bun.spawn()`, await exit, parse output, clean up temp file. Returns a typed result.

```typescript
export interface WhisperResult {
    text: string;
    language?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
}

export interface WhisperService {
    transcribe(
        audioBuffer: ArrayBuffer,
        options: WhisperTranscribeOptions,
        signal?: AbortSignal
    ): Promise<WhisperResult>;
}

export interface WhisperTranscribeOptions {
    language?: string;         // ISO-639-1 or "auto"
    responseFormat?: "json" | "text" | "verbose_json" | "srt" | "vtt";
    prompt?: string;           // forwarded as --prompt (if binary supports it)
    temperature?: number;
}
```

This module is a self-contained I/O unit with no awareness of HTTP.

### `schemas/audio-transcriptions.ts`

**Responsibility:** Zod validation for the multipart form fields. Parallel to `request-schema.ts` for chat completions.

Fields to validate:
- `file` — required, Blob, non-empty
- `model` — required, must match `WHISPER_MODEL_ALIAS` (the proxy's logical alias for Whisper)
- `language` — optional, ISO-639-1 string
- `response_format` — optional, enum: `json | text | verbose_json | srt | vtt`
- `prompt` — optional, string
- `temperature` — optional, number 0–1

Reject unknown fields (consistent with chat completions schema approach using `z.strictObject()`).

---

## Modified Components

### `index.ts` — Route Registration

Add one route match inside the existing `createServer` fetch handler, after the auth gate:

```typescript
if (request.method === 'POST' && pathname === '/v1/audio/transcriptions') {
    return handleAudioTranscriptions(request, requestId);
}
```

No other structural changes. The auth gate, request-ID generation, and `withRequestId` wrapper already apply before this branch is reached.

### `config.ts` — New Env Vars

Add three new fields:

```typescript
whisperBinary: process.env["WHISPER_BINARY"] ?? "whisper-cli",
whisperModelPath: process.env["WHISPER_MODEL_PATH"] ?? "",
whisperModelAlias: process.env["WHISPER_MODEL_ALIAS"] ?? "whisper-1",
whisperConcurrencyLimit: Number(process.env["WHISPER_CONCURRENCY_LIMIT"] ?? 1),
whisperTimeoutMs: Number(process.env["WHISPER_TIMEOUT_MS"] ?? 300000),
```

`whisperModelPath` is required at startup if audio transcription is enabled. Validate at startup: if `WHISPER_MODEL_PATH` is set but the file does not exist, log a warning (not a fatal error — the proxy remains useful for LLM completions).

### `types.ts` — New Shared Types

Add `WhisperResult` and `WhisperTranscribeOptions` interfaces. Keep them in `types.ts` alongside existing interfaces to maintain the one-file-for-contracts convention.

### `GET /ready` route in `index.ts`

Optionally extend `ready` response to include Whisper availability:

```json
{
  "ready": true,
  "mode": "ok",
  "eligibleProviders": ["cerebras", "groq"],
  "audioTranscription": { "available": true, "model": "whisper-1" }
}
```

Only add if `WHISPER_MODEL_PATH` is configured.

---

## Request Lifecycle

**Step-by-step from HTTP receive through response:**

```
1. Client: POST /v1/audio/transcriptions
           Content-Type: multipart/form-data
           Authorization: Bearer PERSONAL_PROXY_API_KEY
           Body: file=<audio blob>, model=whisper-1, [language=en], [response_format=json]

2. index.ts Bun.serve() fetch handler
   → generates requestId (existing OBS-01 pattern)
   → health/ready check: skipped (these are GET)
   → auth gate (existing): validates Bearer token → 401 on fail

3. Route dispatch: POST /v1/audio/transcriptions matched
   → routes/audio-transcriptions.ts handleAudioTranscriptions(request, requestId)

4. Parse multipart form data
   → await request.formData()   [Bun native — verified via docs]
   → const file = formData.get("file") as File | null
   → extract: model, language, response_format, prompt, temperature

5. schemas/audio-transcriptions.ts validation
   → reject unknown fields
   → reject missing file
   → reject unknown model alias
   → return 400 OpenAI error on failure (same openaiError() helper as chat completions)

6. Read audio bytes
   → const audioBuffer = await file.arrayBuffer()
   → size check: if > MAX_REQUEST_BODY_BYTES → 413

7. services/whisper.ts transcribe()
   a. Acquire concurrency slot (semaphore, if WHISPER_CONCURRENCY_LIMIT > 1)
   b. Write temp file: await Bun.write(tmpPath, audioBuffer)
   c. Build Bun.spawn() command array
   d. Await proc.exited with timeout
   e. Read output (from temp output file or stdout depending on format)
   f. Delete temp files (try/finally)
   g. Release concurrency slot
   h. Return WhisperResult or throw typed WhisperError

8. routes/audio-transcriptions.ts
   → map WhisperResult to OpenAI response shape based on response_format
   → return withRequestId(new Response(body, { status: 200 }))

9. Log structured request_complete event (same pattern as chat completions)
   → requestId, route, latencyMs, statusCode, model alias
   → do NOT log audio content or transcription text
```

---

## Whisper Process Model

**Recommendation: per-request subprocess, not persistent process.**

### Why not persistent process (HTTP server mode)

whisper.cpp ships a `whisper-server` binary that runs an HTTP server with mutex-based request serialization. Running it as a sidecar would require:

- Managing a second long-running process from Bun (health checks, restart on crash)
- HTTP-to-HTTP forwarding (adds latency, adds complexity)
- A different startup sequence for model loading
- Network port allocation and potential port conflicts in containerized environments

The benefit — model stays loaded in memory — only matters when throughput is high. For a personal proxy with low concurrency this adds operational complexity without a proportional benefit.

**Ruling: run the CLI binary per-request.**

### Per-request subprocess pattern (chosen)

```typescript
// services/whisper.ts
const proc = Bun.spawn({
    cmd: [config.whisperBinary, "-m", config.whisperModelPath, "-f", tmpInputPath,
          "--output-json", "--output-file", tmpOutputBase, "-l", language, "-t", "2"],
    stdout: "pipe",
    stderr: "pipe",
    timeout: config.whisperTimeoutMs,   // Bun native timeout — kills proc on expiry
    signal,                              // AbortSignal from request handler
});

await proc.exited;

if (proc.exitCode !== 0) {
    const stderr = await proc.stderr.text();
    throw new WhisperError(`whisper process failed (exit ${proc.exitCode}): ${stderr}`);
}
```

**Key tradeoff:** The whisper.cpp binary loads the model into memory on each invocation. For `ggml-base` (~150 MB) on modern hardware this is ~1–2 seconds of startup overhead per request. For a personal proxy where requests are infrequent and sequential this is acceptable.

**If startup latency becomes unacceptable:** the architecture can later be upgraded to a persistent whisper-server sidecar. The service boundary in `services/whisper.ts` makes this swap transparent to the route handler.

### Concurrency: serialization via semaphore

whisper.cpp is single-threaded during inference and CPU-intensive. Running two simultaneous transcriptions saturates CPU and doubles latency for both. The correct design serializes requests through a simple semaphore:

```typescript
// services/whisper.ts — module-level semaphore
let activeTranscriptions = 0;

async function acquireSlot(): Promise<void> {
    while (activeTranscriptions >= config.whisperConcurrencyLimit) {
        await Bun.sleep(50);  // poll — acceptable for low-concurrency personal proxy
    }
    activeTranscriptions++;
}

function releaseSlot(): void {
    activeTranscriptions = Math.max(0, activeTranscriptions - 1);
}
```

For `WHISPER_CONCURRENCY_LIMIT=1` (the default), this serializes all transcriptions. Callers queue and wait, which is correct behavior — excess concurrency would degrade everyone's latency.

**If a promise-based queue is preferred over polling:** a simple `AsyncQueue` backed by an array of resolve functions avoids the `Bun.sleep` loop and is O(1) per enqueue/dequeue. Either approach is appropriate for this use case.

---

## Temp File Management

**Pattern: write input file, spawn process, clean up in `finally`.**

whisper.cpp requires an input file path — it cannot read from stdin (stdin support has been requested but not shipped as of 2026). The output JSON is written to a file named `<base>.json` by the binary.

```typescript
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

async function transcribe(audioBuffer: ArrayBuffer, opts: WhisperTranscribeOptions): Promise<WhisperResult> {
    const id = crypto.randomUUID();
    const tmpInputPath = join(tmpdir(), `whisper-in-${id}.wav`);
    const tmpOutputBase = join(tmpdir(), `whisper-out-${id}`);
    const tmpOutputJson = `${tmpOutputBase}.json`;

    try {
        await Bun.write(tmpInputPath, audioBuffer);

        const proc = Bun.spawn({
            cmd: buildWhisperCmd(tmpInputPath, tmpOutputBase, opts),
            stdout: "ignore",
            stderr: "pipe",
            timeout: config.whisperTimeoutMs,
        });

        await proc.exited;

        if (proc.exitCode !== 0) {
            const errText = await proc.stderr.text();
            throw new WhisperError(proc.exitCode ?? -1, errText);
        }

        const outputFile = Bun.file(tmpOutputJson);
        const raw = await outputFile.json() as WhisperJsonOutput;
        return parseWhisperJson(raw);

    } finally {
        // Best-effort cleanup — never throw from cleanup
        await Promise.allSettled([
            unlink(tmpInputPath).catch(() => {}),
            unlink(tmpOutputJson).catch(() => {}),
        ]);
    }
}
```

**Why `node:os` tmpdir and `node:fs/promises` unlink:** Bun is Node.js-compatible for these APIs. `Bun.write()` handles the write; `node:fs/promises` `unlink` handles deletion. Avoid leaving temp files on disk on error paths — the `finally` block covers both success and all failure modes.

**Audio format note:** whisper.cpp requires 16kHz mono WAV. If the client uploads MP3, M4A, or other formats, the binary will fail. The route handler should either:
1. Reject non-WAV formats with a 400 explaining the limitation (simplest for MVP).
2. Optionally invoke `ffmpeg` before whisper if `ffmpeg` is available (deferred to later).

The `Content-Type` of the file field and its extension are not reliable format indicators — whisper will simply report an error on bad input. The safest MVP approach is to document the WAV requirement and return the binary's stderr as the error message.

---

## Whisper Command Structure

Based on research into whisper.cpp CLI flags:

```bash
whisper-cli \
  -m /path/to/ggml-model.bin \   # WHISPER_MODEL_PATH
  -f /tmp/whisper-in-<uuid>.wav \ # temp input file
  --output-json \                  # produces <output-base>.json
  --output-file /tmp/whisper-out-<uuid> \ # base name without extension
  -l en \                          # language (from request, or "auto" for detect)
  -t 2 \                           # thread count (keep low to avoid CPU starvation)
  --no-prints                      # suppress progress output to stderr (if supported)
```

The JSON output file (`<base>.json`) contains a `transcription` array with segments:

```json
{
  "transcription": [
    { "timestamps": { "from": "00:00:00,000", "to": "00:00:05,120" },
      "offsets": { "from": 0, "to": 5120 },
      "text": " Hello, this is a test." }
  ]
}
```

The OpenAI response for `response_format=json` is:

```json
{ "text": "Hello, this is a test." }
```

For `verbose_json`:

```json
{
  "task": "transcribe",
  "language": "english",
  "duration": 5.12,
  "text": "Hello, this is a test.",
  "segments": [
    { "id": 0, "start": 0.0, "end": 5.12, "text": " Hello, this is a test." }
  ]
}
```

The `parseWhisperJson` function concatenates segment text fields and maps timestamps from millisecond offsets to float seconds.

---

## Configuration

All new env vars go in `config.ts` alongside existing vars. No new config file needed.

| Env var | Default | Required | Notes |
|---------|---------|----------|-------|
| `WHISPER_BINARY` | `whisper-cli` | No | Path or binary name on PATH |
| `WHISPER_MODEL_PATH` | `""` | Yes (if feature used) | Absolute path to `.bin` model file |
| `WHISPER_MODEL_ALIAS` | `whisper-1` | No | Logical alias exposed in `/v1/models` |
| `WHISPER_CONCURRENCY_LIMIT` | `1` | No | Max simultaneous transcriptions |
| `WHISPER_TIMEOUT_MS` | `300000` | No | 5 min; kill proc if exceeded |

**Validation approach:** On startup, if `WHISPER_MODEL_PATH` is non-empty, check that the file exists using `Bun.file(path).exists()`. If absent, log a `warn`-level structured message but do not crash — the proxy can still serve LLM completions. The audio route handler checks availability at request time and returns a 503 if Whisper is not configured.

**`/v1/models` extension:** If `WHISPER_MODEL_ALIAS` is configured and `WHISPER_MODEL_PATH` exists, include the Whisper alias in the models list alongside the LLM aliases. This is the correct OpenAI-compatible behavior — clients discover available models before calling.

---

## Whisper Is Not a Provider Adapter

**Do not route Whisper through the existing `ProviderAdapter` / `chooseEligibleProviders` system.**

The existing provider router exists to:
- Select between Cerebras and Groq
- Track cooldowns after 429 responses
- Fail over to an alternate provider on transient errors

Whisper has none of these properties:
- There is no second Whisper provider to fail over to
- There are no rate limit headers to parse
- There are no cooldown windows
- It is local — failures are process errors, not HTTP status codes

Forcing Whisper into the `ProviderAdapter` interface would require stubbing all the routing fields (cooldown, failover, eligibility) with no-ops and would make the code misleading. The correct architecture is a separate, simpler service module.

**The analogy is:** Whisper is to audio transcriptions what `model-registry.ts` is to model resolution — a focused service module called directly from a route handler, not a generalized adapter plugged into the router.

---

## OpenAI Wire Compatibility

The OpenAI `/v1/audio/transcriptions` endpoint accepts:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `file` | File (multipart) | Yes | Audio file blob |
| `model` | string | Yes | `whisper-1` in OpenAI's case |
| `language` | string | No | ISO-639-1 (e.g., `"en"`) |
| `response_format` | string | No | `json` (default), `text`, `verbose_json`, `srt`, `vtt` |
| `prompt` | string | No | Style hint for the model |
| `temperature` | number | No | 0–1 |

The proxy should accept the same fields. For MVP: support `json` (default), `text`, and `verbose_json`. Defer `srt` and `vtt` — they require format-specific serialization and clients rarely need them from a personal proxy.

The response `Content-Type` is `application/json` for all three supported formats (including `text` — OpenAI wraps it in JSON as `{ "text": "..." }`).

---

## Build Order

Dependencies flow: config → types → schemas → services → routes → index.

### Step 1 — Config extension (low risk, no behavior change)

Add new env vars to `config.ts`. Write a startup validation helper that checks `WHISPER_MODEL_PATH` existence. Tests: verify config object has correct default values.

### Step 2 — Zod schema for audio transcriptions

Create `schemas/audio-transcriptions.ts`. Test in isolation with valid and invalid form field sets. No I/O. This is the same pattern as `request-schema.ts` and can be built and tested entirely standalone.

### Step 3 — Whisper service module

Create `services/whisper.ts`. This is the highest-risk component — it exercises `Bun.spawn`, temp file I/O, process exit codes, and JSON parsing.

Build in sub-steps:
- Write `buildWhisperCmd()` (pure function, testable without spawning)
- Write `parseWhisperJson()` (pure function, testable with fixture JSON)
- Write `transcribe()` with the full spawn/write/cleanup flow
- Test with a real whisper binary and a short WAV file (integration test, requires binary on PATH)
- Test error paths with a mock that returns non-zero exit codes (unit test with spawn mock)

### Step 4 — Route handler

Create `routes/audio-transcriptions.ts`. Wire schema validation → whisper service → response mapping. Test with mock whisper service (inject service instance for testability, consistent with `createServer(adapters)` pattern).

### Step 5 — Register route in `index.ts`

Add route match. Run smoke test: send a valid multipart request and verify JSON response shape.

### Step 6 — Extend `/v1/models` and `/ready`

Add whisper alias to models list when configured. Extend ready response. These are low-risk additions to existing handlers.

### Step 7 — Integration test

Add `tests/integration/audio-transcriptions.test.ts`. Mock the `WhisperService` interface (inject it like `ProviderAdapter`). Test:
- Valid request returns 200 with `{ "text": "..." }`
- Missing `file` field returns 400
- Unknown model alias returns 400
- Whisper process failure returns 500
- Request when Whisper not configured returns 503
- Auth gate: missing token returns 401

---

## Architecture Invariants to Preserve

1. **Never log audio content or transcription text** — same as "never log full prompts" rule in the LLM path.
2. **Temp files are always deleted** — the `finally` block must run even if the request is aborted.
3. **Auth gate applies** — the audio route sits behind the existing Bearer token check, same as all other routes.
4. **`X-Request-ID` on every response** — the existing `withRequestId` wrapper applies.
5. **OpenAI error shape on all errors** — use the existing `openaiError()` helper for 400/401/413/500/503 paths.
6. **Structured logs on every request** — log the same `request_complete` event fields (requestId, route, latencyMs, statusCode). Do not log audio bytes or text.

---

## Sources

- Bun.spawn API: https://bun.sh/docs/api/spawn (HIGH — official docs)
- Bun FormData / file uploads: Context7 /oven-sh/bun docs/guides/http/file-uploads.mdx (HIGH — official)
- Bun.spawn timeout and AbortSignal: https://bun.sh/docs/api/spawn (HIGH — official docs)
- whisper.cpp HTTP server architecture (mutex serialization, persistent model): https://deepwiki.com/ggml-org/whisper.cpp/3.2-http-server (MEDIUM — community wiki)
- whisper.cpp CLI flags (--output-json, --output-file, --language, -t): https://til.simonwillison.net/macos/whisper-cpp (MEDIUM — practitioner blog)
- whisper.cpp JSON output structure and concurrency semaphore pattern: https://sendrec.eu/blog/how-we-added-automatic-transcription-with-whisper/ (MEDIUM — production case study)
- OpenAI /v1/audio/transcriptions field specification: https://platform.openai.com/docs/api-reference/audio/createTranscription (HIGH — official, via web search verification)
- Existing proxy architecture: .planning/codebase/ARCHITECTURE.md
