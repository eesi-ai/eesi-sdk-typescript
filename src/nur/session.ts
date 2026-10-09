// One conversation between a character and a player, in real time.
//
//     const session = await kael.connect({ playerId: "p42" }).start();
//     await session.context.update({ location: "Northern Gate" });
//     const reply = await session.ask("Who goes there?");
//     await session.close();
//
// A session is an ordinary Nur Live realtime connection, so authentication,
// metering, recording consent and organization scope stay at the gateway.
// Nur Live owns the conversation itself: voice activity, turn-taking,
// interruptions, backchannels, history and cancellation. The session owns
// what your application knows: the character, live context, memory, tools
// and the audio on this side.
//
// A session reaches the gateway one of three ways:
// - owned: your server's own session, under your API key (`character.connect`);
// - joined: a browser or game client with a client secret and no key (`joinSession`);
// - controlled: your server steering a session a client opened (`character.control`).

import { ApiError } from "../errors.js";
import { type AudioInput, type AudioOutput, base64ToBytes, bytesToBase64, Resampler } from "./audio.js";
import type { Character, ConnectOptions } from "./character.js";
import { ContextPublisher, LiveContext } from "./context.js";
import { AuthenticationError, ConfigurationError, ContextError, NurError, RealtimeConnectionError, SessionClosedError } from "./errors.js";
import {
    type AnyEventInit,
    EventBus,
    type EventOf,
    type EventPattern,
    type Handler,
    type Logger,
    type NurEvent,
    type ResponseCompleted,
    type SpeakerTurn,
} from "./events.js";
import { Initiative, type Moment, momentInstructions } from "./initiative.js";
import { describeLanguage } from "./languages.js";
import type { CharacterMemory, MemoryRecord, PlayerMemory, RememberOptions } from "./memory/index.js";
import { type AttributedTurn, asPlayers, type PartyLog, type Player, playerKey, SpeakerRoster } from "./multiplayer.js";
import { IDLE_SKIP, idlePrompt, type Proactive, type State, Trigger, type TriggerOptions } from "./proactive.js";
import * as wire from "./protocol.js";
import { type AnyTool, type Outcome, renderResult, type ToolContext, type ToolEvent, ToolRunner } from "./tools.js";
import type { Trace } from "./trace.js";

/** How long a finished turn waits before an app-driven reply is asked for. */
export const TURN_SETTLE_MS = 600;
const MAX_RECONNECT_ATTEMPTS = 6;
const FATAL_CLOSE_CODES = new Set([1002, 1003, 1008]);
const STATUS_INTERVAL_MS = 500;
const KEEPALIVE_INTERVAL_MS = 60_000;
const CONFIGURE_TIMEOUT_MS = 10_000;
/** A client secret's session is configured before the client's first frame; this long without a word means it is. */
const JOINED_READY_FALLBACK_MS = 1_500;
const RECALL_WAIT_MS = 350;
const LEARN_TIMEOUT_MS = 45_000;
const ITEM_ACK_FALLBACK_MS = 2_000;
const FORWARDED_TOOL_TIMEOUT_MS = 30_000;
const RECALL_MIN_SCORE = 0.35;
const RECALL_MAX = 3;
const IDLE_POLL_MS = 1_000;
/** Marks the SDK's own out-of-band requests, which are never shown as replies. */
const INTERNAL_TAG = "eesi_sdk";

/** The parts of a WebSocket a session uses: the browser's, Node's (22+), Deno's, Bun's, or the `ws` package's. */
export interface WebSocketLike {
    readonly readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code: number; reason: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** The platform's WebSocket, or a clear error when there is none. */
export function defaultWebSocket(): WebSocketFactory {
    return (url) => {
        const Native = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
        if (!Native) {
            throw new ConfigurationError(
                "This runtime has no WebSocket. Use Node 22 or later, or pass webSocket: (url) => new WebSocket(url) with the ws package.",
            );
        }
        return new Native(url);
    };
}

/** What a session needs from the character it speaks as. A `Character` is one; a joined session has its own. */
export interface SessionHost {
    readonly name: string;
    readonly model: string;
    readonly turnTaking: "natural" | "app" | "director";
    readonly endOnHangup: boolean;
    readonly personalize: boolean;
    readonly outputSampleRate: 16_000 | 24_000;
    readonly greeting: boolean | string;
    readonly proactive: Proactive | null;
    readonly triggers: Trigger[];
    readonly tools: Array<AnyTool>;
    readonly context: LiveContext;
    readonly memory: CharacterMemory | null;
    readonly party: PartyLog | null;
    readonly bus: EventBus;
    readonly liveSessions: Set<Session>;
    buildSessionConfig?(request: SessionConfigRequest): Promise<Record<string, unknown>>;
    greetingInstructions(greeting: boolean | string, options: { known?: boolean; stranger?: boolean; name?: string | null }): string;
}

export interface SessionConfigRequest {
    language: string | null;
    extraInstructions: string | null;
    playerNames: string[];
    playerName: string | null;
    toolSpecs: unknown[];
}

/** Where a resumed session picks up. */
export interface Resume {
    resume: string;
    resume_token: string;
}

/** How a session reaches the gateway. */
export interface Transport {
    readonly kind: "owned" | "control" | "joined";
    /** The URL of the next dial. Tickets are one-shot, so every dial gets its own. */
    url(resume: Resume | null): Promise<string>;
    readonly webSocket: WebSocketFactory;
    readonly logger: Logger;
}

/** A tool call a joined client hands to your code, usually to forward to your server. */
export interface ToolCall {
    name: string;
    arguments: Record<string, unknown>;
    callId: string;
    playerId: string | null;
}

/** @internal Options only the SDK's own constructors pass. */
export interface SessionOptions extends ConnectOptions {
    /** A controlled session: who answers tool calls. */
    controlTools?: "server" | "client";
    /** A joined session: calls no local tool answers. */
    onToolCall?: (call: ToolCall) => unknown;
}

export interface SessionMetrics {
    turns: number;
    replies: number;
    interruptions: number;
    toolCalls: number;
    toolFailures: number;
    reconnects: number;
    /** Seconds from the end of each player turn to the first audio of its reply. */
    latencies: number[];
    audioInSeconds: number;
    audioOutSeconds: number;
}

export interface MetricsSummary {
    turns: number;
    replies: number;
    interruptions: number;
    toolCalls: number;
    toolFailures: number;
    reconnects: number;
    latencyP50: number | null;
    latencyP95: number | null;
    latencyMean: number | null;
    audioInSeconds: number;
    audioOutSeconds: number;
}

export function summarizeMetrics(metrics: SessionMetrics): MetricsSummary {
    const sorted = [...metrics.latencies].sort((a, b) => a - b);
    const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
    const pct = (p: number) => (sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] as number, 3) : null);
    return {
        turns: metrics.turns,
        replies: metrics.replies,
        interruptions: metrics.interruptions,
        toolCalls: metrics.toolCalls,
        toolFailures: metrics.toolFailures,
        reconnects: metrics.reconnects,
        latencyP50: pct(0.5),
        latencyP95: pct(0.95),
        latencyMean: sorted.length ? round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 3) : null,
        audioInSeconds: round(metrics.audioInSeconds, 1),
        audioOutSeconds: round(metrics.audioOutSeconds, 1),
    };
}

interface Reply {
    deltas: string[];
    segments: string[];
    segmentIds: Set<string>;
    hadAudio: boolean;
    firstAudioAt: number | null;
    calls: number;
    outstanding: Set<string>;
    speakAfter: boolean;
    done: boolean;
    cancelled: boolean;
    continued: boolean;
    turnEndedAt: number | null;
}

function newReply(): Reply {
    return {
        deltas: [],
        segments: [],
        segmentIds: new Set(),
        hadAudio: false,
        firstAudioAt: null,
        calls: 0,
        outstanding: new Set(),
        speakAfter: false,
        done: false,
        cancelled: false,
        continued: false,
        turnEndedAt: null,
    };
}

function replyText(reply: Reply): string {
    if (reply.segments.length) return reply.segments.map((segment) => segment.trim()).filter(Boolean).join(" ");
    return reply.deltas.join("").trim();
}

function reconnectDelay(attempt: number): number {
    const window = Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt));
    return window / 2 + Math.random() * (window / 2);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A failed dial as the error to show for it. */
function dialError(error: unknown): Error {
    if (error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403)) {
        return new AuthenticationError(`The gateway refused the API key (HTTP ${error.statusCode}): ${error.message} Check EESI_API_KEY and its organization.`);
    }
    if (error instanceof NurError) return error;
    return new RealtimeConnectionError(`Could not reach the realtime gateway: ${errorMessage(error)}`, { kind: "unavailable" });
}

