// Phase 8 compatibility shim — deleted in plan 08-04 Task 4.
// Forwards to the store held by the default container, which is the SAME instance every
// createServer() call without injected deps uses. That is what keeps resetForTesting()
// meaningful for the integration suite until the tests are rewired.
import { config } from "../config";
import { getDefaultContainer } from "../composition/container";
import type { ProviderId, ProviderState } from "../domain/types";

export type Provider = ProviderId;
export type { ProviderState };

const store = () => getDefaultContainer(config).store;

export function isEligible(provider: Provider, logicalModel: string): boolean {
    return store().isEligible(provider, logicalModel);
}

export function chooseEligibleProviders(logicalModel: string): Provider[] {
    return store().chooseEligibleProviders(logicalModel);
}

export function advanceCursor(): void {
    store().advanceCursor();
}

export function setCooldown(
    provider: Provider,
    untilMs: number,
    snapshot?: Record<string, string>
): void {
    store().setCooldown(provider, untilMs, snapshot);
}

export function setRateLimitSnapshot(provider: Provider, snapshot: Record<string, string>): void {
    store().setRateLimitSnapshot(provider, snapshot);
}

export function recordSuccess(provider: Provider, statusCode: number): void {
    store().recordSuccess(provider, statusCode);
}

export function recordFailure(provider: Provider, statusCode: number): void {
    store().recordFailure(provider, statusCode);
}

export function getStateSnapshot(): Record<Provider, ProviderState> {
    return store().getSnapshot();
}

export function resetForTesting(): void {
    store().reset();
}
