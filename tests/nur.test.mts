// Tests for the Nur SDK against an in-process stand-in for the gateway. They
// prove what the SDK sends and how it reacts to what Nur sends; never
// speech, the model or the network.
//
// Run via `npm test` in sdk/typescript/ (it builds dist/ first).

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
    AuthenticationError,
    ContextError,
    formatTrace,
    joinSession,
    llmExtractor,
    Memory,
    NurClient,
    parseExtraction,
    Resampler,
    SessionClosedError,
    SilentOutput,
    SpeakerRoster,
    splitSpeakerTurns,
    tool,
    Trace,
    validateSchema,
} from "../dist/index.js";
import type { AudioOutputChunk, JoinInfo, NurEvent, ResponseContext, WebSocketLike } from "../dist/index.js";
import { createHmac } from "node:crypto";
import { FileMemoryStore, fileMemory, readWav, verifyWebhook, WebhookVerificationError, wavBytes } from "../dist/node/index.js";

// ── a gateway stand-in ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = Record<string, any>;

class FakeSocket implements WebSocketLike {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    readonly gateway: FakeGateway;
    readonly url: string;

    constructor(gateway: FakeGateway, url: string) {
        this.gateway = gateway;
        this.url = url;
        setTimeout(() => gateway.accept(this), 0);
    }

    send(data: string): void {
        if (this.readyState !== 1) throw new Error("socket is not open");
        const frame = JSON.parse(data) as Frame;
        if (frame.type === "eesi.context.update" && this.gateway.contextSendError) throw this.gateway.contextSendError;
        this.gateway.receive(this, frame);
    }

    close(code = 1000, reason = ""): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setTimeout(() => this.onclose?.({ code, reason }), 0);
    }

    /** A server event, delivered after everything already queued. */
    deliver(event: Frame): void {
        setTimeout(() => {
            if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(event) });
        }, 0);
    }
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

class FakeGateway {
    frames: Frame[] = [];
    urls: string[] = [];
    socket: FakeSocket | null = null;
    control: FakeSocket | null = null;
    sessionId = "conv_test";
    controlTools: "server" | "client" = "server";
    /** Answer the session a client secret bound, as the real gateway does before the client speaks. */
    bound = false;
    refuseKey = false;
    tickets = 0;
    chatReplies: string[] = [];
    secrets: Frame[] = [];
    onReceive: ((frame: Frame) => void) | null = null;
    contextSendError: Error | null = null;
    private waiters: Array<() => void> = [];

    webSocket = (url: string): WebSocketLike => {
        this.urls.push(url);
        return new FakeSocket(this, url);
    };

    fetch = async (url: string, init?: { method?: string; body?: unknown }): Promise<Response> => {
        const path = new URL(url).pathname;
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Frame) : undefined;
        if (this.refuseKey) return json(401, { detail: "Invalid API key" });
        if (path === "/v1/realtime/ticket") {
            this.tickets += 1;
            return json(200, { ticket: `rt_${this.tickets}`, expires_in: 30 });
        }
        if (path === "/v1/voices") return json(200, { data: [{ voice_id: "ev_atlas", name: "Atlas", is_builtin: true, status: "ready" }] });
        if (path === "/v1/chat/completions") {
            return json(200, { choices: [{ message: { content: this.chatReplies.shift() ?? '{"summary": "", "memories": [], "forget": []}' } }] });
        }
        if (path === "/v1/realtime/client_secrets" && body) {
            this.secrets.push(body);
            const lock = body.eesi_lock === "all" ? ["instructions", "tools", "voice", "turn_detection", "context", "conversation"] : (body.eesi_lock ?? ["instructions", "tools"]);
            return json(200, {
                value: "rt_secret_1",
                expires_at: Math.floor(Date.now() / 1000) + 60,
                session: body.session,
                eesi_lock: lock,
                eesi_control: body.eesi_control ? { id: "ctl_0123456789abcdef", tools: body.eesi_control.tools } : null,
            });
        }
        return json(404, { detail: "Not Found" });
    };

    accept(socket: FakeSocket): void {
        socket.readyState = 1;
        socket.onopen?.({});
        const url = new URL(socket.url);
        if (url.pathname.startsWith("/v1/realtime/control/")) {
            this.control = socket;
            socket.deliver({ type: "eesi.control.attached", control_id: url.pathname.split("/").pop(), session_id: this.sessionId, recording_session_id: "rec_control", tools: this.controlTools });
            return;
        }
        this.socket = socket;
        const resumed = url.searchParams.has("resume");
        socket.deliver({ type: "eesi.recording_disclosure", disclosure: { recorded: false } });
        socket.deliver({ type: "eesi.session", session_id: this.sessionId, resume: { supported: true }, resume_token: "resume-secret", ...(resumed ? { resumed: { replayed_items: 4 } } : {}) });
        socket.deliver({ type: "session.created", session: { id: "sess_1", model: "nur-v1" } });
        if (this.bound) socket.deliver({ type: "session.updated", session: {} });
    }

    receive(socket: FakeSocket, frame: Frame): void {
        this.frames.push(frame);
        this.onReceive?.(frame);
        if (socket === this.socket && frame.type === "session.update") socket.deliver({ type: "session.updated", session: frame.session });
        if (socket === this.socket && frame.type === "conversation.item.create" && frame.item?.type === "message") socket.deliver({ type: "conversation.item.added", item: frame.item });
        for (const wake of this.waiters.splice(0)) wake();
    }

    send(event: Frame): void {
        (this.socket as FakeSocket).deliver(event);
    }

    sendControl(event: Frame): void {
        (this.control as FakeSocket).deliver(event);
    }

    drop(code = 1011): void {
        const socket = this.socket as FakeSocket;
        setTimeout(() => {
            socket.readyState = 3;
            socket.onclose?.({ code, reason: "dropped" });
        }, 0);
    }

    ofType(type: string): Frame[] {
        return this.frames.filter((frame) => frame.type === type);
    }

    async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 3_000): Promise<Frame> {
        const deadline = Date.now() + timeoutMs;
        let seen = 0;
        for (;;) {
            for (const frame of this.frames.slice(seen)) if (predicate(frame)) return frame;
            seen = this.frames.length;
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`no matching frame; got ${this.frames.map((frame) => frame.type).join(", ")}`);
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, left);
                this.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }

    waitType(type: string, after = 0, timeoutMs = 3_000): Promise<Frame> {
        return this.waitFor((frame) => frame.type === type && this.frames.indexOf(frame) >= after, timeoutMs);
    }

    reply(id: string, text: string, options: { audioMs?: number; done?: boolean } = {}): void {
        this.send({ type: "response.created", response: { id } });
        this.send({ type: "response.output_audio_transcript.delta", response_id: id, delta: text });
        const samples = 24 * (options.audioMs ?? 200);
        this.send({ type: "response.output_audio.delta", response_id: id, delta: Buffer.alloc(samples * 2, 0x10).toString("base64") });
        this.send({ type: "response.output_audio_transcript.done", response_id: id, transcript: text, event_id: `e_${id}` });
        if (options.done ?? true) this.send({ type: "response.done", response: { id, status: "completed" } });
    }

    playerSays(text: string, itemId = "item_1"): void {
        this.send({ type: "input_audio_buffer.speech_started", item_id: itemId });
        this.send({ type: "input_audio_buffer.speech_stopped", item_id: itemId });
        this.send({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: text });
    }
}

const quiet = { warn: () => undefined, error: () => undefined };

