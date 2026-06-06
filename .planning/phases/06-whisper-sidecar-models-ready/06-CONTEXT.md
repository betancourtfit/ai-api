# Phase 6: Whisper Sidecar + Models + Ready - Context

**Gathered:** 2026-06-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire real HTTP communication from the proxy to a local `whisper-server` sidecar via native `fetch()` + `FormData`, expose the whisper logical alias in `GET /v1/models`, and add `whisperAvailable` to `GET /ready` — without affecting chat-completion readiness fields. Zero new npm packages.

**Explicitly NOT this phase:** verbose_json/text/srt/vtt formats, language/temperature/prompt forwarding, subprocess spawning, sidecar lifecycle management (start/stop whisper-server from Bun), new routes beyond extending existing `/v1/models` and `/ready`.

</domain>

<decisions>
## Implementation Decisions

### Production boot wiring (discussed)
- **D-01:** Activate `HttpWhisperService` in the production entrypoint **only when `config.whisperModelAlias !== null`** (i.e., `WHISPER_MODEL_ALIAS` env var is set). When unset, keep the default `NoopWhisperService` — audio requests return 503; chat routes unaffected.
- **D-02:** Implement `HttpWhisperService` in **`whisper-service.ts`** alongside the existing `WhisperService` interface and `NoopWhisperService` stub — no separate client file.
- **D-03:** **Inline entrypoint wiring** in `import.meta.main`: pass the third `createServer()` argument explicitly — `new HttpWhisperService()` when alias is set, otherwise omit (default Noop). Do **not** move selection inside `createServer()` — preserve Phase 5 test injection via the optional third parameter.
- **D-04:** **Never block server boot** on sidecar availability. `HttpWhisperService` performs no health probe at startup. Sidecar down → 503 on transcription requests at runtime only.

### Claude's Discretion
(Areas not discussed — planner/researcher decide using roadmap + research defaults.)

- **`GET /v1/models` whisper alias visibility:** Append `config.whisperModelAlias` to the models list when non-null (same `owned_by: "personal-proxy"` shape as chat aliases). Do not require sidecar health to list the alias — configuration intent is enough per EP2-02 wording ("when whisper-server is configured" = alias env set).
- **`GET /ready` `whisperAvailable`:** Add boolean field; probe sidecar `GET http://${whisperHost}:${whisperPort}/health` with a short timeout (reuse `whisperTimeoutMs` or a smaller dedicated cap). Set `whisperAvailable: false` when alias unset OR probe fails. **Must not change** existing `ready`, `mode`, `eligibleProviders`, or `unavailableProviders` semantics for chat (ROADMAP success criterion 2).
- **Sidecar request payload:** Forward reconstructed `FormData` with `file` (+ optional `response_format` if present). The downstream `model` alias is validated locally and **not forwarded** to whisper-server (sidecar owns its loaded model via `--model` at startup). Normalize success to `{ text: "..." }` only.
- **`HttpWhisperService` error mapping:** Network errors, timeouts, non-2xx sidecar responses → throw from `transcribe()` so the existing route try/catch returns OpenAI-shaped 503 (WHSP-03). Never log file content, filename, or transcript text (AUTH2-02).
- **Tests:** Keep all existing TEST2-xx on mock `WhisperService`. Add focused tests for `HttpWhisperService` with mocked `fetch` if needed. Live curl smoke against a running sidecar is manual/UAT — do not gate `bun test` on a real whisper binary (Phase 4/5 gate preserved).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — EP2-02, EP2-03, WHSP-01, WHSP-02, WHSP-03 (Phase 6 pending rows)
- `.planning/ROADMAP.md` §"Phase 6: Whisper Sidecar + Models + Ready" — goal + 4 success criteria
- `CLAUDE.md` §20 readiness behavior — chat degraded mode; whisper is additive
- `.planning/STATE.md` §Accumulated Context — sidecar HTTP (not subprocess), zero new npm packages

### Research (sidecar contract)
- `.planning/research/STACK.md` — whisper-server startup flags (`--inference-path`, `--convert`), proxy `fetch()` pattern, `/health` probe
- `.planning/research/SUMMARY.md` §Phase 6 — build order, open alias naming question
- `.planning/phases/05-transcription-route-auth-tests/05-RESEARCH.md` — `WhisperService` interface, `createServer()` third param, 503 path

### Prior phase context
- `.planning/phases/03-full-compliance-tests/03-CONTEXT.md` — `createServer(adapters)` factory seam (D-02)
- `.planning/phases/04-audio-foundation/04-RESEARCH.md` — config whisper fields, schema-only gate
- `.planning/phases/05-transcription-route-auth-tests/05-RESEARCH.md` — audio route inline in `index.ts`, injectable mock pattern

### Source files
- `whisper-service.ts` — extend with `HttpWhisperService`
- `index.ts` — entrypoint wiring (`import.meta.main`), `/ready`, `/v1/models`, audio route
- `config.ts` — `whisperHost`, `whisperPort`, `whisperTimeoutMs`, `whisperModelAlias`
- `model-registry.ts` — `listAliases()` pattern for models endpoint

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WhisperService` interface + `NoopWhisperService` in `whisper-service.ts` — replace stub in production entrypoint only
- `createServer(adapters, port, whisperService?, audioMaxFileBytes?)` — third param already accepts injection; tests unchanged
- Audio route in `index.ts` (lines ~172–260) — calls `whisperService.transcribe()`; 503 on any throw; no route changes needed beyond wiring real service
- `config.whisperHost/Port/TimeoutMs/ModelAlias` — all sidecar connection params already loaded

### Established Patterns
- Missing optional secrets do not crash import — `optional("WHISPER_MODEL_ALIAS")` returns null
- Production entrypoint guarded by `import.meta.main` — tests import `createServer` without binding port
- OpenAI-shaped errors via `openaiError()`; structured logs via `log()` without sensitive payloads

### Integration Points
- `import.meta.main` block (~line 786): add conditional third argument to `createServer()`
- `GET /v1/models` (~line 275): extend `listAliases()` result with whisper alias when configured
- `GET /ready` (~line 133): add parallel sidecar health probe + `whisperAvailable` field
- `HttpWhisperService.transcribe()`: `fetch(`http://${host}:${port}/v1/audio/transcriptions`, { method: 'POST', body: upstreamFormData, signal })`

</code_context>

<specifics>
## Specific Ideas

- Boot trigger is **alias-only** — not a separate `WHISPER_ENABLED` flag and not requiring host/port beyond existing defaults.
- Operator starts whisper-server separately; proxy stays up and reports degraded whisper via 503 + `whisperAvailable: false`.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. Undiscussed gray areas (models visibility, ready probe, sidecar payload) deferred to planner discretion with research-backed defaults above.

</deferred>

---

*Phase: 6-Whisper Sidecar + Models + Ready*
*Context gathered: 2026-06-06*
