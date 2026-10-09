// Unit tests for @eesi/sdk. Uses Node's built-in `node:test` runner and a
// stubbed fetch — no HTTP, no backend dependency. The endpoint methods are
// generated, so what is tested here is the wire the client puts them on.
//
// Run via `npm test` in sdk/typescript/.

import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the BUILT artifact — same shape consumers get from `npm install`.
// `npm test` runs `tsc` first so dist/ is fresh.
import { ApiError, EESIClient, RequestTimeoutError } from "../dist/index.js";
import type { CreateSpeechBody } from "../dist/index.js";

// ─── EESIClient HTTP plumbing (stubbed fetch) ───────────────────────────

describe("EESIClient", () => {
    it("defaults to the production API", () => {
        const original = process.env.EESI_API_URL;
        delete process.env.EESI_API_URL;
        try {
            const c = new EESIClient({ fetch: async () => jsonResponse(200, {}) });
            assert.equal(c.baseUrl, "https://api.eesi.ai");
        } finally {
            if (original === undefined) delete process.env.EESI_API_URL;
            else process.env.EESI_API_URL = original;
        }
    });

    it("sends the API key as an Authorization bearer token", async () => {
        let capturedHeaders: Headers | undefined;
        const stubFetch: typeof fetch = async (_input, init) => {
            capturedHeaders = new Headers(init?.headers);
            return new Response(JSON.stringify([]), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        };
        const c = new EESIClient({
            baseUrl: "http://api.example",
            apiKey: "sk-test",
            fetch: stubFetch,
        });
        await c.getApiKeys();
        assert.equal(capturedHeaders?.get("authorization"), "Bearer sk-test");
    });

    it("surfaces 4xx responses as ApiError", async () => {
        const stubFetch: typeof fetch = async () =>
            new Response(JSON.stringify({ detail: "Voice not found" }), {
                status: 404,
                headers: { "content-type": "application/json" },
            });
        const c = new EESIClient({
            baseUrl: "http://api.example",
            apiKey: "k",
            fetch: stubFetch,
        });
        await assert.rejects(
            () => c.getVoice("voice_1"),
            (err: unknown) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.statusCode, 404);
                assert.equal(err.message, "Voice not found");
                return true;
            },
        );
    });

    it("ApiError constructor stores statusCode and body", () => {
        const err = new ApiError(500, "boom", { detail: "oops" });
        assert.equal(err.statusCode, 500);
        assert.deepEqual(err.body, { detail: "oops" });
    });
});

// ─── Error envelopes (both backend shapes) ───────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function clientWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): EESIClient {
    return new EESIClient({
        baseUrl: "http://api.example",
        apiKey: "sk-test",
        fetch: fetchImpl,
        ...extra,
    });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error("expected rejection");
}

describe("ApiError envelopes", () => {
    it("reads the OpenAI envelope the speech routes answer with", async () => {
        const c = clientWith(async () =>
            jsonResponse(400, {
                error: {
                    message: "Unknown model: nur-tts-v9",
                    type: "invalid_request_error",
                    param: "model",
                    code: null,
                },
            }),
        );
        const err = await rejection(c.listVoices());
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, "Unknown model: nur-tts-v9");
        assert.equal(err.type, "invalid_request_error");
        assert.equal(err.code, null);
    });

    it("reads an auth failure wearing the OpenAI envelope", async () => {
        const c = clientWith(async () =>
            jsonResponse(401, {
                error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" },
            }),
        );
        const err = await rejection(c.listVoices());
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, "Invalid API key");
        assert.equal(err.code, "invalid_api_key");
    });

    it("reads FastAPI's string detail", async () => {
        const c = clientWith(async () => jsonResponse(404, { detail: "Voice not found" }));
        const err = await rejection(c.getVoice("voice_1"));
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, "Voice not found");
        assert.equal(err.code, null);
        assert.equal(err.type, null);
        assert.deepEqual(err.body, { detail: "Voice not found" });
    });

    it("flattens a 422 array one message per line", async () => {
        const c = clientWith(async () =>
            jsonResponse(422, {
                detail: [
                    { loc: ["body", "name"], msg: "Field required", type: "missing" },
                    { model: "nur-tts-v1", message: "Backend unavailable" },
                    "plain string item",
                ],
            }),
        );
        const err = await rejection(c.getVoice("voice_1"));
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 422);
        assert.equal(err.message, "Field required\nnur-tts-v1: Backend unavailable\nplain string item");
    });

    it("prefers the envelope when a body carries both shapes", () => {
        const err = ApiError.fromBody(400, { error: { message: "from envelope" }, detail: "from detail" });
        assert.equal(err.message, "from envelope");
    });

    it("uses a non-JSON body as its own message", async () => {
        const c = clientWith(async () => new Response("Bad Gateway", { status: 502 }));
        const err = await rejection(c.getVoice("voice_1"));
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, "Bad Gateway");
        assert.equal(err.body, "Bad Gateway");
    });

    it("falls back when nothing in the payload says anything", () => {
        for (const body of [{}, { error: {} }, { error: { message: "" } }, { detail: [] }, ""]) {
            assert.equal(ApiError.fromBody(500, body, "x").message, "x");
        }
        assert.equal(ApiError.fromBody(500, { detail: [{ loc: ["body"] }] }, "x").message, "x");
    });
});