function nurFor(gateway: FakeGateway): NurClient {
    return new NurClient({ apiKey: "sk-test", baseUrl: "http://gateway.test", fetch: gateway.fetch, webSocket: gateway.webSocket, timezone: null, logger: quiet });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerReceipt(responseId: string): Frame {
    return {
        type: "eesi.response_context",
        schema_version: 1,
        event_id: "receipt_event",
        response_id: responseId,
        turn_id: null,
        turn_revision: null,
        status: "provider_started",
        receipt: {
            receipt_id: "receipt_1",
            coverage: "serialized_provider_input",
            provider_format: "chat_completions",
            model: "nur-llm-v1",
            input_sha256: "a".repeat(64),
            item_count: 1,
        },
    };
}

const opened: string[] = [];
const openGate = tool({
    name: "open_gate",
    description: "Open one of the castle gates.",
    parameters: { type: "object", properties: { gate: { type: "string", enum: ["north", "south"] } }, required: ["gate"] },
    run: ({ gate }) => {
        opened.push(gate);
        return `The ${gate} gate is open.`;
    },
});

// ── sessions ─────────────────────────────────────────────────────────────

describe("a session", () => {
    it("delivers only receipt metadata to callbacks, waits, streams and a content-free trace", async () => {
        const gateway = new FakeGateway();
        const trace = new Trace();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ playerId: "p42", trace }).start();
        const seen: ResponseContext[] = [];
        session.on("response.context", (event) => seen.push(event));
        const stream = session.stream();
        try {
            const first = stream.next();
            const waiting = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id: "r_receipt" } });
            const wire = providerReceipt("r_receipt");
            wire.instructions = "excluded prompt marker";
            wire.authorization = "excluded credential marker";
            wire.receipt.words = "excluded words marker";
            wire.receipt.tool_outputs = [{ output: "excluded tool output marker" }];
            gateway.send(wire);
            const event = await waiting;
            assert.equal(seen.length, 1);
            assert.deepEqual(seen[0], event);
            assert.equal((await first).value.type, "response.started");
            assert.deepEqual((await stream.next()).value, event);
            const { at, ...data } = event;
            assert.equal(typeof at, "number");
            assert.deepEqual(data, {
                type: "response.context", sessionId: "conv_test", playerId: "p42",
                responseId: "r_receipt", receiptId: "receipt_1", inputSha256: "a".repeat(64),
                providerFormat: "chat_completions", model: "nur-llm-v1", itemCount: 1,
                coverage: "serialized_provider_input", turnId: null, turnRevision: null,
            });
            const receiptLine = trace.lines.find((line) => line.kind === "response.context");
            assert.equal(receiptLine?.input_sha256, wire.receipt.input_sha256);
            assert.equal(receiptLine?.receipt_id, "receipt_1");
            assert.equal(receiptLine?.coverage, "serialized_provider_input");
            assert.doesNotMatch(JSON.stringify([event, trace.lines]), /excluded/);
        } finally {
            await stream.return?.();
            await session.close({ learn: false });
        }
    });

    it("preserves both provider formats and independently nullable turn fields", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        try {
            for (const [index, [format, turnId, revision]] of [
                ["responses", "turn_1", 0],
                ["chat_completions", null, 2],
                ["responses", "turn_2", null],
                ["chat_completions", undefined, undefined],
            ].entries()) {
                const rid = `r_receipt_${index}`;
                const waiting = session.wait("response.context", { timeoutMs: 1_000 });
                gateway.send({ type: "response.created", response: { id: rid } });
                const wire = providerReceipt(rid);
                wire.receipt.provider_format = format;
                wire.receipt.item_count = 0;
                wire.turn_id = turnId;
                wire.turn_revision = revision;
                gateway.send(wire);
                const event = await waiting;
                assert.equal(event.providerFormat, format);
                assert.equal(event.turnId, turnId ?? null);
                assert.equal(event.turnRevision, revision ?? null);
                assert.equal(event.itemCount, 0);
            }
        } finally {
            await session.close({ learn: false });
        }
    });

    it("ignores malformed receipts and continues receiving the reply's text and PCM", async () => {
        const gateway = new FakeGateway();
        const output = new SilentOutput();
        const trace = new Trace();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ output, trace }).start();
        const seen: ResponseContext[] = [];
        const errors: NurEvent[] = [];
        const audio: AudioOutputChunk[] = [];
        session.on("response.context", (event) => seen.push(event));
        session.on("error", (event) => errors.push(event));
        session.on("audio.output.chunk", (event) => audio.push(event));
        const mutations: Array<(frame: Frame) => void> = [
            (frame) => { frame.schema_version = true; },
            (frame) => { frame.schema_version = 2; },
            (frame) => { delete frame.schema_version; },
            (frame) => { frame.status = "completed"; },
            (frame) => { frame.receipt = []; },
            (frame) => { frame.receipt = null; },
            (frame) => { frame.receipt.coverage = "heard_audio"; },
            (frame) => { frame.receipt.receipt_id = ""; },
            (frame) => { frame.receipt.receipt_id = " "; },
            (frame) => { frame.receipt.receipt_id = "x".repeat(257); },
            (frame) => { frame.receipt.receipt_id = "receipt\n1"; },
            (frame) => { frame.receipt.receipt_id = " receipt_1"; },
            (frame) => { frame.receipt.receipt_id = "receipt_1 "; },
            (frame) => { frame.receipt.model = false; },
            (frame) => { frame.receipt.model = "nur\u200b"; },
            (frame) => { frame.receipt.model = "nur\u00a0model"; },
            (frame) => { frame.receipt.model = "x".repeat(257); },
            (frame) => { frame.receipt.model = " nur-llm-v1"; },
            (frame) => { frame.receipt.model = "nur-llm-v1 "; },
            (frame) => { frame.receipt.input_sha256 = "A".repeat(64); },
            (frame) => { frame.receipt.input_sha256 = "g".repeat(64); },
            (frame) => { frame.receipt.input_sha256 = "a".repeat(63); },
            (frame) => { frame.receipt.provider_format = "unknown"; },
            (frame) => { frame.receipt.item_count = true; },
            (frame) => { frame.receipt.item_count = -1; },
            (frame) => { frame.receipt.item_count = 1.5; },
            (frame) => { frame.receipt.item_count = "1"; },
            (frame) => { frame.receipt.item_count = Number.MAX_SAFE_INTEGER + 1; },
            (frame) => { frame.turn_id = ""; },
            (frame) => { frame.turn_id = "x".repeat(257); },
            (frame) => { frame.turn_id = "turn\n1"; },
            (frame) => { frame.turn_id = 1; },
            (frame) => { frame.turn_id = " turn_1 "; },
            (frame) => { frame.turn_revision = true; },
            (frame) => { frame.turn_revision = -1; },
            (frame) => { frame.turn_revision = 1.5; },
            (frame) => { frame.response_id = "r_receipt\n"; },
            (frame) => { frame.response_id = "x".repeat(257); },
            (frame) => { frame.response_id = " r_receipt "; },
        ];
        try {
            gateway.send({ type: "response.created", response: { id: "r_receipt" } });
            for (const mutate of mutations) {
                const wire = providerReceipt("r_receipt");
                mutate(wire);
                gateway.send(wire);
            }
            const waiting = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send(providerReceipt("r_receipt"));
            await waiting;
            assert.equal(seen.length, 1, "only the final valid receipt was accepted");
            assert.equal(trace.lines.filter((line) => line.kind === "response.context").length, 1);
            const completed = session.wait("response.completed", { timeoutMs: 1_000 });
            const pcm = Buffer.alloc(48, 0x10);
            gateway.send({ type: "response.output_audio.delta", response_id: "r_receipt", delta: pcm.toString("base64") });
            gateway.send({ type: "response.output_audio_transcript.done", response_id: "r_receipt", transcript: "Still speaking.", event_id: "receipt_text" });
            gateway.send({ type: "response.done", response: { id: "r_receipt", status: "completed" } });
            assert.equal((await completed).text, "Still speaking.");
            assert.deepEqual(audio[0]?.pcm, new Uint8Array(pcm));
            assert.deepEqual(errors, []);
        } finally {
            await session.close({ learn: false });
        }
    });

    it("suppresses unknown, cancelled, completed and SDK-internal response receipts", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        const seen: ResponseContext[] = [];
        session.on("response.context", (event) => seen.push(event));
        try {
            gateway.send(providerReceipt("unknown"));
            gateway.send({ type: "response.created", response: { id: "cancelled" } });
            gateway.send({ type: "output_audio_buffer.cleared", response_id: "cancelled" });
            gateway.send(providerReceipt("cancelled"));
            gateway.send({ type: "response.created", response: { id: "internal", metadata: { eesi_sdk: "idle_check" } } });
            gateway.send(providerReceipt("internal"));
            gateway.send({ type: "response.created", response: { id: "completed" } });
            gateway.send({ type: "response.done", response: { id: "completed", status: "completed" } });
            gateway.send(providerReceipt("completed"));
            gateway.send({ type: "response.created", response: { id: "completed" } });
            gateway.send(providerReceipt("completed"));
            const waiting = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id: "public" } });
            gateway.send(providerReceipt("public"));
            assert.equal((await waiting).responseId, "public");
            assert.deepEqual(seen.map((event) => event.responseId), ["public"]);
        } finally {
            await session.close({ learn: false });
        }
    });

    it("does not retain invalid receipt IDs or normalize valid interior spaces", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        const seen: ResponseContext[] = [];
        session.on("response.context", (event) => seen.push(event));
        try {
            for (const id of ["", " padded", "padded ", " ", "x".repeat(257), "line\nbreak", "zero\u200bwidth"]) {
                gateway.send({ type: "response.created", response: { id } });
                gateway.send(providerReceipt(id));
                gateway.send({ type: "response.done", response: { id, status: "completed" } });
            }
            const id = "valid internal space";
            const waiting = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id } });
            const frame = providerReceipt(id);
            frame.receipt.receipt_id = "receipt internal space";
            frame.receipt.model = "model internal space";
            frame.turn_id = "turn internal space";
            gateway.send(frame);
            const event = await waiting;
            assert.equal(event.responseId, id);
            assert.equal(event.receiptId, "receipt internal space");
            assert.equal(event.model, "model internal space");
            assert.equal(event.turnId, "turn internal space");
            assert.deepEqual([...(Reflect.get(session, "receiptResponses") as Map<string, boolean>)], [[id, true]]);
            assert.deepEqual(seen, [event]);
        } finally {
            await session.close({ learn: false });
        }
    });

    it("does not accept an unfinished prior-connection receipt after reconnect", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        const seen: ResponseContext[] = [];
        session.on("response.context", (event) => seen.push(event));
        try {
            const started = session.wait("response.started", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id: "old_connection" } });
            await started;
            const reconnected = session.wait("reconnected", { timeoutMs: 5_000 });
            gateway.drop();
            await reconnected;
            gateway.send(providerReceipt("old_connection"));
            const waiting = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id: "new_connection" } });
            gateway.send(providerReceipt("new_connection"));
            assert.equal((await waiting).responseId, "new_connection");
            assert.deepEqual(seen.map((event) => event.responseId), ["new_connection"]);
            // One reply may make another provider request (for example after
            // a refused tool call); do not deduplicate it by response ID.
            const next = session.wait("response.context", { timeoutMs: 1_000 });
            const later = providerReceipt("new_connection");
            later.receipt.receipt_id = "receipt_2";
            later.receipt.input_sha256 = "b".repeat(64);
            gateway.send(later);
            assert.equal((await next).receiptId, "receipt_2");
            assert.deepEqual(seen.map((event) => event.inputSha256), ["a".repeat(64), "b".repeat(64)]);
        } finally {
            await session.close({ learn: false });
        }
    });

    it("keeps terminal receipt IDs after reply pruning and internal ID reuse", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        const seen: ResponseContext[] = [];
        session.on("response.context", (event) => seen.push(event));
        try {
            gateway.send({ type: "response.created", response: { id: "old_completed" } });
            gateway.send({ type: "response.done", response: { id: "old_completed", status: "completed" } });
            // The session discards old done Reply objects after 64 responses.
            for (let index = 0; index < 66; index += 1) {
                const id = `prune_${index}`;
                gateway.send({ type: "response.created", response: { id } });
                gateway.send({ type: "response.done", response: { id, status: "completed" } });
            }
            gateway.send({ type: "response.created", response: { id: "old_completed" } });
            gateway.send(providerReceipt("old_completed"));
            gateway.send({ type: "response.created", response: { id: "reused_internal" } });
            gateway.send({ type: "response.created", response: { id: "reused_internal", metadata: { eesi_sdk: "idle_check" } } });
            gateway.send({ type: "response.done", response: { id: "reused_internal", status: "completed" } });
            gateway.send(providerReceipt("reused_internal"));
            const waiting = session.wait("response.context", { timeoutMs: 2_000 });
            gateway.send({ type: "response.created", response: { id: "public" } });
            gateway.send(providerReceipt("public"));
            assert.equal((await waiting).responseId, "public");
            assert.deepEqual(seen.map((event) => event.responseId), ["public"]);
        } finally {
            await session.close({ learn: false });
        }
    });

    it("bounds receipt IDs and suppresses overflow receipts until reconnect without stopping PCM", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        const seen: ResponseContext[] = [];
        const audio: AudioOutputChunk[] = [];
        session.on("response.context", (event) => seen.push(event));
        session.on("audio.output.chunk", (event) => audio.push(event));
        try {
            const first = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id: "still_active" } });
            gateway.send(providerReceipt("still_active"));
            await first;
            for (let index = 0; index < 2_047; index += 1) {
                const id = `cap_${index}`;
                gateway.send({ type: "response.created", response: { id } });
                gateway.send({ type: "response.done", response: { id, status: "completed" } });
            }
            gateway.send({ type: "response.created", response: { id: "over_cap" } });
            gateway.send(providerReceipt("over_cap"));
            // Overflow also suppresses a previously eligible reply's receipt.
            gateway.send(providerReceipt("still_active"));
            const completed = session.wait("response.completed", {
                timeoutMs: 5_000, predicate: (event) => event.responseId === "after_cap",
            });
            gateway.reply("after_cap", "Audio continues.", { audioMs: 1 });
            assert.equal((await completed).text, "Audio continues.");
            assert.equal(audio[0]?.pcm.byteLength, 48);
            assert.deepEqual(seen.map((event) => event.responseId), ["still_active"]);
            assert.equal((Reflect.get(session, "receiptResponses") as Map<string, boolean>).size, 2_048);
            const reconnected = session.wait("reconnected", { timeoutMs: 5_000 });
            gateway.drop();
            await reconnected;
            const next = session.wait("response.context", { timeoutMs: 1_000 });
            gateway.send({ type: "response.created", response: { id: "post_reconnect" } });
            gateway.send(providerReceipt("post_reconnect"));
            assert.equal((await next).responseId, "post_reconnect");
            assert.deepEqual(seen.map((event) => event.responseId), ["still_active", "post_reconnect"]);
            assert.equal((Reflect.get(session, "receiptResponses") as Map<string, boolean>).size, 1);
        } finally {
            await session.close({ learn: false });
        }
    });

    for (const request of ["respond", "say"] as const) {
        it(`${request} publishes the latest awaited context before its response frame`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, turnTaking: "director" }).connect({ context: { previousReply: "Old words", job: "Old goal" } }).start();
            try {
                const after = gateway.frames.length;
                await session.context.update({ previousReply: "The preceding generated words", job: "React to that reply" });
                assert.equal(gateway.frames.length, after, "the real publisher still throttles this update");
                await session[request]("A directed reply");
                const frames = gateway.frames.slice(after);
                assert.deepEqual(frames.map((frame) => frame.type), ["eesi.context.update", "response.create"]);
                assert.equal(frames[0]?.key, "scene");
                assert.match(frames[0]?.text, /previousReply: The preceding generated words/);
                assert.match(frames[0]?.text, /job: React to that reply/);
                assert.equal(frames[1]?.response.instructions, request === "respond" ? "A directed reply" : 'Say exactly this, in character and in your own voice, and nothing else: "A directed reply"');
            } finally {
                await session.close({ learn: false });
            }
        });

        it(`${request} rejects a real publisher flush failure without requesting a reply`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, turnTaking: "director" }).connect().start();
            try {
                // Each block is valid alone, but their combined count exceeds
                // the gateway's eight-block contract checked by the publisher.
                for (let index = 0; index < 9; index += 1) await session.context.update({ goal: `Goal ${index}` }, { block: `goal_${index}` });
                await assert.rejects(session[request]("Do not send this cue"), ContextError);
                assert.equal(gateway.ofType("response.create").length, 0);
                assert.equal(gateway.ofType("eesi.context.update").length, 0, "validation fails before any context frame");
            } finally {
                await session.close({ learn: false });
            }
        });

        it(`${request} propagates a socket context failure without remembering or replying`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, turnTaking: "director" }).connect({ context: { job: "Old goal" } }).start();
            try {
                const after = gateway.frames.length;
                await session.context.update({ job: "New final goal" });
                gateway.contextSendError = new Error("synthetic context transport failure");
                await assert.rejects(session[request]("Do not reply with the old goal"), /synthetic context transport failure/);
                assert.deepEqual(gateway.frames.slice(after), [], "neither context nor reply was delivered");
                assert.equal(session.publisher.current().scene, "job: Old goal", "failed state is never marked as published");
            } finally {
                await session.close({ learn: false });
            }
        });

        it(`${request} rejects a context flush over a non-open transport`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, turnTaking: "director" }).connect({ context: { job: "Old goal" } }).start();
            try {
                const after = gateway.frames.length;
                await session.context.update({ job: "New final goal" });
                (gateway.socket as FakeSocket).readyState = 3;
                await assert.rejects(session[request]("Do not reply with the old goal"), /Cannot publish context/);
                assert.deepEqual(gateway.frames.slice(after), []);
                assert.equal(session.publisher.current().scene, "job: Old goal");
            } finally {
                await session.close({ learn: false });
            }
        });

        it(`${request} rechecks closure after the real publisher's send awaits`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, turnTaking: "director" }).connect({ context: { job: "Old goal" } }).start();
            try {
                await session.context.update({ job: "New goal" });
                gateway.onReceive = (frame) => {
                    if (frame.type === "eesi.context.update") void session.close({ learn: false });
                };
                await assert.rejects(session[request]("Do not send this late cue"), SessionClosedError);
                assert.equal(session.closed, true);
                assert.equal(gateway.ofType("response.create").length, 0);
            } finally {
                gateway.onReceive = null;
                await session.close({ learn: false });
            }
        });

        it(`${request} preserves the open-transport guard after publishing context`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, turnTaking: "director" }).connect({ context: { job: "Old goal" } }).start();
            try {
                await session.context.update({ job: "New goal" });
                gateway.onReceive = (frame) => {
                    if (frame.type === "eesi.context.update") (gateway.socket as FakeSocket).readyState = 3;
                };
                await session[request]("Do not send over the closed socket");
                assert.equal(gateway.ofType("response.create").length, 0);
            } finally {
                gateway.onReceive = null;
                await session.close({ learn: false });
            }
        });
    }

    for (const request of ["sendText", "ask"] as const) {
        it(`${request} publishes current context before its automatic response`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ context: { job: "Old goal" } }).start();
            try {
                const after = gateway.frames.length;
                await session.context.update({ job: "New final goal" });
                const completion = request === "ask" ? session.ask("A question", { timeoutMs: 1_000 }) : session.sendText("A question");
                await gateway.waitType("response.create", after);
                const frames = gateway.frames.slice(after);
                assert.deepEqual(frames.map((frame) => frame.type), ["conversation.item.create", "eesi.context.update", "response.create"]);
                assert.equal(frames[1]?.text, "job: New final goal");
                if (request === "ask") gateway.reply("context_order_reply", "The current goal's answer.");
                const answer = await completion;
                if (answer) assert.equal(answer.text, "The current goal's answer.");
            } finally {
                await session.close({ learn: false });
            }
        });

        it(`${request} rejects a failed context send without an automatic response`, async () => {
            const gateway = new FakeGateway();
            const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ context: { job: "Old goal" } }).start();
            try {
                const after = gateway.frames.length;
                await session.context.update({ job: "New final goal" });
                gateway.contextSendError = new Error("synthetic context transport failure");
                const completion = request === "ask" ? session.ask("A question", { timeoutMs: 1_000 }) : session.sendText("A question");
                await assert.rejects(completion, /synthetic context transport failure/);
                assert.deepEqual(gateway.frames.slice(after).map((frame) => frame.type), ["conversation.item.create"], "the player text may arrive, but no reply is requested");
                assert.equal(session.publisher.current().scene, "job: Old goal");
            } finally {
                await session.close({ learn: false });
            }
        });
    }

    it("keeps ordinary realtime sends best effort when the socket throws", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect().start();
        try {
            const after = gateway.frames.length;
            (gateway.socket as FakeSocket).send = () => { throw new Error("synthetic socket send failure"); };
            assert.doesNotThrow(() => session.send({ type: "response.cancel" }));
            assert.deepEqual(gateway.frames.slice(after), []);
        } finally {
            await session.close({ learn: false });
        }
    });

    it("sends the character, then its state, then a greeting, dialing with a ticket", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).npc({ name: "Kael", persona: "An elven merchant.", voice: "Atlas", context: { realm: "Eldermoor" }, tools: [openGate] });
        const session = await kael.connect({ playerId: "p42", context: { location: "the northern gate" } }).start();
        try {
            const update = gateway.ofType("session.update")[0] as Frame;
            assert.match(update.session.instructions, /^You are Kael, a character who lives in this world\. An elven merchant\./);
            assert.equal(update.session.audio.output.voice, "ev_atlas");
            assert.deepEqual(update.session.tools.map((item: Frame) => item.name), ["open_gate"]);
            await gateway.waitType("response.create");
            const types = gateway.frames.map((frame) => frame.type);
            assert.deepEqual(gateway.ofType("eesi.context.update").map((frame) => frame.key), ["world", "scene"]);
            assert.ok(types.indexOf("session.update") < types.indexOf("eesi.context.update"));
            assert.ok(types.indexOf("eesi.context.update") < types.indexOf("response.create"));
            assert.match(gateway.urls[0] as string, /^ws:\/\/gateway\.test\/v1\/realtime\?model=nur-v1&source=sdk&token=rt_1$/);
        } finally {
            await session.close();
        }
    });

    it("fails start() with AuthenticationError when the key is refused", async () => {
        const gateway = new FakeGateway();
        gateway.refuseKey = true;
        await assert.rejects(nurFor(gateway).npc({ name: "Kael" }).connect().start(), AuthenticationError);
    });

    it("runs a tool call once, answers it, and continues once", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", tools: [openGate], greeting: false }).connect().start();
        try {
            opened.length = 0;
            const call = { type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "open_gate", arguments: '{"gate":"north"}' };
            gateway.send({ type: "response.created", response: { id: "r1" } });
            gateway.send(call);
            gateway.send(call);
            gateway.send({ type: "response.done", response: { id: "r1", status: "completed" } });
            const output = await gateway.waitFor((frame) => frame.item?.type === "function_call_output");
            assert.equal(output.item.call_id, "c1");
            assert.equal(output.item.output, "The north gate is open.");
            const after = gateway.frames.indexOf(output);
            const next = await gateway.waitType("response.create", after);
            assert.equal(next.response, undefined, "a plain continuation");
            await sleep(30);
            assert.deepEqual(opened, ["north"]);
            assert.equal(gateway.frames.filter((frame) => frame.item?.type === "function_call_output").length, 1);
        } finally {
            await session.close();
        }
    });

    it("answers bad arguments and refusals without running the tool", async () => {
        const gateway = new FakeGateway();
        const sealed = tool({ name: "open_vault", description: "Open the vault.", allow: () => "the vault is sealed", run: () => "opened" });
        const session = await nurFor(gateway).npc({ name: "Kael", tools: [openGate, sealed], greeting: false }).connect().start();
        try {
            opened.length = 0;
            gateway.send({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "open_gate", arguments: '{"gate":"west"}' });
            gateway.send({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c2", name: "open_vault", arguments: "{}" });
            const bad = await gateway.waitFor((frame) => frame.item?.call_id === "c1");
            const refused = await gateway.waitFor((frame) => frame.item?.call_id === "c2");
            assert.match(bad.item.output, /must be one of "north", "south"/);
            assert.match(refused.item.output, /Not allowed: the vault is sealed/);
            assert.deepEqual(opened, []);
        } finally {
            await session.close();
        }
    });

    it("drops queued audio on barge-in, and the cut reply's late audio", async () => {
        const gateway = new FakeGateway();
        const output = new SilentOutput();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ output }).start();
        try {
            gateway.reply("r1", "A long tale of the north.", { audioMs: 3_000, done: false });
            await session.wait("response.started");
            await sleep(20);
            assert.ok(output.bufferedSeconds() > 2);
            const interrupted = session.wait("speech.interrupted");
            gateway.send({ type: "input_audio_buffer.speech_started" });
            await interrupted;
            assert.equal(output.bufferedSeconds(), 0);
            gateway.send({ type: "response.output_audio.delta", response_id: "r1", delta: Buffer.alloc(4_800, 0x10).toString("base64") });
            await sleep(20);
            assert.equal(output.bufferedSeconds(), 0);
        } finally {
            await session.close();
        }
    });

    it("learns from a conversation and remembers it in the player's next session", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).npc({ name: "Kael", memory: new Memory() });
        gateway.chatReplies.push(
            JSON.stringify({ summary: "They asked about the gate.", memories: [{ text: "They are called Mira.", kind: "fact", importance: "high", key: null, replaces: null }], forget: [] }),
        );
        const first = await kael.connect({ playerId: "p42" }).start();
        gateway.playerSays("I'm Mira. Is the gate open?");
        await first.wait("transcript.final");
        await first.close();
        const texts = (await kael.memory!.forPlayer("p42").list()).map((record) => record.text);
        assert.ok(texts.includes("They are called Mira."));
        assert.deepEqual((await kael.memory!.forPlayer("someone-else").list()).length, 0);

        const before = gateway.frames.length;
        const second = await kael.connect({ playerId: "p42" }).start();
        try {
            const block = await gateway.waitFor((frame) => frame.type === "eesi.context.update" && frame.key === "memory" && gateway.frames.indexOf(frame) >= before);
            assert.match(block.text, /Mira/);
            const greeting = await gateway.waitType("response.create", before);
            assert.match(greeting.response.instructions, /someone you have met before/);
        } finally {
            await second.close({ learn: false });
        }
    });

    it("asks for each reply itself with app turn-taking", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", turnTaking: "app", greeting: false }).connect().start();
        try {
            assert.equal((gateway.ofType("session.update")[0] as Frame).session.audio.input.turn_detection.create_response, false);
            gateway.playerSays("Hello there.");
            const request = await gateway.waitType("response.create");
            assert.equal(request.response.tool_choice, "auto");
        } finally {
            await session.close();
        }
    });

    it("resumes a lost connection and sends the character and its state again", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ context: { location: "the gate" } }).start();
        try {
            const before = gateway.frames.length;
            gateway.drop(1011);
            const reconnected = await session.wait("reconnected", { timeoutMs: 5_000 });
            assert.equal(reconnected.resumed, true);
            assert.match(gateway.urls.at(-1) as string, /resume=conv_test&resume_token=resume-secret&token=rt_2/);
            await gateway.waitType("session.update", before);
            await gateway.waitFor((frame) => frame.type === "eesi.context.update" && frame.key === "scene" && gateway.frames.indexOf(frame) >= before);
        } finally {
            await session.close();
        }
    });

    it("keeps the voice in a partial update", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael", voice: "Atlas", tools: [openGate], greeting: false }).connect().start();
        try {
            await session.setToolEnabled("open_gate", false);
            const update = await gateway.waitFor((frame) => frame.type === "session.update" && Array.isArray(frame.session.tools) && frame.session.tools.length === 0);
            assert.equal(update.session.audio.output.voice, "ev_atlas");
            assert.equal(update.session.tool_choice, "none");
        } finally {
            await session.close();
        }
    });

    it("answers the question asked, not the greeting still playing", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).npc({ name: "Kael" }).connect().start();
        try {
            await gateway.waitType("response.create");
            gateway.reply("r1", "Well met, traveller.", { done: false });
            const answer = session.ask("Is the gate open?");
            await gateway.waitFor((frame) => frame.type === "conversation.item.create" && frame.item?.type === "message");
            await sleep(10);
            gateway.send({ type: "response.done", response: { id: "r1", status: "completed" } });
            gateway.reply("r2", "The gate is shut till dawn.");
            assert.equal((await answer).text, "The gate is shut till dawn.");
        } finally {
            await session.close();
        }
    });

    it("keeps no words in a trace unless asked", async () => {
        const gateway = new FakeGateway();
        const trace = new Trace();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ trace }).start();
        gateway.playerSays("my secret plan");
        await session.wait("transcript.final");
        gateway.reply("r1", "Interesting.");
        await session.wait("response.completed");
        await session.close();
        const heard = trace.lines.find((line) => line.kind === "transcript.final") as Frame;
        assert.deepEqual(heard.text, { chars: 14 });
        assert.doesNotMatch(JSON.stringify(trace.lines), /secret plan/);
        assert.ok("response_id" in (trace.lines.find((line) => line.kind === "response.completed") as Frame));
        assert.ok(trace.lines.some((line) => line.kind === "metrics" && "latency_p50" in line));
        assert.match(formatTrace(trace.lines), /heard {5}player: …/);
    });

    it("does not attribute an explicitly unknown voice to the session's player", async () => {
        const gateway = new FakeGateway();
        const trace = new Trace();
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false }).connect({ playerId: "p1", playerName: "Ana", trace }).start();
        try {
            gateway.playerSays("Unattributed voice: Wait for me.");
            const heard = await session.wait("transcript.final");
            assert.deepEqual(heard.turns, [{ text: "Wait for me.", speaker: null, playerId: null, unattributed: true }]);
            assert.deepEqual(session.transcript.at(-1), ["Unattributed voice", "Wait for me."]);
            assert.match(formatTrace(trace.lines), /heard {5}Unattributed voice: …/);
            assert.doesNotMatch(JSON.stringify(trace.lines), /Wait for me/);
        } finally {
            await session.close();
        }
    });

    it("keeps an unknown voice out of the previous player's tools and memories", async () => {
        const gateway = new FakeGateway();
        const toolPlayers: Array<string | null> = [];
        const learned: Array<Array<[string, string]>> = [];
        const identify = tool({ name: "identify", description: "Read the caller context.", run: (_, context) => { toolPlayers.push(context.playerId); return "done"; } });
        const memory = new Memory(undefined, { extractor: async (request) => { learned.push(request.transcript); return { summary: "", memories: [], forget: [] }; } });
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, tools: [identify], memory }).connect({ playerId: "p1", playerName: "Ana" }).start();
        try {
            gateway.playerSays("Unattributed voice: I live in the unknown city.", "unknown");
            await session.wait("transcript.final");
            gateway.send({ type: "response.function_call_arguments.done", response_id: "unknown_reply", call_id: "unknown_call", name: "identify", arguments: "{}" });
            await gateway.waitFor((frame) => frame.item?.call_id === "unknown_call");
            gateway.reply("unknown_reply", "You live in the unknown city.", { done: false });
            await session.wait("response.started");
            gateway.playerSays("I like tea.", "known");
            await session.wait("transcript.final");
            gateway.send({ type: "response.function_call_arguments.done", response_id: "known_reply", call_id: "known_call", name: "identify", arguments: "{}" });
            await gateway.waitFor((frame) => frame.item?.call_id === "known_call");
            gateway.reply("known_reply", "Tea sounds good.");
            await session.wait("response.completed");
            // The old reply finishes after a known caller has taken the floor.
            // Learning follows the reply's original attribution, not the latest.
            gateway.send({ type: "response.done", response: { id: "unknown_reply", status: "completed" } });
            await session.wait("response.completed");
        } finally {
            await session.close();
        }
        assert.deepEqual(toolPlayers, [null, "p1"]);
        assert.deepEqual(learned, [[["player", "I like tea."], ["Kael", "Tea sounds good."]]]);
        assert.ok(session.transcript.some(([, text]) => text.includes("unknown city")), "public transcript retains all words");
    });

    it("treats an external attributor's explicit unknown flag as authoritative", async () => {
        const gateway = new FakeGateway();
        const players: Array<string | null> = [];
        const identify = tool({ name: "identify", description: "Read the caller context.", run: (_, context) => { players.push(context.playerId); return "done"; } });
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, tools: [identify] }).connect({ playerId: "p1", playerName: "Ana" }).start();
        try {
            // An adapter may retain its previous guesses alongside uncertainty.
            // Neither guess is usable when the adapter explicitly says unknown.
            session.attributor = () => [{ text: "Not Ana.", speaker: 1, player: "Ana", unattributed: true }];
            gateway.playerSays("Unattributed voice: Not Ana.");
            const heard = await session.wait("transcript.final");
            assert.deepEqual(heard.turns, [{ text: "Not Ana.", speaker: null, playerId: null, unattributed: true }]);
            gateway.send({ type: "response.function_call_arguments.done", response_id: "unknown", call_id: "check", name: "identify", arguments: "{}" });
            await gateway.waitFor((frame) => frame.item?.call_id === "check");
            assert.deepEqual(players, [null]);
        } finally {
            await session.close();
        }
    });

    for (const finalUnknown of [true, false]) {
        it(`keeps a response opened before ${finalUnknown ? "unknown" : "known"} final STT unassigned`, async () => {
            const gateway = new FakeGateway();
            const owners: Array<string | null> = [];
            const learned: Array<Array<[string, string]>> = [];
            const identify = tool({ name: "identify", description: "Read the caller context.", run: (_, context) => { owners.push(context.playerId); return "done"; } });
            const memory = new Memory(undefined, { extractor: async (request) => { learned.push(request.transcript); return { summary: "", memories: [], forget: [] }; } });
            const character = nurFor(gateway).npc({ name: "Kael", greeting: false, tools: [identify], memory, party: true });
            const session = await character.connect({ playerId: "p1", playerName: "Ana" }).start();
            try {
                gateway.playerSays("Previous known words.", "previous");
                await session.wait("transcript.final");
                gateway.send({ type: "response.created", response: { id: "established" } });
                await session.wait("response.started");
                gateway.send({ type: "input_audio_buffer.speech_started", item_id: "pending", interrupt_response: false });
                await session.wait("audio.input.started");
                gateway.send({ type: "response.created", response: { id: "early", metadata: { nur_act: "backchannel" } } });
                await session.wait("response.started");
                gateway.send({ type: "input_audio_buffer.speech_stopped", item_id: "pending" });
                gateway.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "pending", transcript: finalUnknown ? "Unattributed voice: New words." : "New known words." });
                await session.wait("transcript.final");
                for (const rid of ["established", "early", "future"]) {
                    gateway.send({ type: "response.function_call_arguments.done", response_id: rid, call_id: rid, name: "identify", arguments: "{}" });
                    await gateway.waitFor((frame) => frame.item?.call_id === rid);
                }
                assert.deepEqual(owners, ["p1", null, finalUnknown ? null : "p1"]);
                gateway.send({ type: "response.output_text.done", response_id: "early", text: "Early reply to the pending voice." });
                gateway.send({ type: "response.done", response: { id: "early", status: "completed" } });
                await session.wait("response.completed");
                assert.match(character.party!.render(), /Kael to Unattributed voice: Early reply/);
            } finally {
                await session.close();
            }
            assert.ok(learned.length);
            assert.ok(learned.every((lines) => lines.every(([, text]) => text !== "Early reply to the pending voice.")));
        });
    }

    it("fences late audio finals and failures from newer audio and typed ownership", async () => {
        const gateway = new FakeGateway();
        const owners: Array<string | null> = [];
        const identify = tool({ name: "identify", description: "Read the caller context.", run: (_, context) => { owners.push(context.playerId); return "done"; } });
        const session = await nurFor(gateway).npc({ name: "Kael", greeting: false, tools: [identify] }).connect({ playerId: "p1" }).start();
        const check = async (id: string, expected: string | null) => {
            gateway.send({ type: "response.function_call_arguments.done", response_id: id, call_id: id, name: "identify", arguments: "{}" });
            await gateway.waitFor((frame) => frame.item?.call_id === id);
            assert.equal(owners.at(-1), expected);
        };
        const start = async (id: string) => {
            gateway.send({ type: "input_audio_buffer.speech_started", item_id: id, interrupt_response: false });
            await session.wait("audio.input.started");
        };
        const final = async (id: string | null, transcript: string) => {
            gateway.send({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
            await session.wait("transcript.final");
        };
        try {
            gateway.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "empty-before-start", transcript: " " });
            await check("empty-control-stream", null);
            await start("older");
            await start("newer");
            await final("older", "Older known voice.");
            await check("late-old", null);
            await final(null, "Unlabelled known voice.");
            await check("unlabelled", null);
            gateway.send({ type: "conversation.item.input_audio_transcription.failed", item_id: "newer" });
            await check("failed", null);
            await start("known");
            await final("known", "Known again.");
            await final("older", "Unattributed voice: Old unknown.");
            await check("known-kept", "p1");
            gateway.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "known", transcript: " " });
            await check("empty-revision", null);
            await final("known", "Known again after empty revision.");
            await start("known"); // A speculative reopen can reuse this item.
            await check("reopened-early", null);
            await final("known", "Known after reopening.");
            await check("reopened-final", "p1");
            gateway.send({ type: "response.function_call_arguments.done", response_id: "reopened-early", call_id: "reopened-late-tool", name: "identify", arguments: "{}" });
            await gateway.waitFor((frame) => frame.item?.call_id === "reopened-late-tool");
            assert.equal(owners.at(-1), null);
            await start("before-text");
            await session.sendText("Typed by the configured player.", { respond: false });
            await check("typed", "p1");
            await final("before-text", "Unattributed voice: Late audio.");
            gateway.send({ type: "conversation.item.input_audio_transcription.failed", item_id: "before-text" });
            await check("typed-kept", "p1");
        } finally {
            await session.close();
        }
    });

    for (const initiallyUnknown of [true, false]) {
        for (const forwarded of [true, false]) {
            it(`preserves ${initiallyUnknown ? "unknown" : "known"} response ownership for a late ${forwarded ? "forwarded tool" : "local tool and party reply"}`, async () => {
                const gateway = new FakeGateway();
                const players: Array<string | null> = [];
                const permissionPlayers: Array<string | null> = [];
                const identify = tool({
                    name: "identify", description: "Read the caller context.",
                    allow: async (context) => {
                        permissionPlayers.push(context.playerId);
                        await sleep(1);
                        permissionPlayers.push(context.playerId);
                        return true;
                    },
                    run: (_, context) => { players.push(context.playerId); return "done"; },
                });
                const character = nurFor(gateway).npc({ name: "Kael", greeting: false, tools: forwarded ? [] : [identify], party: true });
                gateway.bound = forwarded;
                const session = forwarded
                    ? await joinSession({
                        url: "ws://gateway.test/v1/realtime?token=rt_owner", token: "rt_owner",
                        callsUrl: "http://gateway.test/v1/realtime/calls", expiresAt: Date.now() / 1000 + 60,
                        character: "Kael", model: "nur-v1", turnTaking: "natural", tools: "client", controlled: false,
                        greeting: null, proactive: null, outputSampleRate: 24_000, playerId: "p1", playerName: "Ana",
                    }, { webSocket: gateway.webSocket, logger: quiet, onToolCall: (call) => { players.push(call.playerId); return "done"; } })
                    : await character.connect({ playerId: "p1", playerName: "Ana" }).start();
                try {
                    gateway.playerSays(initiallyUnknown ? "Unattributed voice: First words." : "My first words.", "first");
                    await session.wait("transcript.final");
                    gateway.send({ type: "response.created", response: { id: "first_reply" } });
                    await session.wait("response.started");
                    gateway.playerSays(initiallyUnknown ? "My next words." : "Unattributed voice: Next words.", "next");
                    await session.wait("transcript.final");
                    gateway.send({ type: "response.function_call_arguments.done", response_id: "first_reply", call_id: "late_call", name: "identify", arguments: "{}" });
                    await gateway.waitFor((frame) => frame.item?.call_id === "late_call");
                    assert.deepEqual(players, [initiallyUnknown ? null : "p1"]);
                    if (!forwarded) assert.deepEqual(permissionPlayers, [initiallyUnknown ? null : "p1", initiallyUnknown ? null : "p1"]);
                    gateway.send({ type: "response.output_text.done", response_id: "first_reply", text: "A reply to the first voice." });
                    gateway.send({ type: "response.done", response: { id: "first_reply", status: "completed" } });
                    await session.wait("response.completed");
                    if (!forwarded) assert.ok(character.party!.render().includes(`Kael to ${initiallyUnknown ? "Unattributed voice" : "Ana"}: A reply to the first voice.`));
                } finally {
                    await session.close();
                }
            });
        }
    }
});

