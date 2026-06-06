# Features Research: Audio Transcription API

**Domain:** POST /v1/audio/transcriptions — OpenAI-compatible proxy endpoint backed by Groq (Whisper)
**Researched:** 2026-06-06
**Overall confidence:** HIGH — sourced from OpenAI API reference (developers.openai.com), Groq speech-to-text docs (console.groq.com), openai-node and openai-python official source code

---

## Executive Context

This milestone adds `POST /v1/audio/transcriptions` to an existing Bun proxy that already handles
`POST /v1/chat/completions`. The proxy currently routes between Cerebras and Groq. For audio
transcription, **only Groq provides a Whisper-compatible endpoint**. Cerebras has no audio
transcription API. This is a single-provider feature, not a round-robin feature.

Groq's transcription endpoint (`https://api.groq.com/openai/v1/audio/transcriptions`) is
OpenAI-compatible at the wire level. The existing auth middleware, structured logging, and error
response shape all reuse without modification.

---

## Table Stakes (must implement)

These are required for any OpenAI SDK client (`openai-node`, `openai-python`) to call the
endpoint without code changes.

### AUDIO-01 — Multipart Form Data Parsing

**Why required:** OpenAI clients encode all transcription parameters as `multipart/form-data`,
not JSON. The audio file is a binary blob in a named form field called `file`. Bun's
`Request.formData()` parses this natively — no library needed.

**What the client sends:**
```
Content-Type: multipart/form-data; boundary=----FormBoundaryXYZ

------FormBoundaryXYZ
Content-Disposition: form-data; name="file"; filename="audio.mp3"
Content-Type: audio/mpeg

<binary audio bytes>
------FormBoundaryXYZ
Content-Disposition: form-data; name="model"

whisper-large-v3-turbo
------FormBoundaryXYZ--
```

**Bun implementation:** `const form = await request.formData(); const file = form.get("file");`
The `file` field comes back as a `File` (subclass of `Blob`). All other fields are strings.

**Complexity:** Low — Bun native; no multer or busboy needed

---

### AUDIO-02 — Request Field Validation (Allowlist)

**Why required:** Unknown or unsupported fields must be rejected with `400` before reaching
Groq. This maintains the same contract as the existing chat completions allowlist.

**Full field table for `POST /v1/audio/transcriptions`:**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `file` | File (multipart) | Yes | — | Binary audio blob; max 25 MB per OpenAI, 25 MB free-tier / 100 MB dev-tier on Groq |
| `model` | string | Yes | — | Logical proxy alias (see AUDIO-03) |
| `language` | string | No | — | ISO-639-1 code (e.g. `"en"`). Improves accuracy and latency when set |
| `prompt` | string | No | — | Up to 224 tokens. Guides transcription style or continues a prior segment |
| `response_format` | string | No | `"json"` | One of: `json`, `text`, `verbose_json`. Groq does NOT support `srt` or `vtt` |
| `temperature` | number | No | `0` | 0–1 range. Higher = more random. Groq maps `0` to internal epsilon |
| `timestamp_granularities` | string[] | No | `["segment"]` | `"word"` and/or `"segment"`. Only valid when `response_format` is `"verbose_json"` |

**Fields to reject with `400`:**
- Any field not in the table above
- `response_format` values `srt` or `vtt` (OpenAI supports these with whisper-1; Groq does not)
- `timestamp_granularities` when `response_format` is not `"verbose_json"`
- File MIME types not in the supported set

**Complexity:** Low-Medium — Zod schema on FormData fields; mirror existing chat validation pattern

---

### AUDIO-03 — Model Alias Resolution for Transcription

**Why required:** Downstream clients must not need to know Groq's internal model IDs
(`whisper-large-v3`, `whisper-large-v3-turbo`). A logical alias in the model registry
maintains the same drop-in contract as chat completions.

**Recommended initial aliases:**

