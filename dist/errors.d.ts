export declare class EESISdkError extends Error {
    constructor(message: string);
}
/** Raised when a request exceeds the client's connect or read timeout. */
export declare class RequestTimeoutError extends EESISdkError {
    constructor(message: string);
}
/**
 * Raised when the EESI backend returns a non-2xx response.
 *
 * The backend answers in two envelopes — FastAPI's `{ detail }` from the
 * control-plane routes and OpenAI's `{ error: { message, type, code, param } }`
 * from the speech routes — and `message` is read by `parseApiError`, the same
 * function the console, the phone and the Mac use
 * (`packages/api-client/src/apiError.ts`, copied in as `_apiError.ts`).
 *
 * `message` is the server's own sentence; `code` and `type` are set only when
 * the envelope carries them. `body` is the parsed JSON, or the raw text of a
 * non-JSON body.
 */
export declare class ApiError extends EESISdkError {
    readonly statusCode: number;
    readonly body: unknown;
    readonly code: string | null;
    readonly type: string | null;
    constructor(statusCode: number, message: string, body?: unknown, opts?: {
        code?: string | null;
        type?: string | null;
    });
    /**
     * Build the error from a failed response's body, whichever envelope it
     * wears. `fallback` is used when the payload carries no sentence at all —
     * never an empty message.
     */
    static fromBody(statusCode: number, body: unknown, fallback?: string): ApiError;
}
//# sourceMappingURL=errors.d.ts.map