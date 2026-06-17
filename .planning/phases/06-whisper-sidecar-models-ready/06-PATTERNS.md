# Phase 6: Whisper Sidecar + Models + Ready - Pattern Map

**Mapped:** 2026-06-06
**Files analyzed:** 4 (2 source modified, 2 test modified/new)
**Analogs found:** 4 / 4 (HTTP-client networking is partial — no raw `fetch()` analog exists; SDKs are used elsewhere)

> Phase 6 is **wiring, not building**. Every consumer seam (route, `createServer` third param, `config.whisper*`, `listAliases()`, `openaiError()` 503 path, `withRequestId()`, `log()`) already exists from Phases 1–5. The only genuinely new code is the ~40-line `HttpWhisperService`. Prefer copying the in-file analogs below verbatim and changing only what the requirement demands.

## File Classification

| New/Modified File | Change | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|--------|------|-----------|----------------|---------------|
| `whisper-service.ts` | add `health()` to interface; `NoopWhisperService.health()`; new `HttpWhisperService` | service (HTTP client) | request-response (outbound HTTP) | `NoopWhisperService` (same file) for class/interface shape; `services/cerebras.ts`/`groq.ts` `signal: AbortSignal` for timeout-on-network | exact (interface/class) / partial (raw `fetch()` networking) |
| `index.ts` → `GET /v1/models` | append whisper alias when configured | route handler | request-response | existing `/v1/models` handler `index.ts:276-289` | exact (same handler, same file) |
| `index.ts` → `GET /ready` | add `whisperAvailable` field (additive) | route handler | request-response | existing `/ready` handler `index.ts:133-154` | exact (same handler, same file) |
| `index.ts` → `import.meta.main` | inline `HttpWhisperService` vs `NoopWhisperService` selection | entrypoint / config wiring | config-driven instantiation | existing entrypoint `index.ts:786-789` + `createServer` signature `index.ts:104-109` | exact |
| `tests/integration/server.test.ts` | add `healthMock` to mock; reset; EP2-02/EP2-03 tests | test | request-response | `makeMockWhisperService()` `:27-35` + `beforeEach` reset `:54-64` + `postAudio` tests | exact |
| `tests/services/http-whisper-service.test.ts` (NEW) | fake `Bun.serve` sidecar; WHSP-01/02/03 | test | request-response (in-process server) | `createServer`/`Bun.serve` boot in `server.test.ts:37-52`; unit header style `tests/unit/audio-schema.test.ts:1-5` | role-match |

## Pattern Assignments

### `whisper-service.ts` (service / HTTP client, request-response)

**Analog:** `whisper-service.ts` itself (existing `WhisperService` + `NoopWhisperService`) — the file is small (14 lines) and is the exact shape to extend. For the outbound networking there is **no raw `fetch()` analog** in the codebase (both provider adapters use vendor SDKs), so the new `transcribe()`/`health()` HTTP bodies follow RESEARCH.md Pattern 1 directly.

**Current full file** (the surface you are extending):

```1:14:whisper-service.ts
// whisper-service.ts — injectable Whisper transcription contract (Phase 5)
// NoopWhisperService is the production default until Phase 6 wires the HTTP sidecar.
import type { AudioTranscriptionResult } from './types';

export interface WhisperService {
    transcribe(file: File, modelAlias: string): Promise<AudioTranscriptionResult>;
}

export class NoopWhisperService implements WhisperService {
    async transcribe(_file: File, _modelAlias: string): Promise<AudioTranscriptionResult> {
        throw new Error('WhisperService not configured. Set WHISPER_HOST and WHISPER_MODEL_ALIAS.');
    }
}
```

**Imports pattern to copy** — value import of `config`, type-only import of the result (respects `verbatimModuleSyntax`; see Pitfall 5 in RESEARCH.md). The existing file imports only the type; add the `config` value import:

```typescript
import type { AudioTranscriptionResult } from './types';
import { config } from './config';   // NEW — value import (host/port/timeout defaults)
```

**Config fields available** (no new env vars this phase) — read these as constructor defaults:

```61:66:config.ts
    // WHSP-04: whisper sidecar connection
    whisperHost: process.env["WHISPER_HOST"] ?? "127.0.0.1",
    whisperPort: requiredPositiveInt("WHISPER_PORT", 8080),
    whisperTimeoutMs: requiredPositiveInt("WHISPER_TIMEOUT_MS", 30_000),
    // optional() returns null when unset — missing WHISPER_MODEL_ALIAS is non-fatal
    whisperModelAlias: optional("WHISPER_MODEL_ALIAS"),
```

**Result type to return** (`transcribe()` returns `{ text }`; sidecar JSON already matches — read `body.text` only):