| Logical Proxy Alias | Groq Upstream Model | Notes |
|---|---|---|
| `whisper-large-v3-turbo` | `whisper-large-v3-turbo` | Fastest, lowest cost ($0.04/hr). Recommended default |
| `whisper-large-v3` | `whisper-large-v3` | Highest accuracy ($0.111/hr). Use when precision matters |

Clients may pass either alias. The proxy resolves to the Groq model ID before forwarding.
Return `400` for unknown aliases (same behaviour as chat completions).

**Complexity:** Low — extend the existing model registry with an `audio` capability flag

---

### AUDIO-04 — Forward to Groq and Return Raw Response

**Why required:** The proxy must forward the validated multipart form, receive the transcription
response, and relay it to the downstream client.

**Important:** Do NOT use the groq-sdk client here. The groq-sdk's audio module returns a parsed
JavaScript object. For `text`, `srt`, and `vtt` response formats (non-JSON), the raw HTTP body
must be relayed as a string. For `verbose_json` the parsed object is acceptable, but consistency
favors a single path: forward the raw HTTP body from Groq and set the correct `Content-Type`.

**Why forward raw:** Groq returns `verbose_json` with a specific field shape including `task`,
`language`, `duration`, `words`, `segments`. Re-serializing an SDK-parsed object risks dropping
fields or changing float precision. Forward the Groq body bytes directly.

**Content-Type relay:**
| `response_format` | Content-Type to return to client |
|---|---|
| `json` (default) | `application/json` |
| `verbose_json` | `application/json` |
| `text` | `text/plain` |

**Complexity:** Medium — multipart rebuild and raw HTTP fetch to Groq (not SDK call)

---

### AUDIO-05 — Supported Audio Format Validation

**Why required:** Passing an unsupported format to Groq causes a 400 from Groq that the proxy
must then handle. Validate early and return a clear error.

**Supported formats (intersection of OpenAI spec and Groq):**

| Format | MIME Types |
|---|---|
| mp3 | `audio/mpeg`, `audio/mp3` |
| mp4 | `audio/mp4`, `video/mp4` |
| mpeg | `audio/mpeg` |
| mpga | `audio/mpeg` |
| m4a | `audio/m4a`, `audio/x-m4a` |
| wav | `audio/wav`, `audio/x-wav` |
| webm | `audio/webm`, `video/webm` |
| ogg | `audio/ogg` |
| flac | `audio/flac`, `audio/x-flac` |

**Note:** OpenAI's spec does not include `ogg` or `flac` in its published list but Groq accepts
them. For the proxy contract, expose the OpenAI-documented set only (`mp3, mp4, mpeg, mpga, m4a,
wav, webm`) and reject `ogg`/`flac` to stay within the guaranteed intersection.

Validate by file extension from the filename field AND MIME type when available. Return `400`
with `"Unsupported audio format"` if neither matches.

**Complexity:** Low — MIME/extension check before forwarding

---

### AUDIO-06 — File Size Limit Enforcement

**Why required:** Both OpenAI and Groq free-tier cap at 25 MB. Sending oversized files to Groq
causes a Groq-side 413. Validate early to return a clean error.

**Limit:** 25 MB (26,214,400 bytes)

**Implementation:** Check `file.size` on the parsed `File` blob before building the upstream
request. Return `413` with OpenAI error shape:
```json
{
  "error": {
    "message": "Audio file too large. Maximum size is 25 MB.",
    "type": "invalid_request_error",
    "code": "file_too_large",
    "param": "file"
  }
}
```

**Complexity:** Low — single size check

---

### AUDIO-07 — Bearer Auth (reuse existing middleware)

**Why required:** The endpoint must enforce `Authorization: Bearer PERSONAL_PROXY_API_KEY` like
all other protected routes. The existing auth middleware runs before routing and covers this
automatically if the route is registered under the protected router.

**Complexity:** None — already implemented; register route correctly

---

### AUDIO-08 — OpenAI-Shaped Error Responses

**Why required:** Same contract as chat completions. The openai-node SDK's error parsing logic
(`response?.['error']?.message`) applies to audio transcription errors identically.

