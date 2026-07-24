// Phase 8 compatibility shim — removed in plan 08-04. Import from './domain/model-registry'.
// Composition edge: parses MODEL_REGISTRY_JSON once at module load and binds one default
// registry instance. Throw-on-invalid-JSON semantics are part of the current startup contract.
import { config } from './config';
import { createModelRegistry } from './domain/model-registry';

type RegistryEntry = Record<string, string>;
type Registry = Record<string, RegistryEntry>;

let parsed: Registry;
try {
    parsed = JSON.parse(config.modelRegistryJson) as Registry;
} catch {
    throw new Error(`MODEL_REGISTRY_JSON is not valid JSON`);
}

const defaultRegistry = createModelRegistry(parsed);

export function resolveUpstreamModel(alias: string, provider: string): string | undefined {
    return defaultRegistry.resolveUpstreamModel(alias, provider);
}

export function isKnownAlias(alias: string): boolean {
    return defaultRegistry.isKnownAlias(alias);
}

export function listAliases(): string[] {
    return defaultRegistry.listAliases();
}

export function rewriteUpstreamModelIds(text: string): string {
    return defaultRegistry.rewriteUpstreamModelIds(text);
}
