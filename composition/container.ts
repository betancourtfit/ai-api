// composition/container.ts — THE composition root (HEX-13).
//
// Everything that used to happen at import time across six modules happens here, inside one
// function call: registry JSON parsing, provider-state store construction, logger and clock
// selection, SDK client factories, and whisper adapter selection. Importing any module under
// domain/, application/, or adapters/ now has no side effect.
//
// T-08-04-01: the Container carries API keys. It is never serialised, never logged, and never
// returned by a route. /internal/providers/status exposes store.getSnapshot() only.
import { createModelRegistry } from '../domain/model-registry';
import { createProviderStateStore } from '../domain/provider-state';
import { createConsoleLogger } from '../adapters/outbound/console-logger';
import { systemClock } from '../adapters/outbound/system-clock';
import { createCerebrasChatProvider } from '../adapters/outbound/cerebras-chat-provider';
import { createGroqChatProvider } from '../adapters/outbound/groq-chat-provider';
import { HttpWhisperService } from '../adapters/outbound/http-whisper';
import { NoopWhisperService } from '../adapters/outbound/noop-whisper';
import type { AppConfig } from '../config';
import type { ModelRegistry } from '../domain/model-registry';
import type { ProviderId } from '../domain/types';
import type { ChatProviderPort } from '../application/ports/chat-provider';
import type { ProviderStateStore } from '../application/ports/provider-state-store';
import type { TranscriptionPort } from '../application/ports/transcription';
import type { Logger } from '../application/ports/logger';
import type { Clock } from '../application/ports/clock';

export interface Container {
    config: AppConfig;
    clock: Clock;
    logger: Logger;
    registry: ModelRegistry;
    store: ProviderStateStore;
    chatProviders: Record<ProviderId, ChatProviderPort>;
    transcription: TranscriptionPort;
}

type RegistryMap = Record<string, Record<string, string>>;

export function buildContainer(cfg: AppConfig, overrides?: Partial<Container>): Container {
    // Parse MODEL_REGISTRY_JSON once, here — the throw message is part of the startup contract.
    let registryMap: RegistryMap;
    try {
        registryMap = JSON.parse(cfg.modelRegistryJson) as RegistryMap;
    } catch {
        throw new Error(`MODEL_REGISTRY_JSON is not valid JSON`);
    }

    const clock: Clock = systemClock;
    const logger: Logger = createConsoleLogger(cfg.logLevel);
    const registry = createModelRegistry(registryMap);

    const store: ProviderStateStore = createProviderStateStore({
        order: cfg.providerOrder,
        clock,
        // T-08-04-03: booleans only — a key value never enters the store.
        configured: {
            cerebras: Boolean(cfg.cerebrasApiKey),
            groq: Boolean(cfg.groqApiKey),
        },
        resolveUpstreamModel: registry.resolveUpstreamModel,
    });

    const chatProviders: Record<ProviderId, ChatProviderPort> = {
        cerebras: createCerebrasChatProvider({
            apiKey: cfg.cerebrasApiKey,
            versionPatch: cfg.cerebrasVersionPatch,
        }),
        groq: createGroqChatProvider({ apiKey: cfg.groqApiKey }),
    };

    const transcription: TranscriptionPort = cfg.whisperModelAlias !== null
        ? new HttpWhisperService()
        : new NoopWhisperService();

    const base: Container = {
        config: cfg,
        clock,
        logger,
        registry,
        store,
        chatProviders,
        transcription,
    };

    // Shallow-merged last so tests can inject a mock store, mock providers, or a mock
    // transcription service without rebuilding the rest of the graph.
    return overrides ? { ...base, ...overrides } : base;
}

// The application's single container instance. Built lazily on first use — importing this
// module still constructs nothing — and shared by every createServer() call that does not
// inject its own dependencies, so all servers in a process observe one provider-state store
// (the same lifetime the pre-refactor module-level globals had).
let defaultContainer: Container | null = null;

export function getDefaultContainer(cfg: AppConfig): Container {
    if (!defaultContainer) {
        defaultContainer = buildContainer(cfg);
    }
    return defaultContainer;
}