// ─── Multipart, passthrough and binary call shapes ────────────────────────

describe("generated call shapes", () => {
    it("createTranscription sends the file and fields as multipart/form-data", async () => {
        let captured: { headers: Headers; body: unknown } | undefined;
        const stubFetch: typeof fetch = async (_input, init) => {
            captured = { headers: new Headers(init?.headers), body: init?.body };
            return jsonResponse(200, { text: "hello" });
        };
        const c = clientWith(stubFetch);
        const result = await c.createTranscription({
            file: new File([new Uint8Array([82, 73, 70, 70])], "clip.wav", { type: "audio/wav" }),
            model: "nur-stt-v1",
            timestampGranularities: ["word", "segment"],
            temperature: 0.2,
        });
        assert.deepEqual(result, { text: "hello" });
        assert.ok(captured);
        // fetch sets the multipart boundary itself; a preset Content-Type would break it.
        assert.equal(captured.headers.get("content-type"), null);
        assert.ok(captured.body instanceof FormData);
        const file = captured.body.get("file");
        assert.ok(file instanceof File);
        assert.equal(file.name, "clip.wav");
        assert.equal(file.type, "audio/wav");
        assert.equal(captured.body.get("model"), "nur-stt-v1");
        assert.equal(captured.body.get("temperature"), "0.2");
        assert.deepEqual(captured.body.getAll("timestamp_granularities[]"), ["word", "segment"]);
        assert.equal(captured.body.has("language"), false);
        assert.equal(captured.body.has("stream"), false);
    });

    it("createVoice sends booleans as form fields", async () => {
        let body: FormData | undefined;
        const stubFetch: typeof fetch = async (_input, init) => {
            body = init?.body as FormData;
            return jsonResponse(200, {
                voice_id: "voice_1",
                name: "Sarah",
                engine: "nur-tts-v1",
                status: "ready",
                has_ref_text: false,
                created_at: "2026-01-01T00:00:00Z",
            });
        };
        const c = clientWith(stubFetch);
        const voice = await c.createVoice({
            file: new Blob([new Uint8Array(4)]),
            name: "Sarah",
            consentAttested: true,
        });
        assert.equal(voice.name, "Sarah");
        assert.ok(body instanceof FormData);
        assert.equal(body.get("name"), "Sarah");
        assert.equal(body.get("consent_attested"), "true");
    });

    it("chatCompletions forwards the JSON body verbatim", async () => {
        let captured: { headers: Headers; body: unknown } | undefined;
        const stubFetch: typeof fetch = async (_input, init) => {
            captured = { headers: new Headers(init?.headers), body: init?.body };
            return jsonResponse(200, { choices: [] });
        };
        const c = clientWith(stubFetch);
        const payload = { model: "nur-llm-v1", messages: [{ role: "user", content: "hi" }] };
        assert.deepEqual(await c.chatCompletions({ body: payload }), { choices: [] });
        assert.equal(captured?.headers.get("content-type"), "application/json");
        assert.equal(captured?.body, JSON.stringify(payload));
    });

    it("createSpeech returns the audio bytes untouched", async () => {
        const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xff, 0xfb, 0x90, 0x00]);
        const c = clientWith(
            async () => new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } }),
        );
        const out = await c.createSpeech({
            body: { model: "nur-tts-v1", input: "Hello", voice: "ev_1a2b3c4d" },
        });
        assert.ok(out instanceof Uint8Array);
        assert.deepEqual(Array.from(out), Array.from(audio));
    });
});

// ─── Timeouts and retries (mirrors the Python SDK) ────────────────────────

