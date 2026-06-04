# Codebase Concerns

**Analysis Date:** 2026-06-04

## Tech Debt

**Implementation vs. Design Spec Mismatch:**
- Issue: `refactor.md` defines a complete OpenAI-compatible proxy spec (25+ sections) with auth, routing, rate-limit handling, model registry, `/v1/chat/completions`, `/v1/models`, `/ready`, structured logging, and more. The current implementation in `index.ts` is a minimal prototype at `/chat` with no auth and no OpenAI compatibility.
- Files: `index.ts`, `refactor.md`
- Impact: The codebase is not production-ready by the spec's own acceptance criteria. None of the 20 acceptance criteria in `refactor.md` section 22 are currently met.
- Fix approach: Implement the architecture outlined in `refactor.md` section 21, building modules under `src/routes/`, `src/routing/`, `src/providers/`, `src/middleware/`, and `src/services/`.

**Hardcoded Model IDs in Services:**
- Issue: Model identifiers are hardcoded directly inside service files — `"moonshotai/kimi-k2-instruct-0905"` in `services/groq.ts` and `"qwen-3-32b"` in `services/cerebras.ts`. There is no logical model registry or alias system.
- Files: `services/groq.ts` (line 11), `services/cerebras.ts` (line 12)
- Impact: Model changes require code edits and redeployment; clients cannot use stable logical aliases; different models are used per provider with no documented equivalence.
- Fix approach: Implement the model registry from `refactor.md` section 8 using `MODEL_REGISTRY_JSON` env var or a config module.

**Duplicate/Redundant Cerebras Dependency:**
- Issue: `package.json` lists both `@cerebras/cerebras_cloud_sdk` (^1.59.0) and `cerebras` (^1.2.7). Only `@cerebras/cerebras_cloud_sdk` is imported in `services/cerebras.ts`. The `cerebras` package is unused dead weight.
- Files: `package.json` (lines 18-19), `services/cerebras.ts`
- Impact: Unnecessary install size; potential confusion about which SDK is canonical.
- Fix approach: Remove the unused `cerebras` package with `bun remove cerebras`.

**Committed `dist/` Build Artifact:**
- Issue: The compiled output file `dist/index.js` is committed to the repository. The `.gitignore` lists `dist` as an ignored path, but the file is tracked in git anyway (it appears in the file listing).
- Files: `dist/index.js`, `.gitignore` (line 4)
- Impact: Repository bloat; stale artifacts can mislead future contributors; source-of-truth confusion between `index.ts` and `dist/index.js`.
- Fix approach: Run `git rm --cached dist/index.js` and confirm `.gitignore` takes effect.

**Non-standard Endpoint Path:**
- Issue: The chat endpoint is exposed at `POST /chat` instead of the OpenAI-compatible `POST /v1/chat/completions`. Clients expecting OpenAI compatibility cannot drop in the proxy without code changes.
- Files: `index.ts` (line 30)
- Impact: Incompatible with OpenAI SDK `base_url` substitution, which is the stated design goal in `refactor.md` section 1.
- Fix approach: Change route path to `/v1/chat/completions` and implement full OpenAI request/response contract.

**Round-Robin Without Eligibility or Cooldown:**
- Issue: `getNextService()` cycles blindly between all services regardless of provider health, rate-limit state, or whether either service errored. There is no stateful provider tracking.
- Files: `index.ts` (lines 10-16)
- Impact: If one provider hits a 429 or fails, the router will continue sending every other request to it indefinitely. The `refactor.md` spec (section 12) requires stateful round-robin with cooldown windows.
- Fix approach: Implement `ProviderState` tracking and eligibility checks as described in `refactor.md` sections 12 and 13.

## Security Considerations

**No Downstream Authentication:**
- Risk: The API has zero authentication. Any client with network access can send requests and consume upstream API quota (Groq and Cerebras keys).
- Files: `index.ts`
- Current mitigation: None.
- Recommendations: Implement Bearer token auth middleware checking `PERSONAL_PROXY_API_KEY` env var before routing any request. Return HTTP 401 on missing/invalid credentials. Use constant-time comparison to prevent timing attacks, as described in `refactor.md` section 6.

