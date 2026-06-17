# Phase 6: Whisper Sidecar + Models + Ready — Research

**Researched:** 2026-06-06
**Domain:** Bun-native `fetch()`/`FormData` HTTP client to whisper.cpp `whisper-server` sidecar; OpenAI-compatible `/v1/models` + `/ready` extension; bounded health probe; injectable service for tests
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Activate `HttpWhisperService` in the production entrypoint **only when `config.whisperModelAlias !== null`** (i.e., `WHISPER_MODEL_ALIAS` env var is set). When unset, keep the default `NoopWhisperService` — audio requests return 503; chat routes unaffected.
- **D-02:** Implement `HttpWhisperService` in **`whisper-service.ts`** alongside the existing `WhisperService` interface and `NoopWhisperService` stub — no separate client file.
- **D-03:** **Inline entrypoint wiring** in `import.meta.main`: pass the third `createServer()` argument explicitly — `new HttpWhisperService()` when alias is set, otherwise omit (default Noop). Do **not** move selection inside `createServer()` — preserve Phase 5 test injection via the optional third parameter.
- **D-04:** **Never block server boot** on sidecar availability. `HttpWhisperService` performs no health probe at startup. Sidecar down → 503 on transcription requests at runtime only.

### Claude's Discretion
- **`GET /v1/models` whisper alias visibility:** Append `config.whisperModelAlias` to the models list when non-null (same `owned_by: "personal-proxy"` shape as chat aliases). Do not require sidecar health to list the alias — configuration intent is enough per EP2-02 wording.
- **`GET /ready` `whisperAvailable`:** Add boolean field; probe sidecar `GET http://${whisperHost}:${whisperPort}/health` with a short timeout (reuse `whisperTimeoutMs` or a smaller dedicated cap). Set `whisperAvailable: false` when alias unset OR probe fails. **Must not change** existing `ready`, `mode`, `eligibleProviders`, or `unavailableProviders` semantics for chat (ROADMAP success criterion 2).
- **Sidecar request payload:** Forward reconstructed `FormData` with `file` (+ optional `response_format` if present). The downstream `model` alias is validated locally and **not forwarded** to whisper-server (sidecar owns its loaded model via `--model` at startup). Normalize success to `{ text: "..." }` only.
- **`HttpWhisperService` error mapping:** Network errors, timeouts, non-2xx sidecar responses → throw from `transcribe()` so the existing route try/catch returns OpenAI-shaped 503 (WHSP-03). Never log file content, filename, or transcript text (AUTH2-02).
- **Tests:** Keep all existing TEST2-xx on mock `WhisperService`. Add focused tests for `HttpWhisperService` with mocked `fetch` if needed. Live curl smoke against a running sidecar is manual/UAT — do not gate `bun test` on a real whisper binary.

### Deferred Ideas (OUT OF SCOPE)
None. Per CONTEXT.md, discussion stayed within phase scope; undiscussed gray areas were deferred to planner discretion with research-backed defaults above. Out-of-phase items (per `<domain>`): verbose_json/text/srt/vtt formats, language/temperature/prompt forwarding, subprocess spawning, sidecar lifecycle management, new routes.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EP2-02 | User can GET `/v1/models` and see the whisper alias when whisper-server is configured | Append `{ id: config.whisperModelAlias, object: 'model', created: 0, owned_by: 'personal-proxy' }` to the existing `listAliases().map(...)` array in `index.ts` (~line 280) when `config.whisperModelAlias !== null`. "Configured" = alias env set, not sidecar health. |
| EP2-03 | User can GET `/ready` and see a `whisperAvailable` boolean field reflecting sidecar health | Add `whisperAvailable` to the `/ready` JSON via `await whisperService.health()` (new interface method). Bounded ~2 s probe of `GET /health`. Additive field only — `ready`/`mode`/`eligibleProviders`/`unavailableProviders` unchanged. |
| WHSP-01 | Proxy forwards validated transcription request to local whisper-server via HTTP fetch | `HttpWhisperService.transcribe()` reconstructs `FormData` (`file` + `response_format=json`) and `fetch()`es `http://host:port/inference` (whisper.cpp native default path). Verified request shape against whisper.cpp `server.cpp` master. |
| WHSP-02 | Whisper model alias configured via `WHISPER_MODEL_ALIAS` env var; maps to sidecar model | Alias already loaded as `config.whisperModelAlias` (Phase 4). Alias is validated locally (Phase 5 route check) and **not forwarded** — sidecar owns its model via `--model` startup flag. |
| WHSP-03 | When whisper-server is unreachable, proxy returns OpenAI-shaped 503; chat completions remain unaffected | `transcribe()` throws on network error / timeout / non-2xx; existing route `try/catch` (index.ts ~line 244) returns OpenAI-shaped 503. Chat path is fully independent of `whisperService`. |
</phase_requirements>

---

## Summary

Phase 6 is the smallest of the audio milestone phases: it replaces the production `NoopWhisperService` with a real `HttpWhisperService` and surfaces two read-only signals (`/v1/models` alias, `/ready` `whisperAvailable`). Every consumer seam already exists from Phases 4–5 — the route handler, the injectable third `createServer()` parameter, the `config.whisper*` fields, the `listAliases()` pattern, and the `openaiError()` 503 path. No route logic changes; the audio route at `index.ts` ~line 173 calls `whisperService.transcribe()` and already maps any throw to a 503.