function retryable(error: unknown): boolean {
    return !(error instanceof NurError) && (!(error instanceof ApiError) || error.statusCode === 429 || error.statusCode >= 500);
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const existing = out[key];
        out[key] =
            value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)
                ? merge(existing as Record<string, unknown>, value as Record<string, unknown>)
                : value;
    }
    return out;
}

const SPEEDS: Record<string, number> = { slow: 0.9, normal: 1.0, fast: 1.1 };
const PHRASES: Record<string, (value: string) => string> = {
    language: (value) => `Speak ${value} with them unless they switch.`,
    verbosity: (value) =>
        ({ brief: "Keep your answers brief.", short: "Keep your answers brief.", detailed: "They like fuller, more detailed answers.", long: "They like fuller, more detailed answers." })[
            value.toLowerCase()
        ] ?? `Verbosity: ${value}.`,
    pace: (value) => ({ slow: "They like an unhurried pace.", fast: "They like a brisk pace." })[value.toLowerCase()] ?? `Pace: ${value}.`,
    formality: (value) => ({ formal: "Speak to them formally.", casual: "Speak to them casually." })[value.toLowerCase()] ?? `Formality: ${value}.`,
    name: (value) => `Call them ${value}.`,
};

/**
 * How a player likes to be spoken to: applied at once, and kept for their
 * later sessions when the session has player memory.
 *
 *     await session.preferences.set({ language: "Spanish", pace: "slow" });
 */
export class Preferences {
    /** Preferences for this session only (no memory, or `persist: false`). */
    readonly sessionOnly: Record<string, string> = {};

    constructor(private readonly session: Session) {}

    phrase(key: string, value: string): string {
        const render = PHRASES[key];
        return render ? render(value) : `${key.replace(/_/g, " ")}: ${value}.`;
    }

    async set(values: Record<string, string | null>, options: { persist?: boolean } = {}): Promise<void> {
        const persist = options.persist ?? true;
        const memory = this.session.memory;
        for (const [key, value] of Object.entries(values)) {
            if (value === null) {
                delete this.sessionOnly[key];
                if (persist && memory) for (const record of await memory.list({ kinds: ["preference"] })) if (record.key === key) await memory.forget(record.id);
                continue;
            }
            const text = this.phrase(key, value);
            if (persist && memory && this.session.memoryWritable) {
                await memory.remember(text, { kind: "preference", key, source: "player", importance: 0.8 });
                delete this.sessionOnly[key];
            } else {
                this.sessionOnly[key] = text;
            }
            const speed = key === "pace" ? SPEEDS[value.toLowerCase()] : undefined;
            if (speed !== undefined && this.session.ready) await this.session.updateSession({ audio: { output: { speed } } });
        }
        await this.session.refreshMemory();
    }

    async get(): Promise<Record<string, string>> {
        const stored = this.session.memory ? await this.session.memory.preferences() : {};
        return { ...stored, ...this.sessionOnly };
    }
}

/** A live conversation. Make one with `character.connect()`, `character.control()` or `joinSession()`. */
export class Session {
    readonly host: SessionHost;
    /** The character, on your server; null in a session joined with a client secret. */
    readonly character: Character | null;
    readonly playerId: string | null;
    readonly playerName: string | null;
    /** The people sharing this conversation, when several do. */
    readonly players: Player[];
    /** This session's live state: its `scene` block, and any blocks of your own. */
    readonly context = new LiveContext("scene");
    readonly events: EventBus;
    readonly preferences = new Preferences(this);
    readonly metrics: SessionMetrics = {
        turns: 0,
        replies: 0,
        interruptions: 0,
        toolCalls: 0,
        toolFailures: 0,
        reconnects: 0,
        latencies: [],
        audioInSeconds: 0,
        audioOutSeconds: 0,
    };
    /** `[speaker, text]` lines as the SDK saw them: "player", a player's name, "event" or the character's name. */
    readonly transcript: Array<[string, string]> = [];
    /** The language this session is pinned to, when it is: a code or a name. */
    readonly language: string | null;
    /** This player's memories with the character, when the session has them. */
    readonly memory: PlayerMemory | null;
    readonly input: AudioInput | null;
    readonly output: AudioOutput | null;
    sessionId: string | null = null;
    recordingSessionId: string | null = null;
    /** Whether the organization records this session; show `disclosure` to people when it does. */
    recorded = false;
    disclosure: string | null = null;
    /** What the runtime said it supports, from `session.created`. */
    capabilities: Record<string, unknown> = {};
    /** The last player turn's place in the audio sent, in ms: `[start, end]`. */
    speechWindow: [number | null, number | null] = [null, null];
    /** Resolves when the conversation is over, however it ended. */
    readonly ended: Promise<void>;

    /** @internal A Room's attribution, used instead of voice-label guessing. */
    attributor: ((text: string) => AttributedTurn[]) | null = null;
    /** @internal */
    readonly roster: SpeakerRoster | null;
    /** @internal A player's name to the language they speak. */
    readonly languages: Record<string, string> = {};
    /** @internal A player's name to their id. */
    readonly playerIds: Record<string, string> = {};
    /** @internal */
    readonly publisher: ContextPublisher;
    /** @internal This session's mark in the character's party log. */
    readonly origin = wire.randomHex(12);

    private readonly transport: Transport;
    private readonly logger: Logger;
    private readonly options: SessionOptions;
    private readonly trace: Trace | null;
    private readonly tools: ToolRunner;
    private readonly triggers: Trigger[];
    private readonly initiative: Initiative;
    private readonly memoryMode: "off" | "read" | "read_write";
    private readonly greeting: boolean | string;
    private config: Record<string, unknown> = {};
    private ws: WebSocketLike | null = null;
    private chain: Promise<void> = Promise.resolve();
    private startedAt = Date.now();
    private resolveEnded!: () => void;
    private readyResolvers: Array<(ok: boolean) => void> = [];
    private isReady = false;
    private closing = false;
    private established = false;
    private configured = false;
    private resumed = false;
    private resume: Resume | null;
    private limit: { code: string; message: string } | null = null;
    private endReason: [string, number | null, string | null] | null = null;
    private starting: Promise<this> | null = null;
    private shutdown: Promise<void> | null = null;
    private failure: Error | null = null;
    private readyCount = 0;
    private controlTools: "server" | "client";
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private intervals = new Set<ReturnType<typeof setInterval>>();
    private configureTimer: ReturnType<typeof setTimeout> | null = null;
    private replyTimer: ReturnType<typeof setTimeout> | null = null;
    private replies = new Map<string, Reply>();
    private current: string | null = null;
    private cancelled: string[] = [];
    private active = new Set<string>();
    private pendingContinue = new Set<string>();
    private interruptedIds = new Set<string>();
    private itemWaiters = new Map<string, () => void>();
    private internal = new Map<string, string[]>();
    private userSpeaking = false;
    private speechStoppedAt: number | null = null;
    private partial = "";
    private muted = false;
    private hangupRequested = false;
    private memoryRecords: MemoryRecord[] = [];
    private memoryTask: Promise<void> | null = null;
    private lastPlayer: string | null;
    private readonly outResampler: Resampler | null;
    private inResampler: Resampler | null = null;
    private sendResamplers = new Map<number, Resampler>();
    private play = { responseId: "", received: 0, discarded: 0, flushed: false };
    private lastKeepalive = Date.now();
    private lastActivity = Date.now();
    private idleRemarks = 0;
    private lastIdleCheck = -Infinity;
    private idlePending = false;
    private triggerUnsubscribe: Array<() => void> = [];
    private pumping = false;

