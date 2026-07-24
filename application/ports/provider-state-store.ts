// application/ports/provider-state-store.ts — port for provider routing state (HEX-07, HEX-08)
// Interface only. ProviderState is declared in domain/types.ts (domain may not import from
// application/, so the shape lives inward and is re-exported here for port consumers).
import type { ProviderId, ProviderState } from '../../domain/types';

export type { ProviderState };

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