The one external unknown — the whisper.cpp `whisper-server` HTTP contract — is now **verified against the upstream `examples/server/server.cpp` (master branch)**. The native transcription endpoint is `POST /inference` (multipart `file` + optional `response_format`/`temperature`), the default JSON response body is exactly `{ "text": "..." }` (no normalization needed beyond reading `.text`), and there is a real `GET /health` handler that returns `{"status":"ok"}` with HTTP 200 when the model is loaded and HTTP 503 `{"status":"loading model"}` while loading. This corrects a latent assumption in `STACK.md`/CONTEXT.md that the proxy should call `/v1/audio/transcriptions` on the sidecar — that path only exists if the operator passes `--inference-path /v1/audio/transcriptions`. The lowest-friction default is to call the native `/inference`.

Zero new npm packages. The implementation uses Bun-native `fetch()`, `FormData`, and `AbortSignal.timeout()`. Two small, defensible design choices are recommended below: (1) add a `health(): Promise<boolean>` method to the `WhisperService` interface so `/ready` stays injectable and unit-testable, and (2) give `HttpWhisperService` a constructor that accepts host/port/path/timeout overrides (defaulting to `config`) so a test can point it at an in-process fake sidecar instead of mocking the `fetch` global.

**Primary recommendation:** In `whisper-service.ts`, add `health()` to `WhisperService`, implement `NoopWhisperService.health()` (returns `false`), and add `HttpWhisperService` (constructor-injectable host/port/path/timeout; `transcribe()` → `POST /inference`; `health()` → bounded `GET /health`). In `index.ts`, append the whisper alias to `/v1/models`, add `whisperAvailable: await whisperService.health()` to `/ready`, and select `HttpWhisperService` vs `NoopWhisperService` inline in `import.meta.main` based on `config.whisperModelAlias`. Add focused `HttpWhisperService` tests against a fake Bun.serve sidecar, plus a `health` mock on the existing integration mock for `/ready` coverage.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP call to sidecar `/inference` | Service layer (`whisper-service.ts` → `HttpWhisperService`) | — | Encapsulates all sidecar wire knowledge (path, FormData shape, response parsing) behind the `WhisperService` interface; route handler stays sidecar-agnostic |
| Sidecar `/health` probe | Service layer (`HttpWhisperService.health()`) | HTTP handler (`/ready` calls it) | Probe logic (URL, timeout, error→false) belongs with the client; `/ready` only consumes the boolean |
| Whisper alias in `/v1/models` | HTTP handler (`index.ts`) | Config (`config.whisperModelAlias`) | Models list is assembled in the handler; alias visibility is a pure config read, no sidecar dependency |
| `whisperAvailable` in `/ready` | HTTP handler (`index.ts`) | Service layer (`health()`) | Field is additive to the existing `/ready` JSON; chat readiness math is untouched |
| Production service selection | Entrypoint (`import.meta.main`) | Config (`config.whisperModelAlias`) | D-01/D-03: selection is inline at boot, not inside `createServer()`, to preserve the test injection seam |
| Error → 503 mapping | HTTP handler (existing route `try/catch`) | Service layer (throws) | WHSP-03: any throw from `transcribe()` is already converted to OpenAI-shaped 503 by Phase 5 code — no change needed |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun (runtime) | 1.3.11 (local) / 1.1.29 (Docker) | `fetch()`, `FormData`, `AbortSignal.timeout()`, `Bun.serve()` | Built-in Web APIs; identical pattern to existing upstream provider calls |
| `bun:test` | built-in | `HttpWhisperService` tests + `health` mock; fake sidecar via `Bun.serve(0)` | Already used by all existing tests |

**No new packages.** Zero `bun install` calls in Phase 6 (ROADMAP success criterion 4). [VERIFIED: codebase — `whisper-service.ts` currently imports only `./types`; all networking primitives are Bun globals]

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Bun-native `fetch()` | `node:http`/`undici` | Forbidden by constraints + zero benefit; `fetch()` already mirrors the Cerebras/Groq adapter pattern |
| `AbortSignal.timeout(ms)` | manual `AbortController` + `setTimeout` | `AbortSignal.timeout()` is a one-liner, auto-clears, and is supported in Bun; manual timers risk leaks |

**No installation step.** Verify before writing the implementation:
```bash
bun --version            # confirm AbortSignal.timeout availability (Bun >= 1.0)
```

---

## Package Legitimacy Audit

No new packages are installed in this phase. All primitives (`fetch`, `FormData`, `AbortSignal`, `Bun.serve`) are Bun runtime globals already present.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## whisper-server HTTP Contract (VERIFIED against upstream source)

All claims below verified by reading `examples/server/server.cpp` on the whisper.cpp `master` branch.

