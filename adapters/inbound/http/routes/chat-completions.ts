// adapters/inbound/http/routes/chat-completions.ts
// POST /v1/chat/completions — the main completion endpoint.
// This route owns TRANSPORT only: size limits, body read, JSON parse, schema validation, alias
// resolution, and the mapping of a domain result onto an HTTP response. Provider selection,
// failover, cooldown, and normalization all live in the two chat use cases.
import { validateChatCompletion } from '../schemas/request-schema';
import { readLimitedBody } from '../read-limited-body';
import { openaiError } from '../presenters/openai-error';
import { sseHeaders, toSseStream } from '../presenters/sse';
import type { CompletionParams } from '../../../../domain/types';
import type { RouteContext } from '../context';

export function matchChatCompletions(method: string, pathname: string): boolean {
    return method === 'POST' && pathname === '/v1/chat/completions';
}

export async function handleChatCompletions(ctx: RouteContext): Promise<Response> {
    const { request, requestId, requestStart, server, deps } = ctx;
    const pathname = ctx.url.pathname;

    // WHSP-05: enforce the chat limit on actual buffered bytes — the header is not trusted.
    // Optional fast-fail on clearly valid numeric headers to avoid buffering obviously-large requests.
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > deps.maxRequestBodyBytes) {
        return openaiError(
            `Request body too large. Maximum is ${deps.maxRequestBodyBytes} bytes.`,
            'invalid_request_error',
            'request_too_large',
            null,
            413
        );
    }

    const bodyRead = await readLimitedBody(request, deps.maxRequestBodyBytes);
    if (!bodyRead.ok) {
        if (bodyRead.reason === 'too_large') {
            return openaiError(
                `Request body too large. Maximum is ${deps.maxRequestBodyBytes} bytes.`,
                'invalid_request_error',
                'request_too_large',
                null,
                413
            );
        }
        return openaiError(
            'Failed to read request body.',
            'invalid_request_error',
            'invalid_request_error',
            null,
            400
        );
    }

    // Parse JSON body from the already-buffered raw string
    let body: unknown;
    try {
        body = JSON.parse(bodyRead.text);
    } catch {
        return openaiError(
            'Request body must be valid JSON.',
            'invalid_request_error',
            'invalid_request_error',
            null,
            400
        );
    }

    // VALID-01/02: validate against strict Zod schema (first-error, D-05)
    const validation = validateChatCompletion(body);
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

    // OPT-IN default alias: client may omit `model`; fall back to DEFAULT_MODEL_ALIAS.
    // When neither is present, reject before any upstream call.
    const requestedModel = input.model ?? deps.defaultModelAlias ?? undefined;
    if (requestedModel === undefined) {
        return openaiError(
            'Missing required parameter: model (and no DEFAULT_MODEL_ALIAS configured).',
            'invalid_request_error',
            'invalid_request_error',
            'model',
            400
        );
    }

    // VALID-01: unknown model alias — reject before any upstream call
    if (!deps.isKnownAlias(requestedModel)) {
        return openaiError(
            `Unknown model '${requestedModel}'.`,
            'invalid_request_error',
            'model_not_found',
            'model',
            400
        );
    }

    // D-04: inject default max_completion_tokens if client omitted it
    const max_completion_tokens = input.max_completion_tokens ?? deps.defaultMaxCompletionTokens;

    const params: CompletionParams = {
        messages: input.messages,
        temperature: input.temperature ?? null,
        top_p: input.top_p ?? null,
        max_completion_tokens,
        stop: input.stop ?? null,
        seed: input.seed ?? null,
    };

    const useCaseInput = {
        logicalAlias: requestedModel,
        params,
        requestId,
        route: `${request.method} ${pathname}`,
        requestStart,
    };

    if (input.stream === true) {
        const controller = new AbortController();
        request.signal.addEventListener('abort', () => controller.abort(), { once: true });

        const streamed = await deps.streamChatCompletion(useCaseInput, controller.signal);

        if (!streamed.ok) {
            return chatFailureResponse(streamed);
        }

        server.timeout(request, 0);

        return new Response(toSseStream(streamed.chunks), {
            status: 200,
            headers: sseHeaders({
                requestId,
                provider: streamed.provider,
                exposeProvider: deps.exposeProviderHeader,
            }),
        });
    }

    const completed = await deps.createChatCompletion(useCaseInput);

    if (!completed.ok) {
        return chatFailureResponse(completed);
    }

    // OBS-05: X-LLM-Provider conditional on config.exposeProviderHeader
    const responseHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(deps.exposeProviderHeader ? { 'X-LLM-Provider': completed.provider } : {}),
    };

    return new Response(
        JSON.stringify(completed.response),
        { status: 200, headers: responseHeaders }
    );
}

/** Map a failed chat use-case result onto the OpenAI error wire shape. */
function chatFailureResponse(
    result: { kind: 'upstream_rejected'; status: number; message: string } | { kind: 'no_provider' }
): Response {
    if (result.kind === 'upstream_rejected') {
        // D-07: the message already had upstream model IDs rewritten by the use case.
        return openaiError(
            result.message,
            'invalid_request_error',
            'upstream_error',
            null,
            result.status
        );
    }

    return openaiError(
        'No eligible provider available for the requested model.',
        'server_error',
        'no_provider_available',
        'model',
        503
    );
}
