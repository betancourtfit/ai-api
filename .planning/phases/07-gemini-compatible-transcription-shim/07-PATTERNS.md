# Phase 7: Gemini-Compatible Transcription Shim - Pattern Map

**Mapped:** 2026-06-17
**Files analyzed:** 1 modified (index.ts — new route branch + new helper), 4 reused read-only
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `index.ts` (new route branch `POST /v1beta/models/{model}:generateContent`) | controller | request-response | existing `POST /v1/audio/transcriptions` branch (index.ts:173) | exact |
| `index.ts` (new `geminiError()` helper) | utility | — | `openaiError()` (index.ts:32) | exact |

## Pattern Assignments

---

### New route branch: `POST /v1beta/models/{model}:generateContent`

**Analog:** `POST /v1/audio/transcriptions` branch, index.ts lines 173–262
**Insertion point:** After `/ready` branch (index.ts line 155), before the global Bearer auth gate (line 157).

#### Route placement pattern — `/ready` branch end + auth gate start (index.ts:133–171)

```typescript
            if (request.method === 'GET' && pathname === '/ready') {
                // ... /ready handler body ...
                return withRequestId(new Response(
                    JSON.stringify({ ready, mode, eligibleProviders, unavailableProviders, whisperAvailable }),
                    {
                        status: ready ? 200 : 503,
                        headers: { 'Content-Type': 'application/json' },
                    }
                ));
            }

            // --- Auth gate — all routes below require Bearer PERSONAL_PROXY_API_KEY ---
            if (!config.personalProxyApiKey) {
                return withRequestId(authNotConfiguredError());
            }

            const token = extractBearerToken(request);
            if (!token || !verifyToken(token, config.personalProxyApiKey)) {
                return withRequestId(openaiError(
                    'No authorization provided or invalid credentials.',
                    'invalid_request_error',
                    'missing_auth',
                    null,
                    401
                ));
            }
```

**Pattern for new Gemini route:** Insert between line 155 (`}` closing `/ready`) and line 157 (`// --- Auth gate`). The new branch has its **own auth logic** (reads `x-goog-api-key` header or `?key=` param) before the global gate runs.

#### Path matching pattern (analog: transcription route, index.ts:174)

```typescript
            // POST /v1/audio/transcriptions — multipart transcription endpoint (EP2-01)
            if (request.method === 'POST' && pathname === '/v1/audio/transcriptions') {
```

New route uses startsWith + endsWith instead of exact match (D-02):

```typescript
            // POST /v1beta/models/{model}:generateContent — Gemini-compatible transcription shim
            if (request.method === 'POST'
                && pathname.startsWith('/v1beta/models/')
                && pathname.endsWith(':generateContent')) {
                const model = pathname.slice('/v1beta/models/'.length, -':generateContent'.length);
```

#### Auth pattern for Gemini route (D-03, D-04) — reuses `verifyToken` (index.ts:54–65)

```typescript
                // verifyToken — constant-time comparison (index.ts:54)
                function verifyToken(token: string, expected: string): boolean {
                    const enc = new TextEncoder();
                    const a = enc.encode(token);
                    const b = enc.encode(expected);
                    const maxLen = Math.max(a.length, b.length);
                    const paddedA = new Uint8Array(maxLen);
                    const paddedB = new Uint8Array(maxLen);
                    paddedA.set(a);
                    paddedB.set(b);
                    return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
                }
```

Apply at route entry (prefer header over query param, D-03):

```typescript
                const geminiKey =
                    request.headers.get('x-goog-api-key')
                    ?? new URL(request.url).searchParams.get('key');

                if (!config.personalProxyApiKey) {
                    return withRequestId(geminiError(503, 'Proxy authentication is not configured.', 'UNAVAILABLE'));
                }
                if (!geminiKey || !verifyToken(geminiKey, config.personalProxyApiKey)) {
                    return withRequestId(geminiError(401, 'API key not valid. Please provide a valid API key.', 'UNAUTHENTICATED'));
                }
```

#### JSON body parse pattern (analog: chat completions branch, index.ts:367–372)

```typescript
                let body: unknown;
                try {
                    body = JSON.parse(raw);
                } catch {
                    return withRequestId(openaiError('Request body must be valid JSON.', 'invalid_request_error', 'invalid_request_error', null, 400));
                }
```

New route uses `request.json()` directly (body is not size-metered like chat completions — audio ceiling already covers it via `maxRequestBodySize`):