**Complexity:** None — reuse existing error utility

---

## Differentiators (nice to have)

These add value but do not block OpenAI SDK compatibility.

### AUDIO-D1 — verbose_json Model Field Normalization

**Value:** When Groq returns `verbose_json`, it does not include a top-level `model` field. If
the proxy adds `"model": "<logical-alias>"` to the response body before relaying, clients that
read this field (LiteLLM, custom instrumentation) get consistent model tracking.

**Complexity:** Low — JSON parse, inject field, re-serialize

---

### AUDIO-D2 — Structured Logging for Transcription Requests

**Value:** Log request ID, logical model alias, Groq model ID, file size in bytes, audio MIME
type, `response_format`, `language`, latency, Groq status code. Follows existing log schema.
Omit filename and prompt contents (may contain PII).

**Complexity:** Low — extend existing logger call pattern

---

### AUDIO-D3 — X-Request-ID Header on All Responses

**Value:** Consistent with existing proxy behavior. Reuse existing request-ID middleware.

**Complexity:** None — already implemented if route is registered through existing middleware chain

---

### AUDIO-D4 — Rate Limit Header Capture from Groq

**Value:** Groq returns rate-limit headers for audio endpoints too. Capture and snapshot them
into provider state for the `/internal/providers/status` endpoint. Groq audio rate limits are
separate from chat completions rate limits.

Groq audio rate-limit headers:
```
x-ratelimit-limit-requests
x-ratelimit-remaining-requests
x-ratelimit-reset-requests
x-ratelimit-limit-audio-seconds
x-ratelimit-remaining-audio-seconds
x-ratelimit-reset-audio-seconds
```

**Complexity:** Low — extend Groq adapter to capture these headers from audio responses

---

### AUDIO-D5 — GET /v1/models Inclusion of Audio Models

**Value:** Include `whisper-large-v3-turbo` and `whisper-large-v3` in the `/v1/models` response
so clients that call `client.models.list()` can discover them. Mark `owned_by` as
`"personal-proxy"` for consistency.

**Complexity:** Low — extend model registry entries with audio aliases; update models route

---

## Anti-Features / Out of Scope

### ANTI-01 — POST /v1/audio/translations

**Why excluded:** The translations endpoint (`/v1/audio/translations`) translates non-English
audio into English text. Groq supports it at `https://api.groq.com/openai/v1/audio/translations`.
However:
- It is only meaningful for non-English source audio
- It only supports `whisper-large-v3` (not turbo)
- The proxy CLAUDE.md explicitly excludes `/v1/audio/*` from MVP
- Adding it doubles the implementation surface for marginal gain in a personal proxy
- Clients that need translation can call Groq directly

**Decision:** Exclude from this milestone. Return `404` with a clear error message if called.

---

### ANTI-02 — Streaming Transcription (stream: true)

**Why excluded:** OpenAI added `stream: true` for `gpt-4o-transcribe` models in 2025. Groq does
not currently expose a streaming audio transcription endpoint in its OpenAI-compatible API.
Attempting to pass `stream: true` to Groq would fail or return a non-streaming response.

**Decision:** Reject `stream: true` with `400`: `"Streaming is not supported for audio
transcriptions on this proxy."` Do not silently ignore it.

---

### ANTI-03 — srt / vtt Response Formats

**Why excluded:** OpenAI supports `srt` and `vtt` with `whisper-1`. Groq does not support these
formats. Groq only supports `json`, `verbose_json`, and `text`.

**Decision:** Reject with `400`: `"Response format 'srt' is not supported. Use json, verbose_json,
or text."` Do not forward to Groq.

---

### ANTI-04 — Cerebras Audio Transcription

**Why excluded:** Cerebras provides no audio transcription endpoint. Their API is LLM inference
only. Implementing any audio routing to Cerebras is not possible.

**Decision:** Audio transcription is Groq-only. The round-robin router does not apply here.
The provider selection for audio is static: always Groq.

---

### ANTI-05 — diarized_json / Speaker Diarization

