// schema-utils.ts — shared helpers for Zod v4 error extraction
import type * as z from 'zod';

// Extract the first offending key from a Zod unrecognized_keys issue.
// In Zod v4, ZodUnrecognizedKeysIssue carries keys: string[] (non-optional).
// Guard with 'keys' in issue before calling.
export function getUnrecognizedKey(issue: z.ZodIssue): string | null {
    if (issue.code !== 'unrecognized_keys') return null;
    const keys = (issue as { code: 'unrecognized_keys'; keys: string[] }).keys;
    return keys[0] ?? null;
}