```typescript
                let body: unknown;
                try {
                    body = await request.json();
                } catch {
                    return withRequestId(geminiError(400, 'Request body must be valid JSON.', 'INVALID_ARGUMENT'));
                }
```

#### File size validation reuse (analog: transcription branch, index.ts:206–215)

```typescript
                const sizeCheck = validateAudioFileSize(input.file, audioMaxFileBytes);
                if (!sizeCheck.ok) {
                    return withRequestId(openaiError(
                        sizeCheck.message,
                        'invalid_request_error',
                        'request_too_large',
                        'file',
                        413
                    ));
                }
```

New route replaces `openaiError` with `geminiError` (D-07, D-12):

```typescript
                const sizeCheck = validateAudioFileSize(audioFile, audioMaxFileBytes);
                if (!sizeCheck.ok) {
                    return withRequestId(geminiError(400, sizeCheck.message, 'INVALID_ARGUMENT'));
                }
```

`validateAudioFileSize` signature (audio-schema.ts:49–60):

```typescript
export function validateAudioFileSize(
    file: File,
    maxBytes: number
): { ok: true } | { ok: false; message: string } {
    if (file.size > maxBytes) {
        return {
            ok: false,
            message: `File too large. Maximum allowed size is ${maxBytes} bytes.`,
        };
    }
    return { ok: true };
}
```

#### Transcription call + success response pattern (analog: index.ts:229–244)