// ── speaking first, languages ────────────────────────────────────────────

describe("a proactive character", () => {
    it("remarks once when live state turns a condition true", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).npc({ name: "Kael", greeting: false });
        kael.when((state) => Number(state.health) < 20, "The player is badly hurt.", { cooldownMs: 0 });
        const session = await kael.connect({ context: { health: 50 } }).start();
        try {
            await session.context.update({ health: 10 });
            const remark = await gateway.waitFor((frame) => frame.type === "response.create" && JSON.stringify(frame).includes("badly hurt"));
            assert.match(remark.response.input[0].content[0].text, /^\[Game event, not the player speaking\] The player is badly hurt\./);
            await session.context.update({ health: 5 });
            await sleep(50);
            assert.equal(gateway.frames.filter((frame) => JSON.stringify(frame).includes("badly hurt")).length, 1);
        } finally {
            await session.close();
        }
    });

    it("considers a quiet moment out of band and says only what is worth saying", async () => {
        const gateway = new FakeGateway();
        const luna = nurFor(gateway).companion({ name: "Luna", memory: false, greeting: false, proactive: { idleAfterMs: 100, cooldownMs: 0 } });
        const session = await luna.connect().start();
        const started: NurEvent[] = [];
        session.on("response.started", (event) => started.push(event));
        try {
            const check = await gateway.waitFor((frame) => frame.type === "response.create" && frame.response?.conversation === "none", 4_000);
            assert.deepEqual(check.response.metadata, { eesi_sdk: "idle_check" });
            assert.deepEqual(check.response.output_modalities, ["text"]);
            const at = gateway.frames.indexOf(check);
            gateway.send({ type: "response.created", response: { id: "oob1", conversation_id: null, metadata: { eesi_sdk: "idle_check" } } });
            gateway.send({ type: "response.output_text.done", response_id: "oob1", text: "How did the interview go?" });
            gateway.send({ type: "response.done", response: { id: "oob1", status: "completed", metadata: { eesi_sdk: "idle_check" } } });
            const said = await gateway.waitFor((frame) => frame.type === "response.create" && gateway.frames.indexOf(frame) > at);
            assert.match(said.response.instructions, /"How did the interview go\?"/);
            assert.equal(started.length, 0, "a decision is never shown as a reply");
        } finally {
            await session.close();
        }
    });

    it("pins the greeting and replies to one language", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).npc({ name: "Kael", language: "ar-EG", greeting: false });
        const pinned = await kael.connect().start();
        await pinned.close();
        const update = gateway.ofType("session.update")[0] as Frame;
        assert.equal(update.session.audio.input.transcription.language, "ar");
        assert.equal(update.session.eesi_language_name, "Egyptian Arabic");
        assert.match(update.session.instructions, /Speak Egyptian Arabic\./);

        const follower = await nurFor(gateway).npc({ name: "Nadia", greeting: false }).connect().start();
        await follower.close();
        const free = gateway.ofType("session.update")[1] as Frame;
        assert.equal(free.session.audio.input.transcription.language, undefined);
        assert.match(free.session.instructions, /Answer in the language the other person speaks/);
    });
});