    constructor(host: SessionHost, options: SessionOptions, transport: Transport) {
        this.host = host;
        this.options = options;
        this.transport = transport;
        this.logger = transport.logger;
        this.character = transport.kind === "joined" ? null : (host as unknown as Character);
        this.events = new EventBus(this.logger, host.bus);
        this.playerId = options.playerId ?? null;
        this.playerName = options.playerName ?? null;
        this.language = options.language ?? null;
        this.greeting = options.greeting ?? host.greeting;
        this.resume = options.resume ? { resume: options.resume[0], resume_token: options.resume[1] } : null;
        this.input = options.input ?? options.audio?.input ?? null;
        this.output = options.output ?? options.audio?.output ?? null;
        this.outResampler = this.output && this.output.sampleRate !== host.outputSampleRate ? new Resampler(host.outputSampleRate, this.output.sampleRate) : null;
        this.trace = options.trace ?? null;
        this.controlTools = options.controlTools ?? "server";
        this.players = asPlayers(options.players);
        for (const player of this.players) {
            this.playerIds[player.name] = playerKey(player);
            if (player.language) this.languages[player.name] = describeLanguage(player.language)[1];
        }
        this.roster = this.players.length ? new SpeakerRoster(this.players.map((player) => player.name)) : null;
        this.lastPlayer = this.playerId;
        const mode = options.memory === false ? "off" : options.memory === "read" ? "read" : "read_write";
        this.memoryMode = host.memory ? mode : "off";
        this.memory = host.memory && this.playerId && this.memoryMode !== "off" ? host.memory.forPlayer(this.playerId) : null;
        this.tools = new ToolRunner(
            [...host.tools, ...(options.tools ?? [])],
            (callId, args) => this.toolContext(callId, args),
            (event) => this.toolEvent(event),
        );
        this.publisher = new ContextPublisher((key, text) => this.sendContext(key, text), [host.context, this.context], {
            onSent: (block, text) => this.emit({ type: "context.updated", block, text }),
            onError: (error) => this.emit({ type: "error", message: error.message, code: "invalid_context_update" }),
        });
        this.triggers = host.triggers.map((trigger) => trigger.fresh());
        this.initiative = new Initiative((moment) => this.speakMoment(moment));
        this.ended = new Promise((resolve) => {
            this.resolveEnded = resolve;
        });
    }

    /** Whether the character is live and listening. */
    get ready(): boolean {
        return this.isReady && !this.closing;
    }

    /** Whether the session is over (or closing). */
    get closed(): boolean {
        return this.closing;
    }

    /** @internal */
    get memoryWritable(): boolean {
        return this.memoryMode === "read_write";
    }

    // ── lifecycle ─────────────────────────────────────────────────────────

    /**
     * Dial, configure the character, send its context and memories. Resolves
     * with the session once the character is ready; rejects with what went
     * wrong (an `AuthenticationError`, a `RealtimeConnectionError`, …).
     */
    start(): Promise<this> {
        this.starting ??= this.begin();
        return this.starting;
    }

    /** Hang up, learn from the conversation (unless `learn: false`), end every event stream. Safe to call twice. */
    close(options: { learn?: boolean } = {}): Promise<void> {
        if (!this.shutdown) {
            this.endReason = this.endReason ?? ["closed", null, null];
            this.shutdown = this.teardown(options.learn ?? true);
        }
        return this.shutdown;
    }

    /** Call `handler` for events matching `pattern` ("transcript.final", "tool.*", "*"). Returns an unsubscribe function. */
    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void {
        return this.events.on(pattern, handler);
    }

    /** The next event matching `pattern`. */
    wait<T extends EventPattern>(pattern: T, options: { timeoutMs?: number; predicate?: (event: EventOf<T>) => boolean } = {}): Promise<EventOf<T>> {
        return this.events.wait(pattern, options);
    }