**Why excluded:** Groq does not expose diarization. OpenAI's `diarized_json` format requires the
`gpt-4o-transcribe-diarize` model which is an OpenAI-only model. Not implementable via Groq.

---

### ANTI-06 — include[] / logprobs

**Why excluded:** OpenAI's `include: ["logprobs"]` parameter is only supported by
`gpt-4o-transcribe` model on OpenAI's own infrastructure. Groq Whisper does not return logprobs.

---

### ANTI-07 — chunking_strategy / known_speaker_names

**Why excluded:** These are `gpt-4o-transcribe-diarize` specific parameters on OpenAI. Groq
does not support them.

---

### ANTI-08 — POST /v1/audio/speech (TTS)

**Why excluded:** Text-to-speech is a separate capability. Neither Cerebras nor Groq are used
for TTS in this project. Out of scope.

---

## OpenAI Request Contract

Complete field reference for `POST /v1/audio/transcriptions` based on the OpenAI API reference
and verified against Groq's implementation:

| Field | Type | Required | Default | Groq Support | Notes |
|---|---|---|---|---|---|
| `file` | File (multipart) | Yes | — | Yes | Binary audio. Max 25 MB. Must be a valid audio format |
| `model` | string | Yes | — | Yes | Logical alias resolves to `whisper-large-v3` or `whisper-large-v3-turbo` |
| `language` | string | No | — | Yes | ISO-639-1 (e.g. `"en"`, `"es"`). Reduces latency and improves accuracy |
| `prompt` | string | No | — | Yes | Up to 224 tokens. Can continue a prior audio segment's context |
| `response_format` | string | No | `"json"` | Partial | `json` ✓, `verbose_json` ✓, `text` ✓, `srt` ✗, `vtt` ✗ |
| `temperature` | number | No | `0` | Yes | 0–1. Groq maps `0` to internal epsilon. Do not advertise zero-temp reproducibility |
| `timestamp_granularities` | string[] | No | `["segment"]` | Yes | `"word"` and/or `"segment"`. Requires `response_format: "verbose_json"` |
| `stream` | boolean | No | `false` | No | OpenAI-only with gpt-4o models. Reject with 400 |
| `include` | string[] | No | — | No | OpenAI-only (logprobs). Reject with 400 |
| `chunking_strategy` | string/object | No | — | No | OpenAI-only (diarize). Reject with 400 |
| `known_speaker_names` | string[] | No | — | No | OpenAI-only (diarize). Reject with 400 |
| `known_speaker_references` | string[] | No | — | No | OpenAI-only (diarize). Reject with 400 |

---

## Response Format Examples

### json (default)

The simplest response. Returned when `response_format` is omitted or `"json"`.
`Content-Type: application/json`

```json
{
  "text": "Imagine the wildest idea that you've ever had, and you're curious about how it might scale."
}
```

Note: OpenAI's newer gpt-4o-transcribe models also return `usage` in the json response.
Groq's Whisper-based response returns only `text` at the top level. Do not inject a fake
`usage` field — clients that check `typeof response.text === "string"` will work correctly.

---

### verbose_json

Returns rich metadata including segment-level and optionally word-level timestamps.
Only available with `response_format: "verbose_json"`.
`Content-Type: application/json`

```json
{
  "task": "transcribe",
  "language": "english",
  "duration": 8.470000267028809,
  "text": "The beach was a popular spot on a hot summer day. People were swimming in the ocean, building sandcastles, and playing beach volleyball.",
  "segments": [
    {
      "id": 0,
      "seek": 0,
      "start": 0.0,
      "end": 4.5,
      "text": " The beach was a popular spot on a hot summer day.",
      "tokens": [50364, 440, 7534, 390, 257, 3743, 4004, 322, 257, 2368, 4391, 786, 13],
      "temperature": 0.0,
      "avg_logprob": -0.2860786020755768,
      "compression_ratio": 1.2363636493682861,
      "no_speech_prob": 0.00985979475080967
    }
  ],
  "words": [
    {
      "word": "The",
      "start": 0.0,
      "end": 0.23999999463558197
    },
    {
      "word": "beach",
      "start": 0.23999999463558197,
      "end": 0.5
    }
  ]
}
```

