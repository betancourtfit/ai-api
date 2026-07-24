// domain/model-registry.ts — logical model alias registry as a pure factory (REG-01..04, HEX-04)
// No JSON.parse and no config import: parsing MODEL_REGISTRY_JSON is a composition concern.
// No module-level mutable state — the registry map is closed over per instance.

type RegistryEntry = Record<string, string>; // { cerebras: "...", groq: "..." }
type Registry = Record<string, RegistryEntry>;

export interface ModelRegistry {
    resolveUpstreamModel(alias: string, provider: string): string | undefined;
    isKnownAlias(alias: string): boolean;
    listAliases(): string[];
    rewriteUpstreamModelIds(text: string): string;
}

export function createModelRegistry(registry: Registry): ModelRegistry {
    // REG-04: return stable alias IDs only (for GET /v1/models)
    function listAliases(): string[] {
        return Object.keys(registry);
    }

    return {
        // REG-03: returns undefined if alias has no mapping for that provider
        resolveUpstreamModel(alias: string, provider: string): string | undefined {
            return registry[alias]?.[provider];
        },

        // REG-01: check alias exists in registry
        isKnownAlias(alias: string): boolean {
            return alias in registry;
        },

        listAliases,

        // D-07: rewrite upstream model IDs in text back to logical alias — prevents provider ID leak in error messages
        // Sorts by descending upstream ID length for safety (longer IDs matched first to avoid prefix collisions)
        rewriteUpstreamModelIds(text: string): string {
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
        },
    };
}