```57:60:types.ts
// AUDIO-06: OpenAI json transcription response shape
export interface AudioTranscriptionResult {
    text: string;
}
```

**AbortSignal-on-network analog** (the only existing precedent for bounding a network call — the adapter threads a `signal` into the outbound call; `HttpWhisperService` uses `AbortSignal.timeout(ms)` instead):

```69:73:services/cerebras.ts
    async stream(
        upstreamModelId: string,
        params: CompletionParams,
        signal: AbortSignal
    ): Promise<AsyncIterable<StreamChunk>> {
```

**Core pattern to add** (from RESEARCH.md Pattern 1 — verified sidecar contract `POST /inference` → `{ "text": ... }`, `GET /health` 200/503): add `health(): Promise<boolean>` to the interface, `NoopWhisperService.health()` returning `false`, and a constructor-injectable `HttpWhisperService` (`inferencePath` default `/inference`; `healthTimeoutMs` default `2000` — Decision 1 & 3). `transcribe()` builds `FormData` (`file` + `response_format=json`), `fetch()`es with `AbortSignal.timeout(this.timeoutMs)`, throws on `!res.ok`; `health()` does a bounded `GET /health` and `catch → false`. **Do not forward the `model` alias** (WHSP-02). **Error message = status code only** — never file content/name/transcript (AUTH2-02).

---

### `index.ts` → `GET /v1/models` (route handler, request-response)

**Analog:** the existing `/v1/models` handler — extend the `data` array.

```275:289:index.ts
            // GET /v1/models — list logical proxy aliases only (REG-04; EP-03)
            if (request.method === 'GET' && pathname === '/v1/models') {
                return withRequestId(new Response(
                    JSON.stringify({
                        object: 'list',
                        data: listAliases().map((id) => ({
                            id,
                            object: 'model',
                            created: 0,
                            owned_by: 'personal-proxy',
                        })),
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                ));
            }
```

**Pattern (EP2-02):** build `data` into a `const`, then `data.push({ id: config.whisperModelAlias, object: 'model', created: 0, owned_by: 'personal-proxy' })` when `config.whisperModelAlias !== null`. Same `owned_by` shape; **no sidecar health gate** — "configured" = alias env set. Handler sits **after** the auth gate (`index.ts:156`), so listing still requires a valid Bearer token (unchanged).

**`listAliases()` source** (returns chat aliases only — whisper alias is NOT in the registry, hence the explicit append):

```25:28:model-registry.ts
// REG-04: return stable alias IDs only (for GET /v1/models)
export function listAliases(): string[] {
    return Object.keys(registry);
}
```

---

### `index.ts` → `GET /ready` (route handler, request-response)

**Analog:** the existing `/ready` handler — add ONE field; leave the chat math byte-for-byte.

```133:154:index.ts
            if (request.method === 'GET' && pathname === '/ready') {
                const logicalModel = listAliases()[0] ?? '';
                const proxyKeyConfigured = Boolean(config.personalProxyApiKey);
                const eligibleProviders = (['cerebras', 'groq'] as Provider[]).filter((provider) => (
                    isEligible(provider, logicalModel)
                ));
                const unavailableProviders = (['cerebras', 'groq'] as Provider[]).filter((provider) => (
                    !eligibleProviders.includes(provider)
                ));
                const ready = proxyKeyConfigured && eligibleProviders.length > 0;
                const mode = !proxyKeyConfigured
                    ? 'not_configured'
                    : unavailableProviders.length === 0 ? 'ok' : 'degraded';

                return withRequestId(new Response(
                    JSON.stringify({ ready, mode, eligibleProviders, unavailableProviders }),
                    {
                        status: ready ? 200 : 503,
                        headers: { 'Content-Type': 'application/json' },
                    }
                ));
            }
```

**Pattern (EP2-03):** before the `return`, add `const whisperAvailable = await whisperService.health();` (the `fetch` handler is already `async`; `whisperService` is in scope as a `createServer` param). Add `whisperAvailable` to the serialized object. **HTTP `status` stays driven solely by chat `ready`** — do NOT fold whisper into `ready`/`mode`/`eligibleProviders`/`unavailableProviders` (ROADMAP criterion 2). `health()` is bounded (~2 s) and never throws, so `/ready` cannot hang or 500.

---

### `index.ts` → `import.meta.main` (entrypoint, config-driven instantiation)

**Analog:** the existing entrypoint + the `createServer` signature whose third param defaults to `NoopWhisperService`.

```104:109:index.ts
export function createServer(
    adapters: Record<Provider, ProviderAdapter>,
    port: number = config.port,
    whisperService: WhisperService = new NoopWhisperService(),
    audioMaxFileBytes: number = config.audioMaxFileBytes
): ReturnType<typeof Bun.serve> {
```

