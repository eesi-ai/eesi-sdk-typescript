import { type AudioInput, type AudioOutput } from "./audio.js";
import type { Character, ConnectOptions } from "./character.js";
import { ContextPublisher, LiveContext } from "./context.js";
import { type AnyEventInit, EventBus, type EventOf, type EventPattern, type Handler, type Logger, type NurEvent, type ResponseCompleted } from "./events.js";
import { type Moment } from "./initiative.js";
import type { CharacterMemory, MemoryRecord, PlayerMemory, RememberOptions } from "./memory/index.js";
import { type AttributedTurn, type PartyLog, type Player, SpeakerRoster } from "./multiplayer.js";
import { type Proactive, type State, Trigger, type TriggerOptions } from "./proactive.js";
import * as wire from "./protocol.js";
import { type AnyTool } from "./tools.js";
/** How long a finished turn waits before an app-driven reply is asked for. */
export declare const TURN_SETTLE_MS = 600;
/** The parts of a WebSocket a session uses: the browser's, Node's (22+), Deno's, Bun's, or the `ws` package's. */
export interface WebSocketLike {
    readonly readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: {
        data: unknown;
    }) => void) | null;
    onclose: ((event: {
        code: number;
        reason: string;
    }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
/** The platform's WebSocket, or a clear error when there is none. */
export declare function defaultWebSocket(): WebSocketFactory;
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
    greetingInstructions(greeting: boolean | string, options: {
        known?: boolean;
        stranger?: boolean;
        name?: string | null;
    }): string;
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
export declare function summarizeMetrics(metrics: SessionMetrics): MetricsSummary;
/**
 * How a player likes to be spoken to: applied at once, and kept for their
 * later sessions when the session has player memory.
 *
 *     await session.preferences.set({ language: "Spanish", pace: "slow" });
 */
export declare class Preferences {
    private readonly session;
    /** Preferences for this session only (no memory, or `persist: false`). */
    readonly sessionOnly: Record<string, string>;
    constructor(session: Session);
    phrase(key: string, value: string): string;
    set(values: Record<string, string | null>, options?: {
        persist?: boolean;
    }): Promise<void>;
    get(): Promise<Record<string, string>>;
}
/** A live conversation. Make one with `character.connect()`, `character.control()` or `joinSession()`. */
export declare class Session {
    readonly host: SessionHost;
    /** The character, on your server; null in a session joined with a client secret. */
    readonly character: Character | null;
    readonly playerId: string | null;
    readonly playerName: string | null;
    /** The people sharing this conversation, when several do. */
    readonly players: Player[];
    /** This session's live state: its `scene` block, and any blocks of your own. */
    readonly context: LiveContext;
    readonly events: EventBus;
    readonly preferences: Preferences;
    readonly metrics: SessionMetrics;
    /** `[speaker, text]` lines as the SDK saw them: "player", a player's name, "event" or the character's name. */
    readonly transcript: Array<[string, string]>;
    /** The language this session is pinned to, when it is: a code or a name. */
    readonly language: string | null;
    /** This player's memories with the character, when the session has them. */
    readonly memory: PlayerMemory | null;
    readonly input: AudioInput | null;
    readonly output: AudioOutput | null;
    sessionId: string | null;
    recordingSessionId: string | null;
    /** Whether the organization records this session; show `disclosure` to people when it does. */
    recorded: boolean;
    disclosure: string | null;
    /** What the runtime said it supports, from `session.created`. */
    capabilities: Record<string, unknown>;
    /** The last player turn's place in the audio sent, in ms: `[start, end]`. */
    speechWindow: [number | null, number | null];
    /** Resolves when the conversation is over, however it ended. */
    readonly ended: Promise<void>;
    /** @internal A Room's attribution, used instead of voice-label guessing. */
    attributor: ((text: string) => AttributedTurn[]) | null;
    /** @internal */
    readonly roster: SpeakerRoster | null;
    /** @internal A player's name to the language they speak. */
    readonly languages: Record<string, string>;
    /** @internal A player's name to their id. */
    readonly playerIds: Record<string, string>;
    /** @internal */
    readonly publisher: ContextPublisher;
    /** @internal This session's mark in the character's party log. */
    readonly origin: string;
    private readonly transport;
    private readonly logger;
    private readonly options;
    private readonly trace;
    private readonly tools;
    private readonly triggers;
    private readonly initiative;
    private readonly memoryMode;
    private readonly greeting;
    private config;
    private ws;
    private chain;
    private startedAt;
    private resolveEnded;
    private readyResolvers;
    private isReady;
    private closing;
    private established;
    private configured;
    private resumed;
    private resume;
    private limit;
    private endReason;
    private starting;
    private shutdown;
    private failure;
    private readyCount;
    private controlTools;
    private timers;
    private intervals;
    private configureTimer;
    private replyTimer;
    private replies;
    private current;
    private cancelled;
    private active;
    private pendingContinue;
    private interruptedIds;
    private itemWaiters;
    private internal;
    private userSpeaking;
    private speechStoppedAt;
    private partial;
    private muted;
    private hangupRequested;
    private memoryRecords;
    private memoryTask;
    private lastPlayer;
    private readonly outResampler;
    private inResampler;
    private sendResamplers;
    private play;
    private lastKeepalive;
    private lastActivity;
    private idleRemarks;
    private lastIdleCheck;
    private idlePending;
    private triggerUnsubscribe;
    private pumping;
    constructor(host: SessionHost, options: SessionOptions, transport: Transport);
    /** Whether the character is live and listening. */
    get ready(): boolean;
    /** Whether the session is over (or closing). */
    get closed(): boolean;
    /** @internal */
    get memoryWritable(): boolean;
    /**
     * Dial, configure the character, send its context and memories. Resolves
     * with the session once the character is ready; rejects with what went
     * wrong (an `AuthenticationError`, a `RealtimeConnectionError`, …).
     */
    start(): Promise<this>;
    /** Hang up, learn from the conversation (unless `learn: false`), end every event stream. Safe to call twice. */
    close(options?: {
        learn?: boolean;
    }): Promise<void>;
    /** Call `handler` for events matching `pattern` ("transcript.final", "tool.*", "*"). Returns an unsubscribe function. */
    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void;
    /** The next event matching `pattern`. */
    wait<T extends EventPattern>(pattern: T, options?: {
        timeoutMs?: number;
        predicate?: (event: EventOf<T>) => boolean;
    }): Promise<EventOf<T>>;
    /** Events from now until the session ends. Audio chunks only with `includeAudio`. */
    stream(options?: {
        includeAudio?: boolean;
    }): AsyncIterableIterator<NurEvent>;
    [Symbol.asyncIterator](): AsyncIterableIterator<NurEvent>;
    private begin;
    private configRequest;
    /**
     * @internal What a client secret binds, composed exactly as `start()`
     * would: the configuration, the starting context blocks, and the greeting.
     * The session is never dialed and is spent afterwards.
     */
    prepare(): Promise<{
        config: Record<string, unknown>;
        blocks: Record<string, string>;
        greeting: string | null;
    }>;
    private teardown;
    private finish;
    private later;
    private every;
    private requireLive;
    /** Type into the conversation as the player and, unless `respond: false`, ask for a reply. */
    sendText(text: string, options?: {
        respond?: boolean;
        itemId?: string;
    }): Promise<void>;
    /**
     * Type `text` as the player and resolve with the character's answer: the
     * first reply that starts after the line joined the conversation.
     */
    ask(text: string, options?: {
        timeoutMs?: number;
    }): Promise<ResponseCompleted>;
    /** Microphone audio you capture yourself: PCM16 mono, sent at the pace it was recorded. */
    sendAudio(pcm: Uint8Array, options?: {
        sampleRate?: number;
    }): void;
    /** Ask the character to speak now, optionally steered for this one reply. A reply already under way finishes first. */
    respond(instructions?: string): Promise<void>;
    /** Have the character say `line`, as nearly verbatim as the model allows, in its own voice. */
    say(line: string): Promise<void>;
    /** Something happened in your application; the character reacts as soon as the floor is free. */
    cue(event: string, instructions?: string): Promise<void>;
    /**
     * Something the character may remark on, paced so it never talks over
     * anyone: one remark per cooldown unless urgent, and only the newest
     * moment of each kind waits.
     */
    moment(what: string, options?: Omit<Moment, "what" | "kind"> & {
        kind?: string;
    }): void;
    /** Have the character remark when live state turns `condition` true (this session only). */
    when(condition: (state: State) => boolean, what: string | ((state: State) => string), options?: TriggerOptions): Trigger;
    /** Every live field the character can see: its own context, then this session's. */
    state(): State;
    /** Stop the character mid-sentence. */
    interrupt(): Promise<void>;
    /** Stop (or resume) sending the microphone: push-to-talk, a pause menu. */
    mute(muted?: boolean): void;
    /** Keep something about this player for their later sessions. */
    remember(text: string, options?: Omit<RememberOptions, "playerId">): Promise<MemoryRecord>;
    /** A passing emotional state that colours how the character speaks; never who it is. */
    setMood(mood: string | null, options?: {
        reason?: string;
    }): Promise<void>;
    /** Recompose the memory block, optionally around `query`. */
    refreshMemory(query?: string): Promise<MemoryRecord[]>;
    /** Record how a reply (or the session) went, for your own evaluation. Nothing is trained on it. */
    feedback(rating: number | string, options?: {
        note?: string;
        responseId?: string;
    }): void;
    /** What the character is working from right now: instructions, context blocks, tools, memories. */
    inspect(): Record<string, unknown>;
    /** Offer or withdraw one tool for this session only. */
    setToolEnabled(name: string, enabled: boolean): Promise<void>;
    /** @internal A tool registered on the character while this session runs. */
    addTool(item: AnyTool): void;
    /** @internal A trigger registered on the character while this session runs. */
    addTrigger(trigger: Trigger): void;
    /**
     * @internal A partial session.update that keeps the character's voice:
     * gateways before October 2026 pin the default voice on an update that names none.
     */
    updateSession(patch: Record<string, unknown>): Promise<void>;
    /** Dials until the session ends. Never throws: a failure before readiness is left in `failure`. */
    private connectionLoop;
    private refusal;
    private pause;
    private connectOnce;
    /** @internal Send one client event if the socket is open. */
    send(event: wire.ClientEvent): void;
    /** @internal Stamp and deliver an event. */
    emit(event: AnyEventInit): void;
    private pumpAudio;
    /** What the speaker has played, so a cut keeps only what was heard; and a keepalive now and then. */
    private reportStatus;
    private onAudio;
    private audible;
    private dropAudio;
    private cut;
    private reply;
    private handle;
    private onSessionHandle;
    private onReady;
    private greetingText;
    private onSpeechStarted;
    private onUserTurn;
    /** App turn-taking: one reply per finished turn, once fresh state and memories are in. */
    private replyToTurn;
    private onResponseDone;
    private nameOf;
    private toolContext;
    private toolEvent;
    private onToolCall;
    private runTool;
    /** A joined client's call, answered by your code (which usually asks your server: `character.runTool`). */
    private forwardTool;
    private follow;
    private news;
    /**
     * One continuation after every result of a reply is in and that reply is
     * over: one per result would talk over itself when the model asked for two
     * tools at once, one before `response.done` would be refused, and one after
     * a reply that already said what the tool did makes the character say it twice.
     */
    private continueIfSettled;
    private speakMoment;
    private onHangup;
    private onStateChange;
    private isInternal;
    private floorFree;
    /** After a quiet stretch, ask the character (out of band, text only) whether it would speak up. */
    private idleWatch;
    private idleDecided;
    private sendContext;
    /** @internal */
    refreshParty(): void;
    private refreshPartyBlocks;
    private memoryBlock;
    private loadMemory;
    /** Memories this turn brings to mind, in the `recall` block, kept apart so the `memory` block stays a stable prefix. */
    private recallFor;
    /** What the conversation was worth remembering, for each player in it. */
    private learn;
}
//# sourceMappingURL=session.d.ts.map