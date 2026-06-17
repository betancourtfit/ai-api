# Phase 7: Gemini-Compatible Transcription Shim - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning
**Mode:** Smart discuss (autonomous) — recommendations accepted; all tightly constrained by the pre-committed acceptance spec

<domain>
## Phase Boundary

Add a new route `POST /v1beta/models/{model}:generateContent` that is wire-compatible with Google's Gemini `generateContent` for audio transcription. A migrating n8n Gemini node should change only the base URL and the API key value — auth mechanism (`?key=` / `x-goog-api-key`), request body (`contents[].parts[].inline_data`), success response shape (`candidates[0].content.parts[0].text`), and error shape (`{ error: { code, message, status } }`) all match Gemini.

The route reuses the existing `WhisperService.transcribe`. It does NOT touch existing `/v1/*` OpenAI endpoints. Zero new npm packages. `:streamGenerateContent`, `file_data` Files-API URIs, and multi-candidate responses are explicitly out of scope.

Acceptance spec is pre-committed in `tests/integration/gemini-compat.test.ts` under `describe.skip('Phase 7 TARGET: ...')`. Un-skip that block at execution start and build until all tests are green.

</domain>

<decisions>
## Implementation Decisions

### Route Placement & Auth
- **D-01:** Implement the route **inline in `index.ts`'s `Bun.serve().fetch()`**, placed **before** the global Bearer auth gate (alongside `/health` and `/ready`). This is structurally required — the existing global gate (index.ts:157) rejects non-Bearer auth, but Gemini uses `?key=` / `x-goog-api-key`. Matches the flat-file convention (no new route module).
- **D-02:** Match the path with `pathname.startsWith('/v1beta/models/')` AND `pathname.endsWith(':generateContent')`, extracting `{model}` as the substring between. Handles any model id without a brittle regex. Method must be POST.
- **D-03:** Auth precedence: prefer the `x-goog-api-key` header, fall back to the `?key=` query param. Validate the presented key against `PERSONAL_PROXY_API_KEY` using the existing constant-time `verifyToken` helper (GEM-02). Bad/missing key → 401 Gemini-shaped (GEM-09).
- **D-04:** When `PERSONAL_PROXY_API_KEY` is unset, this route returns a **Gemini-shaped** 401 (not the OpenAI-shaped `authNotConfiguredError()`). All errors on this route are Gemini-shaped per GEM-09.

### Request Parsing & Validation
- **D-05:** Find the audio part by scanning all `contents[*].parts[*]` and taking the **first** part that has `inline_data` with both `data` (base64) and `mime_type`. Robust to interleaved text parts (the spec body sends a `{text}` part before the audio part).
- **D-06:** Decode base64 → `File` using Bun-native `Buffer.from(data, 'base64')` then `new File([bytes], 'audio', { type: mime_type })`. Zero new deps (GEM-13).
- **D-07:** Validation order: (1) auth → (2) parse JSON body → (3) if any part has `file_data` (Files-API URI) → Gemini-shaped 400 out-of-scope (GEM-04) → (4) if no `inline_data` audio part found → Gemini-shaped 400 (GEM-10) → (5) if decoded size > `AUDIO_MAX_FILE_BYTES` → Gemini-shaped 400/413 (GEM-11, reuse `validateAudioFileSize`) → (6) transcribe.
- **D-08:** **Do NOT require the URL `{model}` to equal `WHISPER_MODEL_ALIAS`.** Gemini clients send ids like `gemini-1.5-pro-002`; the route accepts the requested id as-is and transcribes via the whisper sidecar using `config.whisperModelAlias` (or the requested id when alias unset). Requiring an exact alias match would break the URL-swap migration that is the entire point of this phase.