describe("timeouts and retries", () => {
    it("rejects with RequestTimeoutError when headers never arrive", async () => {
        let aborted = false;
        const stubFetch: typeof fetch = (_input, init) =>
            new Promise((_, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    aborted = true;
                    reject(new Error("aborted"));
                });
            });
        const c = clientWith(stubFetch, { connectTimeoutMs: 20 });
        const err = await rejection(c.chatCompletions({ body: {} }));
        assert.ok(err instanceof RequestTimeoutError);
        assert.match(err.message, /timed out \(connect after 20 ms\)/);
        assert.equal(aborted, true);
    });

    it("rejects with RequestTimeoutError when the body never finishes", async () => {
        const stubFetch: typeof fetch = async () =>
            ({
                ok: true,
                status: 200,
                statusText: "OK",
                text: () => new Promise<string>(() => {}),
                arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
            }) as unknown as Response;
        const c = clientWith(stubFetch, { readTimeoutMs: 20 });
        const err = await rejection(c.getApiKeys());
        assert.ok(err instanceof RequestTimeoutError);
        assert.match(err.message, /timed out \(read after 20 ms\)/);
    });

    it("does not hide a stalled error body behind a generic ApiError", async () => {
        const stubFetch: typeof fetch = async () =>
            ({
                ok: false,
                status: 503,
                statusText: "Service Unavailable",
                text: () => new Promise<string>(() => {}),
                arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
            }) as unknown as Response;
        const c = clientWith(stubFetch, { readTimeoutMs: 20 });
        const err = await rejection(c.getApiKeys());
        assert.ok(err instanceof RequestTimeoutError);
        assert.match(err.message, /timed out \(read after 20 ms\)/);
    });

    it("retries a GET once when the connection fails", async () => {
        let calls = 0;
        const stubFetch: typeof fetch = async () => {
            calls++;
            if (calls === 1) throw new TypeError("fetch failed");
            return jsonResponse(200, []);
        };
        const c = clientWith(stubFetch);
        assert.deepEqual(await c.getApiKeys(), []);
        assert.equal(calls, 2);
    });

    it("gives up a GET after the single retry", async () => {
        let calls = 0;
        const stubFetch: typeof fetch = async () => {
            calls++;
            throw new TypeError("fetch failed");
        };
        const c = clientWith(stubFetch);
        const err = await rejection(c.getApiKeys());
        assert.ok(err instanceof TypeError);
        assert.equal(calls, 2);
    });

    it("never retries a POST", async () => {
        let calls = 0;
        const stubFetch: typeof fetch = async () => {
            calls++;
            throw new TypeError("fetch failed");
        };
        const c = clientWith(stubFetch);
        const err = await rejection(c.chatCompletions({ body: {} }));
        assert.ok(err instanceof TypeError);
        assert.equal(calls, 1);
    });
});

// ─── Package surface ────────────────────────────────────────────────────

describe("package surface", () => {
    it("exports the generated request/response types from the entry point", async () => {
        // Types leave no runtime trace, so the shipped declaration is what is checked.
        const declaration = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
        assert.match(declaration, /export type \* from "\.\/_generated_models\.js"/);
        const models = await readFile(new URL("../dist/_generated_models.d.ts", import.meta.url), "utf8");
        assert.match(models, /export type SpeechRequest = /);
    });

    it("exports a named body type per method with a request body", async () => {
        const declaration = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
        assert.match(declaration, /export type \* from "\.\/_generated_client\.js"/);
        const client = await readFile(
            new URL("../dist/_generated_client.d.ts", import.meta.url),
            "utf8",
        );
        assert.match(client, /export type CreateSpeechBody = /);
    });
});

// ─── The README's quickstart ─────────────────────────────────────────────
//
// Compiling is most of the assertion here: `SpeechRequest` types the server's
// defaulted fields (`response_format`, `speed`, `stream_format`) as always
// present, so a body that omitted them — every quickstart anyone would write —
// did not build. `CreateSpeechBody` is the type a caller actually needs.

describe("README quickstart", () => {
    it("lists voices and synthesizes with an id from that list", async () => {
        const sent: unknown[] = [];
        const stubFetch: typeof fetch = async (input, init) => {
            sent.push({ url: String(input), body: init?.body });
            return String(input).endsWith("/voices")
                ? jsonResponse(200, {
                      data: [
                          {
                              voice_id: "ev_1a2b3c4d",
                              name: "Nur",
                              engine: "omnivoice",
                              status: "ready",
                              has_ref_text: true,
                              created_at: "2026-01-01T00:00:00Z",
                              is_builtin: true,
                          },
                      ],
                  })
                : new Response(new Uint8Array([1, 2, 3]), {
                      status: 200,
                      headers: { "content-type": "audio/wav" },
                  });
        };
        const client = clientWith(stubFetch);

        const voices = await client.listVoices();
        const body: CreateSpeechBody = {
            model: "nur-tts-v1",
            voice: voices.data[0]!.voice_id,
            input: "Your appointment is confirmed for Thursday at two.",
            response_format: "wav",
        };
        const audio = await client.createSpeech({ body });

        assert.ok(audio instanceof Uint8Array);
        assert.deepEqual(JSON.parse((sent[1] as { body: string }).body), body);
    });

    it("takes a body with nothing but the required fields", async () => {
        const client = clientWith(
            async () => new Response(new Uint8Array([1]), { status: 200 }),
        );
        // No response_format / speed / stream_format: the server owns those.
        const audio = await client.createSpeech({
            body: { model: "nur-tts-v1", voice: "ev_1a2b3c4d", input: "Hello" },
        });
        assert.ok(audio instanceof Uint8Array);
    });
});
