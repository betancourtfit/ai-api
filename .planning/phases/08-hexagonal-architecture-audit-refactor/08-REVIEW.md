---
status: issues_found
phase: 08-hexagonal-architecture-audit-refactor
depth: standard
reviewer: inline (gsd-code-reviewer agent unavailable in this runtime)
files_reviewed: 55
critical: 0
warning: 1
info: 3
resolved_during_review: 1
created: 2026-07-24
---

# Phase 08 Code Review

**Scope:** 55 production `.ts` files changed between `2d19cc5` (phase start) and phase close.
**Depth:** standard — per-file analysis of the changed source, with focused attention on the
security-relevant paths the refactor relocated (auth, body limits, SSE lifecycle, secret handling).

> **Runtime note:** the `gsd-code-reviewer` subagent is not available in this execution context, so
> this review was performed inline by the executor. Per the execute-phase workflow the code-review
> gate is advisory and non-blocking; it did not gate phase completion. A follow-up
> `/gsd-code-review 08` under a runtime with agent support would add independent eyes.

---

## Summary

| Severity | Count | Status |
|---|---:|---|
| Critical | 0 | — |
| Warning | 1 | **fixed during review** |
| Info | 3 | recorded, no action taken |

The refactor's security-relevant controls were verified individually rather than assumed: the
constant-time key comparison, the byte-counted body limit, the Gemini pre-decode size guard, the
allowlist-rebuild normalizer, and the secret-free diagnostics payload all survived relocation intact.

---

## Warning

### W-1 — SSE sentinel emitted from a `finally` block resumed a closing generator *(fixed)*

- **File:** `adapters/inbound/http/presenters/sse.ts`
- **Introduced by:** this phase (plan 08-03, Task 3)
- **Found during:** this review

**Issue.** `toSseStream` emitted the terminating `data: [DONE]\n\n` from a `finally` block:

```ts
try {
    for await (const chunk of chunks) { yield `data: ${JSON.stringify(chunk)}\n\n`; }
} finally {
    yield 'data: [DONE]\n\n';        // also runs on .return()
}
```

`finally` runs not only on normal completion and on error, but also when the consumer calls
`.return()` on the generator — which is what happens when the client disconnects and Bun cancels the
response `ReadableStream`. Yielding while a generator is being closed *resumes* it rather than
completing it, leaving the generator suspended and attempting a write to a socket that is going away.

The pre-refactor inline generator emitted the sentinel from inside `try` (after the loop) and from
inside `catch` — never on early termination. So this was a behavioural divergence introduced by the
extraction, not a pre-existing condition.

**Why the suite did not catch it.** No test exercises mid-stream client disconnect; every streaming
test consumes the response to completion. Both paths the tests do cover (clean stream, upstream
error) produce byte-identical output under either implementation.

**Fix applied.** Emit the sentinel from `try` and `catch` explicitly, with no `finally`, reproducing
the original lifecycle exactly. A comment records why `finally` is deliberately avoided so the next
reader does not "simplify" it back.

**Verification.** `bun test` → 119 pass / 0 fail. SSE framing assertions unchanged.

---

## Info

### I-1 — Config is captured at composition time, not read per request

- **Files:** `adapters/inbound/http/server.ts`, `application/use-cases/{get-readiness,list-models}.ts`

Before the refactor every handler read `config.*` live on each request. Now most values are read
once when `createServer` builds its dependency set. In production this is indistinguishable —
`createServer` runs once at startup and `config` is never mutated — and passing values rather than a
live config object is the correct hexagonal shape, since a use case should not observe mutable global
configuration.

One exception exists: `ServerDeps.defaultModelAlias` is a getter, because
`tests/integration/server.test.ts` mutates `config.defaultModelAlias` around individual cases and the
pre-refactor handler read it live. That concession is documented inline at the getter.

**No action.** Recorded so a future reader understands why exactly one field is a getter and the rest
are values.

### I-2 — Pre-existing `tsc --noEmit` errors persist, two now in relocated files

- **Files:** `adapters/inbound/http/routes/transcriptions.ts`, `application/use-cases/stream-chat-completion.ts`, plus test files

`bunx tsc --noEmit` reports 7 errors. All predate this phase — `git diff 2d19cc5..HEAD -- index.ts`
confirms the two production sites travelled with their code rather than being introduced:

- the undici `FormData` iterator mismatch (was `index.ts:373`, now in `routes/transcriptions.ts`)
- the `StreamChunk` → `Record<string, unknown>` cast (was `index.ts:766`, now in
  `stream-chat-completion.ts`, written as `as unknown as Record<string, unknown>`)

There is no typecheck step in `package.json` and `bun test` does not typecheck, so these are not a
gate today.

**Suggested follow-up (Phase 9 hygiene, not this phase):** add a `typecheck` script and wire it into
the test gate, then clear the 7 errors.

### I-3 — Use cases have no direct unit tests

- **Files:** `application/use-cases/*.ts`

The whole point of extracting orchestration was that it can now be exercised without an HTTP server,
but all coverage still arrives through the integration suite. The failover, cooldown, and exhaustion
paths in `create-chat-completion.ts` are reachable directly with a mock store and mock providers at a
fraction of the setup cost.

**No action this phase** — the plan's explicit non-goal was "no new tests beyond the boundary guard,"
and adding use-case tests would have muddied the "assertions are byte-identical" guarantee that makes
this refactor auditable.

---

## Verified Clean

Checks performed that found nothing:

| Area | Check | Result |
|---|---|---|
| Auth | `verifyToken` pads both buffers to `maxLen` and always runs `timingSafeEqual`; no length pre-check reintroduced (CR-01) | PASS |
| Auth | Empty-token edge: `requireBearer` rejects falsy token and falsy expected key before comparison | PASS |
| Secrets | No route serialises `config` or the `Container`; `/internal/providers/status` returns only `store.getSnapshot()`, whose `configured` field is a boolean, never a key | PASS |
| Secrets | `toUpstreamFailure` copies status, message, and flattened headers only — no request body, no `Authorization` (T-08-02-01) | PASS |
| DoS | `readLimitedBody` counts actual buffered bytes, ignores `content-length`, and calls `reader.cancel()` on overflow | PASS |
| DoS | Gemini `approxBytes` pre-decode guard still precedes `Buffer.from(...)` — line 101 before line 108 (WR-01) | PASS |
| Correctness | Transcription route order: size check → alias check → transcribe, so an unknown alias never reaches the port | PASS (bug caught and fixed during plan 08-03) |
| Correctness | Groq `temperature === 0 → 1e-8` present on both `complete` and `stream` (WR-03) | PASS |
| Correctness | Failover set `{408,429,498,500,502,503,504}` and terminal set `{400,401,403,404,413,422}` moved verbatim | PASS |
| Correctness | `advanceCursor()` still called after successful selection AND after every failed attempt (WR-02) | PASS |
| Normalization | Allowlist-rebuild preserved verbatim; no object spread of raw upstream data introduced | PASS |
| Routing | Pre-auth segment (`/health`, `/ready`, Gemini) matched before the Bearer gate | PASS |
| Logging | No key, prompt, response, filename, or transcript reaches any log call | PASS |
| Dependencies | `git diff 2d19cc5..HEAD -- package.json bun.lock` is empty | PASS |

---

## Next Steps

```
/gsd-verify-work 08     — walk the human-verification items
/gsd-secure-phase 08    — security enforcement is enabled and no SECURITY.md exists yet
/gsd-code-review 08     — re-run under a runtime with gsd-code-reviewer for independent review
```
