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
- [ ] **Phase 3: Full Compliance + Tests** - Complete normalization, observability, diagnostic endpoints, and full test coverage

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

**Plans:** 3 plans
Plans:

**Wave 1**

- [ ] 03-01-PLAN.md — Central response normalizer (allowlist-rebuild) wired into both response paths (NORM-01..09)

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 03-02-PLAN.md — createServer factory, X-Request-ID everywhere, NORM-10 error sweep + D-07 passthrough, structured logging (OBS-01..05)

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 03-03-PLAN.md — 12-case integration suite via real server + mocked adapters (TEST-01..12)

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 2/2 | Complete    | 2026-06-05 |
| 2. Routing + Streaming | 2/2 | Complete    | 2026-06-05 |
| 3. Full Compliance + Tests | 0/3 | Planned | - |

---

*Roadmap created: 2026-06-04*
*Last updated: 2026-06-05 after Phase 3 planning (3 plans, 3 waves)*
