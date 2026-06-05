// request-schema.test.ts — unit tests for model-registry + validation (TDD RED)
// Tests cover the 5 behavior cases from the plan
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
