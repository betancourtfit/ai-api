// application/ports/chat-provider.ts — outbound port for an upstream chat provider (HEX-07, HEX-08)
// Interface only. Allowed primitives: AbortSignal, AsyncIterable, plain records, domain types.
// Forbidden: HTTP transport types and every vendor SDK type — see ARCHITECTURE.md §3 for the list.
import type { CompletionOutcome, CompletionParams, StreamChunk } from '../../domain/types';

export interface ChatProviderPort {
    name: string;
    complete(upstreamModelId: string, params: CompletionParams): Promise<CompletionOutcome>;
    stream(
        upstreamModelId: string,
        params: CompletionParams,
        signal: AbortSignal
    ): Promise<AsyncIterable<StreamChunk>>;
}
