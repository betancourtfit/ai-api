// Phase 8 compatibility shim — removed in plan 08-04.
// Domain: domain/rate-limits.ts + domain/failure-classification.ts
// Adapter: adapters/outbound/sdk-error-mapper.ts (the only vendor-aware module)
//
// This shim keeps every legacy export name and signature so index.ts and
// tests/routing/cooldown-manager.test.ts continue to work unchanged, including the
// tolerance for Headers / plain-record / { get() } inputs.
import {
    calcCooldownMs as calcCooldownMsDomain,
    parseCerebrasHeaders as parseCerebrasHeadersDomain,
    parseGroqHeaders as parseGroqHeadersDomain,
} from "../domain/rate-limits";
import { classifyUpstreamFailure } from "../domain/failure-classification";
import { rawSdkErrorHeaders, toHeaderRecord, toUpstreamFailure } from "../adapters/outbound/sdk-error-mapper";
import type { ParsedCerebrasHeaders, ParsedGroqHeaders } from "../domain/rate-limits";

type HeaderSource =
    | Headers
    | Record<string, string | string[] | null | undefined>
    | { get(name: string): string | null | undefined };

export type { HeaderSource };
export type { ParsedCerebrasHeaders, ParsedGroqHeaders };

export const calcCooldownMs = calcCooldownMsDomain;

export function parseCerebrasHeaders(headers: HeaderSource): ParsedCerebrasHeaders {
    return parseCerebrasHeadersDomain(toHeaderRecord(headers) ?? {});
}

export function parseGroqHeaders(headers: HeaderSource): ParsedGroqHeaders {
    return parseGroqHeadersDomain(toHeaderRecord(headers) ?? {});
}

export function classifyError(err: unknown): {
    shouldFailover: boolean;
    status: number | undefined;
    headers: HeaderSource | undefined;
    message: string | undefined;
} {
    const classified = classifyUpstreamFailure(toUpstreamFailure(err));

    // Legacy contract: hand back the SDK error's own header object by reference.
    // Callers pass it straight into parseCerebrasHeaders/parseGroqHeaders above, which
    // re-flatten it. Plan 08-04 removes this shim and the raw-header passthrough with it.
    const rawHeaders = rawSdkErrorHeaders(err);

    return {
        shouldFailover: classified.shouldFailover,
        status: classified.status,
        headers: rawHeaders === undefined || rawHeaders === null
            ? undefined
            : rawHeaders as HeaderSource,
        message: classified.message,
    };
}
