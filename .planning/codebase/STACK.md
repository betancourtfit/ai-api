# Technology Stack

**Analysis Date:** 2026-06-04

## Languages

**Primary:**
- TypeScript 5.x - All source files (`index.ts`, `types.ts`, `services/*.ts`)

**Secondary:**
- None detected

## Runtime

**Environment:**
- Bun 1.1.29 (pinned in `Dockerfile`) — local dev uses Bun 1.3.11
- ESNext target; module system: `"Preserve"` with bundler-mode resolution

**Package Manager:**
- Bun (`bun install`)
- Lockfile: `bun.lock` present (lockfileVersion 1)

## Frameworks

**Core:**
- `Bun.serve()` (built-in) — HTTP server with SSE streaming; no Express or Hono

**Testing:**
- `bun test` (built-in) — no test files exist yet

**Build/Dev:**
- `bun --watch run index.ts` — watch mode for development (hot-restart)
- `bun index.ts` — production start command
- No separate bundler; `dist/index.js` exists as a pre-built artifact but is not used in production

## Key Dependencies

**Critical:**
- `@cerebras/cerebras_cloud_sdk` ^1.59.0 (resolved 1.59.0) — official Cerebras inference SDK; used in `services/cerebras.ts`
- `groq-sdk` ^0.37.0 (resolved 0.37.0) — official Groq SDK; used in `services/groq.ts`

**Duplicate / Legacy:**
- `cerebras` ^1.2.7 — a separate Cerebras CLI/native binary package listed alongside `@cerebras/cerebras_cloud_sdk`; only `@cerebras/cerebras_cloud_sdk` is imported in source code. The `cerebras` package installs platform-specific native binaries (`cerebras-darwin-arm64`, etc.) and a `cerebras` CLI binary. It appears unused at the application level.

**Dev:**
- `@types/bun` latest (resolved 1.3.5) — TypeScript types for the Bun runtime API

**Peer:**
- `typescript` ^5 — TypeScript compiler (not explicitly installed, provided by environment)

## Configuration

**TypeScript (`tsconfig.json`):**
- `target`: ESNext
- `module`: Preserve (bundler mode)
- `moduleResolution`: bundler
- `strict`: true
- `noUncheckedIndexedAccess`: true
- `noImplicitOverride`: true
- `allowImportingTsExtensions`: true
- `verbatimModuleSyntax`: true
- `noEmit`: true (Bun runs TS directly — no tsc emit step)

**Environment:**
- Bun auto-loads `.env` and `.env.local` — no dotenv library needed
- `.env` and `.env.local` both present (contents secret; never read)
- Key env vars referenced in source: `HOSTNAME`, `PORT`
- Key env vars required per `refactor.md` design spec: `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `PERSONAL_PROXY_API_KEY`, `PORT`, `HOSTNAME`, `LOG_LEVEL`, `REQUEST_TIMEOUT_MS`, `MAX_REQUEST_BODY_BYTES`, `CEREBRAS_BASE_URL`, `GROQ_BASE_URL`, `CEREBRAS_VERSION_PATCH`, `ROUTING_STRATEGY`, `PROVIDER_ORDER`, `DEFAULT_COOLDOWN_SECONDS`, `MAX_PROVIDER_ATTEMPTS_PER_REQUEST`, `MODEL_REGISTRY_JSON`, `EXPOSE_PROVIDER_HEADER`, `ENABLE_INTERNAL_STATUS_ENDPOINT`

**Build:**
- No `tsconfig.build.json` or separate build config; Bun transpiles TypeScript natively at runtime
- `Dockerfile` uses `oven/bun:1.1.29` base image

## Platform Requirements

**Development:**
- Bun >= 1.1.29
- No Node.js required

**Production:**
- Docker container via `oven/bun:1.1.29`
- Port: `3001` (Dockerfile default); `3000` (code default); overridable via `PORT` env var
- Hostname: `0.0.0.0` (all interfaces) or overridable via `HOSTNAME` env var
- Deployment target: EasyPanel (mentioned in code comment) or any reverse-proxy-compatible host

---

*Stack analysis: 2026-06-04*
