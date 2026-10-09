import { _GeneratedClient } from "./_generated_client.js";
export interface EESIFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
}
export interface EESIFetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}
export type EESIFetch = (url: string, init?: EESIFetchInit) => Promise<EESIFetchResponse>;
export declare const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
export declare const DEFAULT_READ_TIMEOUT_MS = 60000;
export interface EESIClientOptions {
    baseUrl?: string;
    apiKey?: string;
    /** Time allowed for the response headers to arrive. Default 10 s. */
    connectTimeoutMs?: number;
    /** Time allowed to read the response body once headers arrived. Default 60 s. */
    readTimeoutMs?: number;
    /** Optional fetch override for tests / custom transports. */
    fetch?: EESIFetch;
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
export declare class EESIClient extends _GeneratedClient {
    readonly baseUrl: string;
    readonly apiKey: string | undefined;
    private readonly fetchImpl;
    private readonly connectTimeoutMs;
    private readonly readTimeoutMs;
    private readonly headers;
    constructor(opts?: EESIClientOptions);
    /**
     * Send one request. `raw: true` returns the response bytes untouched
     * (audio); otherwise JSON is parsed and a non-JSON body comes back as
     * text. See the class docstring for the timeout and retry policy.
     */
    protected request<T = unknown>(method: string, path: string, opts?: {
        json?: unknown;
        params?: Record<string, unknown>;
        form?: FormData;
        raw?: boolean;
    }): Promise<T>;
}
//# sourceMappingURL=client.d.ts.map