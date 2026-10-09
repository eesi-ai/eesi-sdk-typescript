// SDK-level exceptions. All subclass `EESISdkError` so callers can
// catch them as one category.
import { parseApiError } from "./_apiError.js";
export class EESISdkError extends Error {
    constructor(message) {
        super(message);
        this.name = "EESISdkError";
    }
}
/** Raised when a request exceeds the client's connect or read timeout. */
export class RequestTimeoutError extends EESISdkError {
    constructor(message) {
        super(message);
        this.name = "RequestTimeoutError";
    }
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
export class ApiError extends EESISdkError {
    statusCode;
    body;
    code;
    type;
    constructor(statusCode, message, body, opts = {}) {
        super(message);
        this.name = "ApiError";
        this.statusCode = statusCode;
        this.body = body;
        this.code = opts.code ?? null;
        this.type = opts.type ?? null;
    }
    /**
     * Build the error from a failed response's body, whichever envelope it
     * wears. `fallback` is used when the payload carries no sentence at all —
     * never an empty message.
     */
    static fromBody(statusCode, body, fallback = "Request failed") {
        const envelope = typeof body === "object" && body !== null ? body.error : undefined;
        const enveloped = typeof envelope === "object" && envelope !== null
            ? envelope
            : undefined;
        return new ApiError(statusCode, parseApiError(body, fallback), body, {
            code: typeof enveloped?.code === "string" ? enveloped.code : null,
            type: typeof enveloped?.type === "string" ? enveloped.type : null,
        });
    }
}
//# sourceMappingURL=errors.js.map