# SECURITY.md — Phase 7: Gemini-Compatible Transcription Shim

**Generated:** 2026-06-17
**Phase:** 07 — gemini-compatible-transcription-shim
**ASVS Level:** 1
**Auditor:** gsd-security-auditor

---

## Threat Verification Results

**Threats Closed:** 4/4
**Threats Open:** 0/4

### Threat Register

| Threat ID | Category | Disposition | Status | Evidence |
|-----------|----------|-------------|--------|----------|
| T-07-01 | Spoofing / EoP | mitigate | CLOSED | index.ts:187-198 |
| T-07-02 | Information Disclosure | mitigate | CLOSED | index.ts:304-331 |
| T-07-03 | Denial of Service | mitigate | CLOSED | index.ts:126, 268-297 |
| T-07-04 | Tampering (supply chain) | accept | CLOSED | No package.json delta; Buffer+File at index.ts:276,287 |

---

## Detailed Verification

### T-07-01 — Spoofing / Elevation of Privilege

**Declared mitigation:** Validate presented key against `config.personalProxyApiKey` with constant-time `verifyToken`; missing/unset/invalid → Gemini-shaped 401 UNAUTHENTICATED. Auth runs first, before any body parsing.

**Verification method:** Code inspection of the Gemini route branch in `index.ts`.

**Findings:**

1. Route placement (D-01): The `POST /v1beta/models/{model}:generateContent` branch (index.ts:175) sits before the global Bearer gate (index.ts:353). Confirmed by reading the sequential structure — the Gemini branch closes at line 350, the Bearer gate opens at line 353.

2. Auth reads `x-goog-api-key` header first, falls back to `?key=` query param (index.ts:187-188).

3. Three conditions short-circuit to 401 before any body is parsed (index.ts:189-198):
   - `!config.personalProxyApiKey` (unconfigured proxy key)
   - `!apiKey` (missing credential)
   - `!verifyToken(apiKey, config.personalProxyApiKey)` (invalid credential)

4. `verifyToken` (index.ts:66-77) uses `timingSafeEqual` from `node:crypto` with length-equalizing padding so equal-length inputs are required for a pass — no length oracle.

5. The 401 response uses `geminiError(401, ..., 'UNAUTHENTICATED')` — not `openaiError` or `authNotConfiguredError`. No OpenAI shape leaks on auth failure.

**Status: CLOSED**

---

### T-07-02 — Information Disclosure (structured logging)

**Declared mitigation:** `log()` records only requestId, route, model id, fileSize, status, latency; NEVER logs `inline_data.data`, decoded bytes, the base64 string, or `result.text`. Error bodies carry generic messages.

**Verification method:** Grep of all `log(` calls and error message strings in the Gemini route branch.

**Findings:**

1. Success log (`gemini_transcription_complete`, index.ts:322-331): fields are `event`, `requestId`, `timestamp`, `route`, `modelAlias`, `fileSize`, `status`, `latencyMs`. No `inlineData.data`, no `bytes`, no `result.text`.

2. Failure log (`gemini_transcription_failed`, index.ts:304-312): fields are `event`, `requestId`, `route`, `modelAlias`, `fileSize`, `status`, `latencyMs`. No audio bytes or transcript.

3. Grep for `inlineData`, `base64`, `result.text`, `decoded`, `audio_data` in log calls: zero matches.

4. All error response bodies use generic fixed-string messages (`geminiError(..., 'API key not valid. Please pass a valid API key.', ...)`, etc.). No upstream error detail or credential state surfaces in error bodies on this route.

**Status: CLOSED**

---

### T-07-03 — Denial of Service (oversize base64 audio payload)

**Declared mitigation:** `maxRequestBodySize` (25 MiB) bounds the buffered JSON body; after decode, `validateAudioFileSize(file, audioMaxFileBytes)` rejects oversize audio with a Gemini-shaped 400 before transcribe is called.

**Verification method:** Code inspection of `Bun.serve()` config and the Gemini route validation sequence.

**Findings:**

1. `maxRequestBodySize` (index.ts:126): set to `Math.max(config.audioMaxFileBytes, config.maxRequestBodyBytes)`, where `config.audioMaxFileBytes` defaults to 26,214,400 bytes (25 MiB, config.ts:69). This is the transport-level ceiling for all incoming requests including the base64-encoded JSON body.

2. Early size pre-check (index.ts:268-275): before allocating the decode buffer, the route computes `approxBytes = Math.floor(inlineData.data.length * 3 / 4)` and rejects with `geminiError(400, ...)` if `approxBytes > audioMaxFileBytes`. This prevents a large allocation for a clearly oversized base64 string.

3. Empty-decode guard (index.ts:280-285): rejects zero-length `bytes` with 400, preventing garbage/whitespace-only base64 reaching the sidecar.

4. `validateAudioFileSize(file, audioMaxFileBytes)` (index.ts:289-297): called after decode; `audio-schema.ts:49-59` checks `file.size > maxBytes` and returns `{ ok: false, message }`. On failure the Gemini route returns `geminiError(400, sizeCheck.message, 'INVALID_ARGUMENT')` — transcribe is never called.

Two independent size guards are in place: one pre-decode (on the encoded string length) and one post-decode (on the actual `File.size`). `validateAudioFileSize` is the declared mitigation control; the pre-decode guard is an additional defense not required by the plan.

**Status: CLOSED**

---

### T-07-04 — Tampering (npm/pip/cargo installs)

**Declared mitigation (accept):** Zero new packages this phase — decode uses Bun/Node-native `Buffer` + `File`; no install tasks.

**Verification method:** `git diff master -- package.json` produced zero lines of output, confirming no package.json mutation. All imports in `index.ts` (lines 3-17) are `node:crypto`, local relative modules (`./config`, `./model-registry`, etc.), and the two pre-existing SDK packages (`groq-sdk`, `@cerebras/cerebras_cloud_sdk`) — none added by Phase 7. Base64 decode uses native `Buffer.from(inlineData.data, 'base64')` (index.ts:276) and `new File([bytes], 'audio', ...)` (index.ts:287) — zero external dependencies.

**Accepted Risk Log:**

| ID | Risk | Rationale | Owner |
|----|------|-----------|-------|
| T-07-04 | Tampering via supply chain (new npm package install) | No new package was installed. Decode path uses only Bun/Node built-ins (Buffer, File). Risk surface is zero for this phase. | Phase 7 executor |

**Status: CLOSED**

---

## Unregistered Threat Flags

The SUMMARY.md `## Accomplishments` section mentions no new threat flags outside the plan register. No unregistered flags detected.

---

## Accepted Risks Log

| ID | Category | Risk | Disposition | Rationale |
|----|----------|------|-------------|-----------|
| T-07-04 | Tampering | Supply-chain package install | accept | Zero new npm/pip/cargo packages installed this phase; decode uses Bun/Node-native Buffer + File only |

---

## Notes

- The model segment extracted from the URL path (`model`) is bounded post-auth: index.ts:204 rejects values containing `/` or longer than 200 characters before it reaches logs or the `modelVersion` response field. This is defense-in-depth beyond the registered threat register and does not create an open threat.
- `verifyToken` pads both buffers to `maxLen` before `timingSafeEqual` so the comparison always runs in constant time regardless of input length. The subsequent `a.length === b.length` check preserves correctness without reintroducing a timing oracle because it is evaluated after the constant-time comparison completes.