// ── many players, client secrets ─────────────────────────────────────────

describe("multiplayer", () => {
    it("mixes a room's microphones and knows who spoke from the audio", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).multiplayerNpc({ name: "Kael", greeting: false });
        const room = kael.room([{ name: "Ana", id: "p1", language: "ar" }, { name: "Ben", id: "p2" }]);
        await room.start();
        try {
            const tone = new Int16Array(16_000 * 0.4).map((_, index) => Math.round(8_000 * Math.sin(index / 5)));
            room.feed("p1", new Uint8Array(tone.buffer));
            await sleep(500);
            assert.ok(gateway.ofType("input_audio_buffer.append").length >= 15);
            gateway.send({ type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
            gateway.send({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 400 });
            gateway.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Speaker 1: مرحبا يا كايل" });
            const heard = await room.session.wait("transcript.final");
            assert.equal(heard.turns[0]?.playerId, "p1");
            const roster = await gateway.waitFor((frame) => frame.type === "eesi.context.update" && frame.key === "roster" && /Speaker 1 is Ana/.test(frame.text));
            assert.match(roster.text, /Ana \(speaks Arabic\)/);
            // The same loudest microphone is not evidence for a voice the
            // recognizer explicitly could not identify.
            gateway.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "Unattributed voice: One more thing." });
            const unknown = await room.session.wait("transcript.final");
            assert.deepEqual(unknown.turns, [{ text: "One more thing.", speaker: null, playerId: null, unattributed: true }]);
            assert.doesNotMatch(room.render(), /spoke last/);
        } finally {
            await room.close();
        }
    });

    it("tells each player's session what the character told the others", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).multiplayerNpc({ name: "Kael", greeting: false });
        const ana = await kael.connect({ playerId: "p1", playerName: "Ana" }).start();
        const ben = await kael.connect({ playerId: "p2", playerName: "Ben" }).start();
        try {
            await ana.sendText("The bridge is out.");
            const party = await gateway.waitFor((frame) => frame.type === "eesi.context.update" && frame.key === "party" && frame.text.includes("Ana: The bridge is out."));
            assert.match(party.text, /^Your recent conversations with the other players/);
        } finally {
            await ana.close();
            await ben.close();
        }
    });

    it("mints a client secret with the character, the player's memories and state", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).npc({ name: "Kael", voice: "Atlas", memory: new Memory(), context: { realm: "Eldermoor" } });
        await kael.remember("They saved the miller's daughter.", { playerId: "p42" });
        const secret = await kael.clientSecret({ playerId: "p42", playerName: "Mira", context: { location: "the gate" }, lock: ["instructions", "tools", "voice"] });
        const body = gateway.secrets[0] as Frame;
        assert.equal(body.session.model, "nur-v1");
        assert.match(body.session.instructions, /^You are Kael/);
        assert.equal(body.session.audio.output.voice, "ev_atlas");
        assert.deepEqual(Object.keys(body.eesi_context), ["memory", "world", "scene"]);
        assert.match(body.eesi_context.memory, /miller's daughter/);
        assert.deepEqual(body.eesi_lock, ["instructions", "tools", "voice"]);
        assert.equal(body.eesi_control, undefined);
        assert.equal(secret.url, "ws://gateway.test/v1/realtime?model=nur-v1&source=sdk-client&token=rt_secret_1");
        assert.equal(secret.join.controlled, false);
        assert.equal(secret.join.tools, "client");
        assert.match(secret.join.greeting as string, /met before/);
        assert.doesNotMatch(JSON.stringify(secret.join), /sk-test|ctl_/);
    });

    it("puts a studio's limits, webhook, tags and data use on the ticket", async () => {
        const gateway = new FakeGateway();
        const guard = nurFor(gateway).npc({ name: "Guard" });
        const secret = await guard.clientSecret({
            playerId: "p-123",
            lock: "all",
            maxDurationSeconds: 600,
            silenceHangupSeconds: 45,
            webhook: { url: "https://hooks.neotopia.example/nur", secret: "s".repeat(32) },
            metadata: { npc: "guard-7" },
            train: false,
            record: false,
        });
        const body = gateway.secrets[0] as Frame;
        assert.deepEqual(body.eesi_limits, { max_duration_seconds: 600, silence_hangup_seconds: 45 });
        assert.deepEqual(body.eesi_webhook, { url: "https://hooks.neotopia.example/nur", secret: "s".repeat(32) });
        assert.deepEqual(body.eesi_metadata, { npc: "guard-7" });
        assert.deepEqual(body.eesi_data, { train: false, record: false });
        assert.equal(secret.join.token, "rt_secret_1");
        assert.equal(secret.join.callsUrl, "http://gateway.test/v1/realtime/calls");
        assert.doesNotMatch(JSON.stringify(secret.join), /s{32}/);

        await guard.clientSecret({ playerId: "p-1" });
        const plain = gateway.secrets[1] as Frame;
        assert.deepEqual(Object.keys(plain).filter((key) => key.startsWith("eesi_") && key !== "eesi_context"), []);
    });

    it("steers a client's session from the server over the control channel", async () => {
        const gateway = new FakeGateway();
        const kael = nurFor(gateway).npc({ name: "Kael", tools: [openGate] });
        const secret = await kael.clientSecret({ playerId: "p42", control: true });
        assert.deepEqual((gateway.secrets[0] as Frame).eesi_control, { tools: "server" });
        assert.equal(secret.join.tools, "server");
        assert.equal(secret.join.greeting, null, "the server greets");
        const session = await kael.control(secret).start();
        try {
            assert.match(gateway.urls.at(-1) as string, /^ws:\/\/gateway\.test\/v1\/realtime\/control\/ctl_0123456789abcdef\?token=rt_\d+$/);
            assert.equal(session.sessionId, "conv_test");
            assert.equal(session.playerId, "p42");
            await gateway.waitType("response.create");
            await session.context.update({ location: "the gate" });
            await gateway.waitFor((frame) => frame.type === "eesi.context.update" && frame.key === "scene");
            opened.length = 0;
            gateway.sendControl({ type: "response.created", response: { id: "r1" } });
            gateway.sendControl({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "open_gate", arguments: '{"gate":"south"}', eesi_executor: "server" });
            gateway.sendControl({ type: "response.done", response: { id: "r1", status: "completed" } });
            const output = await gateway.waitFor((frame) => frame.item?.type === "function_call_output");
            assert.equal(output.item.output, "The south gate is open.");
            assert.throws(() => session.sendAudio(new Uint8Array(640)), /client streams it/);
            const ended = session.wait("session.ended");
            gateway.sendControl({ type: "eesi.control.ended", reason: "client_closed" });
            assert.equal((await ended).reason, "ended");
        } finally {
            await session.close();
        }
    });

    it("joins with a client secret: no configuration, the server's greeting, tools forwarded", async () => {
        const gateway = new FakeGateway();
        gateway.bound = true;
        const join: JoinInfo = {
            url: "ws://gateway.test/v1/realtime?model=nur-v1&source=sdk-client&token=rt_secret_1",
            token: "rt_secret_1",
            callsUrl: "http://gateway.test/v1/realtime/calls",
            expiresAt: Date.now() / 1000 + 60,
            character: "Kael",
            model: "nur-v1",
            turnTaking: "natural",
            tools: "client",
            controlled: false,
            greeting: "Open the conversation: greet them.",
            proactive: null,
            outputSampleRate: 24_000,
            playerId: "p42",
            playerName: "Mira",
        };
        const forwarded: unknown[] = [];
        const session = await joinSession(join, { webSocket: gateway.webSocket, logger: quiet, onToolCall: (call) => (forwarded.push(call), "Opened.") });
        try {
            assert.equal(gateway.ofType("session.update").length, 0);
            assert.equal((await gateway.waitType("response.create")).response.instructions, "Open the conversation: greet them.");
            gateway.send({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "open_gate", arguments: '{"gate":"north"}' });
            gateway.send({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c2", name: "open_gate", arguments: "{}", eesi_executor: "server" });
            const output = await gateway.waitFor((frame) => frame.item?.type === "function_call_output");
            assert.equal(output.item.output, "Opened.");
            await sleep(30);
            assert.deepEqual(forwarded, [{ name: "open_gate", arguments: { gate: "north" }, callId: "c1", playerId: "p42" }]);
            const ended = session.wait("session.ended");
            gateway.drop(1011);
            assert.equal((await ended).reason, "connection_lost");
            assert.equal(gateway.urls.length, 1, "a secret works once");
        } finally {
            await session.close();
        }
    });
});

