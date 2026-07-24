// application/use-cases/get-readiness.ts — readiness computation, transport-free (HEX-09).
import type { ProviderId } from '../../domain/types';
import type { ProviderStateStore } from '../ports/provider-state-store';
import type { TranscriptionPort } from '../ports/transcription';

export interface GetReadinessDeps {
    store: ProviderStateStore;
    transcription: TranscriptionPort;
    listAliases(): string[];
    proxyKeyConfigured: boolean;
}

export interface Readiness {
    ready: boolean;
    mode: 'not_configured' | 'ok' | 'degraded';
    eligibleProviders: ProviderId[];
    unavailableProviders: ProviderId[];
    whisperAvailable: boolean;
}

export function getReadiness(deps: GetReadinessDeps) {
    return async function run(): Promise<Readiness> {
        const logicalModel = deps.listAliases()[0] ?? '';
        const proxyKeyConfigured = deps.proxyKeyConfigured;
        const eligibleProviders = (['cerebras', 'groq'] as ProviderId[]).filter((provider) => (
            deps.store.isEligible(provider, logicalModel)
        ));
        const unavailableProviders = (['cerebras', 'groq'] as ProviderId[]).filter((provider) => (
            !eligibleProviders.includes(provider)
        ));
        const ready = proxyKeyConfigured && eligibleProviders.length > 0;
        const mode = !proxyKeyConfigured
            ? 'not_configured'
            : unavailableProviders.length === 0 ? 'ok' : 'degraded';
        const whisperAvailable = await deps.transcription.health();

        return { ready, mode, eligibleProviders, unavailableProviders, whisperAvailable };
    };
}
