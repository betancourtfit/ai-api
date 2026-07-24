// adapters/outbound/console-logger.ts — Logger port over stdout, with LOG_LEVEL gating (OBS-02).
// Callers pass structured metadata only: never a key, an Authorization header, prompt or response
// content, base64 audio, decoded bytes, a filename, or transcript text (ARCHITECTURE.md §7).
import type { Logger } from '../../application/ports/logger';

// OBS-02: log level numeric map — error:0, warn:1, info:2
const LOG_LEVEL_MAP: Record<string, number> = { error: 0, warn: 1, info: 2 };

export function createConsoleLogger(logLevel: string): Logger {
    const configuredLogLevel = LOG_LEVEL_MAP[logLevel] ?? 2;

    return {
        log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
            const entryLevel = LOG_LEVEL_MAP[level] ?? 2;
            if (entryLevel <= configuredLogLevel) {
                console.log(JSON.stringify({ level, ...data }));
            }
        },
    };
}
