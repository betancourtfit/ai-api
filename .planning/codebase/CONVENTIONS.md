# Coding Conventions

**Analysis Date:** 2026-06-04

## Naming Patterns

**Files:**
- kebab-case for service files: `services/groq.ts`, `services/cerebras.ts`
- camelCase for entrypoint and shared types: `index.ts`, `types.ts`
- No barrel `index.ts` inside directories — each service file is imported directly

**Functions:**
- camelCase: `getNextService`, `chat`
- Verb + noun pattern for helpers: `getNextService()`

**Variables:**
- camelCase for local variables and module-level state: `currentServiceIndex`, `chatCompletion`
- `const` preferred; `let` used only when mutation is required (e.g., `let currentServiceIndex`)

**Constants / Module-Level:**
- Descriptive camelCase: `groqService`, `cerebrasService`
- Named exports used exclusively (no default exports in services): `export const groqService`

**Types / Interfaces:**
- PascalCase: `ChatMessage`, `AIService`
- Defined in a dedicated `types.ts` file at the root
- Interface keyword used (not `type` alias) for object shapes

## Code Style

**Formatting:**
- No formatter config detected (no `.prettierrc`, `biome.json`, or `.editorconfig`)
- 4-space indentation observed throughout all source files
- Single quotes for SDK imports in `services/groq.ts` (`'groq-sdk'`), double quotes elsewhere — inconsistent
- Trailing newlines present in service files

**Linting:**
- No ESLint or Biome config detected
- TypeScript strict mode is the primary enforcement mechanism (see `tsconfig.json`)

**TypeScript Config (`tsconfig.json`):**
- `strict: true` — all strict checks enabled
- `noUncheckedIndexedAccess: true` — array/index access returns `T | undefined`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`
- `verbatimModuleSyntax: true` — requires `import type` for type-only imports
- `noUnusedLocals: false`, `noUnusedParameters: false` — unused identifiers are not flagged
- Target: `ESNext`; Module: `Preserve` (Bun bundler mode)

## Import Organization

**Order (observed):**
1. Third-party SDK imports (`groq-sdk`, `@cerebras/cerebras_cloud_sdk`)
2. Internal type imports from `../types`

**Style:**
- `import type { ... }` used for type-only imports in `services/cerebras.ts` — consistent with `verbatimModuleSyntax: true`
- Value imports use plain `import { ... }` in `services/groq.ts` (types imported as values — diverges from verbatimModuleSyntax requirement)
- Relative paths only; no path aliases configured

**Correct pattern (enforce `verbatimModuleSyntax`):**
```typescript
// types-only import — must use `import type`
import type { AIService, ChatMessage } from '../types';

// value import
import { Groq } from 'groq-sdk';
```

## Error Handling

**Patterns:**
- No explicit error handling in any source file — all async operations are un-wrapped (`await` with no try/catch)
- Errors propagate naturally to `Bun.serve()`'s unhandled rejection path
- The `refactor.md` spec requires OpenAI-style error responses and upstream status code mapping, but this is not yet implemented
- `as any` cast used in `services/cerebras.ts` line 11 to bypass type mismatch — suppresses TypeScript errors on the `messages` argument

**Required pattern per spec (not yet implemented):**
```typescript
// Should wrap provider calls with structured error handling
try {
  const result = await provider.chat(messages);
  return result;
} catch (err) {
  return new Response(JSON.stringify({ error: { message: "...", type: "...", code: 500 } }), { status: 500 });
}
```

## Logging

**Framework:** `console.log` (native)

**Patterns:**
- Single log per request in `index.ts`: `console.log(`Using service: ${service?.name}`)`
- Template literals used for interpolation
- No structured logging, no request IDs, no timestamps
- `refactor.md` spec requires structured metadata logging (request ID, provider, latency, status code, etc.) — not yet implemented

## Comments

**When to Comment:**
- Inline comments in Spanish for business context: `// healthcheck para EasyPanel / reverse proxies` (`index.ts` line 26)
- No JSDoc or TSDoc present anywhere in the codebase
- Section comments used only where intent might be unclear

**Language note:** Comments mix Spanish and English — standardize to English for consistency.

## Function Design

**Size:** Functions are small and focused (< 20 lines each)

**Parameters:**
- `chat(messages: ChatMessage[])` — typed array parameter
- `getNextService()` — no parameters, accesses module-level state

**Return Values:**
- `chat()` returns `Promise<AsyncIterable<string>>` per the `AIService` interface
- Async generator pattern used via IIFE: `(async function* () { ... })()`
- Note: `services/cerebras.ts` returns the generator function itself (not the invoked result), diverging from the interface contract — this is a bug

**Module-Level State:**
- `currentServiceIndex` in `index.ts` is mutable module-level state managing round-robin routing
- Services (Groq client, Cerebras client) are instantiated once at module load as module-level singletons

## Module Design

**Exports:**
- Named exports only: `export const groqService`, `export const cerebrasService`
- No default exports

**Barrel Files:** Not used — services imported directly by path in `index.ts`

**Interface Contract (`types.ts`):**
```typescript
export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface AIService {
    name: string;
    chat: (messages: ChatMessage[]) => Promise<AsyncIterable<string>>;
}
```
All services must implement `AIService`. The `chat` method must return a `Promise` resolving to an `AsyncIterable<string>`.

## Bun-Specific Conventions

Per `CLAUDE.md`:
- Use `Bun.serve()` for HTTP — no Express
- Use `bun:sqlite` for SQLite — no `better-sqlite3`
- Use `Bun.redis` for Redis — no `ioredis`
- Use `Bun.sql` for Postgres — no `pg`
- Use `Bun.file` over `node:fs` readFile/writeFile
- Bun auto-loads `.env` — do not use `dotenv`
- Use `bun test` — not Jest or Vitest
- Use `bun build` — not webpack or esbuild

---

*Convention analysis: 2026-06-04*