| Aspect | Value | Source |
|--------|-------|--------|
| Default transcription endpoint | `POST /inference` | `std::string inference_path = "/inference";` (server.cpp:62); remappable via `--inference-path` (server.cpp:255) |
| Transcription request | `multipart/form-data` with `file` (required), `response_format`, `temperature`, `temperature_inc` (all optional) | `req.has_file("response_format")` / `req.get_file_value(...)` (server.cpp:576-578); curl example (server.cpp:763-769) |
| Default response_format | `json` | `std::string response_format = json_format;` (server.cpp:117) |
| Default JSON response body | `{ "text": "<transcript>" }` | `json jres = json{ {"text", results} };` (server.cpp:1154-1158) |
| Model-load endpoint | `POST /load` (multipart `model`) | server.cpp:1161 — **not used by the proxy** (sidecar loads model via `--model` flag) |
| Health endpoint | `GET /health` | server.cpp:1204 |
| Health success | HTTP 200, `{"status":"ok"}` (when `SERVER_STATE_READY`) | server.cpp:1206-1208 |
| Health while loading | HTTP 503, `{"status":"loading model"}` | server.cpp:1209-1212 |

[VERIFIED: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/server/server.cpp — read in full this session]
[CITED: https://github.com/ggml-org/whisper.cpp/tree/master/examples/server — README curl examples confirm `/inference` + `/load`]

**Two critical consequences:**
1. **`/health` is NOT under `--inference-path`.** It is registered as `request_path + "/health"` (server.cpp:1204), independent of the inference path remap. With the default empty `request_path`, the readiness probe URL is always `http://host:port/health` regardless of how the operator configured the inference endpoint. The `r.ok` boolean check naturally handles the loading-state 503 (returns `false`).
2. **The default JSON body already matches OpenAI's `{ "text": ... }` shape.** `transcribe()` needs only `body.text` — no field stripping, no model rewrite. (whisper-server never emits provider reasoning fields, so the "no reasoning fields" rule is satisfied trivially.)

---

## Decision 1 — Which sidecar path should `transcribe()` call?

**Important decision — two alternatives evaluated.**

**Option A — Call the native default `/inference` (RECOMMENDED).**
- *Advantages:* Works against an out-of-the-box `whisper-server --model X` with no extra flags; matches the verified upstream default; least operator friction; no new env var.
- *Disadvantages:* If an operator deliberately started the sidecar with `--inference-path /v1/audio/transcriptions`, the proxy must be told. Mitigated by the constructor override (below).

**Option B — Call `/v1/audio/transcriptions` (the assumption in STACK.md/CONTEXT.md integration note).**
- *Advantages:* "OpenAI-looking" sidecar URL; matches the example startup command in `STACK.md`.
- *Disadvantages:* Requires the operator to **always** pass `--inference-path /v1/audio/transcriptions`; a default `whisper-server` launch returns 404 and every transcription silently becomes a 503. Higher setup-mismatch risk.

**Chosen: Option A**, implemented so the path is a constructor option defaulting to `/inference`. This honours "smallest reliable implementation," requires no new config var (keeping the phase tight), and the constructor override doubles as the test seam. Document in the README/UAT that operators who remap `--inference-path` must construct `HttpWhisperService({ inferencePath })` (or, if later desired, a `WHISPER_INFERENCE_PATH` env var can be added — explicitly out of scope for this phase).

[ASSUMED] Most personal-proxy operators will run the sidecar with defaults. Risk if wrong: a remapped sidecar returns 404→503 until the path is overridden. Low — surfaced immediately by the curl smoke test (ROADMAP criterion 3).

## Decision 2 — How should `/ready` learn sidecar health?

**Important decision — two alternatives evaluated.**

**Option A — Add `health(): Promise<boolean>` to the `WhisperService` interface (RECOMMENDED).**
- *Advantages:* `/ready` stays injectable — tests pass a mock whose `health` is scriptable, so EP2-03 is unit-testable for both `true` and `false`; sidecar URL/timeout knowledge stays in the service; symmetrical with `transcribe()`.
- *Disadvantages:* Interface change ripples to `NoopWhisperService` and the integration test mock (both gain a trivial `health`). Small, contained.

**Option B — Inline a raw `fetch('/health')` directly in the `/ready` handler.**
- *Advantages:* No interface change.
- *Disadvantages:* `/ready` can no longer be tested with the injected mock — the inline fetch hits the real `config.whisperHost:Port`, so the test `audioServer` would always report `whisperAvailable: false`, making EP2-03's positive case untestable without a live binary. Also duplicates host/port/timeout logic outside the service.

**Chosen: Option A.** The interface gains one method; `NoopWhisperService.health()` returns `false`; `HttpWhisperService.health()` does the bounded probe. The `/ready` handler (already has `whisperService` in scope via the `createServer` parameter) calls `await whisperService.health()`.

## Decision 3 — Health-probe timeout

`/ready` must stay fast and must not block on the sidecar (CONTEXT discretion + general readiness semantics). `config.whisperTimeoutMs` defaults to **30 000 ms** — far too long for a liveness probe. Use a **small dedicated cap (~2 000 ms)**, a constructor-overridable constant inside `HttpWhisperService`. A slow/hung sidecar then yields `whisperAvailable: false` within ~2 s instead of stalling `/ready` for 30 s. The chat readiness fields are computed synchronously and are unaffected by the probe outcome.

---

## Architecture Patterns

### System Architecture Diagram

```
                          GET /v1/models  ─────────────► listAliases().map(...) + (whisperModelAlias ? whisper alias : [])
                                                              │  (no sidecar call — config intent only, EP2-02)
Downstream client ──────► createServer(adapters, port, whisperService, audioMaxFileBytes)
   (Bearer KEY)                │
                               ├─ GET /ready ───► chat readiness (unchanged: ready/mode/eligible/unavailable)
                               │                      + whisperAvailable = await whisperService.health()  (EP2-03)
                               │                                                      │
                               │                                          bounded ~2s GET /health
                               │                                                      ▼
                               └─ POST /v1/audio/transcriptions (Phase 5 route, unchanged)
                                       │  validate → size → alias check
                                       ▼
                                  whisperService.transcribe(file, alias)
                                       │  (HttpWhisperService)
                                       │   reconstruct FormData {file, response_format:json}
                                       │   fetch POST http://host:port/inference  (AbortSignal.timeout)
                                       ▼
                              ┌────────────────────────┐        network err / timeout / !res.ok
                              │  whisper-server sidecar │ ──────────────────► throw ──► route try/catch ──► 503 (WHSP-03)
                              │  /inference  /health    │
                              └────────────────────────┘
                                       │ 200 { "text": "..." }
                                       ▼
                                  { text: body.text }  ──► route returns 200 { "text": "..." } (AUDIO-06)
```

File-to-implementation mapping: `whisper-service.ts` (new `HttpWhisperService` + `health()` on interface), `index.ts` (`/v1/models` append, `/ready` field, `import.meta.main` selection). No new files.

### Recommended Project Structure
No new files or directories. Modified files only:
```
(root)/
├── whisper-service.ts   # MODIFIED — add health() to interface; NoopWhisperService.health(); new HttpWhisperService
├── index.ts             # MODIFIED — /v1/models alias append; /ready whisperAvailable; import.meta.main selection
└── tests/
    └── integration/
        └── server.test.ts   # MODIFIED — add health mock to MockWhisperService; /ready whisperAvailable tests
    └── unit/ or services/
        └── http-whisper-service.test.ts   # NEW (optional but recommended) — HttpWhisperService vs fake Bun.serve sidecar
```

### Pattern 1: `WhisperService` interface + `HttpWhisperService`

```typescript
// whisper-service.ts — MODIFIED
import type { AudioTranscriptionResult } from './types';
import { config } from './config';

export interface WhisperService {
    transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>;
    // NEW — bounded liveness probe for GET /ready (EP2-03). Never throws.
    health(): Promise<boolean>;
}

export class NoopWhisperService implements WhisperService {
    async transcribe(_file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        throw new Error('WhisperService not configured. Set WHISPER_MODEL_ALIAS.');
    }
    async health(): Promise<boolean> {
        return false; // not configured → never available
    }
}

interface HttpWhisperOptions {
    host?: string;          // default config.whisperHost
    port?: number;          // default config.whisperPort
    inferencePath?: string; // default '/inference' (whisper.cpp native default — Decision 1)
    timeoutMs?: number;     // default config.whisperTimeoutMs (transcription)
    healthTimeoutMs?: number; // default 2000 (Decision 3)
}

export class HttpWhisperService implements WhisperService {
    private readonly baseUrl: string;
    private readonly inferencePath: string;
    private readonly timeoutMs: number;
    private readonly healthTimeoutMs: number;

    constructor(opts: HttpWhisperOptions = {}) {
        const host = opts.host ?? config.whisperHost;
        const port = opts.port ?? config.whisperPort;
        this.baseUrl = `http://${host}:${port}`;
        this.inferencePath = opts.inferencePath ?? '/inference';
        this.timeoutMs = opts.timeoutMs ?? config.whisperTimeoutMs;
        this.healthTimeoutMs = opts.healthTimeoutMs ?? 2000;
    }

    // WHSP-01 / WHSP-03 — model alias is NOT forwarded (sidecar owns its --model)
    async transcribe(file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        const form = new FormData();
        // forward bytes only; filename is generic — never derived for logging (AUTH2-02)
        form.append('file', file, 'audio');
        form.append('response_format', 'json');

        const res = await fetch(`${this.baseUrl}${this.inferencePath}`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            // status only — no body, no transcript, no filename in the message (AUTH2-02)
            throw new Error(`whisper-server responded ${res.status}`);
        }
        const body = (await res.json()) as { text?: string };
        return { text: body.text ?? '' };
    }

    // EP2-03 — bounded, swallow all errors → false
    async health(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/health`, {
                signal: AbortSignal.timeout(this.healthTimeoutMs),
            });
            return res.ok; // 503 'loading model' → r.ok false → not available
        } catch {
            return false;
        }
    }
}
```

[VERIFIED: codebase — `config.whisperHost/Port/TimeoutMs/ModelAlias` exist (config.ts:62-66); `AudioTranscriptionResult = { text: string }` (types.ts:58-60)]
[ASSUMED] `AbortSignal.timeout(ms)` is available in the deployed Bun (1.1.29 Docker / 1.3.11 local). It is a Web standard supported by Bun; verify with a one-line probe during Wave 0. Fallback: `AbortController` + `setTimeout(() => ctrl.abort(), ms)` cleared in a `finally`.

### Pattern 2: `/v1/models` alias append (EP2-02)

```typescript
// index.ts ~line 276-289 — extend the data array
if (request.method === 'GET' && pathname === '/v1/models') {
    const data = listAliases().map((id) => ({
        id, object: 'model', created: 0, owned_by: 'personal-proxy',
    }));
    // EP2-02: surface whisper alias when configured (no sidecar health gate)
    if (config.whisperModelAlias !== null) {
        data.push({
            id: config.whisperModelAlias,
            object: 'model', created: 0, owned_by: 'personal-proxy',
        });
    }
    return withRequestId(new Response(
        JSON.stringify({ object: 'list', data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
}
```

Note: `/v1/models` sits **after** the auth gate (index.ts:156), so listing requires a valid Bearer token — unchanged behaviour. [VERIFIED: index.ts:276 is below the auth block at :156]

### Pattern 3: `/ready` `whisperAvailable` (EP2-03)

```typescript
// index.ts ~line 133-154 — additive field ONLY; chat math untouched
if (request.method === 'GET' && pathname === '/ready') {
    const logicalModel = listAliases()[0] ?? '';
    const proxyKeyConfigured = Boolean(config.personalProxyApiKey);
    const eligibleProviders = (['cerebras', 'groq'] as Provider[]).filter((p) => isEligible(p, logicalModel));
    const unavailableProviders = (['cerebras', 'groq'] as Provider[]).filter((p) => !eligibleProviders.includes(p));
    const ready = proxyKeyConfigured && eligibleProviders.length > 0;
    const mode = !proxyKeyConfigured ? 'not_configured'
        : unavailableProviders.length === 0 ? 'ok' : 'degraded';

    // EP2-03: bounded probe; never affects ready/mode/status
    const whisperAvailable = await whisperService.health();

    return withRequestId(new Response(
        JSON.stringify({ ready, mode, eligibleProviders, unavailableProviders, whisperAvailable }),
        { status: ready ? 200 : 503, headers: { 'Content-Type': 'application/json' } },
    ));
}
```

`/ready` is **above** the auth gate and must remain unauthenticated. `whisperService` is in scope (a `createServer` parameter). The HTTP `status` is still driven solely by chat `ready`. [VERIFIED: index.ts:133 precedes auth gate at :156; `whisperService` param at :107]

### Pattern 4: Inline production selection (D-01 / D-03)

```typescript
// index.ts ~line 786 — import.meta.main
import { NoopWhisperService, HttpWhisperService } from './whisper-service';
// ...
if (import.meta.main) {
    const whisperService = config.whisperModelAlias !== null
        ? new HttpWhisperService()        // alias set → real sidecar client
        : new NoopWhisperService();        // unset → 503 on audio, chat unaffected
    const server = createServer(
        { cerebras: cerebrasAdapter, groq: groqAdapter },
        config.port,
        whisperService,
    );
    console.log(`Server is running on ${server.url}`);
}
```

Selection lives at the entrypoint only; `createServer()`'s signature and default (`NoopWhisperService`) are untouched, so all existing tests keep passing. [VERIFIED: createServer signature index.ts:104-109; current entrypoint index.ts:786-789]

### Pattern 5: Fake sidecar for `HttpWhisperService` tests

```typescript
// tests/.../http-whisper-service.test.ts — no fetch mocking; real in-process sidecar
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HttpWhisperService } from '../../whisper-service';

let sidecar: ReturnType<typeof Bun.serve>;
let svc: HttpWhisperService;

beforeAll(() => {
    sidecar = Bun.serve({
        port: 0,
        async fetch(req) {
            const { pathname } = new URL(req.url);
            if (pathname === '/health') return Response.json({ status: 'ok' });
            if (pathname === '/inference') return Response.json({ text: 'hello world' });
            return new Response('not found', { status: 404 });
        },
    });
    svc = new HttpWhisperService({ host: '127.0.0.1', port: sidecar.port });
});
afterAll(() => sidecar.stop(true));

test('transcribe returns { text } from sidecar json', async () => {
    const out = await svc.transcribe(new File(['x'], 'a'), 'whisper-1');
    expect(out).toEqual({ text: 'hello world' });
});
test('health true when /health 200', async () => {
    expect(await svc.health()).toBe(true);
});
test('transcribe throws on non-2xx → 503 path', async () => {
    const bad = new HttpWhisperService({ host: '127.0.0.1', port: sidecar.port, inferencePath: '/missing' });
    await expect(bad.transcribe(new File(['x'], 'a'), 'whisper-1')).rejects.toThrow();
});
test('health false when sidecar unreachable', async () => {
    const dead = new HttpWhisperService({ host: '127.0.0.1', port: 1, healthTimeoutMs: 300 });
    expect(await dead.health()).toBe(false);
});
```

This exercises real `fetch()`/`FormData` without a whisper binary — the `bun test` no-binary gate is preserved.

### Pattern 6: `health` mock on the existing integration `MockWhisperService` (EP2-03)

```typescript
// tests/integration/server.test.ts — extend makeMockWhisperService()
function makeMockWhisperService(): MockWhisperService {
    const transcribeMock = mock(async (_f: File, _a: string): Promise<AudioTranscriptionResult> => ({ text: 'mock transcript' }));
    const healthMock = mock(async (): Promise<boolean> => true);
    return { transcribe: transcribeMock, health: healthMock, transcribeMock, healthMock };
}
// /ready test (against audioServer, which holds mockWhisper):
mockWhisper.healthMock.mockImplementationOnce(async () => true);
// GET audioUrl('/ready') → expect body.whisperAvailable === true
mockWhisper.healthMock.mockImplementationOnce(async () => false);
// GET audioUrl('/ready') → expect body.whisperAvailable === false  (and ready/mode unchanged)
```

`MockWhisperService` type must gain `health` + `healthMock`. The `beforeEach` reset block (server.test.ts:60-63) should also reset `healthMock`.

### Anti-Patterns to Avoid
- **Calling `whisperService.health()` with no timeout / with `whisperTimeoutMs` (30 s):** stalls `/ready`. Always bound to ~2 s.
- **Letting `health()` throw:** `/ready` would 500. `health()` must `catch → false`.
- **Forwarding the logical `model` alias to the sidecar:** the sidecar owns its model via `--model`; forwarding a `model` field is ignored at best, misleading at worst. Do not append it.
- **Including the whisper alias in the chat `ready`/`mode` calculation:** breaks ROADMAP criterion 2. `whisperAvailable` is a sibling field only.
- **Logging `file.name`, the transcript, or the sidecar response body:** AUTH2-02. The error message uses status code only.
- **Gating the `/v1/models` alias on sidecar health:** EP2-02 = "configured" = alias env set. Listing must not probe the sidecar.
- **Moving service selection into `createServer()`:** violates D-03 and breaks the test injection seam.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Request timeout | manual `setTimeout` + flag juggling | `AbortSignal.timeout(ms)` passed to `fetch` | One line; auto-clears; standard |
| Multipart body to sidecar | manual boundary/encoding | `new FormData()` + `append('file', file)` | Bun sets `multipart/form-data; boundary=...` automatically |
| Error → 503 translation | new error types/handling | existing route `try/catch` (index.ts:228-260) | Phase 5 already maps any throw to OpenAI-shaped 503 |
| Health 503-while-loading handling | parse `{status}` body | `res.ok` boolean | whisper-server returns HTTP 503 while loading; `r.ok` is already correct |
| Response normalization | strip/rewrite fields | read `body.text` | whisper-server json body is already `{ "text": ... }` |

**Key insight:** Phase 6 is wiring, not building. Every hard problem (auth, validation, error shapes, X-Request-ID, structured logging, body-size gating) was solved in Phases 1–5. The only genuinely new code is ~40 lines of `HttpWhisperService`.

---

## Common Pitfalls

### Pitfall 1: Probing the wrong health URL
**What goes wrong:** Building the health URL as `${baseUrl}${inferencePath}/health` or assuming `/health` lives under the remapped inference path.
**Why it happens:** Natural to assume one prefix governs all endpoints.
**How to avoid:** whisper-server registers `/health` as `request_path + "/health"`, independent of `--inference-path` (server.cpp:1204). Probe `${baseUrl}/health` literally.
**Warning signs:** `whisperAvailable` is always `false` even with a healthy sidecar (404 on the composed path).

### Pitfall 2: `/ready` hangs or 500s
**What goes wrong:** Unbounded `health()` fetch, or `health()` throwing on connection-refused, bubbling into `/ready`.
**Why it happens:** `fetch()` to a down host rejects; without a catch it propagates.
**How to avoid:** `AbortSignal.timeout(~2000)` + `try/catch → false` inside `health()`.
**Warning signs:** `/ready` latency spikes to 30 s, or returns 500 when sidecar is down.

### Pitfall 3: Path mismatch with the running sidecar (Decision 1)
**What goes wrong:** Proxy calls `/inference` but operator launched `whisper-server --inference-path /v1/audio/transcriptions` (or vice-versa) → 404 → every transcription becomes 503.
**Why it happens:** STACK.md's example startup command remaps the path; the proxy default does not.
**How to avoid:** Default to `/inference` (native), document the override, and verify with the curl smoke test (ROADMAP criterion 3) against the actual launch command.
**Warning signs:** Smoke test returns 503 while `/health` reports available.

### Pitfall 4: Existing `/ready` consumers break on the new field
**What goes wrong:** A test asserting the whole `/ready` body via `toEqual({...})` fails when `whisperAvailable` is added.
**Why it happens:** Strict object equality.
**How to avoid:** The current suite has no whole-body `/ready` assertion [VERIFIED: grep of server.test.ts found no `/ready` `toEqual`]. Keep new `/ready` tests field-level (`body.whisperAvailable === true`).
**Warning signs:** A previously green `/ready` test fails after the additive change.

### Pitfall 5: `verbatimModuleSyntax` import error in `whisper-service.ts`
**What goes wrong:** `import { config }` is a value import (correct); but mixing a value import of `HttpWhisperService` with a type import elsewhere can trip the linter.
**How to avoid:** `import { config } from './config'` (value), keep `import type { AudioTranscriptionResult }` (type). In `index.ts`, `HttpWhisperService` and `NoopWhisperService` are values → plain `import`.
**Warning signs:** TS error "must use 'import type'".

### Pitfall 6: `health` not reset between tests
**What goes wrong:** A `mockImplementationOnce` on `healthMock` leaks or a prior state persists.
**How to avoid:** Add `mockWhisper.healthMock.mockReset()` + default impl in the existing `beforeEach` (server.test.ts:54-64).
**Warning signs:** `/ready` test order-dependence.

---

## Code Examples

### whisper-server local launch (operator setup — UAT/manual, not in `bun test`)
```bash
# Native default path (/inference) — matches Decision 1 proxy default
whisper-server \
  --model ./whisper-models/ggml-large-v3-turbo.bin \
  --host 127.0.0.1 \
  --port 8080 \
  --convert
# Health: curl http://127.0.0.1:8080/health  -> {"status":"ok"}  (200)
# Inference: curl 127.0.0.1:8080/inference -F file="@jfk.wav" -F response_format="json"  -> {"text":"..."}
```
[CITED: https://github.com/ggml-org/whisper.cpp/tree/master/examples/server]

### End-to-end smoke (ROADMAP criterion 3)
```bash
curl -s http://localhost:3000/v1/audio/transcriptions \
  -H "Authorization: Bearer ${PERSONAL_PROXY_API_KEY}" \
  -F file="@sample.wav" -F model="${WHISPER_MODEL_ALIAS}"     # -> {"text":"..."}  200
# stop whisper-server, repeat -> {"error":{...}} 503 ; chat /v1/chat/completions still 200
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CLI subprocess + temp WAV + stdout JSON | `whisper-server` HTTP sidecar + `fetch` | whisper.cpp added `examples/server` | No `Bun.spawn`, no temp files; identical to upstream provider call pattern |
| Assumed sidecar path `/v1/audio/transcriptions` (STACK.md) | Native default `/inference` (verified) | This research | Proxy default needs no `--inference-path` flag on the sidecar |
| `isAvailable()` (sync, SUMMARY.md sketch) | `health(): Promise<boolean>` (async bounded probe) | This research | Real network liveness, not a static flag |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `AbortSignal.timeout(ms)` is available in deployed Bun (1.1.29 / 1.3.11) | Pattern 1 | If absent, `fetch` ignores the option and timeouts never fire; fallback: `AbortController`+`setTimeout` in a `finally`. Verify Wave 0 with a one-liner. |
| A2 | Operators run `whisper-server` with the default `/inference` path | Decision 1 | Remapped sidecar → 404→503; mitigated by constructor override + curl smoke test |
| A3 | whisper-server json `response_format` body remains `{ "text": ... }` across versions (verified on master) | Contract table | If a future version nests `text`, adjust the `body.text` read; smoke test catches it |
| A4 | The existing test suite has no whole-body `/ready` `toEqual` assertion | Pitfall 4 | grep found none; if a hidden one exists, make it field-level |
| A5 | Forwarding `response_format=json` to the sidecar is harmless (it is the default) | Pattern 1 | If the build rejects the field, drop the append — `file` alone suffices |

**If A1 is wrong:** the only functional gap is unbounded transcription/health calls; the `AbortController`+`setTimeout` fallback restores bounding with ~4 extra lines.

---

## Open Questions

1. **Should the inference path become a `WHISPER_INFERENCE_PATH` env var?**
   - Known: a constructor override already covers tests and advanced operators.
   - Unclear: whether operators will commonly remap the sidecar path.
   - Recommendation: keep it out of this phase (no new config). Add the env var later only if a real need appears. Default `/inference` is the lowest-friction choice.

2. **Should `response_format` be forwarded at all?**
   - Known: whisper-server defaults to json; the proxy only supports json in v2.0.
   - Recommendation: forward `response_format=json` for explicitness; harmless (A5). Drop if any build rejects it.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun runtime (`fetch`, `FormData`, `AbortSignal.timeout`, `Bun.serve`) | All of Phase 6 + tests | ✓ | 1.3.11 local / 1.1.29 Docker | `AbortController`+`setTimeout` if `AbortSignal.timeout` missing (A1) |
| `bun:test` `mock()` | `health` mock; fake-sidecar tests | ✓ | built-in | — |
| `WHISPER_MODEL_ALIAS` in `.env.test` | EP2-02/EP2-03 + existing TEST2 alias checks | ✓ (`whisper-1`) | — | — [VERIFIED: .env.test:4] |
| whisper-server binary | Live UAT smoke only (ROADMAP criterion 3) | Not required for `bun test` | 1.8.6 (brew) | Fake `Bun.serve` sidecar in tests; `NoopWhisperService` in unconfigured prod |

**Missing dependencies with no fallback:** None for `bun test`. The real binary is needed only for the manual/UAT smoke test, by design (Phase 4/5 no-binary gate preserved).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (built-in) |
| Config file | none — `bun test` auto-discovers `*.test.ts`; env from `.env.test` |
| Quick run command | `bun test tests/integration/server.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EP2-02 | `/v1/models` includes whisper alias when configured | integration | `bun test tests/integration/server.test.ts` | ❌ Wave 0 (add to existing file) |
| EP2-03 | `/ready` returns `whisperAvailable:true/false`; chat fields unchanged | integration | `bun test tests/integration/server.test.ts` | ❌ Wave 0 |
| WHSP-01 | `transcribe()` POSTs FormData to `/inference`, returns `{text}` | unit (fake sidecar) | `bun test tests/.../http-whisper-service.test.ts` | ❌ Wave 0 (new file) |
| WHSP-02 | alias not forwarded; sidecar model is authoritative | unit (fake sidecar asserts no `model` field) | same | ❌ Wave 0 |
| WHSP-03 | non-2xx / network / timeout → throw → route 503; chat unaffected | unit + integration | both | ❌ Wave 0 / ✅ existing TEST2-07 covers route 503 |

### Sampling Rate
- **Per task commit:** `bun test tests/integration/server.test.ts`
- **Per wave merge:** `bun test` (full suite — existing ~90 tests must stay green)
- **Phase gate:** full suite green + manual curl smoke (ROADMAP criterion 3) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `whisper-service.ts` — add `health()` to interface, `NoopWhisperService.health()`, new `HttpWhisperService`
- [ ] `tests/services/http-whisper-service.test.ts` (or `tests/unit/`) — fake-sidecar tests (WHSP-01/02/03)
- [ ] `tests/integration/server.test.ts` — add `healthMock` to `MockWhisperService`, reset in `beforeEach`, add EP2-02 `/v1/models` + EP2-03 `/ready` tests
- [ ] `index.ts` — `/v1/models` append, `/ready` `whisperAvailable`, `import.meta.main` selection + `HttpWhisperService` import
- [ ] Wave 0 verify: confirm `AbortSignal.timeout` (A1) with `bun -e "console.log(typeof AbortSignal.timeout)"`

---

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | `/v1/models` + audio route remain behind the existing auth gate (index.ts:156); `/ready` intentionally public, exposes only booleans |
| V3 Session Management | No | Stateless HTTP |
| V4 Access Control | Yes | No new authenticated surface; whisper alias listing requires a valid token like all `/v1/*` |
| V5 Input Validation | Yes | Reuses Phase 5 `validateAudioTranscription` + size/alias checks before any sidecar call |
| V6 Cryptography | No | No new crypto |
| V7/V9 Logging & Comms | Yes | `health()`/`transcribe()` log nothing; error message carries status code only — no filename, transcript, or body (AUTH2-02) |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via operator-controlled host/port | Tampering | Host/port come from server-side `config` only, never from the request; not client-influenced |
| Transcript / filename leak in logs or errors | Info disclosure | Log only `fileSize`/`modelAlias`/`status`; error message = `whisper-server responded <status>` |
| `/ready` probe used to stall the proxy (DoS) | DoS | Bounded ~2 s `AbortSignal.timeout`; failure → `false`, never blocks |
| Unauthenticated audio/model access | Spoofing | Routes sit after the auth gate; only `/health`/`/ready` (booleans) are public |
| Sidecar returns oversized/garbage body | DoS/Tampering | Only `body.text` is read; size already gated upstream by the 25 MiB request limit |

---

## Sources

### Primary (HIGH confidence)
- whisper.cpp `examples/server/server.cpp` @ master — read in full: `/inference` default (l.62), `--inference-path` (l.255), multipart fields (l.576-578), default json `{text}` (l.1154-1158), `/load` (l.1161), `/health` 200/503 (l.1204-1213). https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/server/server.cpp
- Codebase (live): `whisper-service.ts`, `index.ts` (createServer:104-109, /ready:133-154, auth gate:156, audio route:172-261, /v1/models:276-289, entrypoint:786-789), `config.ts:62-70`, `types.ts:58-60`, `model-registry.ts:26`, `audio-schema.ts`, `tests/integration/server.test.ts`, `.env.test`
- `05-RESEARCH.md`, `04-RESEARCH.md` — WhisperService design, createServer third-param injection seam, route 503 path

### Secondary (MEDIUM confidence)
- whisper.cpp `examples/server` README (curl `/inference` + `/load`): https://github.com/ggml-org/whisper.cpp/tree/master/examples/server
- `EvilFreelancer/docker-whisper-server` README — confirms `/inference`, `/load`, `WHISPER_INFERENCE_PATH` default `/inference`: https://github.com/EvilFreelancer/docker-whisper-server

### Tertiary (LOW confidence — not relied upon)
- `agent-cli` and vLLM `/health` references — these are *different* servers (Python wrappers / vLLM); whisper.cpp `/health` was instead verified directly in source above.

---

## Metadata

**Confidence breakdown:**
- whisper-server HTTP contract: HIGH — verified line-by-line in upstream `server.cpp`
- Codebase integration seams: HIGH — every consumer (route, createServer param, config, listAliases) inspected directly
- Design choices (health() interface, constructor injection, /inference default): HIGH — grounded in verified contract + existing patterns
- `AbortSignal.timeout` availability: MEDIUM — Web standard, supported by Bun, but version-confirm in Wave 0 (A1)

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (stable; Bun, Zod, and the whisper.cpp server contract change infrequently — re-verify the sidecar contract if upgrading the whisper-cpp brew formula)
