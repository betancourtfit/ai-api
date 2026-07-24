// domain/rate-limits.ts — rate-limit header parsing and cooldown calculation (RL-01..04, HEX-06)
// Pure: operates on a plain Record<string, string>. The Headers / {get()} tolerance that used to
// live here now sits at the adapter edge in adapters/outbound/sdk-error-mapper.ts (toHeaderRecord).
// No vendor SDK import, no HTTP transport type, no config import.

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

export function parseCerebrasHeaders(headers: Record<string, string>): ParsedCerebrasHeaders {
    return {
        remainingRequestsDay: toFloat(readHeader(headers, "x-ratelimit-remaining-requests-day")),
        remainingTokensMinute: toFloat(readHeader(headers, "x-ratelimit-remaining-tokens-minute")),
        resetRequestsDaySeconds: toFloat(readHeader(headers, "x-ratelimit-reset-requests-day")),
        resetTokensMinuteSeconds: toFloat(readHeader(headers, "x-ratelimit-reset-tokens-minute")),
    };
}

export function parseGroqHeaders(headers: Record<string, string>): ParsedGroqHeaders {
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
        parsed.resetTokensSeconds ?? 0,
        parsed.resetRequestsDaySeconds ?? 0,   // CR-02: was parsed but omitted — daily-quota 429s need full reset window
    );

    return Math.round(seconds * 1000);
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

// Case-insensitive lookup over a plain record. toHeaderRecord already lowercases keys at the
// adapter edge; this fallback keeps the parsers correct for any directly-supplied record.
function readHeader(headers: Record<string, string>, name: string): string | null {
    const direct = headers[name];
    if (typeof direct === "string") {
        return direct;
    }

    const normalizedName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== normalizedName) continue;
        return typeof value === "string" ? value : null;
    }

    return null;
}

function parseDuration(value: string | null): number | undefined {
    if (value === null || value === '') return undefined; // WR-04: explicit guard — !value would miss '' after a refactor to string|undefined

    const match = value.match(/^(?:(\d+)m)?(?:([0-9.]+)s)?$/);
    if (!match) return undefined;

    const minutes = match[1] ? Number(match[1]) : 0;
    const seconds = match[2] ? Number.parseFloat(match[2]) : 0;

    if (Number.isNaN(minutes) || Number.isNaN(seconds)) return undefined;
    return (minutes * 60) + seconds;
}
