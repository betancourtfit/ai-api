// application/use-cases/stream-chat-completion.ts — streaming provider orchestration.
// Transport-free (HEX-09): yields StreamChunk objects, never SSE text. The presenter owns every
// byte of Server-Sent-Events framing, including the terminating sentinel.
//
// Selection loop and generator body are the pre-refactor index.ts streaming path, moved verbatim
// with module-level imports replaced by injected dependencies. The generator NEVER throws: on
// error it logs and returns, so the presenter can always close the stream cleanly (CR-03).
import { classifyUpstreamFailure } from '../../domain/failure-classification';
import { calcCooldownMs } from '../../domain/rate-limits';
import { normalizeChunk } from '../../domain/normalization';
import { parseRateLimitHeaders, toRateLimitSnapshot } from './provider-rate-limits';
import type { ProviderId, StreamChunk } from '../../domain/types';
import type { ChatUseCaseDeps, ChatUseCaseInput, NoProvider, UpstreamRejected } from './chat-deps';

export type StreamChatCompletionResult =
    | {
        ok: true;
        provider: ProviderId;
        upstreamModelId: string;
        attempt: number;
        failoverReason: string | null;
        chunks: AsyncIterable<StreamChunk>;
    }
    | NoProvider
    | UpstreamRejected;

function hasVisibleChunkData(chunk: StreamChunk): boolean {
    return chunk.choices.some((choice) => (
        choice.finish_reason !== null
        || choice.delta.role !== undefined
        || choice.delta.content !== undefined
    ));
}

