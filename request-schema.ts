// request-schema.ts — Zod v4 strict allowlist validation (VALID-01/02/03/04/05/07)
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
    // Phase 1: only false accepted; stream:true returns 400 (D-02; widened to boolean in Phase 2)
    stream: z.literal(false).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    seed: z.number().int().optional(),
    // NOT in allowlist — z.strictObject() rejects these:
    //   n, logprobs, logit_bias, top_logprobs, frequency_penalty, presence_penalty,
    //   tools, tool_choice, parallel_tool_calls, response_format
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

    // path is [] for top-level, ['messages'] for messages field,
    // ['messages', 0] for nested rejection (Pitfall 3: use path[0], not nested key)
    const param = firstIssue.path.length > 0
        ? String(firstIssue.path[0])
        : null;

    return { success: false, param, message: firstIssue.message };
}
