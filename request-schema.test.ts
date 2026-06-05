// request-schema.test.ts — unit tests for model-registry + validation (TDD RED)
// Tests cover the 5 behavior cases from the original plan + 8 new hardening cases (Plan 01-02)
import { test, expect, describe } from "bun:test";
import { validateChatCompletion } from "./request-schema";
import { isKnownAlias, resolveUpstreamModel } from "./model-registry";

describe("validateChatCompletion", () => {
    test("valid body returns success:true with parsed data", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.model).toBe("gpt-oss-120b-balanced");
            expect(result.data.messages).toHaveLength(1);
        }
    });

    test("missing messages returns success:false with param='messages'", () => {
        const result = validateChatCompletion({ model: "x" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("messages");
        }
    });

    test("stream:true returns success:false with param='stream'", () => {
        const result = validateChatCompletion({
            model: "x",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("stream");
        }
    });
});

// Plan 01-02 Task 1: 8 hardening cases — strict allowlist + reject-list
describe("validateChatCompletion — hardened allowlist (01-02)", () => {
    // Case 1: logprobs -> 400 (z.strictObject unrecognized_keys)
    test("logprobs field returns success:false", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            logprobs: true,
        });
        expect(result.success).toBe(false);
    });

    // Case 2: logit_bias -> 400
    test("logit_bias field returns success:false", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            logit_bias: {},
        });
        expect(result.success).toBe(false);
    });

    // Case 3: top_logprobs -> 400
    test("top_logprobs field returns success:false", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            top_logprobs: 2,
        });
        expect(result.success).toBe(false);
    });

    // Case 4: messages[].name -> 400 with param:"messages" (Pitfall 3)
    test("messages with name field returns success:false with param='messages'", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi", name: "Alice" }],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("messages");
        }
    });

    // Case 5: n:1 -> 200 (VALID-06: n=1 is the OpenAI-faithful allowed value)
    test("n:1 returns success:true (OpenAI-faithful allowed value)", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            n: 1,
        });
        expect(result.success).toBe(true);
    });

    // Case 6: n:2 -> 400 with param:"n" (VALID-06)
    test("n:2 returns success:false with param='n'", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            n: 2,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("n");
        }
    });

    // Case 7: frequency_penalty -> 400 (v2 field, not allowlisted)
    test("frequency_penalty field returns success:false", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            frequency_penalty: 0.1,
        });
        expect(result.success).toBe(false);
    });

    // Case 8: full allowlist body -> success:true
    test("full allowlist body (temperature, top_p, max_completion_tokens, stop, seed) returns success:true", () => {
        const result = validateChatCompletion({
            model: "gpt-oss-120b-balanced",
            messages: [{ role: "user", content: "hi" }],
            temperature: 0.7,
            top_p: 1,
            max_completion_tokens: 100,
            stop: "END",
            seed: 42,
        });
        expect(result.success).toBe(true);
    });
});

describe("model registry", () => {
    test("isKnownAlias returns true for gpt-oss-120b-balanced", () => {
        expect(isKnownAlias("gpt-oss-120b-balanced")).toBe(true);
    });

    test("isKnownAlias returns false for unknown alias gpt-4-turbo", () => {
        expect(isKnownAlias("gpt-4-turbo")).toBe(false);
    });

    test("resolveUpstreamModel returns correct cerebras model", () => {
        expect(resolveUpstreamModel("gpt-oss-120b-balanced", "cerebras")).toBe("gpt-oss-120b");
    });

    test("resolveUpstreamModel returns correct groq model", () => {
        expect(resolveUpstreamModel("gpt-oss-120b-balanced", "groq")).toBe("openai/gpt-oss-120b");
    });

    test("resolveUpstreamModel returns undefined for unmapped provider", () => {
        expect(resolveUpstreamModel("gpt-oss-120b-balanced", "openai")).toBeUndefined();
    });
});