**API Keys Initialized Without Validation:**
- Risk: `new Groq()` and `new Cerebras()` read API keys from the environment at module load time. If the env var is absent, the SDK may throw at request time with an opaque error rather than failing fast with a clear message at startup.
- Files: `services/groq.ts` (line 4), `services/cerebras.ts` (line 5)
- Current mitigation: None.
- Recommendations: Add a startup configuration validator that checks for required env vars (`GROQ_API_KEY`, `CEREBRAS_API_KEY`) and exits with a descriptive error if missing.

**No Request Body Size Limit:**
- Risk: Arbitrarily large POST bodies can be sent to `/chat`. No size cap is enforced, risking memory exhaustion under adversarial input.
- Files: `index.ts` (line 31)
- Current mitigation: None.
- Recommendations: Enforce `MAX_REQUEST_BODY_BYTES` (default 1 MB) before parsing. `Bun.serve()` does not impose a body limit by default.

**No Input Validation on `/chat`:**
- Risk: The `messages` field is parsed with a bare `as { messages: ChatMessage[] }` cast and passed directly to upstream SDKs without structural validation. Malformed payloads can produce confusing upstream errors or unexpected behavior.
- Files: `index.ts` (line 31)
- Current mitigation: TypeScript cast only — no runtime validation.
- Recommendations: Validate `messages` array shape, role values, and content types before forwarding. Reject unsupported OpenAI fields explicitly rather than silently passing them.

**Provider Keys Potentially Leaked in Error Responses:**
- Risk: Unhandled exceptions in `service?.chat(messages)` propagate as uncontrolled 500 errors. SDK error objects may include provider URLs or headers that reveal configuration details.
- Files: `index.ts` (lines 34-43)
- Current mitigation: No try/catch around the chat call or stream creation.
- Recommendations: Wrap the service call in try/catch, log internal error details server-side only, and return a sanitized OpenAI-style error response to the client.

## Known Bugs

**Cerebras Service Returns Function Instead of AsyncIterable:**
- Symptoms: `cerebrasService.chat()` returns `(async function* () {...})` — the generator function itself — rather than calling it and returning the resulting async iterable. The groq service correctly invokes the IIFE with `()` at the end.
- Files: `services/cerebras.ts` (lines 18-22)
- Trigger: Every request routed to the Cerebras service. `new Response(stream, ...)` in `index.ts` receives a function reference, not an iterable, and will fail or return an empty body.
- Workaround: None in current code. Fix: add `()` to invoke the generator — `return (async function* () { ... })();`

**Unhandled Promise Rejection on Service Error:**
- Symptoms: If `service?.chat(messages)` throws (network error, invalid API key, rate limit), the error propagates as an unhandled rejection since there is no try/catch around the await. The server will log the error but the client receives no structured response.
- Files: `index.ts` (line 34)
- Trigger: Any upstream provider error.
- Workaround: None. Fix: wrap in try/catch and return an appropriate HTTP error response.

**Optional Chaining Masks Missing Service:**
- Symptoms: `service?.chat(messages)` and `service?.name` use optional chaining. If `services[currentServiceIndex]` is ever `undefined`, the call silently returns `undefined` and `new Response(undefined, ...)` is returned to the client — behavior is undefined.
- Files: `index.ts` (lines 33-34)
- Trigger: Would occur if `services` array is empty or index goes out of bounds (not possible with current modulo, but fragile).
- Workaround: Current modulo prevents out-of-bounds, but the type system allows `AIService | undefined` from array access under `noUncheckedIndexedAccess`. Fix: add a non-null assertion or explicit guard with a proper error response.

## Performance Bottlenecks

**No Request Timeout:**
- Problem: There is no timeout on upstream provider calls. If Groq or Cerebras is slow or hangs, the request will remain open indefinitely.
- Files: `index.ts` (line 34)
- Cause: No `AbortController` or `signal` is passed to the SDK calls.
- Improvement path: Implement `REQUEST_TIMEOUT_MS` (default 120000 ms) using `AbortSignal.timeout()` and pass it to each SDK call.

**No Streaming Abort on Client Disconnect:**
- Problem: If the downstream client disconnects mid-stream, the upstream request continues consuming provider quota and holding a connection open.
- Files: `index.ts` (lines 36-42)
- Cause: No `request.signal` is wired to the upstream stream.
- Improvement path: Pass `request.signal` to provider SDK calls so upstream is aborted when the client disconnects, as specified in `refactor.md` section 16.

## Fragile Areas

