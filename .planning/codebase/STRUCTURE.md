# Codebase Structure

**Analysis Date:** 2026-06-04

## Directory Layout

```
bun-ai-api/
├── index.ts            # HTTP server entry point (Bun.serve), route handlers, round-robin router
├── types.ts            # Shared TypeScript interfaces: AIService, ChatMessage
├── services/           # Provider adapter implementations
│   ├── groq.ts         # Groq Cloud adapter (groq-sdk, model: kimi-k2-instruct-0905)
│   └── cerebras.ts     # Cerebras adapter (@cerebras/cerebras_cloud_sdk, model: qwen-3-32b)
├── dist/               # Compiled output artifact (index.js) — not used at runtime
├── package.json        # Project manifest, scripts, dependencies
├── tsconfig.json       # TypeScript config (ESNext, strict, bundler moduleResolution)
├── bun.lock            # Bun lockfile
├── Dockerfile          # Container image (oven/bun:1.1.29, port 3001, NODE_ENV=production)
├── CLAUDE.md           # Project-local agent instructions (Bun-first conventions)
├── refactor.md         # Full MVP refactor spec: OpenAI-compatible proxy design doc
├── README.md           # Project readme
├── .env                # Environment variables (existence noted; contents not read)
├── .env.local          # Local environment overrides (existence noted; contents not read)
├── .gitignore          # Git ignore rules
├── .planning/          # GSD planning documents
│   └── codebase/       # Codebase map documents (this directory)
├── .bmad-core/         # BMAD agent framework core files (tooling/meta — not application code)
├── .claude/            # Claude agent config and commands
├── .cursor/            # Cursor IDE rules
└── .gemini/            # Gemini agent commands
```

## Directory Purposes

**`services/`:**
- Purpose: Provider adapter modules, one file per upstream AI provider
- Contains: `AIService` interface implementations, SDK client singletons, async generator stream adapters
- Key files: `services/groq.ts`, `services/cerebras.ts`

**`dist/`:**
- Purpose: Compiled JavaScript output (likely from a prior `bun build` step)
- Contains: `dist/index.js`
- Generated: Yes
- Committed: Yes (currently in repo)
- Note: Not used at runtime — `bun index.ts` runs TypeScript directly

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents (ARCHITECTURE.md, STRUCTURE.md, etc.)
- Generated: Yes (by `/gsd:map-codebase`)
- Committed: As needed

**`.bmad-core/`:**
- Purpose: BMAD multi-agent framework scaffolding (agents, checklists, templates, workflows)
- Contains: Agent definitions, task templates, workflow configs
- Note: Tooling infrastructure, not application source code

## Key File Locations

**Entry Points:**
- `index.ts`: HTTP server, all route definitions, round-robin router logic

**Type Definitions:**
- `types.ts`: `ChatMessage` and `AIService` interfaces — import these for all provider work

**Provider Adapters:**
- `services/groq.ts`: Groq Cloud streaming adapter
- `services/cerebras.ts`: Cerebras streaming adapter

**Configuration:**
- `package.json`: Scripts (`start`, `dev`), dependencies
- `tsconfig.json`: TypeScript compiler options
- `Dockerfile`: Container build and runtime config
- `.env` / `.env.local`: Runtime environment variables (Bun auto-loads these)

**Design Specification:**
- `refactor.md`: Comprehensive MVP spec for the full OpenAI-compatible proxy refactor — read before making architectural changes

## Naming Conventions

**Files:**
- Lowercase, hyphen-separated for multi-word names (e.g., `cerebras.ts`, `groq.ts`)
- Single responsibility per file — one provider per service file

**Directories:**
- Lowercase, singular noun (e.g., `services/`)

**Exports:**
- Named exports for service objects (e.g., `export const groqService`, `export const cerebrasService`)
- Named exports for types (e.g., `export interface ChatMessage`, `export interface AIService`)

**Types:**
- PascalCase for interfaces (e.g., `AIService`, `ChatMessage`)

## Where to Add New Code

**New AI Provider Adapter:**
- Implementation: `services/<provider-name>.ts`
- Must implement `AIService` from `types.ts`
- Register in the `services` array in `index.ts:5-8`
- Export as named const: `export const <provider>Service: AIService = { ... }`

**New Route:**
- Add route handler inside `Bun.serve({ async fetch(request) { ... } })` in `index.ts`
- Follow the existing pattern: check `request.method` and `pathname` with if-blocks

**New Shared Type:**
- Add to `types.ts` as a named `export interface` or `export type`

**New Middleware / Cross-Cutting Logic (per refactor spec):**
- Per `refactor.md:821-857`, the planned structure uses dedicated subdirectories:
  - `src/middleware/` — auth, request ID
  - `src/routing/` — provider router, provider state, cooldown manager
  - `src/providers/` — provider adapter interface + per-provider adapters
  - `src/services/` — model registry, response normalizer, stream relay
  - `src/routes/` — per-endpoint route handlers
  - `src/schemas/` — request/response validation schemas
  - `src/utils/` — errors, logger
  - `tests/unit/` and `tests/integration/` — test files

## Special Directories

**`dist/`:**
- Purpose: Compiled JS output from `bun build`
- Generated: Yes
- Committed: Yes (currently; `.gitignore` does not exclude it)
- Note: Can be deleted safely — runtime uses `index.ts` directly

**`.bmad-core/`:**
- Purpose: BMAD agent framework meta-files
- Generated: No (manually installed)
- Committed: Yes
- Note: Not part of application logic; safe to ignore during feature development

---

*Structure analysis: 2026-06-04*