// ── pieces ───────────────────────────────────────────────────────────────

describe("pieces", () => {
    it("validates tool arguments against their schema", () => {
        const schema = { type: "object", properties: { gate: { type: "string", enum: ["north"] }, count: { type: "integer", minimum: 1 } }, required: ["gate"], additionalProperties: false } as const;
        assert.deepEqual(validateSchema(schema, { gate: "north", count: 2 }), []);
        assert.deepEqual(validateSchema(schema, { count: 0, extra: true }), ["gate: is required", "count: must be at least 1", "extra: is not an argument this tool takes"]);
    });

    it("splits a shared transcript into speakers and binds them by introductions", () => {
        assert.deepEqual(splitSpeakerTurns("Speaker 1: hi\nSpeaker 2: hello\nthere"), [
            { speaker: 1, text: "hi" },
            { speaker: 2, text: "hello there" },
        ]);
        const roster = new SpeakerRoster(["Ana", "Ben"]);
        const turns = roster.attribute("Speaker 1: I'm Ben.\nSpeaker 2: And I am Ana.");
        assert.deepEqual(
            turns.map((turn) => turn.player),
            ["Ben", "Ana"],
        );
    });

    it("keeps explicit unknown speech separate without inventing a player", () => {
        assert.deepEqual(splitSpeakerTurns("Speaker 1: Train.\nUnattributed voice: No,\nwait.\nSpeaker 2: Bike."), [
            { speaker: 1, text: "Train." },
            { speaker: null, text: "No, wait.", unattributed: true },
            { speaker: 2, text: "Bike." },
        ]);
        assert.deepEqual(splitSpeakerTurns("Unattributed voice: First.\nUnattributed voice: Second."), [
            { speaker: null, text: "First.", unattributed: true },
            { speaker: null, text: "Second.", unattributed: true },
        ]);
        const roster = new SpeakerRoster(["Ana"]);
        assert.deepEqual(roster.attribute("Unattributed voice: I'm Ana."), [{ speaker: null, text: "I'm Ana.", player: null, unattributed: true }]);
        assert.equal(roster.players().size, 0);
        assert.deepEqual(roster.attribute("Hello."), [{ speaker: null, text: "Hello.", player: "Ana" }]);
    });

    it("resamples the same in pieces as whole", () => {
        const input = new Int16Array(4_800).map((_, index) => Math.round(10_000 * Math.sin(index / 7)));
        const bytes = new Uint8Array(input.buffer);
        const whole = new Resampler(48_000, 16_000).process(bytes);
        const pieces = new Resampler(48_000, 16_000);
        const parts = [bytes.subarray(0, 1_001 * 2), bytes.subarray(1_001 * 2, 3_333 * 2), bytes.subarray(3_333 * 2)].map((part) => pieces.process(part));
        assert.deepEqual(Buffer.concat(parts), Buffer.from(whole));
    });

    it("reads what the memory model answers, even wrapped in prose", () => {
        const result = parseExtraction('Sure:\n```json\n{"summary": "Met.", "memories": [{"text": "They like tea.", "kind": "preference", "importance": "low", "key": "name", "replaces": "m1"}], "forget": ["m2"]}\n```', new Map([["m1", "mem_a"], ["m2", "mem_b"]]));
        assert.equal(result.summary, "Met.");
        assert.deepEqual(result.memories, [{ text: "They like tea.", kind: "preference", importance: 0.3, key: "name", replaces: "mem_a" }]);
        assert.deepEqual(result.forget, ["mem_b"]);
    });

    it("puts a game's own memory rules last in the extraction prompt", async () => {
        const seen: Array<Array<{ role: string; content: string }>> = [];
        const chat = async (messages: Array<{ role: string; content: string }>) => {
            seen.push(messages);
            return '{"summary": "", "memories": [], "forget": []}';
        };
        const request = { characterName: "Sage", playerId: "p1", playerName: null, transcript: [["player", "I'm building a treehouse."]] as Array<[string, string]>, existing: [] };
        await llmExtractor(chat, { rules: "Only game facts. Never age, school or location." })(request);
        await llmExtractor(chat)(request);
        assert.ok(
            seen[0]?.[0]?.content.endsWith(
                "\n\nWhat Sage may remember, set by the game, which wins over the rules above where they differ:\nOnly game facts. Never age, school or location.",
            ),
        );
        assert.doesNotMatch(seen[1]?.[0]?.content ?? "", /set by the game/);
    });

    it("learns a player's memories from a session.ended webhook", async () => {
        const seen: Array<Array<[string, string]>> = [];
        const sage = nurFor(new FakeGateway()).npc({
            name: "Sage",
            memory: new Memory(undefined, {
                extractor: async (request) => {
                    seen.push(request.transcript);
                    return { summary: "Talked about a treehouse.", memories: [{ text: "They are building a treehouse.", kind: "fact", importance: 0.6, key: null, replaces: null }], forget: [] };
                },
            }),
        });
        const event = {
            type: "session.ended",
            session_id: "conv_1",
            transcript: [
                { role: "player", text: "I'm building a treehouse." },
                { role: "character", text: "Use oak for the floor." },
            ],
        };

        const learned = await sage.learnFromSession(event, { playerId: "p-123" });

        assert.deepEqual(seen[0], [
            ["player", "I'm building a treehouse."],
            ["Sage", "Use oak for the floor."],
        ]);
        assert.deepEqual(new Set(learned.added.map((record) => record.text)), new Set(["They are building a treehouse.", "Talked about a treehouse."]));
        assert.ok(learned.added.every((record) => record.playerId === "p-123"));
        assert.deepEqual(await sage.learnFromSession({ type: "response.completed" }, { playerId: "p-123" }), { added: [], superseded: [], forgotten: [] });
    });

    it("keeps memory in a JSON file both SDKs read", async () => {
        const dir = await mkdtemp(join(tmpdir(), "eesi-memory-"));
        const kael = nurFor(new FakeGateway()).npc({ name: "Kael", memory: fileMemory(dir) });
        await kael.remember("They like apples.", { playerId: "p1" });
        const reopened = new FileMemoryStore(join(dir, "memory.json"));
        const records = await reopened.query({ namespace: "default", characterId: "kael", playerIds: ["p1"] });
        assert.equal(records[0]?.text, "They like apples.");
        const file = JSON.parse(await readFile(join(dir, "memory.json"), "utf8")) as Frame;
        assert.equal(file.format, "eesi.memory");
        assert.equal(file.records[0].player_id, "p1");
    });

    it("round-trips WAV audio", async () => {
        const dir = await mkdtemp(join(tmpdir(), "eesi-wav-"));
        const pcm = new Uint8Array(new Int16Array([0, 1_000, -1_000, 32_767]).buffer);
        const path = join(dir, "a.wav");
        await import("node:fs/promises").then((fs) => fs.writeFile(path, wavBytes(pcm, 16_000)));
        const read = readWav(path);
        assert.equal(read.sampleRate, 16_000);
        assert.deepEqual(Buffer.from(read.pcm), Buffer.from(pcm));
    });

    it("verifies a webhook's signature and age", () => {
        const body = JSON.stringify({ id: "whk_1", type: "response.completed" });
        const signature = createHmac("sha256", "s".repeat(32)).update(`whk_1.1760000000.${body}`).digest("hex");
        const headers = { "eesi-webhook-id": "whk_1", "eesi-webhook-timestamp": "1760000000", "eesi-signature": `v1=${signature}` };

        assert.equal(verifyWebhook(body, headers, "s".repeat(32), { now: 1760000030 }).type, "response.completed");
        assert.throws(() => verifyWebhook(`${body} `, headers, "s".repeat(32), { now: 1760000030 }), WebhookVerificationError);
        assert.throws(() => verifyWebhook(body, headers, "t".repeat(32), { now: 1760000030 }), WebhookVerificationError);
        assert.throws(() => verifyWebhook(body, headers, "s".repeat(32), { now: 1760001000 }), /too old/);
    });

    it("keeps the API key out of web pages", () => {
        const globals = globalThis as { document?: unknown };
        globals.document = {};
        try {
            assert.throws(() => new NurClient({ apiKey: "sk-test" }), /readable by everyone/);
        } finally {
            delete globals.document;
        }
    });
});