    /** Events from now until the session ends. Audio chunks only with `includeAudio`. */
    stream(options: { includeAudio?: boolean } = {}): AsyncIterableIterator<NurEvent> {
        return this.events.stream(options);
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<NurEvent> {
        return this.events.stream();
    }

    private async begin(): Promise<this> {
        this.startedAt = Date.now();
        if (this.trace) {
            this.trace.open();
            this.events.on("*", (event) => this.trace?.event(event));
        }
        this.host.liveSessions.add(this);
        try {
            if (this.transport.kind === "owned" && this.host.buildSessionConfig) this.config = await this.host.buildSessionConfig(this.configRequest());
            if (this.options.context) await this.context.update(this.options.context);
            await this.loadMemory();
            this.refreshParty();
        } catch (error) {
            await this.close({ learn: false });
            throw error;
        }
        const timeoutMs = this.options.connectTimeoutMs ?? 20_000;
        const ready = new Promise<boolean>((resolve) => this.readyResolvers.push(resolve));
        const loop = this.connectionLoop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
            timer = this.later(() => resolve("timeout"), timeoutMs);
        });
        const outcome = await Promise.race([ready, loop.then(() => false as const), timeout]);
        if (timer) clearTimeout(timer);
        if (outcome === true) {
            if (this.transport.kind !== "control") {
                void this.pumpAudio();
                this.every(() => this.reportStatus(), STATUS_INTERVAL_MS);
            }
            if (this.host.proactive && this.host.proactive.idleAfterMs !== null) this.every(() => this.idleWatch(), IDLE_POLL_MS);
            this.triggerUnsubscribe = [this.host.context.subscribe(() => this.onStateChange()), this.context.subscribe(() => this.onStateChange())];
            return this;
        }
        const failure = this.failure;
        await this.close({ learn: false });
        if (failure) throw failure;
        if (outcome === "timeout") {
            throw new RealtimeConnectionError(
                this.transport.kind === "control"
                    ? `No client opened the session within ${Math.round(timeoutMs / 1000)} s.`
                    : `The character was not ready within ${Math.round(timeoutMs / 1000)} s.`,
            );
        }
        throw new RealtimeConnectionError("The session ended before it was ready.");
    }

    private configRequest(): SessionConfigRequest {
        return {
            language: this.language,
            extraInstructions: this.options.instructions ?? null,
            playerNames: this.players.map((player) => player.name),
            playerName: this.playerName,
            toolSpecs: this.tools.specs(),
        };
    }

    /**
     * @internal What a client secret binds, composed exactly as `start()`
     * would: the configuration, the starting context blocks, and the greeting.
     * The session is never dialed and is spent afterwards.
     */
    async prepare(): Promise<{ config: Record<string, unknown>; blocks: Record<string, string>; greeting: string | null }> {
        try {
            const config = this.host.buildSessionConfig ? await this.host.buildSessionConfig(this.configRequest()) : {};
            if (this.options.context) await this.context.update(this.options.context);
            await this.loadMemory();
            this.refreshParty();
            const blocks = this.publisher.desired();
            this.publisher.validate(blocks);
            return { config, blocks, greeting: this.greeting ? this.greetingText() : null };
        } finally {
            this.publisher.close();
            this.context.close();
            this.events.close();
        }
    }

    private async teardown(learn: boolean): Promise<void> {
        this.closing = true;
        this.isReady = false;
        for (const timer of this.timers) clearTimeout(timer);
        for (const interval of this.intervals) clearInterval(interval);
        this.timers.clear();
        this.intervals.clear();
        if (this.configureTimer) clearTimeout(this.configureTimer);
        if (this.replyTimer) clearTimeout(this.replyTimer);
        this.initiative.dispose();
        for (const unsubscribe of this.triggerUnsubscribe) unsubscribe();
        this.triggerUnsubscribe = [];
        for (const resolve of this.readyResolvers) resolve(false);
        this.readyResolvers = [];
        const ws = this.ws;
        this.ws = null;
        try {
            ws?.close(1000, "closed");
        } catch {
            // Already closed.
        }
        this.output?.flush();
        this.publisher.close();
        this.context.close();
        const [reason, code, message] = this.endReason ?? ["closed", null, null];
        if (this.established) this.emit({ type: "session.ended", reason, code, message });
        this.trace?.write("metrics", { ...summarizeMetrics(this.metrics) });
        if (learn && this.established) await this.learn();
        this.host.liveSessions.delete(this);
        this.refreshPartyBlocks();
        this.events.close();
        this.trace?.close();
        for (const device of new Set([this.output, this.input])) {
            try {
                device?.close?.();
            } catch (error) {
                this.logger.error("closing an audio device failed", error);
            }
        }
        this.resolveEnded();
    }

    private finish(reason: string, code: number | null = null, message: string | null = null): void {
        if (!this.shutdown) {
            this.endReason = [reason, code, message];
            this.shutdown = this.teardown(true);
        }
    }

    private later(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            callback();
        }, ms);
        this.timers.add(timer);
        return timer;
    }

    private every(callback: () => void, ms: number): void {
        this.intervals.add(setInterval(callback, ms));
    }

    // ── what the application can do ──────────────────────────────────────

    private requireLive(): void {
        if (this.closing) throw new SessionClosedError();
    }

    /** Type into the conversation as the player and, unless `respond: false`, ask for a reply. */
    async sendText(text: string, options: { respond?: boolean; itemId?: string } = {}): Promise<void> {
        this.requireLive();
        this.transcript.push(["player", text]);
        this.lastPlayer = this.playerId;
        if (this.host.party) {
            this.host.party.heard(this.nameOf(this.playerId) ?? "A player", text, this.origin);
            this.refreshPartyBlocks();
        }
        this.send(wire.userText(text, options.itemId));
        if ((options.respond ?? true) && this.host.turnTaking !== "director") this.send(wire.responseCreate());
    }

    /**
     * Type `text` as the player and resolve with the character's answer: the
     * first reply that starts after the line joined the conversation.
     */
    ask(text: string, options: { timeoutMs?: number } = {}): Promise<ResponseCompleted> {
        const itemId = `item_sdk_${wire.randomHex(20)}`;
        const timeoutMs = options.timeoutMs ?? 60_000;
        let added = false;
        const ours = new Set<string>();
        return new Promise<ResponseCompleted>((resolve, reject) => {
            const unsubscribers: Array<() => void> = [];
            const settle = (fn: () => void) => {
                for (const unsubscribe of unsubscribers) unsubscribe();
                this.itemWaiters.delete(itemId);
                clearTimeout(timeout);
                clearTimeout(fallback);
                fn();
            };
            this.itemWaiters.set(itemId, () => {
                added = true;
            });
            // A gateway that never acknowledges items: go by timing alone.
            const fallback = setTimeout(() => {
                added = true;
            }, ITEM_ACK_FALLBACK_MS);
            const timeout = setTimeout(() => settle(() => reject(new Error(`No answer within ${timeoutMs} ms.`))), timeoutMs);
            unsubscribers.push(
                this.events.on("response.started", (event) => {
                    if (added) ours.add(event.responseId);
                }),
                this.events.on("response.completed", (event) => {
                    if (ours.has(event.responseId) && event.text) settle(() => resolve(event));
                }),
                this.events.on("session.ended", () => settle(() => reject(new SessionClosedError()))),
            );
            this.sendText(text, { itemId }).catch((error: unknown) => settle(() => reject(error)));
        });
    }

    /** Microphone audio you capture yourself: PCM16 mono, sent at the pace it was recorded. */
    sendAudio(pcm: Uint8Array, options: { sampleRate?: number } = {}): void {
        this.requireLive();
        if (this.transport.kind === "control") throw new ConfigurationError("A controlled session has no audio here: the player's client streams it.");
        const rate = options.sampleRate ?? wire.INPUT_SAMPLE_RATE;
        let frame = pcm;
        if (rate !== wire.INPUT_SAMPLE_RATE) {
            let resampler = this.sendResamplers.get(rate);
            if (!resampler) {
                resampler = new Resampler(rate, wire.INPUT_SAMPLE_RATE);
                this.sendResamplers.set(rate, resampler);
            }
            frame = resampler.process(pcm);
        }
        if (frame.byteLength && this.isReady) {
            this.metrics.audioInSeconds += frame.byteLength / 2 / wire.INPUT_SAMPLE_RATE;
            this.send(wire.appendAudio(bytesToBase64(frame)));
        }
    }

    /** Ask the character to speak now, optionally steered for this one reply. A reply already under way finishes first. */
    async respond(instructions?: string): Promise<void> {
        this.requireLive();
        this.send(wire.responseCreate({ instructions }));
    }

    /** Have the character say `line`, as nearly verbatim as the model allows, in its own voice. */
    async say(line: string): Promise<void> {
        this.requireLive();
        this.send(wire.responseCreate({ instructions: `Say exactly this, in character and in your own voice, and nothing else: "${line}"` }));
    }

    /** Something happened in your application; the character reacts as soon as the floor is free. */
    async cue(event: string, instructions?: string): Promise<void> {
        this.requireLive();
        this.transcript.push(["event", event]);
        this.initiative.offer({ kind: `cue:${wire.randomHex(8)}`, what: event, instructions, urgent: true, ttlMs: 15_000 });
    }

    /**
     * Something the character may remark on, paced so it never talks over
     * anyone: one remark per cooldown unless urgent, and only the newest
     * moment of each kind waits.
     */
    moment(what: string, options: Omit<Moment, "what" | "kind"> & { kind?: string } = {}): void {
        this.requireLive();
        this.initiative.offer({ ...options, kind: options.kind ?? "moment", what });
    }

    /** Have the character remark when live state turns `condition` true (this session only). */
    when(condition: (state: State) => boolean, what: string | ((state: State) => string), options: TriggerOptions = {}): Trigger {
        const trigger = new Trigger(condition, what, options);
        this.triggers.push(trigger);
        return trigger;
    }

    /** Every live field the character can see: its own context, then this session's. */
    state(): State {
        return { ...this.host.context.allFields(), ...this.context.allFields() };
    }

    /** Stop the character mid-sentence. */
    async interrupt(): Promise<void> {
        this.requireLive();
        if (this.current && this.active.has(this.current)) this.cut(this.current);
        this.send(wire.responseCancel());
    }

    /** Stop (or resume) sending the microphone: push-to-talk, a pause menu. */
    mute(muted = true): void {
        this.muted = muted;
    }

    /** Keep something about this player for their later sessions. */
    async remember(text: string, options: Omit<RememberOptions, "playerId"> = {}): Promise<MemoryRecord> {
        if (!this.memory) throw new SessionClosedError("This session has no player memory (no playerId, or memory is off).");
        const record = await this.memory.remember(text, { ...options, sessionId: this.sessionId });
        this.emit({ type: "memory.updated", added: [record], updated: [], removed: [], source: options.source ?? "app" });
        await this.refreshMemory();
        return record;
    }

    /** A passing emotional state that colours how the character speaks; never who it is. */
    async setMood(mood: string | null, options: { reason?: string } = {}): Promise<void> {
        if (!mood) return this.context.set("mood", null);
        const because = options.reason ? ` (${options.reason})` : "";
        return this.context.set("mood", `Your mood right now: ${mood}${because}. Let it colour how you speak in this moment; it does not change who you are.`);
    }

    /** Recompose the memory block, optionally around `query`. */
    async refreshMemory(query?: string): Promise<MemoryRecord[]> {
        const { text, used } = await this.memoryBlock(query);
        this.publisher.setBlock("memory", text);
        if (used.length) this.memoryRecords = used;
        return used;
    }

    /** Record how a reply (or the session) went, for your own evaluation. Nothing is trained on it. */
    feedback(rating: number | string, options: { note?: string; responseId?: string } = {}): void {
        this.emit({ type: "feedback", rating, note: options.note ?? null, responseId: options.responseId ?? this.current });
    }

    /** What the character is working from right now: instructions, context blocks, tools, memories. */
    inspect(): Record<string, unknown> {
        const audio = (this.config.audio ?? {}) as Record<string, Record<string, unknown> | undefined>;
        return {
            character: this.host.name,
            playerId: this.playerId,
            sessionId: this.sessionId,
            mode: this.transport.kind,
            instructions: this.config.instructions ?? null,
            voice: audio.output?.voice ?? null,
            language: this.language,
            turnTaking: this.host.turnTaking,
            context: this.publisher.current(),
            contextPending: this.publisher.desired(),
            tools: this.tools.specs().map((spec) => spec.name),
            memories: this.memoryRecords,
            metrics: summarizeMetrics(this.metrics),
        };
    }

    /** Offer or withdraw one tool for this session only. */
    async setToolEnabled(name: string, enabled: boolean): Promise<void> {
        if (enabled) this.tools.disabled.delete(name);
        else this.tools.disabled.add(name);
        const specs = this.tools.specs();
        await this.updateSession({ tools: specs, tool_choice: specs.length ? "auto" : "none" });
    }

    /** @internal A tool registered on the character while this session runs. */
    addTool(item: AnyTool): void {
        this.tools.tools.set(item.name, item);
        if (this.isReady && this.transport.kind !== "joined") void this.updateSession({ tools: this.tools.specs(), tool_choice: "auto" });
    }

    /** @internal A trigger registered on the character while this session runs. */
    addTrigger(trigger: Trigger): void {
        this.triggers.push(trigger);
    }

    /**
     * @internal A partial session.update that keeps the character's voice:
     * gateways before October 2026 pin the default voice on an update that names none.
     */
    async updateSession(patch: Record<string, unknown>): Promise<void> {
        const audio = (this.config.audio ?? {}) as Record<string, unknown>;
        const output = (audio.output ?? {}) as Record<string, unknown>;
        this.config = merge(this.config, patch);
        this.send(wire.sessionUpdate(merge({ audio: { output } }, patch)));
    }

    // ── connection ────────────────────────────────────────────────────────

    /** Dials until the session ends. Never throws: a failure before readiness is left in `failure`. */
    private async connectionLoop(): Promise<void> {
        let attempt = 0;
        let dialRetries = 0;
        let readies = 0;
        while (!this.closing) {
            let url: string;
            try {
                url = await this.transport.url(this.transport.kind === "owned" ? this.resume : null);
            } catch (error) {
                if (!this.established) {
                    if (retryable(error) && dialRetries < 2) {
                        dialRetries += 1;
                        await this.pause(reconnectDelay(dialRetries));
                        continue;
                    }
                    this.failure = dialError(error);
                    return;
                }
                this.emit({ type: "error", message: errorMessage(error), code: "connection_failed" });
                this.finish("connection_lost", null, errorMessage(error));
                return;
            }
            if (this.closing) return;
            const { code, reason, opened } = await this.connectOnce(url);
            if (this.closing) return;
            if (this.readyCount > readies) {
                // This connection came up: a later drop starts a fresh reconnect budget.
                readies = this.readyCount;
                attempt = 0;
            }
            if (!this.established) {
                if (this.failure) return;
                if ((!opened || code === 1013) && dialRetries < 2 && this.transport.kind !== "joined") {
                    dialRetries += 1;
                    await this.pause(reconnectDelay(dialRetries));
                    continue;
                }
                this.failure = this.refusal(code, reason, opened);
                return;
            }
            if (this.limit) return this.finish("limit", code, this.limit.message);
            if (this.hangupRequested) return this.finish("hangup", code);
            if (code === 1000 || FATAL_CLOSE_CODES.has(code)) return this.finish("server_closed", code, reason || null);
            // A client secret is spent by its first socket: a joined session cannot dial again.
            const redial = this.transport.kind === "control" || (this.transport.kind === "owned" && this.resume !== null);
            if (!redial || attempt >= MAX_RECONNECT_ATTEMPTS) return this.finish("connection_lost", code, reason || null);
            const delay = reconnectDelay(attempt);
            attempt += 1;
            this.metrics.reconnects += 1;
            this.emit({ type: "reconnecting", attempt, delay: Math.round(delay) / 1000, code });
            await this.pause(delay);
        }
    }

    private refusal(code: number, reason: string, opened: boolean): Error {
        if (code === 1008 && /auth|token|credential/i.test(reason)) return new AuthenticationError(`The gateway refused the credential: ${reason}`);
        if (!opened && this.transport.kind === "control") {
            return new RealtimeConnectionError("The control channel was refused: it is unknown, it has expired, or another organization minted it.", { code, kind: "dropped" });
        }
        if (!opened && this.transport.kind === "joined") {
            return new RealtimeConnectionError("The gateway refused the client secret: it has expired or was already used. Ask your server for a new one.", {
                code,
                kind: "dropped",
            });
        }
        const kind = code === 1008 ? "at-limit" : code === 1011 || !opened ? "unavailable" : "dropped";
        return new RealtimeConnectionError(`The session closed before it was ready (code ${code}${reason ? `: ${reason}` : ""}).`, { code, kind });
    }

    private pause(ms: number): Promise<void> {
        return new Promise((resolve) => this.later(resolve, ms));
    }

    private connectOnce(url: string): Promise<{ code: number; reason: string; opened: boolean }> {
        return new Promise((resolve) => {
            let opened = false;
            let ws: WebSocketLike;
            try {
                ws = this.transport.webSocket(url);
            } catch (error) {
                if (error instanceof ConfigurationError) this.failure = error;
                else this.logger.warn("could not open the realtime socket", error);
                resolve({ code: 1006, reason: errorMessage(error), opened: false });
                return;
            }
            this.ws = ws;
            ws.onopen = () => {
                opened = true;
            };
            ws.onmessage = (message) => {
                if (typeof message.data !== "string") return;
                let event: unknown;
                try {
                    event = JSON.parse(message.data);
                } catch {
                    return;
                }
                if (event && typeof event === "object" && typeof (event as wire.ServerEvent).type === "string") {
                    // One at a time, in order, like the protocol: a handler that awaits holds the next event.
                    this.chain = this.chain
                        .then(() => this.handle(event as wire.ServerEvent))
                        .catch((error: unknown) => this.logger.error(`handling ${(event as wire.ServerEvent).type} failed`, error));
                }
            };
            ws.onerror = () => undefined;
            ws.onclose = (event) => {
                if (this.ws === ws) this.ws = null;
                this.isReady = false;
                this.configured = false;
                this.publisher.stop();
                this.dropAudio();
                // Events already received are handled before deciding what the close means.
                void this.chain.then(() => resolve({ code: event.code ?? 1006, reason: event.reason ?? "", opened }));
            };
        });
    }

    /** @internal Send one client event if the socket is open. */
    send(event: wire.ClientEvent): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return;
        try {
            ws.send(JSON.stringify(event));
        } catch (error) {
            this.logger.warn("sending a realtime event failed", error);
        }
    }

    /** @internal Stamp and deliver an event. */
    emit(event: AnyEventInit): void {
        const stamped = {
            at: Math.round(Date.now() - this.startedAt) / 1000,
            sessionId: this.sessionId,
            playerId: this.playerId,
            ...event,
        };
        this.events.emit(stamped as NurEvent);
    }

    // ── the audio ─────────────────────────────────────────────────────────

    private async pumpAudio(): Promise<void> {
        if (!this.input || this.pumping) return;
        this.pumping = true;
        if (this.input.sampleRate !== wire.INPUT_SAMPLE_RATE) this.inResampler = new Resampler(this.input.sampleRate, wire.INPUT_SAMPLE_RATE);
        try {
            for await (const chunk of this.input.frames()) {
                if (this.closing) return;
                if (!this.isReady || this.muted) continue;
                const frame = this.inResampler ? this.inResampler.process(chunk) : chunk;
                if (frame.byteLength) {
                    this.metrics.audioInSeconds += frame.byteLength / 2 / wire.INPUT_SAMPLE_RATE;
                    this.send(wire.appendAudio(bytesToBase64(frame)));
                }
            }
        } catch (error) {
            if (!this.closing) this.emit({ type: "error", message: `The microphone failed: ${errorMessage(error)}`, code: "sdk_task_failed" });
        } finally {
            this.pumping = false;
        }
    }

    /** What the speaker has played, so a cut keeps only what was heard; and a keepalive now and then. */
    private reportStatus(): void {
        if (!this.isReady) return;
        if (this.output && this.play.responseId) {
            const buffered = this.output.bufferedSeconds();
            const pending = Math.round(buffered * this.host.outputSampleRate);
            this.send(
                wire.outputStatus({
                    responseId: this.play.responseId,
                    sampleRate: this.host.outputSampleRate,
                    received: this.play.received,
                    rendered: Math.max(0, this.play.received - this.play.discarded - pending),
                    discarded: this.play.discarded,
                    flushed: this.play.flushed,
                    bufferedMs: Math.round(buffered * 1000),
                }),
            );
        }
        if (Date.now() - this.lastKeepalive > KEEPALIVE_INTERVAL_MS) {
            this.lastKeepalive = Date.now();
            this.send(wire.keepalive());
        }
    }

    private onAudio(event: wire.ServerEvent): void {
        const rid = wire.responseIdOf(event) || this.current || "";
        if (this.cancelled.includes(rid) || this.internal.has(rid)) return;
        const delta = wire.str(event.delta);
        if (!delta) return;
        const pcm = base64ToBytes(delta);
        const reply = this.reply(rid);
        if (!reply.hadAudio) {
            reply.hadAudio = true;
            reply.firstAudioAt = Date.now();
            if (reply.turnEndedAt !== null) this.metrics.latencies.push((reply.firstAudioAt - reply.turnEndedAt) / 1000);
        }
        const rate = this.host.outputSampleRate;
        this.metrics.audioOutSeconds += pcm.byteLength / 2 / rate;
        if (rid !== this.play.responseId) this.play = { responseId: rid, received: 0, discarded: 0, flushed: false };
        this.play.received += pcm.byteLength / 2;
        this.output?.play(this.outResampler ? this.outResampler.process(pcm) : pcm);
        this.emit({ type: "audio.output.chunk", responseId: rid, pcm, sampleRate: rate });
    }

    private audible(): boolean {
        if (this.output) return this.output.bufferedSeconds() > 0;
        return this.current !== null && this.active.has(this.current);
    }

    private dropAudio(): void {
        if (!this.output) return;
        const dropped = Math.round(this.output.bufferedSeconds() * this.host.outputSampleRate);
        this.output.flush();
        this.outResampler?.reset();
        if (dropped) {
            this.play.discarded += Math.min(dropped, Math.max(0, this.play.received - this.play.discarded));
            this.play.flushed = true;
        }
    }

    private cut(rid: string | null): void {
        const audible = this.audible();
        this.dropAudio();
        if (rid) {
            if (!this.cancelled.includes(rid)) {
                this.cancelled.push(rid);
                if (this.cancelled.length > 64) this.cancelled.shift();
            }
            const reply = this.replies.get(rid);
            if (reply) reply.cancelled = true;
        }
        if ((audible || (rid !== null && this.active.has(rid))) && !(rid && this.interruptedIds.has(rid))) {
            if (rid) this.interruptedIds.add(rid);
            this.metrics.interruptions += 1;
            this.emit({ type: "speech.interrupted", responseId: rid });
        }
    }

    // ── server events ─────────────────────────────────────────────────────

    private reply(rid: string): Reply {
        let reply = this.replies.get(rid);
        if (!reply) {
            reply = newReply();
            this.replies.set(rid, reply);
        }
        return reply;
    }

    private async handle(event: wire.ServerEvent): Promise<void> {
        const kind = wire.canonicalType(event.type);
        const now = Date.now();
        switch (kind) {
            case "eesi.recording_disclosure": {
                const disclosure = wire.record(event.disclosure);
                this.recorded = disclosure.recorded === true;
                this.disclosure = this.recorded ? wire.str(disclosure.text) || null : null;
                return;
            }
            case "eesi.session":
                return this.onSessionHandle(event);
            case "session.created":
                this.capabilities = wire.record(event.capabilities);
                if (this.transport.kind === "control") return; // The client's session, configured by its secret.
                if (this.transport.kind === "joined") {
                    // Its secret configured it before the client's first frame; the answer to that is `session.updated`.
                    this.configureTimer = this.later(() => {
                        if (!this.configured && !this.closing) {
                            this.configured = true;
                            void this.onReady();
                        }
                    }, JOINED_READY_FALLBACK_MS);
                    return;
                }
                this.configured = false;
                this.send(wire.sessionUpdate(this.config));
                this.configureTimer = this.later(() => {
                    if (!this.configured && !this.closing) {
                        this.emit({
                            type: "error",
                            message:
                                "The gateway did not accept the character's configuration (no session.updated). Check the instructions size, the voice and the tool schemas.",
                            code: "configure_timeout",
                        });
                    }
                }, CONFIGURE_TIMEOUT_MS);
                return;
            case "session.updated":
                if (this.transport.kind === "control" || this.configured) return;
                this.configured = true;
                if (this.configureTimer) clearTimeout(this.configureTimer);
                return this.onReady();
            case "eesi.control.attached":
                if (wire.str(event.session_id)) this.sessionId = wire.str(event.session_id);
                if (wire.str(event.recording_session_id)) this.recordingSessionId = wire.str(event.recording_session_id);
                if (event.tools === "server" || event.tools === "client") this.controlTools = event.tools;
                if (!this.isReady) return this.onReady();
                return;
            case "eesi.control.ended":
                return this.finish("ended", null, wire.str(event.reason) || null);
            case "input_audio_buffer.speech_started":
                return this.onSpeechStarted(event);
            case "input_audio_buffer.speech_stopped": {
                this.userSpeaking = false;
                this.speechStoppedAt = now;
                this.lastActivity = now;
                const end = typeof event.audio_end_ms === "number" ? event.audio_end_ms : null;
                this.speechWindow = [this.speechWindow[0], end];
                this.initiative.userStopped();
                this.emit({ type: "audio.input.ended", audioEndMs: end });
                return;
            }
            case "conversation.item.input_audio_transcription.delta": {
                const text = wire.str(event.delta);
                if (text && text !== this.partial) {
                    this.partial = text;
                    this.emit({ type: "transcript.partial", text, itemId: wire.str(event.item_id) || null });
                }
                return;
            }
            case "conversation.item.input_audio_transcription.completed": {
                this.partial = "";
                const text = wire.str(event.transcript).trim();
                if (text) this.onUserTurn(text, wire.str(event.item_id) || null);
                return;
            }
            case "conversation.item.added":
            case "conversation.item.created":
                this.itemWaiters.get(wire.str(wire.record(event.item).id))?.();
                return;
            case "response.created": {
                const rid = wire.responseIdOf(event);
                if (this.isInternal(event)) {
                    this.internal.set(rid, []);
                    return;
                }
                this.lastActivity = now;
                const reply = this.reply(rid);
                reply.turnEndedAt = this.speechStoppedAt;
                this.speechStoppedAt = null;
                this.current = rid;
                this.active.add(rid);
                this.initiative.responseStarted();
                this.emit({ type: "response.started", responseId: rid });
                return;
            }
            case "response.output_audio.delta":
                return this.onAudio(event);
            case "response.output_audio_transcript.delta":
            case "response.output_text.delta": {
                const rid = wire.responseIdOf(event) || this.current || "";
                const delta = wire.str(event.delta);
                const internal = this.internal.get(rid);
                if (internal) {
                    internal.push(delta);
                    return;
                }
                if (delta && !this.cancelled.includes(rid)) {
                    this.reply(rid).deltas.push(delta);
                    this.emit({ type: "response.text.delta", responseId: rid, text: delta });
                }
                return;
            }
            case "response.output_audio_transcript.done":
            case "response.output_text.done": {
                const rid = wire.responseIdOf(event) || this.current || "";
                const text = kind.endsWith("transcript.done") ? wire.str(event.transcript) : wire.str(event.text);
                if (this.internal.has(rid)) {
                    if (text.trim()) this.internal.set(rid, [text]);
                    return;
                }
                const reply = this.reply(rid);
                const id = wire.str(event.event_id);
                if (id && reply.segmentIds.has(id)) return;
                if (id) reply.segmentIds.add(id);
                if (text.trim()) reply.segments.push(text);
                return;
            }
            case "output_audio_buffer.cleared": {
                const rid = wire.str(event.response_id) || this.current;
                if (rid === null || !this.cancelled.includes(rid)) this.cut(rid);
                return;
            }
            case "eesi.output.resume":
                this.output?.duck?.(false);
                return;
            case "response.function_call_arguments.done":
                return this.onToolCall(event);
            case "response.done": {
                const rid = wire.responseIdOf(event);
                const internal = this.internal.get(rid);
                if (internal) {
                    this.internal.delete(rid);
                    return this.idleDecided(internal.join("").trim());
                }
                return this.onResponseDone(event);
            }
            case "eesi.hangup":
                return this.onHangup(wire.str(event.reason) || "model_requested");
            case "error": {
                const { message, code } = wire.errorOf(event);
                if (code === "response_request_superseded") return; // A newer request took a waiting one's place: normal turn-taking.
                if (code === "invalid_context_update" && message.includes("eesi.context.update") && /unknown/i.test(message)) this.publisher.refused();
                this.emit({ type: "error", message, code });
                return;
            }
            default:
                return;
        }
    }

    private onSessionHandle(event: wire.ServerEvent): void {
        if (wire.str(event.session_id)) this.sessionId = wire.str(event.session_id);
        if (wire.str(event.recording_session_id)) this.recordingSessionId = wire.str(event.recording_session_id);
        const resume = wire.record(event.resume);
        const token = wire.str(event.resume_token) || wire.str(resume.token) || wire.str(resume.resume_token);
        this.resume = resume.supported === true && token && this.sessionId ? { resume: this.sessionId, resume_token: token } : null;
        this.resumed = typeof event.resumed === "object" && event.resumed !== null;
        const limit = wire.record(event.limit);
        if (wire.str(limit.code)) {
            this.limit = { code: wire.str(limit.code), message: wire.str(limit.message) };
            this.emit({ type: "error", message: this.limit.message || "The session reached a limit.", code: this.limit.code });
        }
    }

    private async onReady(): Promise<void> {
        try {
            await this.publisher.start();
        } catch (error) {
            if (error instanceof ContextError) this.emit({ type: "error", message: error.message, code: "invalid_context_update" });
            else throw error;
        }
        const first = !this.established;
        this.established = true;
        this.readyCount += 1;
        this.lastActivity = Date.now();
        this.isReady = true;
        for (const resolve of this.readyResolvers) resolve(true);
        this.readyResolvers = [];
        if (!first) {
            this.emit({ type: "reconnected", resumed: this.resumed });
            return;
        }
        this.emit({ type: "session.started", model: this.host.model, resumed: this.resumed, recorded: this.recorded, disclosure: this.disclosure });
        if (this.memoryRecords.length) this.emit({ type: "memory.retrieved", query: null, records: this.memoryRecords });
        if (this.greeting && !this.resumed) this.send(wire.responseCreate({ instructions: this.greetingText() }));
    }

    private greetingText(): string {
        const known = this.memoryRecords.some((record) => record.playerId !== null);
        return this.host.greetingInstructions(this.greeting, { known, stranger: this.memory !== null && !known, name: this.playerName });
    }

    private onSpeechStarted(event: wire.ServerEvent): void {
        const interrupt = event.interrupt_response;
        const audible = this.audible();
        this.userSpeaking = true;
        this.speechStoppedAt = null;
        this.lastActivity = Date.now();
        const start = typeof event.audio_start_ms === "number" ? event.audio_start_ms : null;
        this.speechWindow = [start, null];
        if (this.replyTimer) clearTimeout(this.replyTimer);
        this.replyTimer = null;
        this.initiative.userStarted();
        this.emit({ type: "audio.input.started", whileSpeaking: audible, audioStartMs: start });
        if (interrupt === false && audible) {
            // Held, not cut: the runtime is deciding whether that was a backchannel.
            this.output?.duck?.(true);
            return;
        }
        if (interrupt !== false && !event.eesi_late && (audible || (this.current !== null && this.active.has(this.current)))) this.cut(this.current);
    }

    private onUserTurn(text: string, itemId: string | null): void {
        this.metrics.turns += 1;
        let turns: SpeakerTurn[];
        if (this.attributor || this.roster) {
            const attributed = this.attributor ? this.attributor(text) : (this.roster as SpeakerRoster).attribute(text);
            turns = attributed.map((turn) => ({ text: turn.text, speaker: turn.speaker, playerId: turn.player ? (this.playerIds[turn.player] ?? turn.player) : null }));
            for (const turn of turns) if (turn.playerId) this.lastPlayer = turn.playerId;
            if (this.roster) this.publisher.setBlock("roster", this.roster.render(this.languages));
        } else {
            turns = wire.splitSpeakerTurns(text).map(({ speaker, text: words }) => ({ text: words, speaker, playerId: this.playerId }));
        }
        for (const turn of turns) {
            const label = this.players.length ? (this.nameOf(turn.playerId) ?? (turn.speaker ? `Speaker ${turn.speaker}` : "player")) : "player";
            this.transcript.push([label, turn.text]);
            this.host.party?.heard(this.nameOf(turn.playerId) ?? "A player", turn.text, this.origin);
        }
        if (this.host.party) this.refreshPartyBlocks();
        this.emit({ type: "transcript.final", text, itemId, turns });
        if (this.host.memory && this.host.memory.policy.recallOnTurn && this.memoryMode !== "off" && !this.memoryTask) {
            this.memoryTask = this.recallFor(text)
                .catch((error: unknown) => this.logger.warn("memory recall failed", error))
                .finally(() => {
                    this.memoryTask = null;
                });
        }
        if (this.host.turnTaking === "app") {
            if (this.replyTimer) clearTimeout(this.replyTimer);
            this.replyTimer = this.later(() => void this.replyToTurn(), TURN_SETTLE_MS);
        }
    }

    /** App turn-taking: one reply per finished turn, once fresh state and memories are in. */
    private async replyToTurn(): Promise<void> {
        this.replyTimer = null;
        if (this.userSpeaking || this.closing) return;
        if (this.memoryTask) await Promise.race([this.memoryTask, this.pause(RECALL_WAIT_MS)]);
        try {
            await this.publisher.flush();
        } catch (error) {
            this.emit({ type: "error", message: errorMessage(error), code: "invalid_context_update" });
        }
        if (!this.userSpeaking && !this.closing) this.send(wire.responseCreate({ toolChoice: "auto" }));
    }

    private async onResponseDone(event: wire.ServerEvent): Promise<void> {
        const rid = wire.responseIdOf(event);
        const { status, reason } = wire.responseStatus(event);
        this.lastActivity = Date.now();
        const reply = this.reply(rid);
        this.active.delete(rid);
        reply.done = true;
        const cut = status === "cancelled" || reason === "turn_detected";
        const text = replyText(reply);
        if (cut) {
            this.cut(rid);
            this.emit({ type: "response.cancelled", responseId: rid, reason: reason ?? status, text });
        } else if (status === null || status === "completed" || status === "incomplete") {
            this.metrics.replies += 1;
            const latency = reply.firstAudioAt !== null && reply.turnEndedAt !== null ? Math.round(reply.firstAudioAt - reply.turnEndedAt) / 1000 : null;
            this.emit({ type: "response.completed", responseId: rid, text, latency });
        } else {
            this.emit({ type: "error", message: `The reply ended with status ${status}${reason ? ` (${reason})` : ""}.`, code: reason ?? status });
        }
        if (text) {
            this.transcript.push([this.host.name, text + (cut ? " [cut off]" : "")]);
            if (this.host.party && !cut) {
                this.host.party.said(this.host.name, this.nameOf(this.lastPlayer) ?? "a player", text, this.origin);
                this.refreshPartyBlocks();
            }
        }
        this.initiative.responseDone();
        await this.continueIfSettled(rid);
        for (const pending of [...this.pendingContinue]) await this.continueIfSettled(pending);
        if (this.replies.size > 64) {
            for (const [id, entry] of [...this.replies].slice(0, -32)) if (entry.done && entry.outstanding.size === 0) this.replies.delete(id);
        }
    }

    // ── tools ─────────────────────────────────────────────────────────────

    private nameOf(playerId: string | null): string | null {
        if (playerId === null) return null;
        for (const [name, id] of Object.entries(this.playerIds)) if (id === playerId) return name;
        if (playerId === this.playerId) return this.playerName ?? playerId;
        return playerId;
    }

    private toolContext(callId: string, args: Record<string, unknown>): ToolContext {
        return { session: this, character: this.character, playerId: this.lastPlayer ?? this.playerId, callId, arguments: args };
    }

    private toolEvent(event: ToolEvent): void {
        const { kind, ...data } = event;
        if (kind === "tool.started") this.metrics.toolCalls += 1;
        if (kind === "tool.failed") this.metrics.toolFailures += 1;
        this.emit({ type: kind, ...data } as AnyEventInit);
    }

    private onToolCall(event: wire.ServerEvent): void {
        const callId = wire.str(event.call_id);
        const name = wire.str(event.name);
        if (!callId || !name) return;
        const executor = wire.str(event.eesi_executor);
        if (this.transport.kind === "control") {
            // The server's tools run here; with tools left to the client, the client runs them.
            if (executor === "gateway" || this.controlTools !== "server") return;
        } else if (executor === "gateway" || executor === "server") {
            return;
        }
        if (this.tools.seen(callId)) return;
        const rid = wire.responseIdOf(event) || this.current || "";
        const reply = this.reply(rid);
        reply.calls += 1;
        reply.outstanding.add(callId);
        void this.runTool(rid, callId, name, wire.str(event.arguments) || "{}");
    }

    private async runTool(rid: string, callId: string, name: string, args: string): Promise<void> {
        const forward = this.options.onToolCall;
        const outcome = forward && !this.tools.tools.has(name) ? await this.forwardTool(forward, callId, name, args) : await this.tools.run(callId, name, args);
        if (outcome.later) this.follow(name, outcome.later);
        this.send(wire.toolOutput(callId, outcome.output));
        const reply = this.replies.get(rid);
        if (!reply) return;
        reply.outstanding.delete(callId);
        reply.speakAfter = reply.speakAfter || outcome.speakAfter;
        await this.continueIfSettled(rid);
    }

    /** A joined client's call, answered by your code (which usually asks your server: `character.runTool`). */
    private async forwardTool(forward: (call: ToolCall) => unknown, callId: string, name: string, raw: string): Promise<Outcome> {
        let args: Record<string, unknown> = {};
        try {
            const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
            // Your server validates the arguments.
        }
        this.toolEvent({ kind: "tool.started", callId, name, arguments: args });
        const startedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                Promise.resolve().then(() => forward({ name, arguments: args, callId, playerId: this.lastPlayer ?? this.playerId })),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`no answer within ${FORWARDED_TOOL_TIMEOUT_MS / 1000} s`)), FORWARDED_TOOL_TIMEOUT_MS);
                }),
            ]);
            const output = wire.clipBytes(renderResult(result), wire.MAX_TOOL_RESULT_BYTES);
            this.toolEvent({ kind: "tool.completed", callId, name, arguments: args, result, output, duration: (Date.now() - startedAt) / 1000 });
            return { output, speakAfter: result !== undefined && result !== null, later: null };
        } catch (error) {
            const message = `That failed: ${errorMessage(error)}`;
            this.toolEvent({ kind: "tool.failed", callId, name, arguments: args, reason: "exception", error: message });
            return { output: message, speakAfter: true, later: null };
        } finally {
            clearTimeout(timer);
        }
    }

    private follow(name: string, later: Promise<unknown>): void {
        later.then(
            (result) => this.news(`The ${name} you started earlier finished: ${renderResult(result)}`, name),
            (error: unknown) => this.news(`The ${name} you started earlier failed: ${errorMessage(error)}`, name),
        );
    }

    private news(what: string, name: string): void {
        if (this.closing) return;
        this.transcript.push(["event", what]);
        this.initiative.offer({ kind: `tool:${name}`, what, urgent: true, ttlMs: 30_000 });
    }

    /**
     * One continuation after every result of a reply is in and that reply is
     * over: one per result would talk over itself when the model asked for two
     * tools at once, one before `response.done` would be refused, and one after
     * a reply that already said what the tool did makes the character say it twice.
     */
    private async continueIfSettled(rid: string): Promise<void> {
        const reply = this.replies.get(rid);
        if (!reply || !reply.done || reply.outstanding.size || reply.continued) {
            this.pendingContinue.delete(rid);
            return;
        }
        if (this.active.size) {
            this.pendingContinue.add(rid);
            return;
        }
        this.pendingContinue.delete(rid);
        reply.continued = true;
        if (reply.cancelled || reply.calls === 0 || this.userSpeaking || this.closing) return;
        if (reply.hadAudio && !reply.speakAfter) return;
        // Plain on purpose: a tool the runtime's thinker asked for belongs to that request, and only a plain create resumes it.
        this.send(wire.responseCreate());
    }

    private speakMoment(moment: Moment): void {
        this.send(wire.eventReply(moment.what, momentInstructions(moment)));
    }

    private onHangup(reason: string): void {
        this.hangupRequested = true;
        this.emit({ type: "session.hangup", reason });
        if (!this.host.endOnHangup) return;
        const afterPlayout = () => {
            if (this.output && this.output.bufferedSeconds() > 0.05) {
                this.later(afterPlayout, 100);
                return;
            }
            this.endReason = ["hangup", null, null];
            void this.close();
        };
        this.later(afterPlayout, 300);
    }

    // ── speaking first ────────────────────────────────────────────────────

    private onStateChange(): void {
        if (!this.isReady || this.closing || this.triggers.length === 0) return;
        const state = this.state();
        for (const trigger of this.triggers) {
            const remark = trigger.check(state);
            if (remark) {
                this.moment(remark, {
                    kind: trigger.kind,
                    urgent: trigger.options.urgent,
                    cooldownMs: trigger.options.cooldownMs ?? 30_000,
                    instructions: trigger.options.instructions,
                });
            }
        }
    }

    private isInternal(event: wire.ServerEvent): boolean {
        const response = wire.record(event.response);
        if (wire.record(response.metadata)[INTERNAL_TAG]) return true;
        // A runtime that does not echo metadata still marks an out-of-band reply.
        return this.idlePending && "conversation_id" in response && response.conversation_id === null;
    }

    private floorFree(): boolean {
        return !this.userSpeaking && this.active.size === 0 && !this.audible() && !this.closing;
    }

    /** After a quiet stretch, ask the character (out of band, text only) whether it would speak up. */
    private idleWatch(): void {
        const proactive = this.host.proactive;
        if (!proactive || !this.isReady || this.idlePending || !this.floorFree()) return;
        const now = Date.now();
        if (now - this.lastActivity < (proactive.idleAfterMs ?? 25_000)) return;
        if (now - this.lastIdleCheck < (proactive.cooldownMs ?? 60_000)) return;
        if (proactive.maxRemarks != null && this.idleRemarks >= proactive.maxRemarks) return;
        // The cooldown runs between checks, said or not: each one is a model call.
        this.idlePending = true;
        this.lastActivity = now;
        this.lastIdleCheck = now;
        this.later(() => {
            this.idlePending = false; // A check that never came back.
        }, 30_000);
        this.send(
            wire.responseCreate({
                instructions: idlePrompt(proactive),
                extra: { conversation: "none", output_modalities: ["text"], metadata: { [INTERNAL_TAG]: "idle_check" } },
            }),
        );
    }

    private idleDecided(text: string): void {
        this.idlePending = false;
        this.lastActivity = Date.now();
        const line = text.trim().replace(/^"+|"+$/g, "").trim();
        if (!line || line.toUpperCase().replace(/[.!]+$/, "") === IDLE_SKIP || line.length > 400) return;
        if (!this.floorFree()) return; // Someone spoke while it was deciding.
        this.idleRemarks += 1;
        this.send(wire.responseCreate({ instructions: `Say this now, in your own voice, as it is: "${line}"` }));
    }

    // ── context and memory ────────────────────────────────────────────────

    private async sendContext(key: string, text: string): Promise<void> {
        this.send(wire.contextUpdate(key, text));
    }

    /** @internal */
    refreshParty(): void {
        if (this.host.party) this.publisher.setBlock("party", this.host.party.render(this.origin));
    }

    private refreshPartyBlocks(): void {
        if (!this.host.party) return;
        for (const session of this.host.liveSessions) session.refreshParty();
    }

    private async memoryBlock(query?: string): Promise<{ text: string; used: MemoryRecord[] }> {
        const memory = this.host.memory;
        if (!memory || this.memoryMode === "off") return { text: "", used: [] };
        if (this.players.length && this.playerId === null) {
            const parts: string[] = [];
            const used: MemoryRecord[] = [];
            for (const player of this.players) {
                const block = await memory.block({ playerId: playerKey(player), playerName: player.name, query });
                if (block.text) parts.push(block.text);
                used.push(...block.used.filter((record) => !used.some((seen) => seen.id === record.id)));
            }
            return { text: parts.join("\n\n"), used };
        }
        return memory.block({ playerId: this.playerId, playerName: this.playerName, query, sessionPreferences: this.preferences.sessionOnly });
    }

    private async loadMemory(): Promise<void> {
        const situation = Object.values(this.publisher.desired()).join(" ");
        try {
            const { text, used } = await this.memoryBlock(situation || undefined);
            this.memoryRecords = used;
            this.publisher.setBlock("memory", text);
        } catch (error) {
            this.emit({ type: "error", message: `Memory could not be read: ${errorMessage(error)}`, code: "memory_unavailable" });
        }
    }

    /** Memories this turn brings to mind, in the `recall` block, kept apart so the `memory` block stays a stable prefix. */
    private async recallFor(text: string): Promise<void> {
        const memory = this.host.memory;
        if (!memory) return;
        const shown = new Set(this.memoryRecords.map((record) => record.id));
        const found: MemoryRecord[] = [];
        const ids: Array<string | null> = this.playerId ? [this.playerId] : this.players.length ? this.players.map(playerKey) : [null];
        for (const playerId of ids) {
            for (const [record, score] of await memory.search(text, { playerId, limit: 6 })) {
                if (score >= RECALL_MIN_SCORE && !shown.has(record.id) && !found.some((item) => item.id === record.id)) found.push(record);
            }
        }
        const picked = found.slice(0, RECALL_MAX);
        const lines = picked.map((record) => `- ${record.text.split(/\s+/).join(" ").trim()}`);
        this.publisher.setBlock("recall", lines.length ? `What the player just said reminds you of (use it only if it matters):\n${lines.join("\n")}` : "");
        if (picked.length) {
            await memory.store.touch(
                picked.map((record) => record.id),
                Date.now() / 1000,
            );
            this.emit({ type: "memory.retrieved", query: text, records: picked });
        }
    }

    /** What the conversation was worth remembering, for each player in it. */
    private async learn(): Promise<void> {
        const memory = this.host.memory;
        if (!memory || !this.memoryWritable || !memory.policy.extract) return;
        if (!this.transcript.some(([speaker]) => speaker !== "event" && speaker !== this.host.name)) return;
        const targets: Array<[string, string | null]> = this.playerId ? [[this.playerId, this.playerName]] : this.players.map((player) => [playerKey(player), player.name]);
        for (const [playerId, name] of targets) {
            // Each player's memories come from their own words; the others' are context.
            const lines: Array<[string, string]> = this.transcript.map(([speaker, text]) => [speaker === "player" || speaker === name ? "player" : speaker, text]);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([
                    memory.learn(lines, { playerId, playerName: name, sessionId: this.sessionId, skipKinds: this.host.personalize ? [] : ["preference"] }),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`no answer within ${LEARN_TIMEOUT_MS / 1000} s`)), LEARN_TIMEOUT_MS);
                    }),
                ]);
                if (result.added.length || result.superseded.length || result.forgotten.length) {
                    this.emit({ type: "memory.updated", playerId, added: result.added, updated: result.superseded, removed: result.forgotten, source: "extraction" });
                }
            } catch (error) {
                this.emit({ type: "error", message: `Learning from the conversation failed: ${errorMessage(error)}`, code: "memory_extraction_failed" });
            } finally {
                clearTimeout(timer);
            }
        }
    }
}