```785:789:index.ts
// Entrypoint guard — bun index.ts boots the server; import { createServer } from './index' does not
if (import.meta.main) {
    const server = createServer({ cerebras: cerebrasAdapter, groq: groqAdapter });
    console.log(`Server is running on ${server.url}`);
}
```

**Existing import to extend** (add `HttpWhisperService` to the value import; keep the `WhisperService` type import as-is):

```14:15:index.ts
import { NoopWhisperService } from './whisper-service';
import type { WhisperService } from './whisper-service';
```

**Pattern (D-01/D-03):** in `import.meta.main`, select `const whisperService = config.whisperModelAlias !== null ? new HttpWhisperService() : new NoopWhisperService();` and pass it as the **third** `createServer(...)` argument. Do **not** move selection inside `createServer()` — the default-param Noop preserves the Phase 5 test-injection seam. `createServer`'s signature is untouched, so all existing tests keep passing.

---

### `tests/integration/server.test.ts` (test, request-response)

**Analog:** the existing mock factory + reset block + the audio test helpers. Extend the mock type/factory with `health`, reset it in `beforeEach`, and add EP2-02/EP2-03 tests against `audioServer` (which holds `mockWhisper`).

```18:35:tests/integration/server.test.ts
type MockWhisperService = WhisperService & { transcribeMock: ReturnType<typeof mock> };

let server: ReturnType<typeof createServer>;
let audioServer: ReturnType<typeof createServer>;
let tinyServer: ReturnType<typeof createServer>;
let mockCerebras: MockAdapter;
let mockGroq: MockAdapter;
let mockWhisper: MockWhisperService;

function makeMockWhisperService(): MockWhisperService {
    const transcribeMock = mock(async (_file: File, _alias: string): Promise<AudioTranscriptionResult> => ({
        text: 'mock transcript',
    }));
    return {
        transcribe: transcribeMock,
        transcribeMock,
    };
}
```

```54:64:tests/integration/server.test.ts
beforeEach(() => {
    // TEST-12: state isolation — reset routing cursor and cooldowns
    resetForTesting();
    // Restore default mock implementations after TEST-05's persistent overrides
    resetMockAdapter(mockCerebras);
    resetMockAdapter(mockGroq);
    mockWhisper.transcribeMock.mockReset();
    mockWhisper.transcribeMock.mockImplementation(async (_f: File, _a: string): Promise<AudioTranscriptionResult> => ({
        text: 'mock transcript',
    }));
});
```

**Pattern (EP2-03):** widen `MockWhisperService` to `WhisperService & { transcribeMock; healthMock }`; add `const healthMock = mock(async (): Promise<boolean> => true)` to `makeMockWhisperService()` and return `{ transcribe, health: healthMock, transcribeMock, healthMock }`; add `mockWhisper.healthMock.mockReset()` + default impl to `beforeEach` (avoids order-dependence — Pitfall 6). Test both branches via `healthMock.mockImplementationOnce(async () => true|false)` and assert **field-level** `body.whisperAvailable` (no whole-body `toEqual` — Pitfall 4) plus that `ready`/`mode` are unchanged. For EP2-02, `GET audioUrl('/v1/models')` with the Bearer header and assert the whisper alias is present in `data` (`.env.test` sets `WHISPER_MODEL_ALIAS=whisper-1`). Note: there are **no existing `/ready` or `/v1/models` tests** — these are net-new test cases (use the auth-header + `fetch(audioUrl(...))` helper style already in the file).

---

### `tests/services/http-whisper-service.test.ts` (NEW test, request-response)

**Analog:** the in-process `Bun.serve` boot used by the integration suite, and the unit-test header/import style. RESEARCH.md Pattern 5 gives the full fake-sidecar test.

```37:52:tests/integration/server.test.ts
beforeAll(() => {
    mockCerebras = makeMockAdapter('cerebras');
    mockGroq = makeMockAdapter('groq');
    mockWhisper = makeMockWhisperService();
    // port 0 = OS-assigned free port; read back via server.port
    server = createServer({ cerebras: mockCerebras, groq: mockGroq }, 0);
    audioServer = createServer({ cerebras: mockCerebras, groq: mockGroq }, 0, mockWhisper);
    // TEST2-04: inject 100-byte file limit without lowering global transport ceiling
    tinyServer = createServer({ cerebras: mockCerebras, groq: mockGroq }, 0, mockWhisper, 100);
});
```

