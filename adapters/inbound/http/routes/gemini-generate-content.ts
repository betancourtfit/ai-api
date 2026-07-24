// adapters/inbound/http/routes/gemini-generate-content.ts
// POST /v1beta/models/{model}:generateContent — Gemini-wire-compatible transcription shim (Phase 7).
// Placed BEFORE the global Bearer gate (D-01): Gemini auth is ?key= / x-goog-api-key, not Bearer.
// OUT OF SCOPE (GEM-15): :streamGenerateContent (Gemini SSE — falls through to the 404 handler),
//   file_data Files-API URIs (rejected as 400 below), and multi-candidate responses
//   (always a single candidate at index 0). Do not implement here.
import { config } from '../../../../config';
import { validateAudioFileSize } from '../schemas/audio-schema';
import { geminiError } from '../presenters/gemini-error';
import { verifyToken } from '../middleware/bearer-auth';
import type { RouteContext } from '../context';

export function matchGeminiGenerateContent(method: string, pathname: string): boolean {
    return method === 'POST'
        && pathname.startsWith('/v1beta/models/')
        && pathname.endsWith(':generateContent');
}

export async function handleGeminiGenerateContent(ctx: RouteContext): Promise<Response> {
    const { request, url, requestId, requestStart, deps } = ctx;
    const { pathname } = url;

    const model = pathname.slice(
        '/v1beta/models/'.length,
        pathname.length - ':generateContent'.length
    );

    // 1. Auth (D-03/D-04, GEM-02/09): x-goog-api-key header first, then ?key= query param.
    //    Missing config OR missing/invalid key → Gemini-shaped 401 (NOT openaiError).
    const apiKey = request.headers.get('x-goog-api-key')
        ?? url.searchParams.get('key');
    if (
        !config.personalProxyApiKey
        || !apiKey
        || !verifyToken(apiKey, config.personalProxyApiKey)
    ) {
        return geminiError(
            401,
            'API key not valid. Please pass a valid API key.',
            'UNAUTHENTICATED'
        );
    }

    // IN-02: sanity-bound the echoed model segment (post-auth so we don't reveal
    // anything to unauthenticated callers). It is echoed into modelVersion and logs;
    // reject path-injecting or absurdly long values before doing any work.
    if (model.length === 0 || model.includes('/') || model.length > 200) {
        return geminiError(400, 'Invalid model identifier.', 'INVALID_ARGUMENT');
    }

    // 2. Parse JSON body (D-07 step 2).
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return geminiError(400, 'Invalid JSON request body.', 'INVALID_ARGUMENT');
    }

    // 3. Scan parts (D-05/D-07): file_data anywhere → out-of-scope 400 (GEM-04);
    //    else capture the FIRST inline_data part with both data and mime_type.
    //    WR-02: typed narrowing on `unknown` instead of `any` so strict-mode /
    //    noUncheckedIndexedAccess guarantees still apply to every property access.
    const rawContents = (body as { contents?: unknown } | null | undefined)?.contents;
    const contents: unknown[] = Array.isArray(rawContents) ? rawContents : [];
    let inlineData: { data: string; mime_type: string } | null = null;
    for (const content of contents) {
        const rawParts = (content as { parts?: unknown } | null | undefined)?.parts;
        const parts: unknown[] = Array.isArray(rawParts) ? rawParts : [];
        for (const part of parts) {
            const partObj = part as { file_data?: unknown; inline_data?: unknown } | null | undefined;
            // WR-04: reject only when file_data is truthy — a `{ file_data: null }`
            // part that also carries valid inline_data must not be falsely rejected.
            if (partObj && partObj.file_data) {
                return geminiError(
                    400,
                    'file_data (Files API) input is not supported by this proxy.',
                    'INVALID_ARGUMENT'
                );
            }
            const id = partObj?.inline_data as { data?: unknown; mime_type?: unknown } | null | undefined;
            if (!inlineData && id
                && typeof id.data === 'string' && id.data
                && typeof id.mime_type === 'string' && id.mime_type) {
                inlineData = { data: id.data, mime_type: id.mime_type };
            }
        }
    }

    // 4. No inline audio part found → Gemini-shaped 400 (GEM-10).
    if (!inlineData) {
        return geminiError(400, 'No inline audio data found in request.', 'INVALID_ARGUMENT');
    }

    // 5. Decode base64 → File using native Buffer + File only (D-06, GEM-13).
    //    Filename is the literal 'audio' — never derived from untrusted input.
    //    WR-01: bound the *encoded* length before allocating the decoded buffer.
    //    base64 length * 3/4 ≈ decoded byte count, a safe upper-bound proxy, so an
    //    oversize payload is rejected before the ~18 MiB decode allocation (DoS).
    const audioMaxFileBytes = deps.audioMaxFileBytes;
    const approxBytes = Math.floor(inlineData.data.length * 3 / 4);
    if (approxBytes > audioMaxFileBytes) {
        return geminiError(
            400,
            `File too large. Maximum allowed size is ${audioMaxFileBytes} bytes.`,
            'INVALID_ARGUMENT'
        );
    }
    const bytes = Buffer.from(inlineData.data, 'base64');
    // HG-01: reject empty/zero-length decoded audio. Buffer.from(..., 'base64') is
    // lenient (never throws, silently drops non-alphabet chars), so garbage or
    // whitespace-only input can decode to 0 bytes and otherwise reach the sidecar.
    if (bytes.length === 0) {
        return geminiError(
            400,
            'Inline audio data is empty or not valid base64.',
            'INVALID_ARGUMENT'
        );
    }
    const file = new File([bytes], 'audio', { type: inlineData.mime_type });

    // 6. Size check (D-07/GEM-11) — reuse validateAudioFileSize.
    const sizeCheck = validateAudioFileSize(file, audioMaxFileBytes);
    if (!sizeCheck.ok) {
        return geminiError(400, sizeCheck.message, 'INVALID_ARGUMENT');
    }

    // 7. Transcribe (D-08/D-13). Do NOT require model === whisperModelAlias.
    const result = await deps.transcribeAudio({
        file,
        modelAlias: config.whisperModelAlias ?? model,
        maxBytes: audioMaxFileBytes,
    });

    if (!result.ok) {
        if (result.reason === 'too_large') {
            return geminiError(400, result.message, 'INVALID_ARGUMENT');
        }
        deps.logger.log('warn', {
            event: 'gemini_transcription_failed',
            requestId,
            route: `${request.method} ${pathname}`,
            modelAlias: model,
            fileSize: file.size,
            status: 503,
            latencyMs: Date.now() - requestStart,
        });
        return geminiError(503, 'Transcription service is unavailable.', 'UNAVAILABLE');
    }

    // 8. Success body (D-09/D-10/D-11). Estimated token counts; echo model in modelVersion.
    const estTokens = Math.ceil(result.text.length / 4);
    deps.logger.log('info', {
        event: 'gemini_transcription_complete',
        requestId,
        timestamp: new Date(requestStart).toISOString(),
        route: `${request.method} ${pathname}`,
        modelAlias: model,
        fileSize: file.size,
        status: 200,
        latencyMs: Date.now() - requestStart,
    });

    return new Response(
        JSON.stringify({
            candidates: [
                {
                    content: { role: 'model', parts: [{ text: result.text }] },
                    finishReason: 'STOP',
                    index: 0,
                },
            ],
            usageMetadata: {
                promptTokenCount: 0,
                candidatesTokenCount: estTokens,
                totalTokenCount: estTokens,
            },
            modelVersion: model,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}
