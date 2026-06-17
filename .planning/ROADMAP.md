# Roadmap: bun-ai-api OpenAI-Compatible Proxy Refactor

**Core Value:** Drop-in OpenAI replacement: any fetch already wired to OpenAI works unchanged after pointing to this proxy.
**Granularity:** Coarse
**Mode:** mvp
**Total v1 requirements:** 76
**Coverage:** 76/76 ✓

---

## Phases

- [x] **Phase 1: Foundation** - Working non-streaming endpoint with auth, validation, model registry, and one provider call (completed 2026-06-05)
- [x] **Phase 2: Routing + Streaming** - Stateful round-robin, cooldown, rate-limit parsing, SSE relay, and all /v1 endpoints (completed 2026-06-05)
- [x] **Phase 3: Full Compliance + Tests** - Complete normalization, observability, diagnostic endpoints, and full test coverage (completed 2026-06-05)
- [x] **Phase 4: Audio Foundation** - Config env vars, Zod schema, validation rules, and maxRequestBodySize fix — no whisper binary required (completed 2026-06-06)
- [x] **Phase 5: Transcription Route + Auth + Tests** - Full /v1/audio/transcriptions request lifecycle with mocked WhisperService and 100% test coverage (completed 2026-06-06)
- [x] **Phase 6: Whisper Sidecar + Models + Ready** - Real HTTP fetch to whisper-server sidecar, /v1/models whisper alias, and /ready whisperAvailable field (completed 2026-06-06)
- [ ] **Phase 7: Gemini-Compatible Transcription Shim** - New `POST /v1beta/models/{model}:generateContent` route, wire-compatible with Google Gemini for audio transcription, so n8n nodes migrate by changing only URL + API key (TDD: spec test pre-committed)

---

## Phase Details

### Phase 1: Foundation

**Goal:** The proxy accepts authenticated requests, validates them against the allowlist, resolves model aliases, and returns a non-streaming completion from one provider with a clean OpenAI-shaped response.
**Mode:** mvp
**Depends on:** Nothing (first phase)
**Requirements:** INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, AUTH-01, AUTH-02, AUTH-03, AUTH-04, EP-04, EP-07, VALID-01, VALID-02, VALID-03, VALID-04, VALID-05, VALID-06, VALID-07, REG-01, REG-02, REG-03, REG-04
**Success Criteria** (what must be TRUE):

  1. A request without an Authorization header returns 401 with an OpenAI-shaped error body; a request with the correct key proceeds.
  2. A request with `logprobs`, `n=2`, `messages[].name`, or an unknown model alias returns 400 before any upstream call is made.
  3. `GET /health` returns 200 with no auth; `GET /v1/models` returns `{ "object": "list", "data": [...] }` containing only logical alias IDs.
  4. `POST /v1/chat/completions` with a valid request body returns a complete non-streaming OpenAI-shaped response using one upstream provider SDK.
  5. The old `/chat` endpoint returns 404; no raw provider model IDs appear in any response.

**Plans:** 2/2 plans complete
Plans:

- [x] 01-01-PLAN.md — Walking skeleton: dependency cleanup + config + registry + Cerebras adapter + auth + validation wired to one real completion (`bun index.ts`)
- [x] 01-02-PLAN.md — Hardening: full strict allowlist/reject-list, Groq adapter (D-01), GET /v1/models, /chat removal, wrong-key 401

### Phase 2: Routing + Streaming

**Goal:** Requests are routed across providers via stateful round-robin with cooldown and failover; streaming requests relay SSE chunks to the client without buffering.
**Mode:** mvp
**Depends on:** Phase 1
**Requirements:** ROUTE-01, ROUTE-02, ROUTE-03, ROUTE-04, ROUTE-05, ROUTE-06, ROUTE-07, ROUTE-08, RL-01, RL-02, RL-03, RL-04, RL-05, RL-06, RL-07, STREAM-01, STREAM-02, STREAM-03, STREAM-04, STREAM-05, STREAM-06, STREAM-07, EP-01, EP-02, EP-03, EP-05, EP-06
**Success Criteria** (what must be TRUE):

  1. Consecutive requests alternate between Cerebras and Groq; when one provider is in cooldown the other receives all traffic until cooldown expires.
  2. A 429 from a provider triggers a calculated cooldown; a 500/502/503/504 triggers immediate failover to the alternate provider without the client seeing an error.
  3. When both providers are in cooldown or unavailable, the proxy returns 503 with an OpenAI-shaped error body.
  4. `POST /v1/chat/completions` with `"stream": true` returns `Content-Type: text/event-stream`, relays chunks without buffering, and terminates with `data: [DONE]`.
  5. `GET /ready` returns `"mode": "degraded"` when one provider is down and `"mode": "ok"` when both are healthy; `GET /internal/providers/status` returns provider state only to authenticated callers.

