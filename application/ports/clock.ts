// application/ports/clock.ts — time port (HEX-07, HEX-08)
// Interface only. Domain modules take this instead of calling Date.now() directly.

export interface Clock {
    now(): number;
}
