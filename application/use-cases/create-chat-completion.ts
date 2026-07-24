// application/use-cases/create-chat-completion.ts — non-streaming provider orchestration.
// Transport-free (HEX-09): returns a discriminated domain result, never an HTTP response.
// The loop below is the pre-refactor index.ts non-streaming path, moved verbatim with the
// module-level imports replaced by injected dependencies.
import { classifyUpstreamFailure } from '../../domain/failure-classification';
import { calcCooldownMs } from '../../domain/rate-limits';
import { normalizeResponse } from '../../domain/normalization';
import { parseRateLimitHeaders, toRateLimitSnapshot } from './provider-rate-limits';
import type { ChatCompletionResult, ProviderId } from '../../domain/types';
import type { ChatUseCaseDeps, ChatUseCaseInput, NoProvider, UpstreamRejected } from './chat-deps';

export type CreateChatCompletionResult =
    | {
        ok: true;
        response: ChatCompletionResult;
        provider: ProviderId;
        upstreamModelId: string;
        attempt: number;
        failoverReason: string | null;
    }
    | NoProvider
    | UpstreamRejected;

export function createChatCompletion(deps: ChatUseCaseDeps) {
    return async function run(input: ChatUseCaseInput): Promise<CreateChatCompletionResult> {
        const { logicalAlias, params, requestId, route, requestStart } = input;
        const { store, registry, logger, clock } = deps;

        const candidates = store.chooseEligibleProviders(logicalAlias);
        // WR-02: do NOT advance cursor unconditionally here — cursor is advanced after
        // each failed provider attempt so that on recovery the next request starts from
        // the provider after the one that last failed, not from a stale pre-eligibility-check position.

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
                streaming: false,
                statusCode: 503,
                latencyMs: clock.now() - requestStart,
                failoverReason: null,
                usage: null,
            });
            return { ok: false, kind: 'no_provider', attempt: 0, failoverReason: null };
        }

        let attempt = 0;
        let failoverReason: string | null = null;

        for (const provider of candidates.slice(0, deps.maxAttempts)) {
            const upstreamModelId = registry.resolveUpstreamModel(logicalAlias, provider);
            if (!upstreamModelId) continue;
            const adapter = deps.providers[provider];
            attempt++;

            try {
                const { result, headers } = await adapter.complete(upstreamModelId, params);
                const parsed = parseRateLimitHeaders(provider, headers);
                const snapshot = toRateLimitSnapshot(parsed as Record<string, number | undefined>);

                store.setRateLimitSnapshot(provider, snapshot);
                store.recordSuccess(provider, 200);
                store.advanceCursor(); // WR-02: advance after successful selection for next request's round-robin

                // D-08: warn when upstream omits usage
                if (result.usage === undefined) {
                    logger.log('warn', { event: 'usage_missing', provider, requestId });
                }

                const normalized = normalizeResponse(result, logicalAlias);

                // OBS-02: request-completion log for non-streaming success
                logger.log('info', {
                    event: 'request_complete',
                    requestId,
                    timestamp: new Date(requestStart).toISOString(),
                    route,
                    logicalAlias,
                    provider,
                    upstreamModelId,
                    attempt,
                    streaming: false,
                    statusCode: 200,
                    latencyMs: clock.now() - requestStart,
                    failoverReason,
                    usage: normalized.usage,
                });

                return {
                    ok: true,
                    response: normalized,
                    provider,
                    upstreamModelId,
                    attempt,
                    failoverReason,
                };
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

        // OBS-02: request-completion log for exhaustion path
        logger.log('info', {
            event: 'request_complete',
            requestId,
            timestamp: new Date(requestStart).toISOString(),
            route,
            logicalAlias,
            provider: null,
            upstreamModelId: null,
            attempt,
            streaming: false,
            statusCode: 503,
            latencyMs: clock.now() - requestStart,
            failoverReason,
            usage: null,
        });

        return { ok: false, kind: 'no_provider', attempt, failoverReason };
    };
}
