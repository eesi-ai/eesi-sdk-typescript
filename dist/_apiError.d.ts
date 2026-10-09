/**
 * The human-readable message in a failed response, whichever envelope it wears.
 *
 * Accepts what a caller is likely to be holding: the parsed JSON body, the
 * hey-api `error` value (parsed JSON, or the raw text of a non-JSON body), a
 * thrown `Error`, or a bare string. Returns `fallback` when the payload carries
 * no sentence at all — never an empty string, so callers can render it directly.
 */
export declare function parseApiError(payload: unknown, fallback?: string): string;
//# sourceMappingURL=_apiError.d.ts.map