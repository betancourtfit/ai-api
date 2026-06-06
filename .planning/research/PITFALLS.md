# Pitfalls Research: Local Audio Transcription

**Domain:** Adding POST /v1/audio/transcriptions (local Whisper) to existing Bun proxy
**Researched:** 2026-06-06
**Milestone context:** Subsequent milestone — existing chat proxy is production-stable; this adds a
local-inference route alongside it.
**Overall Confidence:** HIGH — Bun-specific issues verified against open GitHub issues; Whisper
behavior from official repo discussions; subprocess/temp-file patterns from Node/Bun documentation.

---

## Critical Pitfalls (will break things)

### AUDIO-CRIT-1: Bun `request.formData()` Throws on Missing or Malformed Multipart Boundary

**What goes wrong:** Bun's built-in multipart parser requires the `Content-Type: multipart/form-data;
boundary=<value>` header to include an exact boundary token. If the client sends the header as just
`multipart/form-data` without the boundary parameter — which some HTTP clients do when boundary
generation is misconfigured — `await request.formData()` throws a TypeError: "FormData parse error
missing final boundary." The error is unhandled, crashes the fetch handler, and Bun returns an empty
502 with no OpenAI-style error body.

There is also a confirmed Bun bug (issue #29630) where Bun's *own* FormData serializer emits a
boundary with only one leading dash (`-WebkitFormBoundary…`), producing a 3-dash body-marker instead
of the RFC-correct 4-dash format. Downstream parsers (including some openai-node versions) may reject
this.

**Prevention:**
- Wrap `await request.formData()` in try/catch and return an OpenAI-style 400 if parsing fails.
- Log the raw `Content-Type` header value at DEBUG level so boundary problems are diagnosable.
- Do not rely on Bun's FormData serializer when constructing test fixtures; use `@mjackson/multipart-parser` or raw boundary strings that match the RFC 4-dash format.
- Validate that `Content-Type` contains `multipart/form-data` before calling `.formData()`.

**Detection:** Empty 502 responses or "FormData parse error" in logs when audio upload clients are
first integrated. Run the integration test with curl (`-F`) and with the openai-node SDK separately.

**Phase:** Multipart parsing layer (earliest, before any Whisper work).

---

### AUDIO-CRIT-2: Bun FormData Binary Truncation at Null Bytes (Files ≤ 8 Bytes)

**What goes wrong:** Confirmed Bun bug (issue #26740). Bun's multipart parser stores field values in a
`Semver.String` type that uses null-byte scanning for length on inline strings ≤ 8 bytes. Any binary
file whose content includes a `0x00` byte within the first 8 bytes will be silently truncated at that
byte. Audio file headers that can trigger this include gzip-compressed audio and RIFF/WAV headers
(which contain null bytes in the chunk size fields).

In practice, real audio files are much larger than 8 bytes, but this can surface in automated tests
that use small synthetic audio fixtures or when someone uploads a nearly-empty test file.

**Prevention:**
- Use audio test fixtures that are at least 32 bytes. Never use ≤ 8 byte binary fixtures.
- After reading the `file` field from FormData, assert `blob.size > 0` before writing to disk. Return
  a 400 with `"Audio file is empty or unreadable"` if the assertion fails.
- In CI, test with a real minimal WAV file (44-byte header + silent PCM) rather than a constructed
  byte string.

**Detection:** Whisper subprocess exits with "failed to open audio file" on a file that the proxy
wrote with zero or truncated bytes.

**Phase:** Multipart parsing validation.

---

### AUDIO-CRIT-3: Whisper Subprocess PATH Resolution Fails in Bun Compiled Binaries and Clean Environments

**What goes wrong:** Bun has a confirmed bug (issue #10865) where `Bun.spawn` and the Bun Shell PATH
lookup fails in compiled binaries on macOS. Even in non-compiled mode, `Bun.spawn` uses `process.env`
as captured at startup — if `whisper` or `whisper-cpp` is installed in a path that was added to PATH
*after* Bun started (e.g., via `/opt/homebrew/bin` in some shell profiles), it will not be found.

`Bun.spawn(["whisper", ...])` will throw `ENOENT` or `spawn whisper ENOENT` with no meaningful error
message distinguishing "binary not found" from "binary crashed immediately."

**Prevention:**
- Use `Bun.which("whisper")` (or `Bun.which("whisper-cpp")`) at startup and fail fast with a clear
  error if the binary is not found. This check runs during server initialization, not per-request.
- Make the whisper binary path configurable via an env var (`WHISPER_BIN_PATH`). Default to `Bun.which("whisper") ?? "whisper"` but log a warning at startup if `which` returns null.
- Always resolve to an absolute path before passing to `Bun.spawn`.
- In Docker, install whisper.cpp to an absolute, known path and set `WHISPER_BIN_PATH` explicitly.

**Detection:** `ENOENT` errors in spawn call; "whisper binary not found" startup warning.

**Phase:** Startup config validation (`/ready` endpoint should report `whisper_available: false` if
binary is missing).

---

### AUDIO-CRIT-4: Model File Paths with Spaces or Non-ASCII Characters Break Whisper CLI

**What goes wrong:** whisper.cpp's CLI and multiple Python whisper implementations have confirmed bugs
when the model file path or the input audio file path contains spaces or non-ASCII (including Chinese,
Japanese, emoji, etc.) characters. The path is passed as a command-line argument and if not properly
quoted, the C runtime will split on whitespace. Even with shell quoting, whisper.cpp's internal path
handling in older versions truncates at the first space (confirmed: issue #1038 "Model download fails
if the destination folder includes a space").

This affects:
- `--model /Users/juan my files/whisper/ggml-base.bin` → whisper reads `/Users/juan` and fails
- Temp audio files written to `/var/folders/abc/T/audio 123.wav` → path split on space
- Model paths with accented characters on Windows deployments

**Prevention:**
- Always write temp audio files to a path with no spaces: use `crypto.randomUUID()` as the filename
  stem (e.g., `/tmp/audio-<uuid>.wav`) — UUIDs contain only hex and hyphens.
- Validate the configured model path at startup: if it contains spaces, either reject with a clear
  error or double-quote it in the spawn argument array *and* test that whisper.cpp version handles it.
- Use `Bun.spawn(["whisper-cpp", "--model", modelPath, "--file", audioPath, ...])` with separate
  array entries (not a shell string) — this bypasses shell word splitting. Never construct a shell
  string like `"whisper --model " + modelPath` and pass it to `Bun.Shell`.

**Detection:** whisper exits with non-zero code and stderr "failed to open model file"; no
transcription output even for valid audio.

**Phase:** Subprocess invocation layer.

---

### AUDIO-CRIT-5: Temp File Leaks When Whisper Process Is Killed or Handler Throws

**What goes wrong:** The standard pattern is: write audio to `/tmp/<uuid>.wav`, spawn whisper, read
output, delete temp file. If the Bun process receives SIGTERM mid-transcription, or if the fetch
handler throws an unhandled exception between file write and file delete, the temp file is never
cleaned up. On a busy server, thousands of temp files accumulate until disk space runs out, eventually
killing the process.

This is compounded by Bun's file descriptor inheritance behavior: POSIX defaults FDs to be inherited
by child processes. If the temp file FD is open in the parent when the child spawns, the child holds
a reference and the file cannot be GC'd even if the parent unlinks it (on Linux, the file data
remains until the child exits; on macOS the file is deleted but disk blocks are retained until FD
closure).

**Prevention:**
- Use `try { ... } finally { await Bun.file(tmpPath).unlink?.() ?? unlinkSync(tmpPath) }` around the
  full transcription block. `finally` runs even on throw.
- Register a `process.on("exit", ...)` and `process.on("SIGTERM", ...)` handler at startup that
  tracks and deletes all in-flight temp files from a `Set<string>`.
- Write temp files to a dedicated subdirectory (e.g., `/tmp/bun-audio-proxy/`) and sweep it on
  startup to clean up files left by a previous crash.
- Set `Bun.spawn({ ... })` with `stdio: ["ignore", "pipe", "pipe"]` to avoid inheriting the parent's
  FDs unnecessarily.

**Detection:** Growing `/tmp` directory; disk-full errors under load.

**Phase:** Transcription service implementation and process lifecycle.

---

### AUDIO-CRIT-6: Whisper Subprocess stderr vs stdout Confusion Corrupts JSON Output

**What goes wrong:** When whisper.cpp is invoked with `--output-json` or `--output-txt`, the
transcription result goes to a *file* (not stdout) by default. The subprocess's stdout emits only
progress/timing lines like:
```
whisper_model_load: loading model from '/path/to/ggml-base.bin'
whisper_model_load: n_vocab = 51864
```
and its stderr emits per-segment timestamps.

A naive implementation that reads `stdout` for the transcription text will receive only model-loading
progress lines, not the actual transcript. The actual output goes to `<inputfile>.txt` or
`<inputfile>.json` on disk.

Alternatively, if `--output-txt -` (dash for stdout) is supported in the installed version, mixing
progress noise with transcript text on stdout produces unparseable output.

**Prevention:**
- Use `--output-json` with an explicit output file path: `--output-json --output-file <tmpBasePath>`.
  Whisper writes `<tmpBasePath>.json`. Read this file after the process exits.
- Capture stderr separately (`stderr: "pipe"`) and log it at DEBUG level — never mix it into stdout.
- After process exit, assert exit code is 0 before attempting to read the output file.
- Treat any non-zero exit code as a transcription failure and return a 500.

**Detection:** Transcription returning model load logs as text; empty JSON parse errors on whisper
output.

**Phase:** Subprocess invocation and output handling.

---

### AUDIO-CRIT-7: No Request Timeout Set — Long Audio Blocks the Handler Indefinitely

**What goes wrong:** Bun.serve has a default `idleTimeout` of 10 seconds — but for the *transcription
handler* this is the wrong concern. The handler actively sends no bytes while whisper is running (it's
waiting for the subprocess), so the connection is considered "active" and the idle timeout does not
fire. However, whisper on CPU for a 60-minute audio file can take 10–30 minutes. If the downstream
client has a 30-second timeout (the OpenAI SDK default), the client gives up and closes the
connection, but the whisper subprocess continues running on the server, consuming CPU and holding the
temp file.

The existing proxy already uses `server.timeout(request, 0)` for SSE streams. The transcription
endpoint needs the same treatment — but additionally it needs an *application-level* timeout on the
whisper subprocess itself, because `server.timeout(request, 0)` prevents Bun from closing the
connection but does nothing to kill the subprocess if the client disconnects.

**Prevention:**
- Call `server.timeout(request, 0)` at the top of the transcription handler (same pattern as SSE).
- Set an application-level timeout on the Bun.spawn process:
  ```typescript
  const timeout = setTimeout(() => { proc.kill(); }, REQUEST_TIMEOUT_MS);
  await proc.exited;
  clearTimeout(timeout);
  ```
- Listen to `request.signal.addEventListener("abort", () => proc.kill())` to kill the subprocess when
  the client disconnects.
- Return a 504 with OpenAI-style error body if the subprocess is killed by timeout.

**Detection:** whisper processes visible in `ps aux` long after client disconnected; server CPU pegged
at 100% with no active connections.

**Phase:** Subprocess lifecycle management.

---

### AUDIO-CRIT-8: Bun `maxRequestBodySize` Default Is 128 MiB — Conflicts with Proxy's `MAX_REQUEST_BODY_BYTES`

**What goes wrong:** The existing proxy config sets `MAX_REQUEST_BODY_BYTES=1048576` (1 MiB) as the
request body limit, enforced in the Bun.serve configuration. Audio files routinely exceed 1 MiB — a
60-second MP3 is typically 1–4 MiB; a 10-minute WAV is 100+ MiB.

If `maxRequestBodySize` stays at 1 MiB, Bun will return a bare 413 status with no body — not an
OpenAI-style error — before the fetch handler is even called. The existing `openaiError()` helper
never runs.

**Prevention:**
- Add a separate `AUDIO_MAX_FILE_BYTES` env var (default: 26214400 = 25 MiB, matching OpenAI's
  Whisper API limit).
- Set `maxRequestBodySize` on `Bun.serve` to `AUDIO_MAX_FILE_BYTES` when the transcription route is
  enabled — this overrides the global limit.
- Inside the handler, read `blob.size` after formData parsing and return a proper OpenAI 413 error if
  it exceeds `AUDIO_MAX_FILE_BYTES`.
- Document that enabling the audio route changes the server-wide body limit and could allow large
  bodies on other routes too (or implement route-level enforcement in the handler).

**Detection:** curl returning bare `413` with empty body when uploading audio > 1 MiB; no log entry
from the fetch handler.

**Phase:** Server configuration and route registration.

---

## Common Mistakes (easy to miss)

### AUDIO-COMMON-1: Audio Format Mismatch — Client Sends Formats Whisper Cannot Read Directly

**What goes wrong:** The OpenAI Whisper API accepts mp3, mp4, mpeg, mpga, m4a, wav, and webm. Local
whisper.cpp does not natively read all of these — it requires input as WAV (PCM, 16kHz, mono, 16-bit)
for most CLI invocations. Without `ffmpeg` pre-conversion, passing an MP3 file directly to
whisper.cpp either produces garbage output, a cryptic "failed to read WAV file" error, or (with some
builds) silently reads only the first few seconds.

The openai-python and openai-node SDKs pass whatever file the user provides — they do not pre-convert
for you.

**Prevention:**
- Always convert incoming audio to WAV 16kHz mono before passing to whisper. Shell out to `ffmpeg`:
  ```bash
  ffmpeg -i input.<ext> -ac 1 -ar 16000 -f wav output.wav -y -loglevel error
  ```
- Validate `ffmpeg` availability at startup alongside the whisper binary check.
- Accept the OpenAI-documented formats at the proxy level (`mp3|mp4|mpeg|mpga|m4a|wav|webm`) and
  reject any other MIME type with a 400 before converting.
- Keep both the raw upload temp file and the converted WAV as separate paths; delete both in
  `finally`.

**Detection:** whisper exits 0 but returns empty transcript; stderr says "failed to read audio."

**Phase:** Audio preprocessing step.

---

### AUDIO-COMMON-2: Whisper Hallucination on Silent or Near-Silent Audio

**What goes wrong:** Whisper (all versions) is well-documented to hallucinate text on silent audio
segments. On completely silent audio, Whisper-large-v3 transcribes filler phrases like "so" in 55% of
cases. On long files with silence between speech segments, hallucinations appear at 1% overall but
with harmful content in 38% of those hallucinations. A proxy that passes hallucinated output
downstream as legitimate transcription has no signal that anything went wrong — the exit code is 0 and
the output file is valid JSON.

**Prevention:**
- This is a fundamental Whisper limitation, not a bug to fix in the proxy. Document it clearly.
- Optionally expose `no_speech_prob` from verbose JSON output to downstream clients who request
  `response_format=verbose_json`, so they can filter low-confidence results.
- Do not attempt to validate transcription quality in the proxy — that responsibility belongs to the
  caller.

**Detection:** Clients reporting spurious transcription text on empty recordings.

**Phase:** API contract documentation; verbose_json passthrough.

---

### AUDIO-COMMON-3: Model Cold-Start Latency on First Request

**What goes wrong:** When whisper is invoked as a subprocess (CLI), it loads the model from disk on
every request. For `ggml-base.bin` (~150 MB), this adds 2–5 seconds of model load time before
inference begins. For `ggml-large-v3.bin` (~3 GB), cold load can take 30+ seconds on slow storage.
On the first request after server startup, clients experience this delay with no progress indication.

Unlike a persistent Python server that holds the model in memory, a subprocess-per-request pattern
pays the cold-start cost on every single request.

**Prevention:**
- Choose a model size appropriate for the hardware and acceptable latency. `ggml-base` or `ggml-small`
  are the practical options for a personal proxy with CPU-only inference.
- Consider running `whisper.cpp --server` mode as a persistent sidecar process and calling its HTTP
  API instead of spawning a new process per request. This keeps the model warm and serializes requests
  through its internal queue.
- Log model load time (from spawn to first output) separately from inference time to give visibility.
- Document in `/ready` response whether the whisper binary and model file are both accessible, so
  callers know startup is complete before sending requests.

**Detection:** First request takes 10x longer than subsequent requests; logs show no whisper activity
until model is fully loaded.

**Phase:** Architecture decision (sidecar vs subprocess) must be made before implementation.

---

### AUDIO-COMMON-4: Concurrency — Simultaneous Whisper Subprocesses Saturate CPU

**What goes wrong:** Bun's event loop is single-threaded and non-blocking — it handles concurrent
HTTP requests naturally. But whisper inference is CPU-bound and runs in the subprocess. If two audio
transcription requests arrive simultaneously, two whisper subprocesses spawn concurrently. Each uses
all available CPU cores (whisper.cpp uses OpenMP threading by default). Two concurrent large-model
inferences on a 4-core machine will: (a) take 4–8x longer each due to CPU contention, (b) spike
memory to 2x model size, (c) potentially cause OOM kills.

The existing chat proxy is not affected by this — upstream inference is remote. Adding local whisper
introduces the first CPU-bound shared resource.

**Prevention:**
- Implement a serial request queue for whisper invocations: only one subprocess at a time, all others
  wait. A simple semaphore with a module-level `let transcriptionInProgress = false` and a queue of
  pending callbacks is sufficient for a personal proxy.
- Set a maximum queue depth (e.g., 3) and return 503 "Transcription service busy" to requests beyond
  that depth.
- Log queue depth and wait time so the bottleneck is visible.
- Alternatively, use `whisper.cpp --server` which handles its own task queue internally.

**Detection:** CPU at 100% with concurrent uploads; whisper subprocesses visible in `ps` with both
consuming CPU simultaneously; dramatically increased latency under concurrent load.

**Phase:** Concurrency control, implemented before or alongside the transcription handler.

---

### AUDIO-COMMON-5: `response_format` Values Have Different Content-Type Requirements

**What goes wrong:** The OpenAI transcription API returns different `Content-Type` headers depending
on `response_format`:

| `response_format` | Expected `Content-Type` |
|---|---|
| `json` (default) | `application/json` |
| `text` | `text/plain` |
| `verbose_json` | `application/json` |
| `srt` | `text/plain` |
| `vtt` | `text/plain` |

The openai-python SDK inspects the `Content-Type` response header to decide how to parse the body. If
the proxy returns `text/plain` for `response_format=text` but the proxy always sets
`Content-Type: application/json`, the SDK will try to JSON-parse the plain text and throw a parse
error. Conversely, returning `application/json` when the format is `text` breaks plain-text clients.

**Prevention:**
- Map `response_format` to `Content-Type` explicitly in the route handler.
- Default to `application/json` for `json` and `verbose_json`; use `text/plain` for `text`, `srt`,
  and `vtt`.
- Return the whisper output in the correct format: for `json`, wrap the text in
  `{"text": "..."}` exactly matching OpenAI's schema. For `verbose_json`, include `task`, `language`,
  `duration`, and `segments`.

**Detection:** openai-python SDK throwing `json.JSONDecodeError` when `response_format="text"`;
text clients receiving JSON envelope they didn't ask for.

**Phase:** Route handler and response serialization.

---

### AUDIO-COMMON-6: OpenAI-Node SDK Sends `filename` in Content-Disposition — Proxy Must Not Discard It

**What goes wrong:** The openai-node SDK constructs the multipart body with a `Content-Disposition`
header that includes `filename="audio.mp3"` (or whatever the user provided). Some OpenAI-compatible
implementations use this filename to infer the audio format when no explicit `MIME type` is in the
part's `Content-Type`. If the proxy discards the filename and only stores the raw bytes, whisper
cannot infer the original format for pre-conversion.

The openai-python SDK, by contrast, sends both `filename` and a `Content-Type` like `audio/mpeg` in
the part headers. openai-node may omit the `Content-Type` on the file part in some versions, sending
only the filename.

**Prevention:**
- Always use `ffmpeg` for conversion regardless of extension — do not trust filename extension for
  format detection. Pass the raw bytes to ffmpeg with `-i` and let ffmpeg probe the format.
- If you need the original filename for logging, extract it from the FormData file blob's `name`
  property: `const file = formData.get("file") as File; file.name`.
- Test with both the openai-python and openai-node SDKs; they construct multipart differently.

**Detection:** "format not recognized" or incorrect audio parsing when using openai-node vs
openai-python.

**Phase:** Multipart parsing and audio preprocessing.

---

### AUDIO-COMMON-7: Whisper Model File Validation at Runtime, Not Startup

**What goes wrong:** The whisper model file may exist at startup but become unavailable later (NFS
mount unmounted, file deleted by another process, permissions changed). More commonly, the model path
is configured but the file was never downloaded — the env var is set but points to a nonexistent path.

If the model file is only checked when a request arrives, the first transcription request fails after
a multi-second whisper invocation attempt, rather than failing fast at server start.

**Prevention:**
- At startup, call `Bun.file(modelPath).exists()` (or `await Bun.file(modelPath).size()`) and refuse
  to start (or mark whisper as unavailable in `/ready`) if the model file is missing.
- Include `whisper_model_available: true/false` in the `/ready` response body.
- The `WHISPER_MODEL_PATH` env var should be required if the transcription route is enabled; fail with
  a clear message if it is unset.

**Detection:** First transcription request returning "file not found" after several seconds; `/ready`
not reflecting whisper unavailability.

**Phase:** Startup validation and `/ready` endpoint.

---

## Bun-Specific Issues

### AUDIO-BUN-1: `Bun.spawn` Inherits All Parent File Descriptors by Default

**What goes wrong:** On POSIX, child processes inherit open FDs from the parent. Bun mitigates this
on modern Linux with `close_range` but not on macOS. A temp audio file opened via `Bun.write()` is
held open by the parent; when the whisper subprocess spawns, it inherits this FD. If the parent then
tries to `unlink` the file while the child still has it open, the file is removed from the directory
but the data remains on disk until whisper exits. This is usually fine on Linux (unlink + FD = data
freed on last close) but can cause confusion on macOS where the behavior differs.

More importantly: if the server holds an open FD to a temp file that was "deleted," and whisper fails
to read it from the path (because it's already unlinked), whisper reports a file-not-found error even
though the data is still accessible via FD.

**Prevention:**
- Write temp audio via `await Bun.write(tmpPath, blob)` and do not keep the returned file handle
  open. The `Bun.write` call closes the FD when complete.
- Only unlink the temp file *after* the whisper process has fully exited (`await proc.exited`).
- Use `Bun.spawn({ stdin: "ignore", stdout: "pipe", stderr: "pipe" })` to explicitly control which
  FDs the child inherits.

**Phase:** Subprocess invocation.

---

### AUDIO-BUN-2: `Bun.serve` idleTimeout Fires During Long Transcription If No Bytes Are Sent

**What goes wrong:** The transcription endpoint does not stream — it waits for whisper to complete and
returns the full result. During this wait (which can be 30+ seconds for long audio on CPU), Bun
considers the connection idle (no bytes flowing). The default `idleTimeout` (which was 10 seconds in
Bun v1.1.26 and has been intermittently changed in subsequent versions) may close the connection
before whisper finishes.

The existing proxy already calls `server.timeout(request, 0)` for SSE streams. The transcription
endpoint must do the same even though it is not a stream.

**Prevention:**
- Call `server.timeout(request, 0)` immediately at the start of the transcription handler, before
  awaiting anything.
- This is a one-line addition to the route handler that costs nothing.

**Phase:** Route handler setup.

---

### AUDIO-BUN-3: TypeScript `FormDataEntryValue` Is `string | File` — `File` Is Not `Blob` in Bun Types

**What goes wrong:** In Bun's TypeScript types, `FormDataEntryValue` is `string | File`. The `File`
type in server-side Bun is a subset of the browser `File` interface — it has `.name`, `.size`,
`.type`, and `.arrayBuffer()` but it may not have all `Blob` methods depending on the Bun version and
how types are resolved. Code that casts `formData.get("file") as Blob` and calls Blob-only methods
may fail at runtime even if TypeScript does not catch it.

More practically: calling `.arrayBuffer()` to get audio bytes works correctly, but calling
`new Blob([file])` to re-wrap may produce double-boxing issues.

**Prevention:**
- Use `formData.get("file")` typed as `File | null`, not `Blob`.
- To write to disk: `await Bun.write(tmpPath, file)` — Bun.write accepts `File` directly without
  needing to cast to Blob.
- To get bytes: `await file.arrayBuffer()` — this is on both `File` and `Blob`.
- Add `if (!(file instanceof File)) return openaiError("file field must be an audio file", ...)` to
  guard against the field being a string.

**Phase:** Multipart parsing and type handling.

---

### AUDIO-BUN-4: `Bun.spawn` stdout Buffer Overflow for Long Transcriptions

**What goes wrong:** If whisper's stdout is captured with `stdout: "pipe"` and the subprocess writes
a very large amount of text (e.g., transcribing a 2-hour lecture), the pipe buffer fills up. If the
parent does not read from the pipe while the process runs, the subprocess blocks waiting for the
parent to drain the buffer, and the parent blocks waiting for the subprocess to exit. Classic
deadlock.

**Prevention:**
- If reading stdout via pipe, consume it incrementally: `for await (const chunk of proc.stdout) {
  buffer += chunk; }`.
- Alternatively, use the output-file approach (AUDIO-CRIT-6): whisper writes to a file, not stdout.
  This eliminates the buffer concern entirely and is the recommended approach.
- If stdout must be piped, use `Bun.readableStreamToText(proc.stdout)` which reads fully to a string
  — but this still requires whisper stdout to be the transcript, not progress noise.

**Phase:** Subprocess output handling.

---

## Integration Pitfalls

### AUDIO-INTEG-1: Whisper CPU Inference Degrades Chat Completions Latency

**What goes wrong:** The existing chat proxy routes requests to remote providers (Cerebras, Groq) with
latency dominated by network I/O. Adding local whisper introduces CPU-bound work on the same process.
Bun's event loop is single-threaded; even though `Bun.spawn` is async (the subprocess runs in a
separate process), the CPU *on the machine* is shared. If whisper saturates all cores during
inference, the Bun event loop's async I/O operations (forwarding chat request/response chunks to
upstream providers) are not blocked — but system scheduler jitter can add latency to in-flight HTTP
responses.

On a single-core VPS or a resource-constrained Docker container, this is especially pronounced.

**Prevention:**
- Run whisper with a CPU thread limit if the model supports it: `--threads 2` for whisper.cpp limits
  OpenMP threads, leaving cores available for Bun's I/O.
- On production hosts with resource constraints, add documentation warning that whisper transcription
  may transiently increase chat completion latency.
- Consider a `WHISPER_MAX_THREADS` env var that defaults to `Math.max(1, os.cpus().length - 1)`.
- Log whisper inference duration so the correlation with chat latency spikes is diagnosable.

**Phase:** Subprocess configuration and monitoring.

---

### AUDIO-INTEG-2: Auth Middleware Must Cover `/v1/audio/transcriptions` — Not Assumed from Route Order

**What goes wrong:** The existing auth gate in `index.ts` is structured as an early-return pattern:
all routes below the auth check are protected. Adding a new route must be placed *after* the auth
check, not before it. A common mistake when adding a new route is to insert it near the top (for
clarity) without realizing it bypasses the auth guard.

The transcription endpoint must require the same `Authorization: Bearer PERSONAL_PROXY_API_KEY` as
all other endpoints.

**Prevention:**
- Review `index.ts` route ordering after adding the new route; write a test that calls
  `/v1/audio/transcriptions` without an `Authorization` header and asserts 401.
- Consider extracting the auth check into a reusable function or middleware object to make it
  impossible to forget.

**Detection:** Unauthenticated POST to `/v1/audio/transcriptions` returning a response other than 401.

**Phase:** Route registration (first thing to verify after adding the handler).

---

### AUDIO-INTEG-3: `/ready` Endpoint Must Report Whisper Availability Separately from Provider Availability

**What goes wrong:** The existing `/ready` implementation checks for at least one eligible upstream
provider and a configured proxy key. Adding whisper transcription creates a second independently
optional capability. A caller may need to know "is transcription available?" separately from "are
chat completions available?" If whisper is down (model missing, binary not found), chat completions
should still work.

**Prevention:**
- Add a `whisperAvailable: boolean` field to the `/ready` response.
- The `ready: true` condition should remain "at least one chat provider available AND proxy key
  configured" — whisper unavailability should produce a degraded mode, not a failed readiness check.
- Example response:
  ```json
  { "ready": true, "mode": "degraded", "eligibleProviders": ["cerebras"],
    "unavailableProviders": ["groq"], "whisperAvailable": false }
  ```

**Phase:** `/ready` endpoint update.

---

### AUDIO-INTEG-4: OpenAI-Style Error Shape Differs Between Chat and Audio Endpoints

**What goes wrong:** The existing proxy returns `{ "error": { "message": "...", "type": "...",
"code": "...", "param": null } }` for all errors. The OpenAI transcription API returns the same error
shape for most errors — but some SDKs (particularly openai-python) have special handling for
transcription-specific error codes.

More importantly: the transcription endpoint must return `application/json` for error responses even
when `response_format=text` was requested. A client requesting plain text output still expects JSON
error bodies.

**Prevention:**
- Always use the existing `openaiError()` helper for all error paths in the transcription handler,
  regardless of `response_format`.
- Test error paths (400, 401, 413, 500, 503) with the openai-python SDK and verify it raises
  `openai.BadRequestError`, not a JSON parse error.

**Phase:** Route handler error handling.

---

### AUDIO-INTEG-5: `createServer` Factory Receives `adapters` Parameter — Transcription Handler Is Not Adapter-Based

**What goes wrong:** The existing `createServer(adapters, port)` factory in `index.ts` takes a
`Record<Provider, ProviderAdapter>` parameter and uses dependency injection for testability. The
whisper transcription service does not fit this adapter pattern — it is a subprocess-based local
service, not a remote provider.

Adding whisper by simply calling `Bun.spawn` inline in the route handler makes the transcription
route untestable without a real whisper binary. The test suite (which already uses mock adapters for
Cerebras and Groq) has no equivalent injection point for whisper.

**Prevention:**
- Extract a `TranscriptionService` interface with `transcribe(audioPath: string, options: ...): Promise<TranscriptionResult>` signature.
- Inject it alongside adapters: `createServer(adapters, transcriptionService, port)`.
- The real implementation calls whisper; tests inject a mock that returns fixture data.
- This mirrors the existing adapter injection pattern exactly.

**Phase:** Architecture decision — define this interface before writing the transcription handler.

---

## Testing Pitfalls

### AUDIO-TEST-1: Cannot Mock `Bun.spawn` Easily — Tests Require Filesystem Fixtures

**What goes wrong:** Bun's `mock.module()` can mock `Bun.spawn` but doing so globally is fragile and
interferes with other tests. The transcription handler calls `Bun.spawn` directly, making unit
testing require either (a) a real whisper binary on the CI machine, or (b) a real `ffmpeg` binary.
Most CI environments do not have whisper.cpp installed.

**Prevention:**
- Use the `TranscriptionService` injection pattern (AUDIO-INTEG-5). Tests inject a mock
  `TranscriptionService` that does not call `Bun.spawn` at all.
- For integration tests that must exercise the subprocess, gate them with an env var
  (`INTEGRATION_WHISPER=true`) and skip them in CI unless the binary is available.
- Use `Bun.which("whisper")` in the test setup to skip whisper tests automatically if the binary is
  not found: `test.skipIf(!Bun.which("whisper"))("transcribes audio", ...)`.

**Phase:** Test infrastructure design.

---

### AUDIO-TEST-2: Temp File Cleanup Not Verified — Tests Leave Orphan Files

**What goes wrong:** If the transcription handler has a bug that causes temp file leaks (e.g., the
`finally` block is missing), unit tests will not catch it because they use mock transcription
services. The leak only appears in integration or production.

**Prevention:**
- In integration tests that exercise the real subprocess path, assert that no temp files exist in the
  temp directory after the request completes:
  ```typescript
  const files = readdirSync("/tmp").filter(f => f.startsWith("audio-"));
  expect(files.length).toBe(0);
  ```
- Run this assertion even when the transcription fails (test error paths too).

**Phase:** Integration test design.

---

### AUDIO-TEST-3: Multipart FormData Test Construction Is Brittle in Bun

**What goes wrong:** Constructing multipart requests in `bun test` to exercise the `formData()`
parsing path requires building a valid `Request` with a `FormData` body. The boundary Bun generates
may be non-standard (AUDIO-CRIT-1: one leading dash instead of two). Test code that manually
constructs `Content-Type: multipart/form-data; boundary=----test` and builds the body string must
match Bun's expected format exactly, or `formData()` will throw a parse error during the test — not
because of a bug in the handler, but because the test fixture is malformed.

**Prevention:**
- Build test request bodies by constructing a native `FormData` object and passing it to `new
  Request(url, { method: "POST", body: formData })`. Let Bun generate the boundary automatically.
- Do not hand-construct multipart body strings for unit tests.
- Use the real openai-node or openai-python SDK in integration tests — their multipart encoding is
  well-tested against the real OpenAI API and should work with a compliant proxy.

**Phase:** Test fixture construction.

---

### AUDIO-TEST-4: Concurrency Queue Behavior Hard to Test Deterministically

**What goes wrong:** The serial whisper queue (AUDIO-COMMON-4) requires concurrent requests to test
correctly. Testing that "the second request waits for the first" requires launching two requests
simultaneously and asserting ordering. In `bun test`, async timing tests are inherently flaky when
based on wall-clock delays.

**Prevention:**
- Test the queue logic in isolation by injecting a mock `TranscriptionService` that takes a
  configurable delay:
  ```typescript
  const slowService = { transcribe: () => new Promise(r => setTimeout(r, 100)) };
  ```
- Assert that the second request's promise does not resolve until the first's mock delay completes.
- Do not test ordering based on HTTP response arrival time — test based on queue state inspection.

**Phase:** Concurrency queue testing.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|---|---|---|
| Multipart parsing | Bun boundary parse error on malformed Content-Type | try/catch `formData()`, return OpenAI 400 |
| Multipart parsing | Binary data truncated at null bytes for small files | Use real WAV fixtures ≥ 32 bytes in tests |
| Server config | `maxRequestBodySize` 1 MiB blocks audio uploads | Separate `AUDIO_MAX_FILE_BYTES` env var |
| Startup validation | Whisper binary not on PATH in clean/Docker env | `Bun.which()` check at startup; fail fast |
| Startup validation | Model file path has spaces or is missing | Validate path at startup; report in `/ready` |
| Audio preprocessing | Client sends MP3/M4A/WebM but whisper expects WAV | Always ffmpeg-convert before whisper |
| Subprocess invocation | Whisper stdout contains progress noise, not transcript | Use `--output-json` to file, not stdout |
| Subprocess invocation | Path with spaces causes shell-split | Array-style `Bun.spawn` args, UUID temp names |
| Temp file lifecycle | Crash or throw leaves temp files on disk | `try/finally` + startup sweep + SIGTERM handler |
| Subprocess lifecycle | Client disconnects but whisper keeps running | `request.signal` abort kills subprocess |
| Subprocess lifecycle | Long audio blocks handler past client timeout | `server.timeout(request, 0)` + app-level timeout |
| Concurrency | Two whisper processes saturate CPU | Serial semaphore queue with max depth |
| Response format | Wrong `Content-Type` for `text`/`srt`/`vtt` formats | Map `response_format` to Content-Type header |
| Auth coverage | New route added before auth guard | Always test 401 for new endpoints |
| Testability | Inline `Bun.spawn` call not injectable | `TranscriptionService` interface + injection |
| CI compatibility | Tests require whisper binary | `test.skipIf(!Bun.which("whisper"))` guard |

---

## Sources

- Bun FormData boundary bug (one leading dash): https://github.com/oven-sh/bun/issues/29630
- Bun FormData null-byte truncation: https://github.com/oven-sh/bun/issues/26740
- Bun FormData missing final boundary: https://github.com/oven-sh/bun/issues/6038
- Bun PATH lookup failure in compiled binaries: https://github.com/oven-sh/bun/issues/10865
- Bun idleTimeout default 10s: https://github.com/oven-sh/bun/issues/13392
- Bun server.timeout per-request API: https://bun.com/reference/bun/Server/timeout
- Bun maxRequestBodySize: https://bun.com/docs/runtime/http/server
- whisper.cpp model path with spaces: https://github.com/ggml-org/whisper.cpp/issues/1038
- whisper.cpp stdout vs output-file behavior: https://github.com/ggml-org/whisper.cpp/issues/17
- whisper hallucination on silence: https://github.com/ggml-org/whisper.cpp/issues/1724
- whisper.cpp concurrency model: https://deepwiki.com/ggml-org/whisper.cpp/3.2-http-server
- OpenAI audio format requirements: https://platform.openai.com/docs/guides/speech-to-text
- whisper cold start CLI per-request: https://github.com/openai/whisper/discussions/669
- faster-whisper filename with spaces: https://github.com/SYSTRAN/faster-whisper/issues/613
- OpenAI audio response_format options: https://platform.openai.com/docs/api-reference/audio/createTranscription
- @mjackson/multipart-parser (Bun-compatible alternative): https://jsr.io/@mjackson/multipart-parser
- Bun file descriptor inheritance and close_range: https://github.com/oven-sh/bun/issues/15020