**Plans:** 2/2 plans complete
Plans:

- [x] 02-01-PLAN.md — provider state, round-robin routing, cooldown parsing, failover classification, `/ready`, and `/internal/providers/status`
- [x] 02-02-PLAN.md — streaming adapter contracts, schema widening, SSE relay, disconnect abort, and live verification hardening

### Phase 3: Full Compliance + Tests

**Goal:** All provider-specific fields are stripped from responses, every response carries correct OpenAI field shapes and observability headers, and the full test suite passes with isolated state.
**Mode:** mvp
**Depends on:** Phase 2
**Requirements:** NORM-01, NORM-02, NORM-03, NORM-04, NORM-05, NORM-06, NORM-07, NORM-08, NORM-09, NORM-10, OBS-01, OBS-02, OBS-03, OBS-04, OBS-05, TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06, TEST-07, TEST-08, TEST-09, TEST-10, TEST-11, TEST-12
**Success Criteria** (what must be TRUE):

  1. Non-streaming and streaming responses never contain `reasoning`, `reasoning_logprobs`, `time_info`, `x_groq`, or `usage_breakdown`; the `model` field always shows the logical alias.
  2. Every response (success and error) carries an `X-Request-ID` header; structured JSON logs include request ID, provider, latency, and status without leaking keys or prompt content.
  3. `bun test` reports all 12 test cases passing, including round-robin alternation, cooldown, recovery, failover, exhaustion, auth rejection, alias rejection, field rejection, non-streaming shape, streaming format, model rewrite, and state reset.
  4. Error responses at every error path return `{ "error": { "message", "type", "code", "param" } }` — never a flat body.

**Plans:** 3/3 plans complete
Plans:

**Wave 1**

- [x] 03-01-PLAN.md — Central response normalizer (allowlist-rebuild) wired into both response paths (NORM-01..09)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md — createServer factory, X-Request-ID everywhere, NORM-10 error sweep + D-07 passthrough, structured logging (OBS-01..05)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-03-PLAN.md — 12-case integration suite via real server + mocked adapters (TEST-01..12)

### Phase 4: Audio Foundation

**Goal:** All configuration, types, and Zod validation for the transcription endpoint are in place and enforced — ready for a route handler to be wired in, with no whisper binary required to run or test.
**Depends on:** Phase 3
**Requirements:** AUDIO-01, AUDIO-02, AUDIO-03, AUDIO-04, AUDIO-05, AUDIO-06, WHSP-04, WHSP-05
**Success Criteria** (what must be TRUE):

  1. `bun test` passes with all existing v1.0 tests still green and new schema unit tests passing — no whisper-server binary required.
  2. A multipart request missing the `file` field, using an unknown model alias, exceeding 25 MB, or including unknown fields each produce an OpenAI-shaped 400 or 413 — verified via unit tests against the Zod schema and validators.
  3. `WHISPER_PORT`, `WHISPER_HOST`, `WHISPER_TIMEOUT_MS`, and `AUDIO_MAX_FILE_BYTES` are read from environment and surfaced in the config object; a missing `WHISPER_MODEL_ALIAS` does not crash the server.
  4. `maxRequestBodySize` in `Bun.serve()` is raised to the configured audio limit without changing the 1 MiB chat-completion behavior.

**Plans:** 3/3 plans complete

Plans:

- [x] 04-01-PLAN.md — Audio foundation: whisper/audio config fields, AudioTranscriptionResult type, Zod audio-schema validators + unit tests, maxRequestBodySize raise + 1 MiB chat gate

### Phase 5: Transcription Route + Auth + Tests

**Goal:** `POST /v1/audio/transcriptions` is fully wired — authenticated, validated, logged, and returning an OpenAI-shaped transcript — with all 7 test cases passing against a mocked WhisperService.
**Depends on:** Phase 4
**Requirements:** EP2-01, AUTH2-01, AUTH2-02, OBS2-01, OBS2-02, TEST2-01, TEST2-02, TEST2-03, TEST2-04, TEST2-05, TEST2-06, TEST2-07
**Success Criteria** (what must be TRUE):

  1. `curl -X POST /v1/audio/transcriptions` without a valid Bearer token returns 401 with an OpenAI-shaped error body; a valid token proceeds to validation.
  2. `bun test` reports all 7 TEST2-xx cases passing: 401, missing file, unknown alias, oversized file, unknown field, 200 transcript, and 503 sidecar-down — all against a mocked WhisperService with no real binary.
  3. Every transcription response (success and error) carries `X-Request-ID`; structured logs record `requestId`, `latencyMs`, `fileSize`, `modelAlias`, and `status` without logging audio content or filenames.
  4. A successful mock response returns exactly `{ "text": "..." }` with HTTP 200 — no extra provider fields in the body.