describe("a described voice", () => {
    it("is designed and kept through the API, with nothing uploaded or attested", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            const method = init?.method ?? "GET";
            const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
            calls.push({ method, path: url.pathname, body });
            const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
            if (url.pathname.endsWith("/voices") && method === "GET") return json({ data: [] });
            if (url.pathname.endsWith("/voices/design")) {
                return json({ name: "Harold", takes: [0, 1, 2].map((i) => ({ take_id: `t${i}`, audio: Buffer.from(`RIFF${i}`).toString("base64") })) });
            }
            if (url.pathname.endsWith("/voices/design/keep")) return json({ voice_id: "ev_kept", status: "ready", category: "characters" });
            return new Response(JSON.stringify({ error: { message: url.pathname } }), { status: 404 });
        };
        const nur = new NurClient({ apiKey: "sk-test", baseUrl: "http://gateway.test", fetch, timezone: null, logger: quiet });
        const voice = await nur.designVoice("Harold", "a calm older man with a deep voice", { take: 1 });
        assert.equal(voice.id, "ev_kept");
        assert.equal(voice.status, "ready");
        const design = calls.find((call) => call.path.endsWith("/voices/design"));
        assert.deepEqual(design?.body, { description: "a calm older man with a deep voice", language: "en" });
        const keep = calls.find((call) => call.path.endsWith("/voices/design/keep"));
        assert.equal((keep?.body as { take_id: string }).take_id, "t1");
        assert.equal((keep?.body as { name: string }).name, "Harold");
        assert.ok(!calls.some((call) => call.method === "POST" && call.path.endsWith("/voices")));
    });
});

