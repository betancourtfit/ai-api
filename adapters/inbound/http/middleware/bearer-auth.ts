// adapters/inbound/http/middleware/bearer-auth.ts — downstream Bearer gate (AUTH-01..04).
import { timingSafeEqual } from 'node:crypto';
import { authNotConfiguredError, openaiError } from '../presenters/openai-error';

// AUTH-01..04: extract Bearer token — never log or echo value
export function extractBearerToken(request: Request): string | null {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7);
}

// AUTH-03: constant-time comparison — pad both buffers to maxLen so timingSafeEqual always runs.
// The prior length pre-check leaked the key's byte length as a timing oracle (CR-01).
// DO NOT reintroduce an early length return before the comparison.
export function verifyToken(token: string, expected: string): boolean {
    const enc = new TextEncoder();
    const a = enc.encode(token);
    const b = enc.encode(expected);
    const maxLen = Math.max(a.length, b.length);
    const paddedA = new Uint8Array(maxLen);
    const paddedB = new Uint8Array(maxLen);
    paddedA.set(a);
    paddedB.set(b);
    // timingSafeEqual always runs — no length oracle
    return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

/**
 * The global Bearer gate. Everything in the post-auth route segment runs behind this.
 * Missing proxy configuration is a 503; a missing or wrong token is a 401.
 */
export function requireBearer(
    request: Request,
    expectedKey: string | null
): { ok: true } | { ok: false; response: Response } {
    if (!expectedKey) {
        return { ok: false, response: authNotConfiguredError() };
    }

    const token = extractBearerToken(request);
    if (!token || !verifyToken(token, expectedKey)) {
        return {
            ok: false,
            response: openaiError(
                'No authorization provided or invalid credentials.',
                'invalid_request_error',
                'missing_auth',
                null,
                401
            ),
        };
    }

    return { ok: true };
}
