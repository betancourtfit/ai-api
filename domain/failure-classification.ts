// domain/failure-classification.ts — failover policy over a provider-agnostic failure (HEX-05)
// Pure: zero SDK imports. The instanceof checks against vendor APIError classes live only in
// adapters/outbound/sdk-error-mapper.ts. See ARCHITECTURE.md §5 (the de-vendoring seam).
import type { UpstreamFailure } from './types';

export interface FailureClassification {
    shouldFailover: boolean;
    status: number | undefined;
    headers: Record<string, string> | undefined;
    message: string | undefined;
}

export function classifyUpstreamFailure(failure: UpstreamFailure): FailureClassification {
    const failoverStatuses = new Set([408, 429, 498, 500, 502, 503, 504]);
    const noFailoverStatuses = new Set([400, 401, 403, 404, 413, 422]);

    if (noFailoverStatuses.has(failure.status ?? -1)) {
        return {
            shouldFailover: false,
            status: failure.status,
            headers: failure.headers,
            message: failure.message,
        };
    }

    if (failoverStatuses.has(failure.status ?? -1)) {
        return {
            shouldFailover: true,
            status: failure.status,
            headers: failure.headers,
            message: failure.message,
        };
    }

    // Unknown or absent status — fail over. Matches the pre-refactor default exactly.
    return {
        shouldFailover: true,
        status: failure.status,
        headers: failure.headers,
        message: failure.message,
    };
}
