import { describe, expect, test } from "bun:test";
import { APIError as CerebrasAPIError } from "@cerebras/cerebras_cloud_sdk";
import { APIError as GroqAPIError } from "groq-sdk";
import {
    calcCooldownMs,
    classifyError,
    parseCerebrasHeaders,
    parseGroqHeaders,
} from "../../routing/cooldown-manager";

describe("parseGroqHeaders", () => {
    test("parses duration strings and retry-after", () => {
        const headers = new Headers({
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-remaining-tokens": "6000",
            "x-ratelimit-reset-requests": "2m59.56s",
            "x-ratelimit-reset-tokens": "1m30s",
            "retry-after": "2",
        });

        const parsed = parseGroqHeaders(headers);

        expect(parsed.remainingRequests).toBe(0);
        expect(parsed.remainingTokens).toBe(6000);
        expect(parsed.resetRequestsSeconds).toBe(179.56);
        expect(parsed.resetTokensSeconds).toBe(90);
        expect(parsed.retryAfterSeconds).toBe(2);
    });

    test("parses 30s and 1m forms", () => {
        const headers = new Headers({
            "x-ratelimit-reset-requests": "30s",
            "x-ratelimit-reset-tokens": "1m",
        });

        const parsed = parseGroqHeaders(headers);

        expect(parsed.resetRequestsSeconds).toBe(30);
        expect(parsed.resetTokensSeconds).toBe(60);
    });

    test("returns undefined fields when headers are absent", () => {
        expect(parseGroqHeaders(new Headers())).toEqual({
            remainingRequests: undefined,
            remainingTokens: undefined,
            resetRequestsSeconds: undefined,
            resetTokensSeconds: undefined,
            retryAfterSeconds: undefined,
        });
    });

    test("parses plain object headers", () => {
        const parsed = parseGroqHeaders({
            "x-ratelimit-reset-requests": "30s",
            "x-ratelimit-reset-tokens": "1m",
            "retry-after": "2",
        });

        expect(parsed.resetRequestsSeconds).toBe(30);
        expect(parsed.resetTokensSeconds).toBe(60);
        expect(parsed.retryAfterSeconds).toBe(2);
    });
});

describe("parseCerebrasHeaders", () => {
    test("parses floating second reset headers", () => {
        const headers = new Headers({
            "x-ratelimit-remaining-requests-day": "999",
            "x-ratelimit-remaining-tokens-minute": "20000",
            "x-ratelimit-reset-requests-day": "33011.382867097855",
            "x-ratelimit-reset-tokens-minute": "11.382867097854614",
        });

        const parsed = parseCerebrasHeaders(headers);

        expect(parsed.remainingRequestsDay).toBe(999);
        expect(parsed.remainingTokensMinute).toBe(20000);
        expect(parsed.resetRequestsDaySeconds).toBe(33011.382867097855);
        expect(parsed.resetTokensMinuteSeconds).toBe(11.382867097854614);
    });

    test("returns undefined fields when headers are absent", () => {
        expect(parseCerebrasHeaders(new Headers())).toEqual({
            remainingRequestsDay: undefined,
            remainingTokensMinute: undefined,
            resetRequestsDaySeconds: undefined,
            resetTokensMinuteSeconds: undefined,
        });
    });

    test("parses plain object headers", () => {
        const parsed = parseCerebrasHeaders({
            "x-ratelimit-remaining-requests-day": "999",
            "x-ratelimit-reset-tokens-minute": "11.382867097854614",
        });

        expect(parsed.remainingRequestsDay).toBe(999);
        expect(parsed.resetTokensMinuteSeconds).toBe(11.382867097854614);
    });
});

describe("calcCooldownMs", () => {
    test("uses the max retry/reset/default value", () => {
        expect(
            calcCooldownMs(
                { retryAfterSeconds: 2, resetTokensSeconds: 179.56 },
                60
            )
        ).toBe(179560);
    });

    test("falls back to the default cooldown when parsed values are missing", () => {
        expect(calcCooldownMs({}, 60)).toBe(60000);
    });
});

describe("classifyError", () => {
    function groqError(status: number | undefined, headers?: Headers): GroqAPIError {
        return new GroqAPIError(status, undefined, "boom", headers);
    }

    function cerebrasError(status: number | undefined, headers?: Headers): CerebrasAPIError {
        return new CerebrasAPIError(
            status,
            undefined,
            "boom",
            headers as ConstructorParameters<typeof CerebrasAPIError>[3]
        );
    }

    test("marks failover statuses as retryable", () => {
        for (const status of [408, 429, 498, 500, 502, 503, 504]) {
            const result = classifyError(groqError(status));
            expect(result.shouldFailover).toBe(true);
            expect(result.status).toBe(status);
        }
    });

    test("marks no-failover statuses as terminal", () => {
        for (const status of [400, 401, 403, 404, 413, 422]) {
            const result = classifyError(cerebrasError(status));
            expect(result.shouldFailover).toBe(false);
            expect(result.status).toBe(status);
        }
    });

    test("treats undefined and unknown statuses as failover", () => {
        expect(classifyError(groqError(undefined)).shouldFailover).toBe(true);
        expect(classifyError(groqError(418)).shouldFailover).toBe(true);
    });

    test("returns headers for API errors and retries unknown objects", () => {
        const headers = new Headers({ "retry-after": "2" });
        const apiResult = classifyError(groqError(429, headers));
        expect(apiResult.headers).toBe(headers);

        const unknownResult = classifyError({ nope: true });
        expect(unknownResult).toEqual({
            shouldFailover: true,
            status: undefined,
            headers: undefined,
            message: undefined, // WR-06: complete assertion — ensures message is not accidentally set for unknown errors
        });
    });
});