**verbose_json field schema:**

| Field | Type | Always Present | Description |
|---|---|---|---|
| `task` | string | Yes | Always `"transcribe"` |
| `language` | string | Yes | Full language name (e.g. `"english"`, not `"en"`) |
| `duration` | number | Yes | Audio duration in seconds (float) |
| `text` | string | Yes | Complete transcription |
| `segments` | array | Yes | Array of segment objects |
| `segments[].id` | integer | Yes | Sequential segment index starting at 0 |
| `segments[].seek` | integer | Yes | Audio frame offset (internal Whisper seek position) |
| `segments[].start` | number | Yes | Segment start time in seconds |
| `segments[].end` | number | Yes | Segment end time in seconds |
| `segments[].text` | string | Yes | Segment text (may have leading space) |
| `segments[].tokens` | integer[] | Yes | Whisper token IDs |
| `segments[].temperature` | number | Yes | Sampling temperature used for this segment |
| `segments[].avg_logprob` | number | Yes | Average log probability. Values below -1 indicate unreliable output |
| `segments[].compression_ratio` | number | Yes | Compression ratio. Values above 2.4 indicate likely hallucination |
| `segments[].no_speech_prob` | number | Yes | Probability the segment contains no speech (0–1) |
| `words` | array | Only with `timestamp_granularities: ["word"]` | Array of word objects |
| `words[].word` | string | — | The word (may have leading/trailing space) |
| `words[].start` | number | — | Word start time in seconds |
| `words[].end` | number | — | Word end time in seconds |

**Interpretation guidance for clients:**
- `avg_logprob < -1`: transcription confidence is low for this segment
- `no_speech_prob > 1.0 AND avg_logprob < -1`: segment is likely silence, discard
- `compression_ratio > 2.4`: segment may be hallucinated repeated text

---

### text

Plain string response. No JSON wrapping.
`Content-Type: text/plain`

```
The beach was a popular spot on a hot summer day. People were swimming in the ocean, building sandcastles, and playing beach volleyball.
```

---

## Client Library Behavior

### openai-node (TypeScript)

The `openai.audio.transcriptions.create()` method internally calls:
```typescript
this._client.post(
  '/audio/transcriptions',
  multipartFormRequestOptions({ body, ...options }, this._client)
)
```

The `multipartFormRequestOptions` utility:
1. Sets `Content-Type: multipart/form-data` (browser adds boundary automatically via Fetch API)
2. Extracts the `file` field (path `[["file"]]`) and converts it to a multipart part
3. Sends all other fields as string parts

**File input types accepted by openai-node:**
- `fs.createReadStream("audio.mp3")` — Node.js ReadStream
- A `File` object (Web API)
- A `Blob` object
- A `Response` from `fetch()`

The client sets `filename` from the stream's `path` property or from a `File` object's `name`.
If filename is missing, the library uses a default like `"upload"`. Groq requires a filename
with a valid extension to infer MIME type — always include a filename.

**Response type overloads:**
```typescript
// response_format: "json" (default) → Transcription { text: string }
// response_format: "verbose_json" → TranscriptionVerbose { task, language, duration, text, words, segments }
// response_format: "text" | "srt" | "vtt" → string
```

The Node client returns a plain object for `json`/`verbose_json` and a `string` for text formats.

### openai-python

```python
client.audio.transcriptions.create(
    file=open("audio.mp3", "rb"),
    model="whisper-1",
    response_format="verbose_json",
    timestamp_granularities=["word"]
)
```

The Python client:
1. Calls `extract_files(body, paths=[["file"]])` to pull out the file for multipart encoding
2. Calls `maybe_transform(body, TranscriptionCreateParams)` to validate and serialize all other fields
3. Sets `Content-Type: multipart/form-data` explicitly in extra headers

