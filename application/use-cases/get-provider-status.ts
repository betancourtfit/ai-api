// application/use-cases/get-provider-status.ts — diagnostics snapshot, transport-free (HEX-09).
// Returns the deep-cloned provider states; the route decides whether the endpoint is enabled
// and builds the JSON envelope. Never exposes a key value — ProviderState carries a `configured`
// boolean only.
import type { ProviderState } from '../ports/provider-state-store';
import type { ProviderStateStore } from '../ports/provider-state-store';

export interface GetProviderStatusDeps {
    store: ProviderStateStore;
}

export function getProviderStatus(deps: GetProviderStatusDeps) {
    return function run(): ProviderState[] {
        return Object.values(deps.store.getSnapshot());
    };
}