**Plans:** 2/2 plans complete

**Wave 1**

- [x] 05-01-PLAN.md — WhisperService interface + NoopWhisperService stub + createServer() extension + POST /v1/audio/transcriptions handler (EP2-01, AUTH2-01, AUTH2-02, OBS2-01, OBS2-02)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 05-02-PLAN.md — 7-case audio integration test suite against mock WhisperService (TEST2-01..07)

### Phase 6: Whisper Sidecar + Models + Ready

**Goal:** The proxy forwards transcription requests to a real whisper-server HTTP sidecar via native `fetch()`, exposes the whisper alias in `/v1/models`, and reports sidecar health in `/ready` — with no new npm packages added.
**Depends on:** Phase 5
**Requirements:** EP2-02, EP2-03, WHSP-01, WHSP-02, WHSP-03
**Success Criteria** (what must be TRUE):

  1. `GET /v1/models` returns the whisper alias (configured via `WHISPER_MODEL_ALIAS`) alongside existing chat-completion aliases when whisper-server is configured.
  2. `GET /ready` includes `"whisperAvailable": true` when the sidecar responds to its health check, and `"whisperAvailable": false` when it is unreachable — without affecting `"mode"` for chat-completion providers.
  3. A `curl` smoke test against a running whisper-server instance returns `{ "text": "..." }` through the proxy with HTTP 200; when the sidecar is stopped, the same request returns 503 with an OpenAI-shaped error body, and chat-completion requests continue to succeed.
  4. Zero new npm packages are added; all sidecar communication uses `fetch()` and `FormData` from the Bun runtime.

**Plans:** 3/3 plans complete

**Wave 1**

- [x] 06-01-PLAN.md — HttpWhisperService + health() interface method + fake-sidecar unit tests (WHSP-01, WHSP-02, WHSP-03)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 06-02-PLAN.md — /v1/models alias append + /ready whisperAvailable + import.meta.main selection + integration tests (EP2-02, EP2-03)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 06-03-PLAN.md — Live curl smoke checkpoint against a real whisper-server (ROADMAP criterion 3; WHSP-01, WHSP-03)

### Phase 7: Gemini-Compatible Transcription Shim

**Milestone:** v3.0
**Goal:** A new route `POST /v1beta/models/{model}:generateContent` is wire-compatible with Google's Gemini generateContent for audio transcription. An n8n node migrating from Gemini changes only the base URL and the API key value — auth mechanism (`?key=` / `x-goog-api-key`), request body, response shape, and error shape all match Gemini.
**Mode:** mvp
**Depends on:** Phase 6 (reuses WhisperService)
**Requirements:** GEM-01..15
**Approach:** TDD — acceptance spec pre-committed as `describe.skip('Phase 7 TARGET')` in `tests/integration/gemini-compat.test.ts`. Un-skip at execution start; build until all green.
**Success Criteria** (what must be TRUE):

  1. A Gemini-shaped transcription request (`contents[].parts[].inline_data`) authenticated via `?key=` or `x-goog-api-key` returns a Gemini-shaped `candidates[0].content.parts[0].text` transcript with HTTP 200.
  2. Errors on this route (bad key, missing audio, oversize, file_data URI) return the Gemini shape `{ error: { code, message, status } }` — never the OpenAI error shape.
  3. The response carries `usageMetadata` and `modelVersion`, with no OpenAI fields (`text`, `choices`) leaking into the body.
  4. Zero new npm packages; existing `/v1/*` OpenAI endpoints remain unchanged; `:streamGenerateContent` documented as out of scope.

**Plans:** Not yet planned — run `/gsd-plan-phase 7`

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 2/2 | Complete | 2026-06-05 |
| 2. Routing + Streaming | 2/2 | Complete | 2026-06-05 |
| 3. Full Compliance + Tests | 3/3 | Complete | 2026-06-05 |
| 4. Audio Foundation | 3/3 | Complete   | 2026-06-06 |
| 5. Transcription Route + Auth + Tests | 2/2 | Complete    | 2026-06-06 |
| 6. Whisper Sidecar + Models + Ready | 3/3 | Complete    | 2026-06-06 |
| 7. Gemini-Compatible Transcription Shim | 0/? | Planned | — |

---

*Roadmap created: 2026-06-04*
*Last updated: 2026-06-06 — Phase 6 plans created (3 plans, 3 waves)*