**Timestamp granularities encoding:** The Python client sends this as repeated form fields:
```
timestamp_granularities[]=word
timestamp_granularities[]=segment
```

Bun's `FormData.getAll("timestamp_granularities[]")` retrieves the array. This is the standard
HTML array-in-form-data convention; Bun handles it natively.

### Raw curl (canonical wire format)

```bash
curl https://localhost:3000/v1/audio/transcriptions \
  -H "Authorization: Bearer PERSONAL_PROXY_API_KEY" \
  -F file="@audio.mp3" \
  -F model="whisper-large-v3-turbo" \
  -F language="en" \
  -F response_format="verbose_json" \
  -F "timestamp_granularities[]=word" \
  -F "timestamp_granularities[]=segment"
```

curl uses `-F` to build multipart form data automatically. Each `-F` becomes one part.
Array parameters use the `field[]` key convention.

---

## Feature Dependencies

```
Bearer auth middleware (existing)
  → covers /v1/audio/transcriptions automatically if route is registered under protected router

Request-ID middleware (existing)
  → adds X-Request-ID to all responses

Multipart form parser (new)
  → AUDIO-01 → required by all other audio features

Request field validator (new, audio-specific)
  → AUDIO-02 → runs after parsing, before upstream call
  → rejects unsupported fields, formats, MIME types, oversized files

Model alias resolver (extend existing)
  → AUDIO-03 → resolves logical alias to Groq whisper model ID
  → returns 400 for unknown aliases

Groq audio adapter (new)
  → AUDIO-04 → forwards validated multipart form to Groq via raw fetch
  → relays raw response body without SDK parsing
  → captures Groq rate-limit headers for provider state

Error response utility (existing)
  → used by all validation and upstream error paths
```

---

## Implementation Notes for Bun

**FormData parsing is Bun-native:**
```typescript
const form = await request.formData();
const file = form.get("file") as File;          // File extends Blob
const model = form.get("model") as string;
const granularities = form.getAll("timestamp_granularities[]"); // string[]
```

**Forwarding multipart to Groq without SDK:**
Use `fetch()` with a new `FormData` object populated from the validated fields. Bun's `fetch`
natively handles `FormData` as a body and sets the correct `Content-Type` with boundary.

```typescript
const upstream = new FormData();
upstream.set("file", file, file.name);  // preserve filename for MIME inference
upstream.set("model", groqModelId);
if (language) upstream.set("language", language);
// ... other validated fields

const response = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
  body: upstream,
});
```

Do NOT set `Content-Type` manually — let Bun/Fetch set it with the boundary.

**Known Bun issue:** Bun v1.x has intermittent multipart upload reliability issues under load
(GitHub issues #19097, #21467). If integration tests reveal multipart failures, investigate
whether the issue is in Bun's `FormData` serialization and consider pinning to a fixed Bun
version or using a raw `Blob` body with manual boundary construction as a fallback.

---

## Sources

- OpenAI audio transcriptions API reference: https://developers.openai.com/api/docs/api-reference/audio/createTranscription
- OpenAI speech-to-text guide: https://developers.openai.com/api/docs/guides/speech-to-text
- Groq speech-to-text documentation: https://console.groq.com/docs/speech-to-text
- openai-node transcriptions source: https://github.com/openai/openai-node/blob/master/src/resources/audio/transcriptions.ts
- openai-python transcriptions source: https://github.com/openai/openai-python/blob/main/src/openai/resources/audio/transcriptions.py
- openai-python transcription tests (all params): https://github.com/openai/openai-python/blob/main/openai-python/tests/api_resources/audio/test_transcriptions.py
- Bun FormData parsing guide: https://bun.com/docs/guides/http/file-uploads
- Bun multipart issue tracker: https://github.com/oven-sh/bun/issues/19097
- Context7 OpenAI API docs: /websites/developers_openai_api
- Context7 openai-node: /openai/openai-node
- Context7 openai-python: /openai/openai-python
