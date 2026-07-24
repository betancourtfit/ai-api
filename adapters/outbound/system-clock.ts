// adapters/outbound/system-clock.ts — Clock port over the ambient wall clock.
// Kept as an arrow so Bun's setSystemTime() in tests is observed at call time.
import type { Clock } from '../../application/ports/clock';

export const systemClock: Clock = { now: () => Date.now() };
