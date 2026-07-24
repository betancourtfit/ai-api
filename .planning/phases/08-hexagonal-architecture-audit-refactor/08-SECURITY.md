---
phase: 08
slug: hexagonal-architecture-audit-refactor
status: verified
threats_open: 0
asvs_level: 1
created: 2026-07-24
---

# Phase 08 — Security

Audit date: 2026-07-24
Auditor: gsd-security-auditor (read-only; implementation files not modified)
Commit range audited: `2d19cc5..HEAD`
Scope: verification of every threat declared in `08-01-PLAN.md` through `08-04-PLAN.md`
`<threat_model>` blocks, against the code actually merged.

## Result: SECURED — 24/24 threats CLOSED, 0 open

20 `disposition=mitigate` verified by the auditor; 4 `disposition=accept` verified by the
orchestrator. `bun test` → **119 pass / 0 fail / 303 expect() calls / 9 files** (verified
live during the audit).

Context for the register's size: phase 08 was a ~1,300-line hexagonal restructuring that
physically relocated **every** security control in the codebase (`index.ts` 1,012 → 22 LOC).
Each control was therefore a regression candidate, and each is verified below by `file:line`.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| untrusted client → proxy | Bearer token, `x-goog-api-key`/`?key=`, JSON bodies, multipart uploads, base64 audio, URL path segments | Credentials, attacker-controlled payloads |
| proxy → upstream providers | Provider selection, retry, cooldown; upstream error messages flow back toward the client | Provider API keys outbound; upstream-controlled strings inbound |
| upstream provider → proxy | SDK error objects (status, message, headers) flattened by `toUpstreamFailure` | Upstream-controlled strings and headers |
| proxy → whisper sidecar | Audio bytes to the local transcription sidecar | Decoded audio |
| environment → process | `loadConfig()` is the single ingress for `process.env` | All three secrets |
| composition root → adapters | `buildContainer` hands API keys to provider factories | Provider API keys |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation / Evidence | Status |
|-----------|----------|-----------|-------------|------------------------|--------|
| T-08-01-01 | Information Disclosure | audit document content | mitigate | `ARCHITECTURE.md` and `08-ARCHITECTURE-AUDIT.md` contain only `file:line`/construct-name citations. Grep for secret-shaped strings (`sk-`, populated `*_API_KEY=`, bearer tokens) returned nothing. | closed |
| T-08-01-02 | Tampering | documented invariants | mitigate | `ARCHITECTURE.md:116-126` §7 "Invariants that outrank the architecture" records constant-time comparison, no-secret-logging, wire contract, size limits, allowlist-rebuild, zero-new-deps, and route ordering as outranking every layering rule. | closed |
| T-08-01-03 | Tampering | npm installs | accept | `git diff 2d19cc5..HEAD -- package.json bun.lock` empty. | closed |
| T-08-02-01 | Information Disclosure | `toUpstreamFailure` / `toHeaderRecord` | mitigate | `adapters/outbound/sdk-error-mapper.ts:63-74` copies only `status`/`message`/flattened `headers`; `toHeaderRecord` (`:31-56`) flattens header iterables only — no request body, no `Authorization` header. | closed |
| T-08-02-02 | Elevation of Privilege | failover status sets | mitigate | `domain/failure-classification.ts:14-15` — failover `{408,429,498,500,502,503,504}`, terminal `{400,401,403,404,413,422}`, verbatim. A 401 cannot silently retry the other provider. | closed |
| T-08-02-03 | Denial of Service | `calcCooldownMs` | mitigate | `domain/rate-limits.ts:44-50` — five-way `Math.max` including `resetRequestsDaySeconds` (CR-02) plus the `DEFAULT_COOLDOWN_SECONDS` floor. | closed |
| T-08-02-04 | Spoofing | `configured` flags | mitigate | `composition/container.ts:55-59` — `Boolean(cfg.cerebrasApiKey)` / `Boolean(cfg.groqApiKey)`; only booleans reach the provider-state store. | closed |
| T-08-02-05 | Information Disclosure | `domain/errors.ts` classes | mitigate | Classes carry a status and a human message only — no provider name, upstream URL, or key material. | closed |
| T-08-02-06 | Tampering | npm installs | accept | Boundary guard uses `bun:test` + `Bun.Glob`, both built in. Lockfile diff empty. | closed |
| T-08-03-01 | Spoofing / EoP | route ordering vs Bearer gate | mitigate | `adapters/inbound/http/router.ts:29-41` — `PRE_AUTH_ROUTES` is exactly `[health, ready, geminiGenerateContent]`; `requireBearer` (`:57`) runs before `POST_AUTH_ROUTES`. No `/v1/*` route sits pre-auth. | closed |
| T-08-03-02 | Elevation of Privilege | constant-time key comparison | mitigate | `adapters/inbound/http/middleware/bearer-auth.ts:15-26` — both buffers padded to `maxLen`, `timingSafeEqual` always executes, length checked only after via `&&`. The CR-01 timing oracle is not back. | closed |
| T-08-03-03 | Denial of Service | body-size enforcement | mitigate | `adapters/inbound/http/read-limited-body.ts:22-43` — counts actual buffered bytes via `runningTotal`, ignores `content-length`, `reader.cancel()` on overflow, returns 413. | closed |
| T-08-03-04 | Denial of Service | Gemini pre-decode size guard | mitigate | `adapters/inbound/http/routes/gemini-generate-content.ts:100-108` — `approxBytes` guard (`:101`) precedes `Buffer.from(...)` (`:108`). No ~18 MiB allocation on attacker input. | closed |
| T-08-03-05 | Information Disclosure | upstream error text | mitigate | Terminal-error path in `create-chat-completion.ts` wraps upstream messages through `rewriteUpstreamModelIds` before returning `upstream_rejected`; the presenter adds no fields. Raw provider model IDs never leak. | closed |
| T-08-03-06 | Information Disclosure | logging in use cases and routes | mitigate | Every `logger.log` call site in `application/use-cases/*.ts` and `adapters/inbound/http/routes/{transcriptions,gemini-generate-content}.ts` enumerated; fields limited to requestId/route/provider/status/latency/fileSize/modelAlias. No key, Authorization header, prompt, response, base64 audio, decoded bytes, filename, or transcript text. | closed |
| T-08-03-07 | Tampering | SSE stream integrity | mitigate | `adapters/inbound/http/presenters/sse.ts:19-25` — `data: [DONE]` emitted from `try` and `catch`, explicitly **not** `finally` (source comment records why). Independently re-verified by the orchestrator. `08-REVIEW.md` W-1 documents the catch-and-fix. | closed |
| T-08-03-08 | Tampering | npm installs | accept | SSE framing, routing, and DI hand-written. Lockfile diff empty. | closed |
| T-08-04-01 | Information Disclosure | `Container` carrying API keys | mitigate | `adapters/inbound/http/routes/providers-status.ts:24-27` returns only `getProviderStatus()`; `application/use-cases/get-provider-status.ts:12-16` returns `Object.values(store.getSnapshot())`. No route returns `config` or the `Container`. | closed |
| T-08-04-02 | Information Disclosure | `loadConfig(env)` injected map | mitigate | `config.ts:9` — `loadConfig(env: Env = process.env)`; default remains `process.env`. Boundary guard rule 3 (`ARCHITECTURE.md:106`) enforces no stray `process.env` read outside `config.ts` / `routes/health.ts`. | closed |
| T-08-04-03 | Elevation of Privilege | `configured` flags in `buildContainer` | mitigate | `composition/container.ts:55-59` — booleans only, single injection point. A keyless provider stays ineligible. | closed |
| T-08-04-04 | Denial of Service | config validation | mitigate | `config.ts:17-27` — `requiredPositiveInt` throws the identical message; `optional()` (`:10-13`) still returns `null` for absent secrets, so a missing key degrades via `/ready` instead of crashing. | closed |
| T-08-04-05 | Tampering | test-harness integrity | mitigate | `git diff 2d19cc5..HEAD -- tests/` shows exactly **one** non-additive assertion change across the whole phase: `expect(apiResult.headers).toBe(headers)` → `.toEqual({"retry-after":"2"})` (reference→value equality, forced by the `Headers`→`Record` contract change). 43 `expect()` added, 1 removed. Independently re-verified by the orchestrator. 119 pass / 0 fail. | closed |
| T-08-04-06 | Spoofing | Groq `temperature === 0 → 1e-8` | mitigate | `adapters/outbound/groq-chat-provider.ts:37` (complete) and `:78` (stream) both contain `temperature === 0 ? 1e-8 : (params.temperature ?? undefined)`. | closed |
| T-08-04-07 | Tampering | npm installs | accept | `git diff 2d19cc5..HEAD -- package.json bun.lock` empty; deps unchanged at 3 (`@cerebras/cerebras_cloud_sdk`, `groq-sdk`, `zod`). | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

