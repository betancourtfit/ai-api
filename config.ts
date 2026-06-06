// config.ts — centralized env config (INFRA-05)
// Bun auto-loads .env and .env.local — do NOT add dotenv.
// All process.env reads happen here; all other modules import from this file.

function optional(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
}

export const config = {
    port: Number(process.env["PORT"] ?? 3000),
    hostname: process.env["HOSTNAME"] ?? "0.0.0.0",
    personalProxyApiKey: optional("PERSONAL_PROXY_API_KEY"),
    cerebrasApiKey: optional("CEREBRAS_API_KEY"),
    groqApiKey: optional("GROQ_API_KEY"),
    cerebrasBaseUrl: process.env["CEREBRAS_BASE_URL"] ?? "https://api.cerebras.ai/v1",
    groqBaseUrl: process.env["GROQ_BASE_URL"] ?? "https://api.groq.com/openai/v1",
    cerebrasVersionPatch: process.env["CEREBRAS_VERSION_PATCH"] ?? "2",
    defaultMaxCompletionTokens: Number(process.env["DEFAULT_MAX_COMPLETION_TOKENS"] ?? 4096),
    defaultCooldownSeconds: Number(process.env["DEFAULT_COOLDOWN_SECONDS"] ?? 60),
    maxProviderAttemptsPerRequest: Number(process.env["MAX_PROVIDER_ATTEMPTS_PER_REQUEST"] ?? 2),
    exposeProviderHeader: (process.env["EXPOSE_PROVIDER_HEADER"] ?? "false") === "true",
    enableInternalStatusEndpoint: (process.env["ENABLE_INTERNAL_STATUS_ENDPOINT"] ?? "true") === "true",
    providerOrder: (process.env["PROVIDER_ORDER"] ?? "cerebras,groq").split(",") as Array<"cerebras" | "groq">,
    modelRegistryJson: process.env["MODEL_REGISTRY_JSON"]
        ?? `{"gpt-oss-120b-balanced":{"cerebras":"gpt-oss-120b","groq":"openai/gpt-oss-120b"}}`,
    logLevel: process.env["LOG_LEVEL"] ?? "info",

    // WHSP-04: whisper sidecar connection
    whisperHost: process.env["WHISPER_HOST"] ?? "127.0.0.1",
    whisperPort: Number(process.env["WHISPER_PORT"] ?? 8080),
    whisperTimeoutMs: Number(process.env["WHISPER_TIMEOUT_MS"] ?? 30_000),
    // optional() returns null when unset — missing WHISPER_MODEL_ALIAS is non-fatal
    whisperModelAlias: optional("WHISPER_MODEL_ALIAS"),

    // AUDIO-03 + WHSP-05: file and body size limits
    audioMaxFileBytes: Number(process.env["AUDIO_MAX_FILE_BYTES"] ?? 26_214_400),   // 25 MiB
    maxRequestBodyBytes: Number(process.env["MAX_REQUEST_BODY_BYTES"] ?? 1_048_576), // 1 MiB for chat JSON
} as const;
