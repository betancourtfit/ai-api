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

// D-07: rewrite upstream model IDs in text back to logical alias — prevents provider ID leak in error messages
// Sorts by descending upstream ID length for safety (longer IDs matched first to avoid prefix collisions)
export function rewriteUpstreamModelIds(text: string): string {
    // Collect all (upstreamId, alias) pairs, sorted by descending upstream ID length
    const pairs: Array<{ upstreamId: string; alias: string }> = [];
    for (const alias of listAliases()) {
        const entry = registry[alias];
        if (!entry) continue;
        for (const upstreamId of Object.values(entry)) {
            pairs.push({ upstreamId, alias });
        }
    }
    pairs.sort((a, b) => b.upstreamId.length - a.upstreamId.length);

    let result = text;
    for (const { upstreamId, alias } of pairs) {
        result = result.split(upstreamId).join(alias);
    }
    return result;
}
