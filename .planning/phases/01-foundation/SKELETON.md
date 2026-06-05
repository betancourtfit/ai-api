# Walking Skeleton — bun-ai-api OpenAI-Compatible Proxy

**Phase:** 1
**Generated:** 2026-06-05

## Capability Proven End-to-End

A downstream client (OpenAI SDK or curl) sends a Bearer-authenticated, allowlist-validated chat request using the logical alias `gpt-oss-120b-balanced`; the proxy resolves the alias to a real Cerebras upstream model, makes one real non-streaming completion call, and returns a clean OpenAI-shaped `chat.completion` whose `model` field is the logical alias — all from a server started with `bun index.ts`.

> Note: this is a HEADLESS API proxy. There is no database and no UI. The "real interaction" that proves the full stack is a real upstream provider completion returning real assistant content — not a DB write or a UI click.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime / server | Bun + `Bun.serve({ fetch })` | Project constraint — Bun only; no Express/Hono. Native fetch router already in prototype. |
| Language / config | TypeScript (strict, verbatimModuleSyntax); Bun auto-loads `.env` | No dotenv needed; `tsconfig.json` already strict. Bun transpiles TS at runtime (noEmit). |
| Upstream SDKs | Keep `groq-sdk` (^1.2.1) + `@cerebras/cerebras_cloud_sdk` (^1.64.1); `maxRetries: 0` | Wrapping is safer than re-implementing HTTP auth/error parsing; maxRetries:0 so SDK retries don't fight Phase 2 proxy failover. |
| Validation | Zod v4 `z.strictObject()` + first-error mapping | Strict allowlist enforces the intersection contract; rejects unsupported fields before any upstream call; `.strict()` removed in v4. |
| Downstream auth | Single shared `PERSONAL_PROXY_API_KEY`, `node:crypto` `timingSafeEqual` (length pre-check) | Personal proxy; constant-time compare avoids timing attacks (AUTH-03). Upstream keys never reach clients. |
| Model identity | Logical alias registry from `MODEL_REGISTRY_JSON`; response `model` rewritten to alias | Clients use stable aliases; provider-specific IDs never leak downstream (REG-04, NORM basis). |
| Provider selection (Phase 1) | Deterministic first-eligible from `PROVIDER_ORDER` | Round-robin / cooldown / failover deferred to Phase 2; both adapters built now so Phase 2 lands with zero adapter rework (D-01). |
| Directory layout | Flat root-level files (config.ts, types.ts, model-registry.ts, request-schema.ts) + existing `services/` for adapters | D-03 — minimal structure; do NOT scaffold the full §21 tree until Phase 2/3 needs it. |
| Deployment / run | Local full-stack run: `bun index.ts` (Dockerfile `oven/bun` for EasyPanel later) | No deploy step in Phase 1; documented local run exercises the full path. |

## Stack Touched in Phase 1

- [x] Project scaffold — config module, typed adapter contract, dependency cleanup (groq-sdk ^1.2.1, dead `cerebras` removed, Zod v4)
- [x] Routing — real routes: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`
- [x] Real upstream call (replaces "DB read/write" for this headless proxy) — one real non-streaming Cerebras completion (Plan 01) + Groq adapter wired (Plan 02)
- [x] Real client interaction wired to the pipeline — `curl` / OpenAI SDK against `/v1/chat/completions` returns real content normalized to the logical alias
- [x] Run command — `bun index.ts` starts the full stack and serves real completions

## Out of Scope (Deferred to Later Slices)

- Streaming relay / SSE (`stream: true`) — Phase 2 (STREAM-01..07). Phase 1 rejects `stream: true` with 400.
- Stateful round-robin routing, cooldown, rate-limit header parsing, failover — Phase 2 (ROUTE/RL).
- `GET /ready` degraded mode, `GET /internal/providers/status` — Phase 2 (EP-05, EP-06).
- Full response normalization beyond Phase 1 strip (streaming chunk rewrite, full x_groq/time_info matrix) — Phase 3 (NORM).
- Observability (`X-Request-ID`, structured JSON logs, `X-LLM-Provider`) — Phase 3 (OBS).
- Automated test suite for routing/cooldown/streaming — Phase 3 (TEST-01..12). Phase 1 ships only the request-schema unit tests.
- Full §21 directory tree (routes/ middleware/ schemas/ providers/ utils/) — adopt when Phase 2/3 needs it (D-03).

## Subsequent Slice Plan

Each later phase adds vertical slices on top of this skeleton without altering its architectural decisions (Bun.serve, SDK adapters, alias registry, config module, ProviderAdapter contract):

- **Phase 2 (Routing + Streaming):** stateful round-robin across the two existing adapters, cooldown + rate-limit header parsing, failover, SSE streaming relay, `/ready` + `/internal/providers/status`.
- **Phase 3 (Full Compliance + Tests):** complete provider-field stripping across streaming + non-streaming, `X-Request-ID` + structured logs, and the full 12-case `bun test` suite with `resetForTesting()` state isolation.
