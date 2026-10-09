// GENERATED — do not edit. Copied from packages/api-client/src/apiError.ts by
// scripts/generate_sdk.sh: the published SDK reads error bodies exactly the
// way the console, the phone and the Mac do, without depending on a private
// workspace package.

/**
 * One reading of every error body the EESI backend produces.
 *
 * Two envelopes exist, and every surface used to know exactly one of them:
 *
 * - FastAPI's `{ detail }` from the control-plane routes — a string, or on 422
 *   an array of `{ loc, msg, type }`, or the backend's own validation arrays of
 *   `{ model, message }`.
 * - OpenAI's `{ error: { message, type, code, param } }` from the speech
 *   routes (`/v1/audio`, `/v1/chat`, `/v1/models`, `/v1/realtime`, `/v1/voices`
 *   — `api/services/speech_gateway/errors.py`), including auth failures on
 *   those paths, which wear the same envelope so SDKs can parse them.
 *
 * A parser that knew only the first rendered "Request failed" for every
 * speech-route failure — the one place the server's own sentence is usually
 * the diagnosis. This is the single implementation; the console, the phone and
 * the Mac all import it rather than keeping a shape each, and the published
 * `@eesi/sdk` carries a copy that `scripts/generate_sdk.sh` refreshes from
 * this file.
 */

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
}

/** One item of a FastAPI/backend validation array, or null when it says nothing. */
function describeDetailItem(item: unknown): string | null {
    if (typeof item === "string") return item || null;
    const detail = record(item);
    if (!detail) return null;
    const message =
        typeof detail.message === "string"
            ? detail.message
            : typeof detail.msg === "string"
              ? detail.msg
              : "";
    if (!message) return null;
    return typeof detail.model === "string" && detail.model
        ? `${detail.model}: ${message}`
        : message;
}

/**
 * The human-readable message in a failed response, whichever envelope it wears.
 *
 * Accepts what a caller is likely to be holding: the parsed JSON body, the
 * hey-api `error` value (parsed JSON, or the raw text of a non-JSON body), a
 * thrown `Error`, or a bare string. Returns `fallback` when the payload carries
 * no sentence at all — never an empty string, so callers can render it directly.
 */
export function parseApiError(payload: unknown, fallback = "Request failed"): string {
    if (typeof payload === "string") return payload || fallback;
    if (payload instanceof Error) return payload.message || fallback;
    const body = record(payload);
    if (!body) return fallback;

    const enveloped = record(body.error)?.message;
    if (typeof enveloped === "string" && enveloped) return enveloped;

    const detail = body.detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail)) {
        const messages = detail
            .map(describeDetailItem)
            .filter((message): message is string => message !== null);
        if (messages.length > 0) return messages.join("\n");
    }
    return fallback;
}
