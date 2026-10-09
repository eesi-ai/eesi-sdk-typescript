// HTTP client for the EESI REST API.
//
// Every endpoint method comes from `_GeneratedClient` (auto-generated from
// the FastAPI OpenAPI spec — see `scripts/generate_sdk.sh`). This class only
// adds session/auth/transport around that base.
import { _GeneratedClient } from "./_generated_client.js";
import { ApiError, RequestTimeoutError } from "./errors.js";
function getRuntimeEnv(name) {
    const runtime = globalThis;
    return runtime.process?.env?.[name];
}
// Shared with the Python SDK — change both or neither.
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_READ_TIMEOUT_MS = 60_000;
/**
 * Reject `promise` with a `RequestTimeoutError` after `ms`, aborting the
 * underlying request; the race means a fetch that ignores the abort signal
 * still cannot hang the caller.
 */
function withTimeout(promise, ms, abort, describe) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            // Reject before aborting: a fetch that rejects on abort would
            // otherwise win the race with its own error.
            reject(new RequestTimeoutError(describe()));
            abort.abort();
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/**
 * Timeouts and retries (identical in the Python SDK):
 *
 * - connect 10 s (time to response headers), read 60 s (time to finish the
 *   body). Both raise `RequestTimeoutError`. Override per client with
 *   `connectTimeoutMs` / `readTimeoutMs`.
 * - `GET` is retried once, after a 100–300 ms jittered pause, when the
 *   request fails before any headers arrive (refused, DNS, connect timeout).
 *   Nothing else is retried: a `POST`/`PUT`/`PATCH`/`DELETE` that failed on
 *   the wire may still have reached the server, and a read timeout means the
 *   server took the request. Connection failures that survive the retry
 *   propagate as the fetch implementation's own error (a `TypeError` for
 *   the platform `fetch`).
 * - Non-2xx responses throw `ApiError` (see `errors.ts` for the two
 *   envelopes it reads).
 */
export class EESIClient extends _GeneratedClient {
    baseUrl;
    apiKey;
    fetchImpl;
    connectTimeoutMs;
    readTimeoutMs;
    headers;
    constructor(opts = {}) {
        super();
        const rawBase = opts.baseUrl ??
            getRuntimeEnv("EESI_API_URL") ??
            "https://api.eesi.ai";
        this.baseUrl = rawBase.replace(/\/+$/, "");
        this.apiKey = opts.apiKey ?? getRuntimeEnv("EESI_API_KEY");
        this.fetchImpl = opts.fetch ?? globalThis.fetch;
        this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
        this.headers = { Accept: "application/json" };
        if (this.apiKey)
            this.headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    // ── low-level (overrides `_GeneratedClient.request`) ──────────────
    /**
     * Send one request. `raw: true` returns the response bytes untouched
     * (audio); otherwise JSON is parsed and a non-JSON body comes back as
     * text. See the class docstring for the timeout and retry policy.
     */
    async request(method, path, opts) {
        let url = `${this.baseUrl}/v1${path}`;
        if (opts?.params) {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(opts.params)) {
                if (v !== undefined && v !== null)
                    qs.append(k, String(v));
            }
            const q = qs.toString();
            if (q)
                url += (url.includes("?") ? "&" : "?") + q;
        }
        const hasJson = opts?.json !== undefined;
        const init = {
            method,
            headers: {
                ...this.headers,
                // A FormData body gets its multipart boundary from fetch.
                ...(hasJson ? { "Content-Type": "application/json" } : {}),
            },
            body: hasJson ? JSON.stringify(opts.json) : opts?.form,
        };
        const attempts = method === "GET" ? 2 : 1;
        let resp;
        let controller = new AbortController();
        for (let attempt = 0; attempt < attempts; attempt++) {
            controller = new AbortController();
            init.signal = controller.signal;
            try {
                resp = await withTimeout(this.fetchImpl(url, init), this.connectTimeoutMs, controller, () => `${method} ${path} timed out (connect after ${this.connectTimeoutMs} ms)`);
                break;
            }
            catch (err) {
                if (attempt + 1 < attempts) {
                    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
                    continue;
                }
                throw err;
            }
        }
        if (!resp)
            throw new Error("unreachable: no response and no error");
        const readBody = (read) => withTimeout(read(), this.readTimeoutMs, controller, () => `${method} ${path} timed out (read after ${this.readTimeoutMs} ms)`);
        if (!resp.ok) {
            // A stalled error body is still a read timeout. Hiding it behind a
            // generic ApiError makes a transport failure look like a response
            // the server completed and contradicts the timeout contract above.
            const text = await readBody(() => resp.text());
            let body = text;
            try {
                body = JSON.parse(text);
            }
            catch {
                // Non-JSON error body: the text is its own message.
            }
            throw ApiError.fromBody(resp.status, body, resp.statusText || "Request failed");
        }
        if (opts?.raw) {
            return new Uint8Array(await readBody(() => resp.arrayBuffer()));
        }
        if (resp.status === 204)
            return undefined;
        const text = await readBody(() => resp.text());
        if (text === "")
            return undefined;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
}
//# sourceMappingURL=client.js.map