describe("remote MCP servers", () => {
    const deepwiki = {
        url: "https://mcp.deepwiki.com/mcp",
        label: "deepwiki",
        description: "Answers questions about public GitHub repositories.",
        allowedTools: ["ask_wiki_question"],
        authorization: "sk-mcp-token",
        requireApproval: ["delete_page"],
    };

    it("declares the character's servers and restates them on every tools update", async () => {
        const gateway = new FakeGateway();
        const sage = nurFor(gateway).character({ name: "Sage", greeting: false, mcpServers: [deepwiki] });
        assert.deepEqual(sage.toJSON().mcp_servers, ["deepwiki"]);
        assert.doesNotMatch(JSON.stringify(sage.toJSON()), /sk-mcp-token/);
        assert.throws(() => nurFor(gateway).character({ name: "X", mcpServers: [{ url: "https://x.example.com", label: "has space" }] }));
        const session = await sage.connect().start();
        try {
            const first = gateway.ofType("session.update")[0] as Frame;
            assert.deepEqual(first.session.tools, [
                {
                    type: "mcp",
                    server_label: "deepwiki",
                    server_url: "https://mcp.deepwiki.com/mcp",
                    server_description: "Answers questions about public GitHub repositories.",
                    allowed_tools: ["ask_wiki_question"],
                    authorization: "sk-mcp-token",
                    require_approval: { always: { tool_names: ["delete_page"] } },
                },
            ]);
            assert.equal(first.session.tool_choice, "auto");
            sage.tool(openGate);
            const again = await gateway.waitType("session.update", gateway.frames.indexOf(first) + 1);
            assert.deepEqual(again.session.tools.map((item: Frame) => item.name ?? item.server_label), ["open_gate", "deepwiki"]);
        } finally {
            await session.close();
        }
    });

    it("reads the gateway's MCP events and never answers its calls", async () => {
        const gateway = new FakeGateway();
        const session = await nurFor(gateway).character({ name: "Sage", greeting: false, mcpServers: [deepwiki] }).connect().start();
        const events: NurEvent[] = [];
        session.on("mcp.*", (event) => {
            events.push(event);
        });
        try {
            const listing = { id: "mcpl_1", type: "mcp_list_tools", server_label: "deepwiki" };
            gateway.send({ type: "conversation.item.added", item: { ...listing, tools: [] } });
            gateway.send({ type: "mcp_list_tools.in_progress", item_id: "mcpl_1" });
            gateway.send({ type: "conversation.item.done", item: { ...listing, tools: [{ name: "ask_wiki_question", input_schema: {} }] } });
            gateway.send({ type: "mcp_list_tools.completed", item_id: "mcpl_1" });
            const call = { id: "item_1", type: "mcp_call", server_label: "deepwiki", name: "ask_wiki_question", arguments: '{"repoName":"a/b"}' };
            gateway.send({ type: "response.created", response: { id: "r1" } });
            gateway.send({ type: "response.output_item.added", response_id: "r1", output_index: 0, item: call });
            gateway.send({ type: "response.mcp_call.in_progress", item_id: "item_1", output_index: 0 });
            gateway.send({ type: "response.done", response: { id: "r1", status: "completed", output: [call] } });
            gateway.send({ type: "conversation.item.done", item: { ...call, output: "It is a wiki.", error: null } });
            gateway.send({ type: "response.mcp_call.completed", item_id: "item_1", output_index: 0 });
            gateway.send({ type: "conversation.item.done", item: { ...call, id: "item_2", error: { type: "tool_execution_error", message: "too slow" } } });
            gateway.send({ type: "response.mcp_call.failed", item_id: "item_2", output_index: 0 });
            const request = { id: "ask_1", type: "mcp_approval_request", server_label: "deepwiki", name: "delete_page", arguments: '{"page":"Home"}' };
            for (const type of ["response.output_item.added", "conversation.item.added", "response.output_item.done"]) gateway.send({ type, item: request });
            gateway.send({ type: "mcp_list_tools.failed", server_label: "other", error: { code: "not_public", message: "The server is not on the public internet." } });
            await session.wait("mcp.tools.failed", { timeoutMs: 1_000 });
            session.approveMcp("ask_1");
            const approval = await gateway.waitFor((frame) => frame.item?.type === "mcp_approval_response");
            await sleep(30);
            assert.deepEqual(
                events.map((event) => event.type),
                ["mcp.tools.listed", "mcp.call.started", "mcp.call.completed", "mcp.call.failed", "mcp.approval.requested", "mcp.tools.failed"],
            );
            const [listed, started, completed, failed, asked] = events as Frame[];
            assert.deepEqual(listed?.tools, ["ask_wiki_question"]);
            assert.equal(started?.name, "ask_wiki_question");
            assert.equal(completed?.output, "It is a wiki.");
            assert.equal(failed?.kind, "tool_execution_error");
            assert.equal(asked?.requestId, "ask_1");
            assert.deepEqual(approval.item, { type: "mcp_approval_response", approval_request_id: "ask_1", approve: true });
            assert.equal(gateway.frames.filter((frame) => frame.item?.type === "function_call_output").length, 0);
            assert.equal(gateway.ofType("response.create").length, 0);
        } finally {
            await session.close();
        }
    });
});
