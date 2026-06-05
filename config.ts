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
} as const;
