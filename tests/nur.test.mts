// Tests for the Nur SDK against an in-process stand-in for the gateway. They
// prove what the SDK sends and how it reacts to what Nur Live sends; never
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
    formatTrace,
    joinSession,
    Memory,
    NurClient,
    parseExtraction,
    Resampler,
    SilentOutput,
    SpeakerRoster,
    splitSpeakerTurns,
    tool,
    Trace,
    validateSchema,
} from "../dist/index.js";
import type { JoinInfo, NurEvent, WebSocketLike } from "../dist/index.js";
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
        this.gateway.receive(this, JSON.parse(data) as Frame);
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
        socket.deliver({ type: "session.created", session: { id: "sess_1", model: "nur-live-v1" } });
        if (this.bound) socket.deliver({ type: "session.updated", session: {} });
    }

    receive(socket: FakeSocket, frame: Frame): void {
        this.frames.push(frame);
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
            assert.match(gateway.urls[0] as string, /^ws:\/\/gateway\.test\/v1\/realtime\?model=nur-live-v1&source=sdk&token=rt_1$/);
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
        assert.equal(body.session.model, "nur-live-v1");
        assert.match(body.session.instructions, /^You are Kael/);
        assert.equal(body.session.audio.output.voice, "ev_atlas");
        assert.deepEqual(Object.keys(body.eesi_context), ["memory", "world", "scene"]);
        assert.match(body.eesi_context.memory, /miller's daughter/);
        assert.deepEqual(body.eesi_lock, ["instructions", "tools", "voice"]);
        assert.equal(body.eesi_control, undefined);
        assert.equal(secret.url, "ws://gateway.test/v1/realtime?model=nur-live-v1&source=sdk-client&token=rt_secret_1");
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
            url: "ws://gateway.test/v1/realtime?model=nur-live-v1&source=sdk-client&token=rt_secret_1",
            token: "rt_secret_1",
            callsUrl: "http://gateway.test/v1/realtime/calls",
            expiresAt: Date.now() / 1000 + 60,
            character: "Kael",
            model: "nur-live-v1",
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
