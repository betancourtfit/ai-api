// application/ports/logger.ts — structured logging port (HEX-07, HEX-08)
// Interface only. Callers pass metadata records — never secrets, prompts, or transcripts
// (ARCHITECTURE.md §7 invariant 3).

export interface Logger {
    log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void;
}
