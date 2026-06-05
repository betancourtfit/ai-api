// routing/cooldown-manager.ts — rate-limit header parsers, cooldown calc, error classification (RL-01..04, ROUTE-05/06)
import { APIError as CerebrasAPIError } from "@cerebras/cerebras_cloud_sdk";
import { APIError as GroqAPIError } from "groq-sdk";

type HeaderSource =
    | Headers
    | Record<string, string | string[] | null | undefined>
    | { get(name: string): string | null | undefined };

export type { HeaderSource };

export interface ParsedCerebrasHeaders {
    remainingRequestsDay?: number;
    remainingTokensMinute?: number;
    resetRequestsDaySeconds?: number;
    resetTokensMinuteSeconds?: number;
}

export interface ParsedGroqHeaders {
    remainingRequests?: number;
    remainingTokens?: number;
    resetRequestsSeconds?: number;
    resetTokensSeconds?: number;
    retryAfterSeconds?: number;
}

export function parseCerebrasHeaders(headers: HeaderSource): ParsedCerebrasHeaders {
    return {
        remainingRequestsDay: toFloat(readHeader(headers, "x-ratelimit-remaining-requests-day")),
        remainingTokensMinute: toFloat(readHeader(headers, "x-ratelimit-remaining-tokens-minute")),
        resetRequestsDaySeconds: toFloat(readHeader(headers, "x-ratelimit-reset-requests-day")),
        resetTokensMinuteSeconds: toFloat(readHeader(headers, "x-ratelimit-reset-tokens-minute")),
    };
}

export function parseGroqHeaders(headers: HeaderSource): ParsedGroqHeaders {
    return {
        remainingRequests: toNum(readHeader(headers, "x-ratelimit-remaining-requests")),
        remainingTokens: toNum(readHeader(headers, "x-ratelimit-remaining-tokens")),
        resetRequestsSeconds: parseDuration(readHeader(headers, "x-ratelimit-reset-requests")),
        resetTokensSeconds: parseDuration(readHeader(headers, "x-ratelimit-reset-tokens")),
        retryAfterSeconds: toFloat(readHeader(headers, "retry-after")),
    };
}

export function calcCooldownMs(
    parsed: Partial<ParsedCerebrasHeaders & ParsedGroqHeaders>,
    defaultCooldownSeconds: number
): number {
    const seconds = Math.max(
        defaultCooldownSeconds,
        parsed.retryAfterSeconds ?? 0,
        parsed.resetTokensMinuteSeconds ?? 0,
        parsed.resetTokensSeconds ?? 0
    );

    return Math.round(seconds * 1000);
}

export function classifyError(err: unknown): {
    shouldFailover: boolean;
    status: number | undefined;
    headers: HeaderSource | undefined;
    message: string | undefined;
} {
    const failoverStatuses = new Set([408, 429, 498, 500, 502, 503, 504]);
    const noFailoverStatuses = new Set([400, 401, 403, 404, 413, 422]);

    if (err instanceof GroqAPIError || err instanceof CerebrasAPIError) {
        if (noFailoverStatuses.has(err.status ?? -1)) {
            return { shouldFailover: false, status: err.status, headers: err.headers, message: err.message };
        }

        if (failoverStatuses.has(err.status ?? -1)) {
            return { shouldFailover: true, status: err.status, headers: err.headers, message: err.message };
        }

        return { shouldFailover: true, status: err.status, headers: err.headers, message: err.message };
    }

    return {
        shouldFailover: true,
        status: undefined,
        headers: undefined,
        message: undefined,
    };
}

function toFloat(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function toNum(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function readHeader(headers: HeaderSource, name: string): string | null {
    if ("get" in headers && typeof headers.get === "function") {
        return headers.get(name) ?? null;
    }

    const recordHeaders = headers as Record<string, string | string[] | null | undefined>;
    const direct = recordHeaders[name];
    if (Array.isArray(direct)) {
        return direct[0] ?? null;
    }
    if (typeof direct === "string") {
        return direct;
    }

    const normalizedName = name.toLowerCase();
    for (const [key, value] of Object.entries(recordHeaders)) {
        if (key.toLowerCase() !== normalizedName) continue;
        if (Array.isArray(value)) {
            return value[0] ?? null;
        }
        return typeof value === "string" ? value : null;
    }

    return null;
}

function parseDuration(value: string | null): number | undefined {
    if (!value) return undefined;

    const match = value.match(/^(?:(\d+)m)?(?:([0-9.]+)s)?$/);
    if (!match) return undefined;

    const minutes = match[1] ? Number(match[1]) : 0;
    const seconds = match[2] ? Number.parseFloat(match[2]) : 0;

    if (Number.isNaN(minutes) || Number.isNaN(seconds)) return undefined;
    return (minutes * 60) + seconds;
}
