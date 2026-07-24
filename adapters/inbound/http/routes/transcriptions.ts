// adapters/inbound/http/routes/transcriptions.ts
// POST /v1/audio/transcriptions — multipart transcription endpoint (EP2-01).
// Owns only the OpenAI wire shapes; the transcription itself is application/use-cases/transcribe-audio.ts.
import { config } from '../../../../config';
import { validateAudioFileSize, validateAudioTranscription } from '../schemas/audio-schema';
import { openaiError } from '../presenters/openai-error';
import type { RouteContext } from '../context';

export function matchTranscriptions(method: string, pathname: string): boolean {
    return method === 'POST' && pathname === '/v1/audio/transcriptions';
}

export async function handleTranscriptions(ctx: RouteContext): Promise<Response> {
    const { request, requestId, requestStart, deps } = ctx;
    const pathname = ctx.url.pathname;

    let formData: Awaited<ReturnType<typeof request.formData>>;
    try {
        formData = await request.formData();
    } catch {
        return openaiError(
            'Failed to parse multipart form data.',
            'invalid_request_error',
            'invalid_request_error',
            null,
            400
        );
    }

    const rawInput: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
        rawInput[key] = value;
    }

    const validation = validateAudioTranscription(rawInput);
    if (!validation.success) {
        return openaiError(
            validation.message,
            'invalid_request_error',
            'invalid_request_error',
            validation.param,
            400
        );
    }

    const input = validation.data;

    // Order is load-bearing and matches the pre-refactor flow exactly (index.ts:402-423):
    // size rejection precedes the alias check, so an oversize body is never transcribed and
    // an unknown alias never reaches the transcription port.
    const sizeCheck = validateAudioFileSize(input.file, deps.audioMaxFileBytes);
    if (!sizeCheck.ok) {
        return openaiError(
            sizeCheck.message,
            'invalid_request_error',
            'request_too_large',
            'file',
            413
        );
    }

    const isKnownWhisperAlias = config.whisperModelAlias !== null
        && input.model === config.whisperModelAlias;
    if (!isKnownWhisperAlias) {
        return openaiError(
            `Unknown model '${input.model}'.`,
            'invalid_request_error',
            'model_not_found',
            'model',
            400
        );
    }

    const result = await deps.transcribeAudio({
        file: input.file,
        modelAlias: input.model,
        maxBytes: deps.audioMaxFileBytes,
    });

    if (!result.ok) {
        // reason is 'unavailable' here — 'too_large' was already rejected above with a 413.
        deps.logger.log('warn', {
            event: 'transcription_failed',
            requestId,
            modelAlias: input.model,
            fileSize: input.file.size,
            status: 503,
            latencyMs: Date.now() - requestStart,
        });
        return openaiError(
            'Transcription service is unavailable.',
            'server_error',
            'service_unavailable',
            null,
            503
        );
    }

    deps.logger.log('info', {
        event: 'transcription_complete',
        requestId,
        timestamp: new Date(requestStart).toISOString(),
        route: `${request.method} ${pathname}`,
        modelAlias: input.model,
        fileSize: input.file.size,
        status: 200,
        latencyMs: Date.now() - requestStart,
    });

    return new Response(JSON.stringify({ text: result.text }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
