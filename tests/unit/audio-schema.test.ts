// tests/unit/audio-schema.test.ts — unit tests for audio-schema.ts validators (TDD RED)
// Covers AUDIO-01..06, validates schema allowlist and size-check path (AUDIO-03).
// No server, no FormData, no whisper binary required.
import { test, expect, describe } from "bun:test";
import { validateAudioTranscription, validateAudioFileSize } from "../../audio-schema";

describe("validateAudioTranscription", () => {
    test("valid input returns success:true with data.model", () => {
        const file = new File(["audio data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "whisper-1", file });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.model).toBe("whisper-1");
        }
    });

    test("missing file returns success:false with param='file'", () => {
        const result = validateAudioTranscription({ model: "whisper-1" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("file");
        }
    });

    test("missing model returns success:false with param='model'", () => {
        const file = new File(["audio data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ file });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("model");
        }
    });

    test("response_format 'json' returns success:true", () => {
        const file = new File(["audio data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "whisper-1", file, response_format: "json" });
        expect(result.success).toBe(true);
    });

    test("omitting response_format returns success:true (optional field)", () => {
        const file = new File(["audio data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "whisper-1", file });
        expect(result.success).toBe(true);
    });
});

// Plan 04-01 Task 2: hardened allowlist + size cases
describe("validateAudioTranscription — hardened allowlist", () => {
    test("unknown field 'language' returns success:false with param='language'", () => {
        const file = new File(["audio data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "whisper-1", file, language: "en" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe('language');
        }
    });

    test("response_format 'text' returns success:false (AUDIO-04/05)", () => {
        const file = new File(["audio data"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioTranscription({ model: "whisper-1", file, response_format: "text" });
        expect(result.success).toBe(false);
    });

    test("file passed as string returns success:false with param='file'", () => {
        const result = validateAudioTranscription({ model: "whisper-1", file: "path/to/audio.mp3" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.param).toBe("file");
        }
    });
});

describe("validateAudioFileSize", () => {
    test("file within limit returns ok:true", () => {
        const file = new File(["small audio"], "t.mp3", { type: "audio/mpeg" });
        const result = validateAudioFileSize(file, 26_214_400);
        expect(result.ok).toBe(true);
    });

    test("file exceeding limit returns ok:false with message containing maxBytes", () => {
        // Create a file whose size exceeds maxBytes by providing enough content
        const content = new Uint8Array(101);
        const file = new File([content], "big.mp3", { type: "audio/mpeg" });
        const result = validateAudioFileSize(file, 100);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain("100");
        }
    });
});
