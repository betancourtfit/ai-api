# Phase 3: Full Compliance + Tests - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-05
**Phase:** 3-Full Compliance + Tests
**Areas discussed:** Test harness strategy, Normalization architecture

---

## Test Harness Strategy

### Q1: How should the suite exercise end-to-end behaviors (alternation, streaming SSE, auth 401)?

| Option | Description | Selected |
|--------|-------------|----------|
| Real server + mocked adapters | Boot real Bun.serve() on random port, inject mock provider adapters, assert via fetch(). Covers full HTTP path. | ✓ |
| Pure unit tests | Test router/normalizer/handler functions directly, no HTTP. | |
| Mix: unit + thin integration | Unit tests for logic plus small integration suite over real server. | |

**User's choice:** Real server + mocked adapters (recommended)

### Q2: How do tests inject mock adapters given index.ts builds adapterMap at module load?

| Option | Description | Selected |
|--------|-------------|----------|
| createServer() factory | Export createServer(adapters); entrypoint calls with real adapters; tests with mocks on port 0. Also fixes server-starts-on-import. | ✓ |
| Bun mock.module() | Mock service modules before importing index.ts. Import-order fragile. | |
| Upstream fetch stub | Point provider base URLs at local mock HTTP server; exercises real SDKs. | |

**User's choice:** createServer() factory (recommended)

### Q3: Time control for cooldown-expiry test (TEST-03)?

| Option | Description | Selected |
|--------|-------------|----------|
| Bun setSystemTime | bun:test fake clock, jump past cooldownUntil instantly. | ✓ |
| Tiny real cooldowns | retry-after: 0.05, sleep ~60ms. Wall-clock flake risk. | |
| Injectable clock param | Refactor cooldown-manager to accept now() function. | |

**User's choice:** Bun setSystemTime (recommended)

### Q4: Live smoke tests against real providers in the suite?

| Option | Description | Selected |
|--------|-------------|----------|
| Mocked only | bun test 100% deterministic; live verification stays manual curl. | ✓ |
| Separate opt-in live file | tests/live.test.ts behind RUN_LIVE=1. | |
| Live included in default run | Real provider calls every run. Quota burn + flake. | |

**User's choice:** Mocked only (recommended)

---

## Normalization Architecture

### Q1: Where should response normalization live?

| Option | Description | Selected |
|--------|-------------|----------|
| Central normalizer module | response-normalizer.ts; adapters return raw SDK output; normalizer at route layer. One place to test NORM-01..09. | ✓ |
| Per-adapter stripping | Each adapter normalizes its own output. Duplicate logic. | |
| Hybrid | Adapters drop known fields; central module enforces final shape. | |

**User's choice:** Central normalizer module (recommended)

### Q2: Strip strategy — allowlist-rebuild or denylist-strip?

| Option | Description | Selected |
|--------|-------------|----------|
| Allowlist-rebuild | Build clean response with only known OpenAI fields. Unknown provider fields can never leak. | ✓ |
| Denylist-strip | Delete named bad fields, pass rest. New fields leak silently. | |
| Denylist + warn log | Denylist plus log unknown keys. Leaks until patched. | |

**User's choice:** Allowlist-rebuild (recommended)

### Q3: Upstream provider error messages — passthrough or generic?

| Option | Description | Selected |
|--------|-------------|----------|
| Pass through + rewrite IDs | Keep provider message, rewrite known upstream model IDs to logical alias. | ✓ |
| Pass through verbatim | Unchanged in OpenAI shape; risks model-ID leak. | |
| Generic proxy messages | Fixed proxy-authored messages per status code. Loses diagnostics. | |

**User's choice:** Pass through + rewrite IDs (recommended)

### Q4: If upstream omits usage on non-streaming response (NORM-08)?

| Option | Description | Selected |
|--------|-------------|----------|
| Synthesize zeros + log | usage 0/0/0 + warning log. NORM-08 always holds. | ✓ |
| Omit field | Pass absence through. Violates NORM-08. | |
| Fail request | 502 on missing usage. Kills good completions. | |

**User's choice:** Synthesize zeros + log (recommended)

---

## Claude's Discretion

- Test file layout (consolidate to tests/unit + tests/integration vs current hybrid)
- X-Request-ID: honor inbound header or always generate
- Logger shape: raw console.log JSON vs small logger util with LOG_LEVEL gating
- Stream latency definition in logs (TTFB vs total)
- Mock adapter design (scriptable response sequences)

## Deferred Ideas

None — discussion stayed within phase scope.
