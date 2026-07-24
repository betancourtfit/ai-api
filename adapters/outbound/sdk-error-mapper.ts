// adapters/outbound/sdk-error-mapper.ts — the ONLY module allowed to name a vendor error class.
// Flattens a Cerebras/Groq SDK APIError into the provider-agnostic domain shape UpstreamFailure,
// so routing policy (domain/failure-classification.ts) never sees a vendor type. ARCHITECTURE.md §5.
//
// T-08-02-01: headers only. Never copy the SDK error's request body, Authorization header,
// or client configuration into UpstreamFailure.
import { APIError as CerebrasAPIError } from '@cerebras/cerebras_cloud_sdk';
import { APIError as GroqAPIError } from 'groq-sdk';
import type { UpstreamFailure } from '../../domain/types';

interface SdkErrorView {
    status: number | undefined;
    message: string | undefined;
    rawHeaders: unknown;
}

// Single instanceof site. Returns null for anything that is not a vendor APIError.
function asSdkError(err: unknown): SdkErrorView | null {
    if (err instanceof GroqAPIError || err instanceof CerebrasAPIError) {
        return { status: err.status, message: err.message, rawHeaders: err.headers };
    }
    return null;
}

/**
 * Flatten an arbitrary header carrier — a WHATWG `Headers`, a plain record, or any object
 * exposing `get(name)` — into a lowercase-keyed plain record. This is the old `readHeader`
 * tolerance relocated from routing policy to the adapter edge (V-04).
 * Returns undefined when there is nothing to flatten.
 */
export function toHeaderRecord(headers: unknown): Record<string, string> | undefined {
    if (headers === null || headers === undefined) return undefined;

    // WHATWG Headers (and anything else iterable as [key, value] pairs)
    if (typeof (headers as { forEach?: unknown }).forEach === 'function'
        && typeof (headers as { get?: unknown }).get === 'function') {
        const out: Record<string, string> = {};
        (headers as Headers).forEach((value, key) => {
            out[key.toLowerCase()] = value;
        });
        return out;
    }

    if (typeof headers !== 'object') return undefined;

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value === 'string') {
            out[key.toLowerCase()] = value;
        } else if (Array.isArray(value)) {
            const first = value[0];
            if (typeof first === 'string') out[key.toLowerCase()] = first;
        }
    }
    return out;
}

/**
 * Map any thrown value to the domain failure shape. A non-APIError yields
 * `{ status: undefined, message: undefined, headers: undefined }` — identical to the
 * pre-refactor fallback in routing/cooldown-manager.ts.
 */
export function toUpstreamFailure(err: unknown): UpstreamFailure {
    const sdkError = asSdkError(err);
    if (!sdkError) {
        return { status: undefined, message: undefined, headers: undefined };
    }

    return {
        status: sdkError.status,
        message: sdkError.message,
        headers: toHeaderRecord(sdkError.rawHeaders),
    };
}

/**
 * Legacy escape hatch used ONLY by the routing/cooldown-manager.ts compatibility shim.
 * Returns the SDK error's header object by reference so the pre-existing
 * `expect(classifyError(err).headers).toBe(headers)` identity assertion keeps holding.
 * Deleted together with the shim in plan 08-04.
 */
export function rawSdkErrorHeaders(err: unknown): unknown {
    return asSdkError(err)?.rawHeaders;
}
