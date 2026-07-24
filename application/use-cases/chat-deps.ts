// application/use-cases/chat-deps.ts — the dependency set shared by both chat use cases.
// Everything here is a port, a pure domain type, or an injected function. No adapter import:
// `toFailure` is supplied by the composition root (adapters/outbound/sdk-error-mapper.ts), which
// keeps the vendor `instanceof` knowledge outside the application layer (ARCHITECTURE.md §5).
import type { CompletionParams, ProviderId, UpstreamFailure } from '../../domain/types';
import type { ModelRegistry } from '../../domain/model-registry';
import type { ChatProviderPort } from '../ports/chat-provider';
import type { ProviderStateStore } from '../ports/provider-state-store';
import type { Logger } from '../ports/logger';
import type { Clock } from '../ports/clock';

export interface ChatUseCaseDeps {
    providers: Record<ProviderId, ChatProviderPort>;
    store: ProviderStateStore;
    registry: ModelRegistry;
    logger: Logger;
    clock: Clock;
    maxAttempts: number;
    defaultCooldownSeconds: number;
    toFailure(err: unknown): UpstreamFailure;
}

export interface ChatUseCaseInput {
    logicalAlias: string;
    params: CompletionParams;
    requestId: string;
    route: string;
    requestStart: number;
}

export interface UpstreamRejected {
    ok: false;
    kind: 'upstream_rejected';
    status: number;
    message: string;
}

export interface NoProvider {
    ok: false;
    kind: 'no_provider';
    attempt: number;
    failoverReason: string | null;
}