### Response Shape & Errors
- **D-09:** Success body: `{ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], usageMetadata: {...}, modelVersion }`. No OpenAI fields (`text`, `choices`) at top level (GEM-06, GEM-12).
- **D-10:** `usageMetadata`: estimate tokens — `promptTokenCount: 0`, `candidatesTokenCount: Math.ceil(text.length / 4)`, `totalTokenCount` = sum. Spec permits estimated/zero counts (GEM-07).
- **D-11:** `modelVersion` echoes the exact `{model}` extracted from the URL path (test asserts `toContain('gemini-1.5-pro-002')`) (GEM-08).
- **D-12:** Add a new `geminiError(code, message, status)` helper that emits `{ error: { code: <int>, message: <string>, status: <UPPER_SNAKE_CASE> } }` with NO `type` field. Status mapping: 401 → `UNAUTHENTICATED`, 400 → `INVALID_ARGUMENT`, 413/oversize → `INVALID_ARGUMENT` (or 413 with same body), 503 → `UNAVAILABLE` (GEM-09, GEM-12).
- **D-13:** Transcription failure (sidecar down / `transcribe()` throws) → Gemini-shaped 503 `{error:{code:503,message,status:'UNAVAILABLE'}}`. Never leak the OpenAI 503 shape on this route.

### Claude's Discretion
- Exact HTTP status for oversize audio (400 vs 413) — either is acceptable as long as the body is Gemini-shaped and `error.status` is present (test only asserts `error.status` exists for GEM-11-adjacent cases; GEM-11 only requires a Gemini-shaped error).
- Whether `:streamGenerateContent` falls through to the existing 404 handler or is explicitly matched and rejected — just document it as out of scope (GEM-15).
- Internal log event names/fields for the new route (must follow existing `log()` pattern; never log audio bytes, base64 data, or transcript text — AUTH2-02).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WhisperService.transcribe(file, modelAlias)` + injected instance (3rd `createServer` param) — already mocked in `gemini-compat.test.ts` returning `'hello world'`. No service changes needed.
- `verifyToken(token, expected)` — constant-time comparison (index.ts:54), reuse for `?key=` / `x-goog-api-key` validation.
- `validateAudioFileSize(file, maxBytes)` from `audio-schema.ts` — reuse for GEM-11 oversize check.
- `AudioTranscriptionResult` type (`types.ts:58`) — `{ text: string }` shape returned by transcribe; map `.text` into Gemini `parts[0].text`.
- `config.whisperModelAlias`, `config.audioMaxFileBytes`, `config.personalProxyApiKey` — all already loaded (`config.ts`).
- `withRequestId(response)` wrapper + `crypto.randomUUID()` request id + `log()` structured logger — apply to the new route for OBS parity.

### Established Patterns
- All routes are inline `if (method && pathname...)` branches in `Bun.serve().fetch()`; flat-file structure, no router library.
- Health/ready sit BEFORE the global Bearer gate; everything else sits AFTER it. The Gemini route must sit BEFORE the gate (own auth).
- Error helpers return `Response` objects wrapped by `withRequestId`. New `geminiError()` mirrors `openaiError()` (index.ts:32) but with Gemini body shape.
- `maxRequestBodySize` already raised to 25 MiB audio ceiling — the new route's base64 JSON body is covered.

### Integration Points
- Insert the new route branch in `index.ts` immediately after the `/ready` branch (~line 155) and before the auth gate (~line 157).
- New `geminiError()` helper near `openaiError()` (~line 32).
- No changes to `/v1/models`, `/v1/chat/completions`, `/v1/audio/transcriptions`, `/ready`, or `import.meta.main` wiring (GEM-14).

</code_context>

<specifics>
## Specific Ideas

- The migration target is an **n8n Gemini transcription node**: it must work by changing only base URL + API key value. Every observable difference beyond those two must be zero.
- The pre-committed `describe.skip('Phase 7 TARGET: ...')` block in `tests/integration/gemini-compat.test.ts` is the authoritative spec — un-skip and make green. The earlier `describe('Gemini generateContent → proxy compatibility ...')` block asserts the *old* incompatibility on `/v1/audio/transcriptions`; those tests must remain green (the new route is additive, the old OpenAI route is unchanged).
- Reuse the configured whisper sidecar transparently — Gemini model id in, whisper transcription out, Gemini model id echoed back in `modelVersion`.

</specifics>

<deferred>
## Deferred Ideas

- `:streamGenerateContent` (SSE Gemini streaming) — out of scope for this milestone (GEM-15), document only.
- `file_data` Files-API URI ingestion — explicitly rejected as out of scope (GEM-04).
- Multi-candidate responses (`candidateCount > 1`) — out of scope; always return a single candidate at `index: 0`.
- Accurate token counting in `usageMetadata` — estimation is acceptable for now.

</deferred>