**`index.ts` — Monolithic Request Handler:**
- Files: `index.ts`
- Why fragile: All routing, service selection, and response handling are in a single `fetch()` function. Adding routes, middleware, or error handling requires modifying this one file with no separation of concerns.
- Safe modification: Extract routes into separate handler modules. Follow the `src/routes/` structure proposed in `refactor.md` section 21.
- Test coverage: Zero. No tests exist anywhere in the repository.

**Global Mutable State for Service Index:**
- Files: `index.ts` (line 10)
- Why fragile: `currentServiceIndex` is a module-level mutable variable. Under Bun's single-threaded model this is safe, but it provides no observability and cannot be reset or inspected without restarting the process.
- Safe modification: Encapsulate router state in a class or closure with explicit accessor methods to enable testability and future diagnostics endpoint support.
- Test coverage: None.

**`services/cerebras.ts` — `messages as any` Cast:**
- Files: `services/cerebras.ts` (line 11)
- Why fragile: `messages` is cast to `any` before being passed to the Cerebras SDK. This bypasses TypeScript's type checking and could silently pass incompatible message shapes to the upstream API.
- Safe modification: Use the SDK's native message type or add a mapping step that transforms `ChatMessage[]` into the SDK-expected format.
- Test coverage: None.

## Scaling Limits

**In-Memory Service State:**
- Current capacity: Single process, single instance.
- Limit: The round-robin index and any future provider cooldown state live only in memory. Restarting the process resets all state. Multiple replicas would have independent counters — no coordination.
- Scaling path: For single-instance deployment this is acceptable per `refactor.md` section 5 (which explicitly excludes distributed coordination). If multi-replica deployment is needed, shared state storage (e.g., Redis via `Bun.redis`) would be required.

## Dependencies at Risk

**`cerebras` (^1.2.7) — Unused Package:**
- Risk: Listed in `package.json` as a runtime dependency but never imported. Adds install time and surface area.
- Impact: None at runtime, but creates confusion.
- Migration plan: Remove with `bun remove cerebras`.

**`@types/bun` Pinned to `latest`:**
- Risk: Using `latest` for a devDependency means any breaking change to the type definitions will affect the next `bun install` unpredictably.
- Files: `package.json` (line 11)
- Impact: Build-time type errors could appear after unattended dependency updates.
- Migration plan: Pin to a specific version (e.g., `"@types/bun": "1.2.x"`) and upgrade deliberately.

**Dockerfile Pins Bun to `1.1.29`:**
- Risk: `oven/bun:1.1.29` is significantly behind current Bun releases. Bug fixes, performance improvements, and security patches in later versions are not available.
- Files: `Dockerfile` (line 2)
- Impact: Production container runs an outdated runtime.
- Migration plan: Update to a recent stable release tag or use `oven/bun:latest` with explicit lock via `bun.lock`.

## Missing Critical Features

**No Authentication Layer:**
- Problem: The entire API is publicly accessible with no credential check.
- Blocks: Production deployment where upstream API keys must be protected.

**No OpenAI-Compatible Endpoint (`/v1/chat/completions`):**
- Problem: The current `/chat` route is not compatible with OpenAI client libraries.
- Blocks: The primary design goal of allowing drop-in `base_url` substitution.

**No `/v1/models` Endpoint:**
- Problem: Clients cannot discover available logical model aliases.
- Blocks: OpenAI SDK compatibility.

**No `/ready` Endpoint:**
- Problem: No readiness probe to verify configuration before accepting traffic.
- Blocks: Safe deployment in container orchestration environments (EasyPanel, Kubernetes).

**No Error Handling or OpenAI-Style Error Responses:**
- Problem: Upstream errors surface as unhandled rejections; no structured error JSON is returned.
- Blocks: Clients relying on OpenAI error format for retry logic.

**No Rate-Limit Awareness or Provider Cooldown:**
- Problem: When a provider returns 429, the router continues sending requests to it.
- Blocks: Reliable operation under free-tier quota constraints.

## Test Coverage Gaps

**Zero Test Coverage:**
- What's not tested: Everything. No test files exist in the repository.
- Files: Entire codebase — `index.ts`, `services/groq.ts`, `services/cerebras.ts`
- Risk: The Cerebras generator bug (returning a function reference instead of calling it) would be caught immediately by a basic integration test. All routing, streaming, and error paths are untested.
- Priority: High — `refactor.md` section 22 acceptance criterion 20 explicitly requires automated tests covering alternating, cooldown, recovery, timeouts, invalid configuration, provider failure, and both-provider exhaustion.

---

*Concerns audit: 2026-06-04*
