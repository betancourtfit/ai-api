// Phase 8 compatibility shim — deleted in plan 08-04 Task 4.
import { config } from '../config';
import { createGroqChatProvider } from '../adapters/outbound/groq-chat-provider';

export const groqAdapter = createGroqChatProvider({ apiKey: config.groqApiKey });
