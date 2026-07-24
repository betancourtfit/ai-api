// domain/provider-state.ts — provider eligibility, cooldowns, and the round-robin cursor
// as an injectable store (ROUTE-01..03, ROUTE-08, RL-05, HEX-04).
//
// Pure: no config import, no module-level mutable state, no ambient wall-clock read. Order, clock,
// configured-flags, and alias resolution are all injected. The returned object structurally
// satisfies application/ports/provider-state-store.ts — domain does not import that port,
// because domain may not depend on application/ (ARCHITECTURE.md §2).
import type { ProviderId, ProviderState } from './types';

// WR-01: circuit-breaker threshold — after 5 consecutive transient failures mark provider unhealthy
// so the round-robin router stops selecting it. isEligible() gates on entry.healthy; the provider
// recovers when recordSuccess() resets consecutiveFailures and healthy back to true.
const CONSECUTIVE_FAILURE_THRESHOLD = 5;

export interface ProviderStateStoreDeps {
    order: ProviderId[];
    clock: { now(): number };
    configured: Record<ProviderId, boolean>;
    resolveUpstreamModel(alias: string, provider: string): string | undefined;
}

export interface ProviderStateStoreInstance {
    isEligible(provider: ProviderId, logicalModel: string): boolean;
    chooseEligibleProviders(logicalModel: string): ProviderId[];
    advanceCursor(): void;
    setCooldown(provider: ProviderId, untilMs: number, snapshot?: Record<string, string>): void;
    setRateLimitSnapshot(provider: ProviderId, snapshot: Record<string, string>): void;
    recordSuccess(provider: ProviderId, statusCode: number): void;
    recordFailure(provider: ProviderId, statusCode: number): void;
    getSnapshot(): Record<ProviderId, ProviderState>;
    reset(): void;
}

export function createProviderStateStore(deps: ProviderStateStoreDeps): ProviderStateStoreInstance {
    const providerOrder = deps.order;

    function buildInitialState(): Record<ProviderId, ProviderState> {
        return {
            cerebras: {
                provider: "cerebras",
                enabled: true,
                configured: deps.configured.cerebras,
                healthy: true,
                cooldownUntil: null,
                lastSelectedAt: null,
                lastSuccessAt: null,
                lastFailureAt: null,
                lastStatusCode: null,
                consecutiveFailures: 0,
            },
            groq: {
                provider: "groq",
                enabled: true,
                configured: deps.configured.groq,
                healthy: true,
                cooldownUntil: null,
                lastSelectedAt: null,
                lastFailureAt: null,
                lastSuccessAt: null,
                lastStatusCode: null,
                consecutiveFailures: 0,
            },
        };
    }

    let state = buildInitialState();
    let roundRobinCursor = 0;

    function isEligible(provider: ProviderId, logicalModel: string): boolean {
        const entry = state[provider];
        if (!entry.configured || !entry.enabled) return false;
        if (!deps.resolveUpstreamModel(logicalModel, provider)) return false;

        if (entry.cooldownUntil !== null) {
            if (deps.clock.now() < entry.cooldownUntil) return false;
            entry.cooldownUntil = null;
            entry.healthy = true;
        }

        return entry.healthy;
    }

    return {
        isEligible,

        chooseEligibleProviders(logicalModel: string): ProviderId[] {
            const rotatedOrder = providerOrder.map((_, index) => (
                providerOrder[(roundRobinCursor + index) % providerOrder.length]
            ));

            const eligible = rotatedOrder.filter((provider): provider is ProviderId => (
                provider !== undefined && isEligible(provider, logicalModel)
            ));

            // WR-05: stamp lastSelectedAt for each provider added to the result list so
            // the diagnostics endpoint reports accurate selection times (not always null).
            const now = deps.clock.now();
            for (const provider of eligible) {
                state[provider].lastSelectedAt = now;
            }

            return eligible;
        },

        advanceCursor(): void {
            roundRobinCursor = (roundRobinCursor + 1) % providerOrder.length;
        },

        setCooldown(provider: ProviderId, untilMs: number, snapshot?: Record<string, string>): void {
            state[provider].cooldownUntil = untilMs;
            state[provider].healthy = false;
            if (snapshot) {
                state[provider].rateLimitSnapshot = { ...snapshot };
            }
        },

        setRateLimitSnapshot(provider: ProviderId, snapshot: Record<string, string>): void {
            state[provider].rateLimitSnapshot = { ...snapshot };
        },

        recordSuccess(provider: ProviderId, statusCode: number): void {
            state[provider].healthy = true;
            state[provider].cooldownUntil = null;
            state[provider].lastSuccessAt = deps.clock.now();
            state[provider].lastStatusCode = statusCode;
            state[provider].consecutiveFailures = 0;
        },

        recordFailure(provider: ProviderId, statusCode: number): void {
            state[provider].lastFailureAt = deps.clock.now();
            state[provider].lastStatusCode = statusCode;
            state[provider].consecutiveFailures += 1;
            if (state[provider].consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
                state[provider].healthy = false;
            }
        },

        getSnapshot(): Record<ProviderId, ProviderState> {
            return structuredClone(state);
        },

        reset(): void {
            state = buildInitialState();
            roundRobinCursor = 0;
        },
    };
}
