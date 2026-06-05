// routing/provider-state.ts — ProviderState, eligibility, round-robin cursor, resetForTesting() (ROUTE-01..03, ROUTE-08, RL-05)
import { config } from "../config";
import { resolveUpstreamModel } from "../model-registry";

export type Provider = "cerebras" | "groq";

export interface ProviderState {
    provider: Provider;
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

const providerOrder = config.providerOrder as Provider[];

let state = buildInitialState();
let roundRobinCursor = 0;

export function isEligible(provider: Provider, logicalModel: string): boolean {
    const entry = state[provider];
    if (!entry.configured || !entry.enabled) return false;
    if (!resolveUpstreamModel(logicalModel, provider)) return false;

    if (entry.cooldownUntil !== null) {
        if (Date.now() < entry.cooldownUntil) return false;
        entry.cooldownUntil = null;
        entry.healthy = true;
    }

    return entry.healthy;
}

export function chooseEligibleProviders(logicalModel: string): Provider[] {
    const rotatedOrder = providerOrder.map((_, index) => (
        providerOrder[(roundRobinCursor + index) % providerOrder.length]
    ));

    return rotatedOrder.filter((provider): provider is Provider => (
        provider !== undefined && isEligible(provider, logicalModel)
    ));
}

export function advanceCursor(): void {
    roundRobinCursor = (roundRobinCursor + 1) % providerOrder.length;
}

export function setCooldown(
    provider: Provider,
    untilMs: number,
    snapshot?: Record<string, string>
): void {
    state[provider].cooldownUntil = untilMs;
    state[provider].healthy = false;
    if (snapshot) {
        state[provider].rateLimitSnapshot = { ...snapshot };
    }
}

export function setRateLimitSnapshot(provider: Provider, snapshot: Record<string, string>): void {
    state[provider].rateLimitSnapshot = { ...snapshot };
}

export function recordSuccess(provider: Provider, statusCode: number): void {
    state[provider].healthy = true;
    state[provider].cooldownUntil = null;
    state[provider].lastSuccessAt = Date.now();
    state[provider].lastStatusCode = statusCode;
    state[provider].consecutiveFailures = 0;
}

export function recordFailure(provider: Provider, statusCode: number): void {
    state[provider].lastFailureAt = Date.now();
    state[provider].lastStatusCode = statusCode;
    state[provider].consecutiveFailures += 1;
}

export function getStateSnapshot(): Record<Provider, ProviderState> {
    return structuredClone(state);
}

export function resetForTesting(): void {
    state = buildInitialState();
    roundRobinCursor = 0;
}

function buildInitialState(): Record<Provider, ProviderState> {
    return {
        cerebras: {
            provider: "cerebras",
            enabled: true,
            configured: true,
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
            configured: true,
            healthy: true,
            cooldownUntil: null,
            lastSelectedAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastStatusCode: null,
            consecutiveFailures: 0,
        },
    };
}