```1:5:tests/unit/audio-schema.test.ts
// tests/unit/audio-schema.test.ts — unit tests for audio-schema.ts validators (TDD RED)
// Covers AUDIO-01..06, validates schema allowlist and size-check path (AUDIO-03).
// No server, no FormData, no whisper binary required.
import { test, expect, describe } from "bun:test";
import { validateAudioTranscription, validateAudioFileSize } from "../../audio-schema";
```

**Pattern (WHSP-01/02/03):** spin a fake sidecar with `Bun.serve({ port: 0, fetch })` in `beforeAll` (route `/health` → `Response.json({status:'ok'})`, `/inference` → `Response.json({text:'hello world'})`), `sidecar.stop(true)` in `afterAll`, and point `new HttpWhisperService({ host:'127.0.0.1', port: sidecar.port })` at it. Assert `transcribe()` returns `{ text }`, the sidecar received **no `model` field** (WHSP-02), non-2xx → `rejects.toThrow()` (WHSP-03), `health()` true on 200 and false on an unreachable port. This exercises real `fetch()`/`FormData` with no whisper binary — the `bun test` no-binary gate stays intact. Place under `tests/services/` (new dir) or `tests/unit/` to match existing layout.

## Shared Patterns

### OpenAI-shaped 503 on transcribe throw (WHSP-03 — already wired, do NOT change)
**Source:** route `try/catch` `index.ts:228-260` calling `openaiError()` `index.ts:32-43`
**Apply to:** nothing new — confirm `HttpWhisperService.transcribe()` **throws** so this existing handler maps it to 503.

```228:260:index.ts
                try {
                    const result = await whisperService.transcribe(input.file, input.model);
                    log('info', {
                        event: 'transcription_complete',
                        requestId,
                        timestamp: new Date(requestStart).toISOString(),
                        route: `${request.method} ${pathname}`,
                        modelAlias: input.model,
                        fileSize: input.file.size,
                        status: 200,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(new Response(JSON.stringify(result), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }));
                } catch {
                    log('warn', {
                        event: 'transcription_failed',
                        requestId,
                        modelAlias: input.model,
                        fileSize: input.file.size,
                        status: 503,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(openaiError(
                        'Transcription service is unavailable.',
                        'server_error',
                        'service_unavailable',
                        null,
                        503
                    ));
                }
```

### Structured logging without sensitive payloads (AUTH2-02)
**Source:** `log()` `index.ts:24-29`
**Apply to:** `HttpWhisperService` logs nothing; error messages carry **status code only**. The route already logs `modelAlias` + `fileSize` (never filename/transcript/body) — mirror that discipline.

```24:29:index.ts
function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
    const entryLevel = LOG_LEVEL_MAP[level] ?? 2;
    if (entryLevel <= configuredLogLevel) {
        console.log(JSON.stringify({ level, ...data }));
    }
}
```

### X-Request-ID wrapping on every response
**Source:** `withRequestId()` `index.ts:122-126`
**Apply to:** both modified handlers (`/ready`, `/v1/models`) already wrap their `Response` in `withRequestId(...)` — keep that wrapper when editing.

```122:126:index.ts
            function withRequestId(response: Response): Response {
                const headers = new Headers(response.headers);
                headers.set('X-Request-ID', requestId);
                return new Response(response.body, { status: response.status, headers });
            }
```

### Optional-config / null-guard convention (D-01 boot trigger)
**Source:** `optional()` `config.ts:5-8`; usage `config.whisperModelAlias` `config.ts:66`
**Apply to:** entrypoint selection and `/v1/models` append both gate on `config.whisperModelAlias !== null` — the same null-as-unset convention used throughout config.

```5:8:config.ts
function optional(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
}
```

## No Analog Found

| File / Change | Role | Data Flow | Reason |
|---------------|------|-----------|--------|
| `HttpWhisperService.transcribe()` / `health()` raw `fetch()` body | service (HTTP client) | request-response (outbound) | No raw `fetch()`/`FormData`/`AbortSignal.timeout()` client exists — both provider adapters (`services/cerebras.ts`, `services/groq.ts`) call vendor **SDKs**, not `fetch`. The networking code is genuinely new; follow RESEARCH.md Pattern 1 (verified whisper.cpp `server.cpp` contract). The `signal: AbortSignal` adapter param is the only structural precedent. |

## Metadata

**Analog search scope:** repo root (`whisper-service.ts`, `index.ts`, `config.ts`, `types.ts`, `model-registry.ts`), `services/`, `tests/integration/`, `tests/unit/`
**Files scanned:** 8 source/test files read; grep for `fetch(`/`AbortSignal`/`FormData`, `/ready`, `/v1/models`, mock whisper helpers
**Pattern extraction date:** 2026-06-06
