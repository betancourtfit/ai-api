// request-schema.ts — Zod v4 strict allowlist validation (VALID-01/02/03/04/05/06/07)
// Uses z.strictObject() — rejects any key not in the schema (Pitfall 7: no .strict() in v4)
import * as z from 'zod';

// Message schema: name field intentionally OMITTED (VALID-05 — rejected by z.strictObject())
const messageSchema = z.strictObject({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
});

// Top-level schema: strict allowlist per CLAUDE.md §11 and RESEARCH.md Pattern 4
export const chatCompletionSchema = z.strictObject({
    model: z.string(),
    messages: z.array(messageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    // Phase 2: both non-streaming and streaming requests are supported.
    stream: z.boolean().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    seed: z.number().int().optional(),
    // VALID-06: n is allowed ONLY when it equals 1; z.literal(1) rejects n:2 with path ['n']
    // n is omittable — z.literal(1).optional() accepts undefined (omitted) and 1, rejects all other values
    n: z.literal(1).optional(),
    // NOT in allowlist — z.strictObject() rejects all unlisted fields as unrecognized_keys.
    // Reject-list per CLAUDE.md §11: log_probs variants, bias, penalty fields, tools, response_format.
});

export type ChatCompletionInput = z.infer<typeof chatCompletionSchema>;

// D-05: return first offending field only — stop at first violation
export function validateChatCompletion(body: unknown):
    { success: true; data: ChatCompletionInput } |
    { success: false; param: string | null; message: string }
{
    const result = chatCompletionSchema.safeParse(body);
    if (result.success) return { success: true, data: result.data };

    const firstIssue = result.error.issues[0];
    if (!firstIssue) return { success: false, param: null, message: 'Invalid request body' };

    // path is [] for unrecognized top-level keys (z.strictObject unrecognized_keys issue)
    // path is ['n'] for n:2 (literal mismatch)
    // path is ['messages'] for messages field errors (missing/invalid)
    // path is ['messages', 0, ...] for nested message rejection (Pitfall 3: use path[0])
    let param: string | null;
    if (firstIssue.path.length > 0) {
        // Named path: use path[0] (covers 'messages', 'n', 'stream', etc.)
        param = String(firstIssue.path[0]);
    } else if (firstIssue.code === 'unrecognized_keys' && 'keys' in firstIssue) {
        // Top-level unrecognized key — extract first offending key name (OpenAI-faithful)
        const keys = (firstIssue as { keys?: string[] }).keys;
        param = (keys && keys[0]) ? keys[0] : null;
    } else {
        param = null;
    }

    return { success: false, param, message: firstIssue.message };
}
