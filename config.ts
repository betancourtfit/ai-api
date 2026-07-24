// config.ts — centralized env config (INFRA-05). Composition layer.
// Bun auto-loads .env and .env.local — do NOT add dotenv.
// This is the ONLY module that reads process.env for configuration. The single documented
// exception elsewhere is adapters/inbound/http/routes/health.ts reading BUILD_VERSION, which
// is a build stamp, not configuration.

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env) {
    function optional(name: string): string | null {
        const value = env[name]?.trim();
        return value ? value : null;
    }

    // CR-01: validate numeric env vars at startup — throws on NaN or non-positive values
    // so the failure is loud rather than silently disabling security gates.
    function requiredPositiveInt(name: string, fallback: number): number {
        const raw = env[name]?.trim();
        if (!raw) return fallback;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(
                `Config: ${name}="${raw}" must be a positive finite number (got ${value})`
            );
        }
        return Math.floor(value);
    }

    return {
        port: requiredPositiveInt("PORT", 3000),
        hostname: env["HOSTNAME"] ?? "0.0.0.0",
        personalProxyApiKey: optional("PERSONAL_PROXY_API_KEY"),
        cerebrasApiKey: optional("CEREBRAS_API_KEY"),
        groqApiKey: optional("GROQ_API_KEY"),
        cerebrasBaseUrl: env["CEREBRAS_BASE_URL"] ?? "https://api.cerebras.ai/v1",
        groqBaseUrl: env["GROQ_BASE_URL"] ?? "https://api.groq.com/openai/v1",
        cerebrasVersionPatch: env["CEREBRAS_VERSION_PATCH"] ?? "2",
        defaultMaxCompletionTokens: requiredPositiveInt("DEFAULT_MAX_COMPLETION_TOKENS", 4096),
        defaultCooldownSeconds: requiredPositiveInt("DEFAULT_COOLDOWN_SECONDS", 60),
        maxProviderAttemptsPerRequest: requiredPositiveInt("MAX_PROVIDER_ATTEMPTS_PER_REQUEST", 2),
        exposeProviderHeader: (env["EXPOSE_PROVIDER_HEADER"] ?? "false") === "true",
        enableInternalStatusEndpoint: (env["ENABLE_INTERNAL_STATUS_ENDPOINT"] ?? "true") === "true",
        providerOrder: (() => {
            const VALID: ReadonlySet<string> = new Set(["cerebras", "groq"]);
            const order = (env["PROVIDER_ORDER"] ?? "cerebras,groq")
                .split(",").map((s) => s.trim()).filter(Boolean);
            for (const p of order) {
                if (!VALID.has(p)) {
                    throw new Error(
                        `Config: PROVIDER_ORDER contains invalid provider "${p}". ` +
                        `Allowed values: cerebras, groq`
                    );
                }
            }
            if (order.length === 0) {
                throw new Error(
                    `Config: PROVIDER_ORDER must contain at least one valid provider (cerebras, groq)`
                );
            }
            return order as Array<"cerebras" | "groq">;
        })(),
        modelRegistryJson: env["MODEL_REGISTRY_JSON"]
            ?? `{"gpt-oss-120b-balanced":{"cerebras":"gpt-oss-120b","groq":"openai/gpt-oss-120b"}}`,
        // OPT-IN default alias: when client omits `model` on /v1/chat/completions, fall back to this.
        // optional() returns null when unset — no default configured means omitting model is a 400.
        defaultModelAlias: optional("DEFAULT_MODEL_ALIAS"),
        logLevel: env["LOG_LEVEL"] ?? "info",

        // WHSP-04: whisper sidecar connection
        whisperHost: env["WHISPER_HOST"] ?? "127.0.0.1",
        whisperPort: requiredPositiveInt("WHISPER_PORT", 8080),
        whisperTimeoutMs: requiredPositiveInt("WHISPER_TIMEOUT_MS", 30_000),
        // optional() returns null when unset — missing WHISPER_MODEL_ALIAS is non-fatal
        whisperModelAlias: optional("WHISPER_MODEL_ALIAS"),
        // whisper-server defaults language to "en"; force es by default (operator always
        // speaks Spanish). Forcing the wrong language yields canonical hallucinations.
        // Set WHISPER_LANGUAGE=auto for per-clip detection.
        whisperLanguage: env["WHISPER_LANGUAGE"] ?? "es",

        // AUDIO-03 + WHSP-05: file and body size limits
        audioMaxFileBytes: requiredPositiveInt("AUDIO_MAX_FILE_BYTES", 26_214_400),   // 25 MiB
        maxRequestBodyBytes: requiredPositiveInt("MAX_REQUEST_BODY_BYTES", 1_048_576), // 1 MiB for chat JSON
    };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config = loadConfig();
