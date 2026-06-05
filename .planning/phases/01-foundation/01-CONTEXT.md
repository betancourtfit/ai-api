# Phase 1: Foundation - Context

**Gathered:** 2026-06-05
**Status:** Ready for planning

<domain>
## Phase Boundary

The proxy accepts authenticated requests, validates them against a strict allowlist, resolves a logical model alias, and returns a **non-streaming** OpenAI-shaped completion from one provider. Delivers: config module (INFRA-05), SDK/dependency cleanup (INFRA-01..04), downstream Bearer auth (AUTH-01..04), request validation (VALID-01..07), logical model registry (REG-01..04), `GET /health` (EP-04), `GET /v1/models` (EP-03 surface — list aliases only), non-streaming `POST /v1/chat/completions`, and removal of old `/chat` (EP-07).

**Explicitly NOT this phase:** streaming relay, round-robin routing, cooldown/rate-limit handling, failover, `/ready`, `/internal/providers/status`, full response normalization, observability headers, tests. Those are Phase 2/3.

</domain>

<decisions>
## Implementation Decisions

### Provider wiring
- **D-01:** Build **both** Cerebras and Groq adapters behind a single shared non-streaming adapter interface. Phase 1 does not pick one provider exclusively — both are implemented so Phase 2 round-robin lands on top with zero adapter rework.
- **D-02:** **Non-streaming path only this phase.** Implement `stream: false` completions end-to-end. Streaming (`stream: true`) is deferred entirely to Phase 2 — do not build SSE relay now. The current streaming `AIService` (`AsyncIterable<string>`) interface is replaced by a non-streaming completion contract; streaming method can be stubbed/deferred.

### Module structure
- **D-03:** **Minimal structure, grow later.** Refactor the flat `index.ts` and add config, model-registry, request schema, and the two provider adapters as a small number of root-level files. Do NOT scaffold the full spec section-21 directory tree (routes/ middleware/ schemas/ providers/ services/ utils/) yet — split into directories only when Phase 2 routing/streaming actually needs them. Keep files at root level per project constraint.

### Missing max_completion_tokens
- **D-04:** When the client **omits** `max_completion_tokens`, **inject a default of 4096** before forwarding. Make the default **env-configurable** (e.g. `DEFAULT_MAX_COMPLETION_TOKENS`, default `4096`). Rationale: avoids Cerebras up-front token-estimate rejections; 4096 is safe for both providers' quotas. When the client supplies a value, forward it untouched.

### Validation error shape
- **D-05:** On validation failure, return the **first offending field only** — stop at first violation, `error.param` = that field. Stays OpenAI-faithful (OpenAI reports a single `param`). All errors use the OpenAI shape `{ "error": { "message", "type", "code", "param" } }` (NORM-10 is Phase 3, but Phase 1 auth/validation errors should already adopt this shape per success criteria).

### Claude's Discretion
- Exact config module API, Zod schema layout, adapter interface signature, and file names are left to the planner — bias toward the minimal-structure decision (D-03) and the SDK conventions already in `services/`.
- Which single provider the non-streaming call resolves to at runtime when both are configured: planner may pick a deterministic default (e.g. first in `PROVIDER_ORDER`) since true round-robin is Phase 2.
- `/health` body shape and whether root `/` stays a health alias (current code aliases both) — keep simple.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project spec & requirements
- `CLAUDE.md` — full proxy spec. Phase 1 relevant sections: §6 downstream auth, §7 env vars, §8 logical model registry, §10 non-streaming chat completions, §11 common request contract (allowlist + reject list), §14 error/failover policy (error shape), §15 response normalization (alias rewrite), §20 readiness (context only), §21 suggested architecture, §23 implementation sequence (steps 1–10, 16).
- `.planning/REQUIREMENTS.md` — Phase 1 requirement IDs: INFRA-01..05, AUTH-01..04, EP-04, EP-07, VALID-01..07, REG-01..04. Authoritative wording.
- `.planning/ROADMAP.md` §"Phase 1: Foundation" — goal + 5 success criteria.

### Provider docs (verify before adding compatibility claims — per spec working-rule 15)
- Cerebras OpenAI compatibility: https://inference-docs.cerebras.ai/resources/openai
- Cerebras Chat Completions: https://inference-docs.cerebras.ai/api-reference/chat-completions
- Groq OpenAI compatibility: https://console.groq.com/docs/openai
- Groq Chat Completions: https://console.groq.com/docs/text-chat
- Groq error codes: https://console.groq.com/docs/errors

### Codebase maps
- `.planning/codebase/STRUCTURE.md`, `CONVENTIONS.md`, `STACK.md` — current flat layout, Bun conventions, SDK versions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `services/groq.ts` + `services/cerebras.ts`: existing SDK client instantiation (module-level singletons reading env at import) and the `AIService` shape — reuse the singleton pattern but replace the streaming `chat()` with a non-streaming completion method, and add `maxRetries: 0` (INFRA-03).
- `index.ts`: existing `Bun.serve()` fetch router and the `/health` aliasing of `/` — keep the server skeleton, replace `/chat` with `/v1/chat/completions` + `/v1/models`, add auth + validation in front.
- `types.ts`: `ChatMessage` shape (`role`/`content`) — extend/replace for the OpenAI request contract.

### Established Patterns
- `Bun.serve({ fetch })` native routing, no framework (per project constraint — Bun only).
- 4-space indent; named exports only; kebab-case service files, camelCase entry/types.
- Bun auto-loads `.env` — no dotenv; config module (INFRA-05) centralizes `process.env` reads with validation and typed exports.

### Integration Points
- New auth + validation layers sit in front of the existing fetch router before any provider call.
- Model registry (REG-01, from `MODEL_REGISTRY_JSON`) resolves alias → upstream model ID inside each adapter call.
- Provider adapters wrap groq-sdk (upgrade ^0.37 → ^1.2.1, INFRA-01) and `@cerebras/cerebras_cloud_sdk`; remove unused `cerebras` CLI package (INFRA-02); add Zod v4 (INFRA-04).

</code_context>

<specifics>
## Specific Ideas

- Default token cap value chosen explicitly: **4096** (matches current `groq.ts`), env-overridable.
- Error responses adopt OpenAI shape from Phase 1 onward (don't wait for Phase 3 NORM-10 to shape auth/validation errors).
- Both adapters exist after Phase 1 but only the non-streaming code path is exercised; streaming methods left for Phase 2.

</specifics>

<deferred>
## Deferred Ideas

- Streaming relay / SSE — Phase 2 (STREAM-01..07).
- Round-robin routing, cooldown, rate-limit header parsing, failover — Phase 2 (ROUTE/RL).
- Full response normalization (reasoning strip, x_groq strip, chunk rewrite) — Phase 3 (NORM).
- Observability (X-Request-ID, structured logs, X-LLM-Provider) — Phase 3 (OBS).
- Full spec section-21 directory tree — adopt when Phase 2/3 needs it (per D-03).
- `/ready` degraded mode, `/internal/providers/status` — Phase 2 (EP-05, EP-06).

None of these were scope creep — all are already roadmapped to later phases.

</deferred>

---

*Phase: 1-Foundation*
*Context gathered: 2026-06-05*
