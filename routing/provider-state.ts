// Phase 8 compatibility shim — removed in plan 08-04.
// Domain: domain/provider-state.ts (createProviderStateStore)
//
// Holds the ONE default store instance, matching today's module-global lifetime exactly,
// and forwards every legacy export — including resetForTesting(), which tests call in
// beforeEach. Plan 08-04 moves this instance into composition/container.ts.
import { config } from "../config";
import { resolveUpstreamModel } from "../model-registry";
import { createProviderStateStore } from "../domain/provider-state";
import type { ProviderId, ProviderState } from "../domain/types";

export type Provider = ProviderId;
export type { ProviderState };

const defaultStore = createProviderStateStore({
    order: config.providerOrder as ProviderId[],
    clock: { now: () => Date.now() },
    configured: {
        cerebras: Boolean(config.cerebrasApiKey),
        groq: Boolean(config.groqApiKey),
    },
    resolveUpstreamModel,
});

export function isEligible(provider: Provider, logicalModel: string): boolean {
    return defaultStore.isEligible(provider, logicalModel);
}

export function chooseEligibleProviders(logicalModel: string): Provider[] {
    return defaultStore.chooseEligibleProviders(logicalModel);
}

export function advanceCursor(): void {
    defaultStore.advanceCursor();
}

export function setCooldown(
    provider: Provider,
    untilMs: number,
    snapshot?: Record<string, string>
): void {
    defaultStore.setCooldown(provider, untilMs, snapshot);
}

export function setRateLimitSnapshot(provider: Provider, snapshot: Record<string, string>): void {
    defaultStore.setRateLimitSnapshot(provider, snapshot);
}

export function recordSuccess(provider: Provider, statusCode: number): void {
    defaultStore.recordSuccess(provider, statusCode);
}

export function recordFailure(provider: Provider, statusCode: number): void {
    defaultStore.recordFailure(provider, statusCode);
}

export function getStateSnapshot(): Record<Provider, ProviderState> {
    return defaultStore.getSnapshot();
}

export function resetForTesting(): void {
    defaultStore.reset();
}
