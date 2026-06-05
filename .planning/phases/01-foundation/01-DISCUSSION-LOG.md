# Phase 1: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-05
**Phase:** 1-Foundation
**Areas discussed:** First-provider strategy, Restructure scope, Missing token limit, Validation error shape

---

## First-provider strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Both adapters, static pick | Build Cerebras + Groq behind shared interface; Phase 1 picks one statically; Phase 2 adds round-robin | ✓ |
| Cerebras only first | Wire only Cerebras this phase | |
| Groq only first | Wire only Groq this phase | |

**User's choice:** "both but ignore stream true mode for now, priority on stream false"
**Notes:** Build both adapters behind the shared interface, but implement the non-streaming (`stream: false`) path only. Streaming deferred entirely to Phase 2.

---

## Restructure scope

| Option | Description | Selected |
|--------|-------------|----------|
| Full spec tree now | Create routes/ middleware/ schemas/ providers/ services/ config/ utils/ this phase | |
| Minimal, grow later | Refactor flat index.ts + add config/registry/schema/adapters as few root files; split dirs when needed | ✓ |
| You decide | Let planner choose | |

**User's choice:** Minimal, grow later.
**Notes:** Defer full section-21 directory tree until Phase 2/3 needs it. Keep root-level files.

---

## Missing token limit

| Option | Description | Selected |
|--------|-------------|----------|
| Forward absent as-is | Pure pass-through; risk Cerebras estimate rejection | |
| Inject safe default | Set a default when omitted | ✓ |
| Forward + log warning | Pass through but log no-cap | |

**User's choice:** Inject safe default.
**Follow-up — default value:**

| Option | Description | Selected |
|--------|-------------|----------|
| 4096, configurable | Matches groq.ts; safe for both quotas | ✓ |
| 16384, configurable | Matches cerebras.ts; more headroom | |
| 1024, configurable | Conservative | |

**Notes:** Default 4096, env-configurable (`DEFAULT_MAX_COMPLETION_TOKENS`). Client-supplied values forwarded untouched.

---

## Validation error shape

| Option | Description | Selected |
|--------|-------------|----------|
| First field only | Stop at first violation; error.param = that field; OpenAI-faithful | ✓ |
| Collect all violations | Aggregate every bad field into one error | |
| You decide | Planner picks, default first-field | |

**User's choice:** First field only.
**Notes:** OpenAI reports a single `param`; stay faithful. Errors use `{ "error": { "message", "type", "code", "param" } }` shape from Phase 1 onward.

---

## Claude's Discretion

- Exact config module API, Zod schema layout, adapter interface signature, file names.
- Runtime default provider selection when both configured (true round-robin is Phase 2).
- `/health` body shape; whether root `/` stays a health alias.

## Deferred Ideas

- Streaming/SSE relay → Phase 2.
- Round-robin, cooldown, rate-limit parsing, failover → Phase 2.
- Full response normalization → Phase 3.
- Observability headers/logs → Phase 3.
- Full section-21 directory tree → adopt when later phases need it.
- `/ready`, `/internal/providers/status` → Phase 2.

(No scope creep — all deferred items already roadmapped to later phases.)