No accepted risks. The four `disposition=accept` threats were all "zero new packages"
claims, which were **verified** rather than accepted — the lockfile diff is empty, so the
claim is closed on evidence, not on acceptance.

---

## Unregistered flags

None. No `## Threat Flags` section exists in any of `08-01-SUMMARY.md` through
`08-04-SUMMARY.md`, so the executor identified no new attack surface during implementation.

---

## Residual risk (not threats — coverage limits carried forward)

These are gaps in *evidence*, not unmitigated threats. Recorded so they are not mistaken
for verified ground later.

| Item | Why it matters | Source |
|------|----------------|--------|
| Upstream abort on client disconnect is unverified | UAT confirmed the server survives a mid-stream disconnect, not that the upstream provider request is actually cancelled. A leak here wastes provider quota rather than exposing data. | `08-UAT.md` test 2 |
| The 429 cooldown / failover path never ran against a real provider | No provider returned 429 during UAT, so that path is covered by mock-based tests only. | `08-UAT.md` test 3 |
| `bunx tsc --noEmit` reports 7 pre-existing errors | No typecheck gate is wired into CI, so type regressions are not blocked. Pre-existing, not introduced by phase 08. | phase 08 execution report |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-24 | 24 | 24 | 0 | gsd-security-auditor (20) + orchestrator (4 accept, plus independent re-verification of T-08-03-07 and T-08-04-05) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-24

---

## Notes

- This audit is read-only: no implementation file was created or modified.
- `08-REVIEW.md` (inline code review, run degraded because `gsd-code-reviewer` was
  unavailable in the executing runtime) independently covered the same controls and found
  the SSE `finally`-block sentinel bug (W-1), fixed before this audit ran.
- The auditor initially wrote this report to the repository root; it was relocated here and
  given the template frontmatter so the `threats_open` gate is machine-readable.