export function streamChatCompletion(deps: ChatUseCaseDeps) {
    return async function run(
        input: ChatUseCaseInput,
        signal: AbortSignal
    ): Promise<StreamChatCompletionResult> {
        const { logicalAlias, params, requestId, route, requestStart } = input;
        const { store, registry, logger, clock } = deps;

        const candidates = store.chooseEligibleProviders(logicalAlias);
        // WR-02: cursor advances after each attempt, not before the eligibility check.

        if (candidates.length === 0) {
            logger.log('info', {
                event: 'request_complete',
                requestId,
                timestamp: new Date(requestStart).toISOString(),
                route,
                logicalAlias,
                provider: null,
                upstreamModelId: null,
                attempt: 0,
                streaming: true,
                statusCode: 503,
                latencyMs: clock.now() - requestStart,
                failoverReason: null,
                usage: null,
            });
            return { ok: false, kind: 'no_provider', attempt: 0, failoverReason: null };
        }

        let chosenProvider: ProviderId | null = null;
        let chosenUpstreamModelId: string | null = null;
        let sdkStream: AsyncIterable<StreamChunk> | null = null;
        let attemptCount = 0;
        let failoverReason: string | null = null;

        for (const provider of candidates.slice(0, deps.maxAttempts)) {
            const upstreamModelId = registry.resolveUpstreamModel(logicalAlias, provider);
            if (!upstreamModelId) continue;
            const adapter = deps.providers[provider];
            attemptCount++;

            try {
                sdkStream = await adapter.stream(upstreamModelId, params, signal);
                chosenProvider = provider;
                chosenUpstreamModelId = upstreamModelId;
                store.advanceCursor(); // WR-02: advance after successful selection for next request's round-robin
                break;
            } catch (err) {
                const classified = classifyUpstreamFailure(deps.toFailure(err));
                store.recordFailure(provider, classified.status ?? 0);
                // WR-02: advance cursor after each failed attempt so the next request
                // does not restart from the same failing provider.
                store.advanceCursor();

                if (!classified.shouldFailover) {
                    // D-07: pass upstream error message through with model-ID de-leaking
                    return {
                        ok: false,
                        kind: 'upstream_rejected',
                        status: classified.status ?? 502,
                        message: registry.rewriteUpstreamModelIds(
                            classified.message ?? 'Upstream provider rejected the request.'
                        ),
                    };
                }

                if (classified.status === 429 || classified.status === 498) {
                    // CR-02: always apply cooldown — use DEFAULT_COOLDOWN_SECONDS
                    // when headers are absent (CLAUDE.md §13.3)
                    const parsed = classified.headers
                        ? parseRateLimitHeaders(provider, classified.headers)
                        : {};
                    const snapshot = classified.headers
                        ? toRateLimitSnapshot(parsed as Record<string, number | undefined>)
                        : {};
                    const cooldownMs = calcCooldownMs(parsed, deps.defaultCooldownSeconds);
                    const cooldownUntil = clock.now() + cooldownMs;

                    store.setCooldown(provider, cooldownUntil,
                        Object.keys(snapshot).length > 0 ? snapshot : undefined);
                    failoverReason = `status_${classified.status}`;
                    logger.log('warn', {
                        event: 'provider_cooldown',
                        requestId,
                        provider,
                        status: classified.status,
                        cooldownUntil: new Date(cooldownUntil).toISOString(),
                    });
                    continue;
                }

                failoverReason = `status_${classified.status ?? 'unknown'}`;
                logger.log('warn', {
                    event: 'provider_failover',
                    requestId,
                    provider,
                    status: classified.status,
                });
            }
        }

        if (!sdkStream || !chosenProvider || !chosenUpstreamModelId) {
            logger.log('info', {
                event: 'request_complete',
                requestId,
                timestamp: new Date(requestStart).toISOString(),
                route,
                logicalAlias,
                provider: null,
                upstreamModelId: null,
                attempt: attemptCount,
                streaming: true,
                statusCode: 503,
                latencyMs: clock.now() - requestStart,
                failoverReason,
                usage: null,
            });
            return { ok: false, kind: 'no_provider', attempt: attemptCount, failoverReason };
        }

        // Capture for closure (TypeScript narrowing)
        const upstream = sdkStream;
        const finalProvider = chosenProvider;
        const finalUpstreamModelId = chosenUpstreamModelId;
        const finalAttemptCount = attemptCount;
        const finalFailoverReason = failoverReason;

        const chunks = (async function* (): AsyncGenerator<StreamChunk> {
            let firstChunkSent = false;
            let streamUsage: unknown = null;

            try {
                for await (const chunk of upstream) {
                    // WR-02: capture usage from terminal chunk (choices:[], usage:{...})
                    // before the hasVisibleChunkData check discards it.
                    const rawChunk = chunk as unknown as Record<string, unknown>;
                    if (rawChunk['usage'] &&
                            Array.isArray(rawChunk['choices']) &&
                            (rawChunk['choices'] as unknown[]).length === 0) {
                        streamUsage = rawChunk['usage'];
                        continue; // terminal usage chunk — not forwarded downstream
                    }

                    const normalized = normalizeChunk(chunk, logicalAlias);
                    if (!hasVisibleChunkData(normalized)) {
                        continue;
                    }
                    if (!firstChunkSent) {
                        // WR-01: record success only after first real data is received —
                        // adapter.stream() resolves without consuming bytes, so a
                        // stream-open failure would commit a false success record.
                        store.recordSuccess(finalProvider, 200);
                        firstChunkSent = true;
                    }
                    yield normalized;
                }

                // WR-01: if stream completed without any visible chunks, still mark success
                if (!firstChunkSent) {
                    store.recordSuccess(finalProvider, 200);
                }

                // OBS-02: emit request-completion log after the last chunk — total stream duration
                logger.log('info', {
                    event: 'request_complete',
                    requestId,
                    timestamp: new Date(requestStart).toISOString(),
                    route,
                    logicalAlias,
                    provider: finalProvider,
                    upstreamModelId: finalUpstreamModelId,
                    attempt: finalAttemptCount,
                    streaming: true,
                    statusCode: 200,
                    latencyMs: clock.now() - requestStart,
                    failoverReason: finalFailoverReason,
                    usage: streamUsage,
                });
            } catch (err) {
                // CR-03: log unconditionally regardless of firstChunkSent. When firstChunkSent=true,
                // a mid-stream error must still let the presenter close the SSE stream gracefully
                // so clients don't hang waiting for the sentinel. This generator never rethrows.
                const classified = classifyUpstreamFailure(deps.toFailure(err));
                logger.log('warn', {
                    event: firstChunkSent
                        ? 'stream_error_after_first_chunk'
                        : 'stream_error_before_first_chunk',
                    requestId,
                    provider: finalProvider,
                    status: classified.status,
                });

                // OBS-02: emit request-complete log for all stream error paths
                logger.log('info', {
                    event: 'request_complete',
                    requestId,
                    timestamp: new Date(requestStart).toISOString(),
                    route,
                    logicalAlias,
                    provider: finalProvider,
                    upstreamModelId: finalUpstreamModelId,
                    attempt: finalAttemptCount,
                    streaming: true,
                    statusCode: classified.status ?? 500,
                    latencyMs: clock.now() - requestStart,
                    failoverReason: finalFailoverReason,
                    usage: streamUsage,
                });
                // Return normally — the presenter appends the sentinel.
            }
        })();

        return {
            ok: true,
            provider: finalProvider,
            upstreamModelId: finalUpstreamModelId,
            attempt: finalAttemptCount,
            failoverReason: finalFailoverReason,
            chunks,
        };
    };
}
