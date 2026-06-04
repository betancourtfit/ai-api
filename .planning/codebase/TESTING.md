# Testing Patterns

**Analysis Date:** 2026-06-04

## Test Framework

**Runner:**
- Bun's built-in test runner (`bun test`)
- No separate test framework installed; `bun:test` is the native module
- No config file (`jest.config.*`, `vitest.config.*`) — Bun discovers tests automatically by filename pattern

**Assertion Library:**
- `bun:test` built-in (`expect`, `test`, `describe`, `beforeEach`, `afterEach`, `mock`)

**Run Commands:**
```bash
bun test                    # Run all tests
bun test --watch            # Watch mode
bun test --coverage         # Coverage report
bun test <path/to/file>     # Run specific test file
```

## Test File Organization

**Current State:** No test files exist in the repository at this time.

**Location (per `refactor.md` spec):**
- Unit tests: `tests/unit/`
- Integration tests: `tests/integration/`

**Naming convention (Bun convention):**
- `*.test.ts` — preferred
- `*.spec.ts` — also discovered by Bun

**Structure (per spec):**
```
tests/
  unit/
    routing/
    providers/
    services/
  integration/
```

## Test Structure

**Suite Organization (Bun pattern to follow):**
```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("GroqService", () => {
  beforeEach(() => {
    // reset state or mocks
  });

  test("returns AsyncIterable<string> from chat()", async () => {
    // arrange
    // act
    // assert
    expect(result).toBeDefined();
  });
});
```

**Patterns:**
- `describe` blocks group by module or behavior
- `beforeEach` for per-test state reset (especially important for the mutable `currentServiceIndex` in `index.ts`)
- `test` (or `it`) for individual assertions
- Async tests use `async/await` naturally

## Mocking

**Framework:** `bun:test` built-in `mock()` and `spyOn()`

**Patterns:**
```typescript
import { mock, spyOn } from "bun:test";

// Mock an entire module
const mockGroq = mock(() => ({
  chat: {
    completions: {
      create: mock(async () => ({ choices: [] })),
    },
  },
}));

// Spy on a method
const spy = spyOn(groqService, "chat");
```

**What to Mock:**
- Groq SDK client (`groq-sdk`) — avoid real network calls in unit tests
- Cerebras SDK client (`@cerebras/cerebras_cloud_sdk`) — same reason
- `process.env` values for configuration testing
- Provider responses (429s, 500s, streaming chunks) to test routing and cooldown logic

**What NOT to Mock:**
- `types.ts` interfaces — use real implementations
- The `AIService` interface contract — verify real conformance
- Internal routing logic under unit test — test it directly

## Fixtures and Factories

**Test Data (to be established):**
```typescript
// Suggested factory pattern for ChatMessage arrays
function makeMessages(overrides?: Partial<ChatMessage>[]): ChatMessage[] {
  return overrides ?? [
    { role: "user", content: "Hello" }
  ];
}

// Suggested mock streaming response
async function* mockStreamChunks(chunks: string[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}
```

**Location:** Place in `tests/unit/fixtures/` or co-locate as helpers within test files for small suites.

## Coverage

**Requirements:** None enforced currently — no coverage threshold configured

**View Coverage:**
```bash
bun test --coverage
```

## Test Types

**Unit Tests:**
- Scope: Individual functions and service objects in isolation
- Target modules: `services/groq.ts`, `services/cerebras.ts`, routing logic in `index.ts` (once extracted to a module)
- SDK clients must be mocked

**Integration Tests:**
- Scope: Full HTTP request/response cycle through `Bun.serve()`
- Test using `fetch()` against a locally started server instance
- Verify SSE streaming output, round-robin alternation, health endpoints
- Per `refactor.md` acceptance criteria: must cover alternating routing, cooldown, recovery, timeouts, invalid config, provider failure, both-provider exhaustion

**E2E Tests:** Not specified — out of scope for MVP per `refactor.md`

## Common Patterns

**Async Testing:**
```typescript
test("streams content from chat()", async () => {
  const messages = [{ role: "user" as const, content: "hello" }];
  const stream = await groqService.chat(messages);
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  expect(chunks.length).toBeGreaterThan(0);
});
```

**Error Testing:**
```typescript
test("returns 404 for unknown route", async () => {
  const res = await fetch("http://localhost:3000/unknown");
  expect(res.status).toBe(404);
});

test("returns 401 when Authorization header is missing", async () => {
  const res = await fetch("http://localhost:3000/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-oss-120b-balanced", messages: [] }),
  });
  expect(res.status).toBe(401);
});
```

**Streaming Test Pattern:**
```typescript
test("streams SSE chunks", async () => {
  const res = await fetch("http://localhost:3000/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  // consume body as stream
  const reader = res.body!.getReader();
  const { done, value } = await reader.read();
  expect(done).toBe(false);
  expect(value).toBeDefined();
});
```

## Priority Test Areas (from `refactor.md` acceptance criteria)

The following behaviors must be covered by automated tests before expanding scope:

1. Consecutive requests alternate providers (round-robin)
2. A provider `429` removes it from rotation temporarily
3. Provider returns to rotation after cooldown expires
4. Requests continue through alternate provider during cooldown
5. OpenAI-style error returned when no eligible provider exists
6. Upstream provider API keys never appear in responses
7. Invalid downstream credentials return `401`
8. Unknown model aliases return `400`
9. Streaming works without buffering for both providers
10. Streaming requests are not replayed after partial output is sent
11. Unsupported request fields are rejected before reaching providers
12. Structured logs record provider selection without secrets
13. `GET /ready` returns degraded mode correctly

---

*Testing analysis: 2026-06-04*
