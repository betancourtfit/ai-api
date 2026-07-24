// application/ports/provider-state-store.ts — port for provider routing state (HEX-07, HEX-08)
// Interface only. ProviderState moved verbatim from routing/provider-state.ts:7-19.
import type { ProviderId } from '../../domain/types';

export interface ProviderState {
    provider: ProviderId;
    enabled: boolean;
    configured: boolean;
    healthy: boolean;
    cooldownUntil: number | null;
    lastSelectedAt: number | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    lastStatusCode: number | null;
    consecutiveFailures: number;
    rateLimitSnapshot?: Record<string, string>;
}

export interface ProviderStateStore {
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