```typescript
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

New route: `whisperService.transcribe(audioFile, config.whisperModelAlias ?? model)` (D-08), success returns Gemini shape (D-09/10/11), failure returns `geminiError` (D-13):

```typescript
                try {
                    const result = await whisperService.transcribe(audioFile, config.whisperModelAlias ?? model);
                    const text = result.text;
                    const candidatesTokenCount = Math.ceil(text.length / 4);
                    log('info', {
                        event: 'gemini_transcription_complete',
                        requestId,
                        timestamp: new Date(requestStart).toISOString(),
                        route: `${request.method} ${pathname}`,
                        modelVersion: model,
                        fileSize: audioFile.size,
                        status: 200,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(new Response(
                        JSON.stringify({
                            candidates: [{
                                content: { role: 'model', parts: [{ text }] },
                                finishReason: 'STOP',
                                index: 0,
                            }],
                            usageMetadata: {
                                promptTokenCount: 0,
                                candidatesTokenCount,
                                totalTokenCount: candidatesTokenCount,
                            },
                            modelVersion: model,
                        }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    ));
                } catch {
                    log('warn', {
                        event: 'gemini_transcription_failed',
                        requestId,
                        modelVersion: model,
                        fileSize: audioFile.size,
                        status: 503,
                        latencyMs: Date.now() - requestStart,
                    });
                    return withRequestId(geminiError(503, 'Transcription service is unavailable.', 'UNAVAILABLE'));
                }
```

`AudioTranscriptionResult` type (types.ts:57–60):

```typescript
// AUDIO-06: OpenAI json transcription response shape
export interface AudioTranscriptionResult {
    text: string;
}
```

Map `result.text` directly into `candidates[0].content.parts[0].text`.

#### base64 → File decode pattern (D-06 — Bun-native, no new deps)

```typescript
                const bytes = Buffer.from(part.inline_data.data, 'base64');
                const audioFile = new File([bytes], 'audio', { type: part.inline_data.mime_type });
```

---

### New helper: `geminiError(code, message, status)`

**Analog:** `openaiError()` (index.ts:32–43) and `authNotConfiguredError()` (index.ts:67–75)

**`openaiError` verbatim (index.ts:32–43):**

```typescript
// OpenAI-style error shape (D-05 + spec §14) — used for ALL error paths
function openaiError(
    message: string,
    type: string,
    code: string | number,
    param: string | null = null,
    status: number = 400
): Response {
    return new Response(
        JSON.stringify({ error: { message, type, code, param } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}
```

**`authNotConfiguredError` verbatim (index.ts:67–75):**

```typescript
function authNotConfiguredError(): Response {
    return openaiError(
        'Proxy authentication is not configured.',
        'server_error',
        'proxy_not_configured',
        null,
        503
    );
}
```

**New `geminiError` — mirrors `openaiError` structure, Gemini body (D-12):**

Key differences from `openaiError`:
- Body is `{ error: { code: <int>, message: <string>, status: <UPPER_SNAKE_CASE> } }` — no `type`, no `param` fields
- `code` parameter is always `number` (HTTP status int), not `string | number`
- `status` parameter is the Gemini UPPER_SNAKE_CASE string (`UNAUTHENTICATED`, `INVALID_ARGUMENT`, `UNAVAILABLE`)
- HTTP status code is a separate 4th parameter

```typescript
// Gemini-style error shape (D-12) — used exclusively on the /v1beta/... route
function geminiError(
    httpStatus: number,
    message: string,
    status: 'UNAUTHENTICATED' | 'INVALID_ARGUMENT' | 'UNAVAILABLE'
): Response {
    return new Response(
        JSON.stringify({ error: { code: httpStatus, message, status } }),
        { httpStatus, headers: { 'Content-Type': 'application/json' } }
    );
}
```

Status mapping (D-12): 401 → `UNAUTHENTICATED`, 400 → `INVALID_ARGUMENT`, 413 → `INVALID_ARGUMENT`, 503 → `UNAVAILABLE`.

Place near `openaiError` (after line 43, before line 45).

---

## Shared Patterns (applied to new route)

### `withRequestId` wrapper

**Source:** index.ts:121–126 (inner function inside `fetch()`)

```typescript
            function withRequestId(response: Response): Response {
                const headers = new Headers(response.headers);
                headers.set('X-Request-ID', requestId);
                return new Response(response.body, { status: response.status, headers });
            }
```

Apply to every return in the new Gemini route branch, identical to all other routes.

### `crypto.randomUUID()` request ID + `requestStart`

**Source:** index.ts:117–118

```typescript
            const requestId = crypto.randomUUID();
            const requestStart = Date.now();
```

Already available — these execute at the top of every `fetch()` call, shared across all branches.

### `log()` structured logger

**Source:** index.ts:24–29

```typescript
function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
    const entryLevel = LOG_LEVEL_MAP[level] ?? 2;
    if (entryLevel <= configuredLogLevel) {
        console.log(JSON.stringify({ level, ...data }));
    }
}
```

Never log: audio bytes, base64 data, transcript text (AUTH2-02 / CLAUDE.md §19). Mirror the field set from the transcription branch: `event`, `requestId`, `timestamp`, `route`, `modelVersion` (not `modelAlias`), `fileSize`, `status`, `latencyMs`.

### Config fields used by new route

**Source:** config.ts (all `as const`)

```typescript
config.personalProxyApiKey   // string | null — Gemini auth gate
config.whisperModelAlias     // string | null — passed to transcribe(); fall back to URL {model} when null (D-08)
config.audioMaxFileBytes     // number — passed to validateAudioFileSize()
```

### `verifyToken(token, expected)` — constant-time comparison

**Source:** index.ts:54–65 (already in scope inside `createServer`)

```typescript
function verifyToken(token: string, expected: string): boolean {
    const enc = new TextEncoder();
    const a = enc.encode(token);
    const b = enc.encode(expected);
    const maxLen = Math.max(a.length, b.length);
    const paddedA = new Uint8Array(maxLen);
    const paddedB = new Uint8Array(maxLen);
    paddedA.set(a);
    paddedB.set(b);
    return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}
```

### `validateAudioFileSize(file, maxBytes)` — reusable size guard

**Source:** audio-schema.ts:49–60 — already imported in index.ts line 6.

```typescript
import { validateAudioFileSize, validateAudioTranscription } from './audio-schema';
```

No new import needed.

---

## No Analog Found

None. Every artifact in Phase 7 has a direct analog or is a pure reuse of an existing symbol.

---

## Acceptance Test Map

Each test in `tests/integration/gemini-compat.test.ts` (the `describe.skip` block, lines 135–227) maps to a specific pattern above:

| Test | Spec ID | Pattern to apply |
|------|---------|-----------------|
| valid `?key=` → Gemini candidates | GEM-01/03/05/06 | transcription call + Gemini success shape (D-09) |
| `x-goog-api-key` header auth | GEM-02 | header-preferred auth (D-03) |
| `usageMetadata` + `modelVersion` present | GEM-07/08 | token estimation + model echo (D-10/11) |
| bad key → `{error:{code,message,status}}` no `type` | GEM-09 | `geminiError()` shape (D-12) |
| missing `inline_data` → Gemini 400 | GEM-10 | part-scan logic → `geminiError(400,…,'INVALID_ARGUMENT')` |
| `file_data` URI → Gemini 400 | GEM-04 | file_data guard (D-07 step 3) |

---

## Metadata

**Analog search scope:** `index.ts`, `audio-schema.ts`, `config.ts`, `types.ts`, `tests/integration/gemini-compat.test.ts`
**Files scanned:** 5
**Pattern extraction date:** 2026-06-17
