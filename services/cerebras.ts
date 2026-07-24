// Phase 8 compatibility shim — deleted in plan 08-04 Task 4.
import { config } from '../config';
import { createCerebrasChatProvider } from '../adapters/outbound/cerebras-chat-provider';

export const cerebrasAdapter = createCerebrasChatProvider({
    apiKey: config.cerebrasApiKey,
    versionPatch: config.cerebrasVersionPatch,
});
