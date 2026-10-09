// HTTP client for the EESI REST API.
//
// Every endpoint method comes from `_GeneratedClient` (auto-generated from
// the FastAPI OpenAPI spec — see `scripts/generate_sdk.sh`). This class only
// adds session/auth/transport around that base.

import { _GeneratedClient } from "./_generated_client.js";
import { ApiError, RequestTimeoutError } from "./errors.js";

type RuntimeProcess = {
    env?: Record<string, string | undefined>;
};

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

export type EESIFetch = (
    url: string,
    init?: EESIFetchInit,
) => Promise<EESIFetchResponse>;

function getRuntimeEnv(name: string): string | undefined {
    const runtime = globalThis as typeof globalThis & { process?: RuntimeProcess };
    return runtime.process?.env?.[name];
}

// Shared with the Python SDK — change both or neither.
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_READ_TIMEOUT_MS = 60_000;

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
 * Reject `promise` with a `RequestTimeoutError` after `ms`, aborting the
 * underlying request; the race means a fetch that ignores the abort signal
 * still cannot hang the caller.
 */
function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    abort: AbortController,
    describe: () => string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
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
    readonly baseUrl: string;
    readonly apiKey: string | undefined;
    private readonly fetchImpl: EESIFetch;
    private readonly connectTimeoutMs: number;
    private readonly readTimeoutMs: number;
    private readonly headers: Record<string, string>;

    constructor(opts: EESIClientOptions = {}) {
        super();
        const rawBase =
            opts.baseUrl ??
            getRuntimeEnv("EESI_API_URL") ??
            "https://api.eesi.ai";
        this.baseUrl = rawBase.replace(/\/+$/, "");
        this.apiKey = opts.apiKey ?? getRuntimeEnv("EESI_API_KEY");
        this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as EESIFetch);
        this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
        this.headers = { Accept: "application/json" };
        if (this.apiKey) this.headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // ── low-level (overrides `_GeneratedClient.request`) ──────────────

    /**
     * Send one request. `raw: true` returns the response bytes untouched
     * (audio); otherwise JSON is parsed and a non-JSON body comes back as
     * text. See the class docstring for the timeout and retry policy.
     */
    protected async request<T = unknown>(
        method: string,
        path: string,
        opts?: {
            json?: unknown;
            params?: Record<string, unknown>;
            form?: FormData;
            raw?: boolean;
        },
    ): Promise<T> {
        let url = `${this.baseUrl}/v1${path}`;
        if (opts?.params) {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(opts.params)) {
                if (v !== undefined && v !== null) qs.append(k, String(v));
            }
            const q = qs.toString();
            if (q) url += (url.includes("?") ? "&" : "?") + q;
        }

        const hasJson = opts?.json !== undefined;
        const init: EESIFetchInit = {
            method,
            headers: {
                ...this.headers,
                // A FormData body gets its multipart boundary from fetch.
                ...(hasJson ? { "Content-Type": "application/json" } : {}),
            },
            body: hasJson ? JSON.stringify(opts.json) : opts?.form,
        };

        const attempts = method === "GET" ? 2 : 1;
        let resp: EESIFetchResponse | undefined;
        let controller = new AbortController();
        for (let attempt = 0; attempt < attempts; attempt++) {
            controller = new AbortController();
            init.signal = controller.signal;
            try {
                resp = await withTimeout(
                    this.fetchImpl(url, init),
                    this.connectTimeoutMs,
                    controller,
                    () => `${method} ${path} timed out (connect after ${this.connectTimeoutMs} ms)`,
                );
                break;
            } catch (err) {
                if (attempt + 1 < attempts) {
                    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
                    continue;
                }
                throw err;
            }
        }
        if (!resp) throw new Error("unreachable: no response and no error");

        const readBody = <B>(read: () => Promise<B>): Promise<B> =>
            withTimeout(
                read(),
                this.readTimeoutMs,
                controller,
                () => `${method} ${path} timed out (read after ${this.readTimeoutMs} ms)`,
            );

        if (!resp.ok) {
            // A stalled error body is still a read timeout. Hiding it behind a
            // generic ApiError makes a transport failure look like a response
            // the server completed and contradicts the timeout contract above.
            const text = await readBody(() => resp.text());
            let body: unknown = text;
            try {
                body = JSON.parse(text);
            } catch {
                // Non-JSON error body: the text is its own message.
            }
            throw ApiError.fromBody(resp.status, body, resp.statusText || "Request failed");
        }

        if (opts?.raw) {
            return new Uint8Array(await readBody(() => resp.arrayBuffer())) as unknown as T;
        }
        if (resp.status === 204) return undefined as T;
        const text = await readBody(() => resp.text());
        if (text === "") return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            return text as unknown as T;
        }
    }
}
