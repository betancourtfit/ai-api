import { beforeEach, describe, expect, test } from "bun:test";
import { createProviderStateStore } from "../../domain/provider-state";
import { createModelRegistry } from "../../domain/model-registry";

// Store under test, built with the same order/clock/configured values the composition root uses
// for the default MODEL_REGISTRY_JSON. Methods are destructured so the assertions below call the
// same bare names they always did; getStateSnapshot/resetForTesting map to getSnapshot/reset.
const registry = createModelRegistry({
    "gpt-oss-120b-balanced": { cerebras: "gpt-oss-120b", groq: "openai/gpt-oss-120b" },
});
const store = createProviderStateStore({
    order: ["cerebras", "groq"],
    clock: { now: () => Date.now() },
    configured: { cerebras: true, groq: true },
    resolveUpstreamModel: registry.resolveUpstreamModel,
});
const {
    advanceCursor,
    chooseEligibleProviders,
    getSnapshot: getStateSnapshot,
    isEligible,
    recordFailure,
    recordSuccess,
    reset: resetForTesting,
    setCooldown,
    setRateLimitSnapshot,
} = store;

const alias = "gpt-oss-120b-balanced";

describe("provider-state", () => {
    beforeEach(() => {
        resetForTesting();
    });

    test("starts with provider order from config", () => {
        expect(chooseEligibleProviders(alias)).toEqual(["cerebras", "groq"]);
    });

    test("alternates when the cursor advances", () => {
        advanceCursor();
        expect(chooseEligibleProviders(alias)).toEqual(["groq", "cerebras"]);
    });

    test("excludes providers that are cooling down", () => {
        setCooldown("groq", Date.now() + 60_000);
        expect(isEligible("groq", alias)).toBe(false);
        expect(chooseEligibleProviders(alias)).toEqual(["cerebras"]);
    });

    test("restores eligibility when cooldown has expired", () => {
        setCooldown("groq", Date.now() - 1);
        expect(isEligible("groq", alias)).toBe(true);
    });

    test("returns no candidates when both providers are unavailable", () => {
        setCooldown("cerebras", Date.now() + 60_000);
        setCooldown("groq", Date.now() + 60_000);
        expect(chooseEligibleProviders(alias)).toEqual([]);
    });

    test("rejects aliases that are not mapped for a provider", () => {
        expect(isEligible("cerebras", "unknown-alias")).toBe(false);
    });

    test("tracks failure and success transitions", () => {
        recordFailure("cerebras", 500);
        let snapshot = getStateSnapshot();

        expect(snapshot.cerebras.consecutiveFailures).toBe(1);
        expect(snapshot.cerebras.lastStatusCode).toBe(500);
        expect(snapshot.cerebras.lastFailureAt).toBeNumber();

        recordSuccess("cerebras", 200);
        snapshot = getStateSnapshot();

        expect(snapshot.cerebras.consecutiveFailures).toBe(0);
        expect(snapshot.cerebras.lastStatusCode).toBe(200);
        expect(snapshot.cerebras.healthy).toBe(true);
        expect(snapshot.cerebras.cooldownUntil).toBeNull();
    });

    test("stores rate-limit snapshots", () => {
        setRateLimitSnapshot("groq", { remainingRequests: "10" });
        expect(getStateSnapshot().groq.rateLimitSnapshot?.remainingRequests).toBe("10");
    });

    test("returns a deep-cloned state snapshot", () => {
        const snapshot = getStateSnapshot();
        snapshot.groq.enabled = false;
        expect(getStateSnapshot().groq.enabled).toBe(true);
    });

    test("resetForTesting restores the initial state and cursor", () => {
        advanceCursor();
        setCooldown("groq", Date.now() + 60_000);

        resetForTesting();

        expect(chooseEligibleProviders(alias)).toEqual(["cerebras", "groq"]);
    });
});
