// application/use-cases/provider-rate-limits.ts — shared helper for the two chat use cases.
// Dispatches on ProviderId to the matching pure domain parser, then flattens the parsed
// numbers into the string snapshot the diagnostics endpoint exposes.
import { parseCerebrasHeaders, parseGroqHeaders } from '../../domain/rate-limits';
import type { ProviderId } from '../../domain/types';

export function parseRateLimitHeaders(provider: ProviderId, headers: Record<string, string>) {
    return provider === 'cerebras'
        ? parseCerebrasHeaders(headers)
        : parseGroqHeaders(headers);
}

export function toRateLimitSnapshot(parsed: Record<string, number | undefined>): Record<string, string> {
    const snapshot: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) {
            snapshot[key] = String(value);
        }
    }

    return snapshot;
}
