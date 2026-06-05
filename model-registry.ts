// model-registry.ts — logical model alias registry (REG-01..04)
// Parse MODEL_REGISTRY_JSON once at module load; throw on invalid JSON.
import { config } from './config';

type RegistryEntry = Record<string, string>; // { cerebras: "...", groq: "..." }
type Registry = Record<string, RegistryEntry>;

let registry: Registry;
try {
    registry = JSON.parse(config.modelRegistryJson) as Registry;
} catch {
    throw new Error(`MODEL_REGISTRY_JSON is not valid JSON`);
}

// REG-03: returns undefined if alias has no mapping for that provider
export function resolveUpstreamModel(alias: string, provider: string): string | undefined {
    return registry[alias]?.[provider];
}

// REG-01: check alias exists in registry
export function isKnownAlias(alias: string): boolean {
    return alias in registry;
}

// REG-04: return stable alias IDs only (for GET /v1/models)
export function listAliases(): string[] {
    return Object.keys(registry);
}
