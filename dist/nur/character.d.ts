import type { AudioDevices, AudioInput, AudioOutput } from "./audio.js";
import type { ClientSecret, NurClient, VoiceDesign } from "./client.js";
import { LiveContext } from "./context.js";
import { EventBus, type EventPattern, type Handler } from "./events.js";
import { CharacterMemory, Memory, type MemoryRecord, type MemoryStore, type RememberOptions } from "./memory/index.js";
import { type Player, PartyLog } from "./multiplayer.js";
import { type Preset, type PresetName } from "./presets.js";
import { type Proactive, type State, Trigger, type TriggerOptions } from "./proactive.js";
import { Room, type RoomOptions } from "./room.js";
import { Session } from "./session.js";
import type { Trace } from "./trace.js";
import { type AnyTool } from "./tools.js";
/**
 * Who decides when the character speaks.
 * - `natural` (default): Nur Live's own full-duplex floor control.
 * - `app`: the SDK asks for a reply after each finished turn, once fresh state
 *   and memories are in place. Tool use is most reliable here.
 * - `director`: the character only speaks when your code says so.
 */
export type TurnTaking = "natural" | "app" | "director";
export type Verbosity = "brief" | "normal" | "expansive";
export interface CharacterOptions {
    name: string;
    persona?: string;
    instructions?: string;
    /** A built-in voice name ("Atlas"), a voice id ("ev_…"), or `nur.voiceDesign(...)`. */
    voice?: string | VoiceDesign;
    /** One language (a code or a name) to speak, several to choose from, or none to follow the player. */
    language?: string | string[];
    /** The variety's name when a code is not enough ("Kansai Japanese"). */
    languageName?: string;
    traits?: string[];
    speakingStyle?: string;
    goals?: string | string[];
    boundaries?: string | string[];
    knowledge?: string | string[];
    /** Lines in the character's voice, for style only. */
    examples?: string[];
    /** Speak first when a session starts: true, false, or a line to say. */
    greeting?: boolean | string;
    verbosity?: Verbosity;
    tools?: Array<AnyTool>;
    /** The character's shared live state (its `world` block). */
    context?: Record<string, unknown>;
    /** true (in memory), a `Memory`, or a `MemoryStore`. Node: `fileMemory("./dir")` from `@eesi/sdk/node`. */
    memory?: boolean | Memory | MemoryStore;
    /** Keep a party log shared by every player's session. */
    party?: boolean;
    turnTaking?: TurnTaking;
    /** `deliberate` sends every request through the reasoning lane: slower, steadier with tools. */
    thinking?: "fast" | "deliberate";
    interruptible?: boolean;
    silenceMs?: number;
    /** Voice speed, 0.5 to 2. */
    speed?: number;
    /** Names and words the speech recognizer should expect. */
    hotwords?: string[];
    model?: string;
    /** A stable id; memories are keyed by it (defaults to the name in lowercase-dashes). */
    id?: string;
    preset?: PresetName | Preset;
    /** Learn players' preferences from conversations. Default true. */
    personalize?: boolean;
    /** Close the session once the character says goodbye. Default true. */
    endOnHangup?: boolean;
    outputSampleRate?: 16_000 | 24_000;
    version?: string;
    metadata?: Record<string, unknown>;
    /** Speak up after a quiet stretch: true for defaults, or settings. */
    proactive?: Proactive | boolean;
}
export interface ConnectOptions {
    /** Whose memories this session reads and writes: your id, not a name. */
    playerId?: string;
    playerName?: string;
    /** The people sharing this conversation (one microphone, or a room). */
    players?: Array<Player | string> | Record<string, string>;
    input?: AudioInput;
    output?: AudioOutput;
    /** A microphone and a speaker together, like `browserAudio()`. */
    audio?: AudioDevices;
    /** This session's starting live state (its `scene` block). */
    context?: Record<string, unknown>;
    /** true (default), "read" to recall without learning, or false. */
    memory?: boolean | "read";
    trace?: Trace;
    tools?: Array<AnyTool>;
    greeting?: boolean | string;
    /** Extra instructions for this session only. */
    instructions?: string;
    /** Pin this session to one language: a code ("ar-EG") or a name. */
    language?: string;
    /** Resume an earlier conversation: `[sessionId, resumeToken]`. */
    resume?: [string, string];
    connectTimeoutMs?: number;
}
/** A character. Make one with `nur.character()` (or `nur.npc()`, `nur.companion()`, …). */
export declare class Character {
    readonly client: NurClient;
    readonly name: string;
    readonly id: string;
    readonly persona: string;
    readonly instructions: string;
    readonly voice: string | VoiceDesign | undefined;
    readonly language: string | string[] | undefined;
    readonly languageName: string | undefined;
    readonly traits: string[];
    readonly speakingStyle: string | undefined;
    readonly goals: string[];
    readonly boundaries: string[];
    readonly knowledge: string[];
    readonly examples: string[];
    readonly greeting: boolean | string;
    readonly verbosity: Verbosity;
    readonly turnTaking: TurnTaking;
    readonly thinking: "fast" | "deliberate";
    readonly interruptible: boolean;
    readonly silenceMs: number | undefined;
    readonly speed: number | undefined;
    readonly hotwords: string[];
    readonly model: string;
    readonly preset: Preset | null;
    readonly personalize: boolean;
    readonly endOnHangup: boolean;
    readonly outputSampleRate: 16_000 | 24_000;
    readonly version: string | undefined;
    readonly metadata: Record<string, unknown>;
    readonly proactive: Proactive | null;
    tools: Array<AnyTool>;
    readonly triggers: Trigger[];
    /** The character's shared live state: its `world` block, in every session. */
    readonly context: LiveContext;
    readonly memory: CharacterMemory | null;
    readonly party: PartyLog | null;
    /** @internal */
    readonly bus: EventBus;
    /** @internal */
    readonly liveSessions: Set<Session>;
    private readonly options;
    constructor(client: NurClient, options: CharacterOptions);
    /** The character's instructions as the model receives them (before the platform's own base). */
    instructionsText(options?: {
        language?: string;
    }): string;
    /** @internal The greeting request's instructions. */
    greetingInstructions(greeting: boolean | string, options?: {
        known?: boolean;
        stranger?: boolean;
        name?: string | null;
    }): string;
    /** @internal The (code, name) a session is held to, when it is held to one. */
    pinnedLanguage(sessionLanguage?: string | null): [string | null, string] | null;
    /** @internal The `session.update` body for a session. */
    buildSessionConfig(session: {
        language: string | null;
        extraInstructions: string | null;
        playerNames: string[];
        playerName: string | null;
        toolSpecs: unknown[];
    }): Promise<Record<string, unknown>>;
    /** The `session.update` body this character sends, for clients you build yourself. */
    sessionConfig(options?: {
        playerName?: string;
        language?: string;
    }): Promise<Record<string, unknown>>;
    /** A conversation with one player (or a group), under your API key. `await session.start()`, then `close()`. */
    connect(options?: ConnectOptions): Session;
    /**
     * Steer, from your server, a session a player's client opened with `secret`
     * (minted with `clientSecret({ control: true })`). The client holds the
     * audio; this session sees everything else and acts in it: live context,
     * tools, cues, proactive remarks, memory. It becomes ready when the client
     * connects, so `connectTimeoutMs` (default ten minutes) is how long to wait.
     */
    control(secret: ClientSecret | string, options?: Omit<ConnectOptions, "input" | "output" | "audio" | "resume" | "language">): Session;
    /** Several players in one conversation with this character; see `Room`. */
    room(players: Array<Player | string>, options?: RoomOptions): Room;
    /** Live sessions of this character. */
    get sessions(): Session[];
    /** Subscribe to events from every session of this character. */
    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void;
    /** Register a tool (or several); live sessions are offered it at once. */
    tool(...tools: Array<AnyTool>): this;
    /** Have the character remark when live state turns `condition` true, in every session. */
    when(condition: (state: State) => boolean, what: string | ((state: State) => string), options?: TriggerOptions): Trigger;
    /** Keep something. Without `playerId` it is the character's world knowledge, known to every session. */
    remember(text: string, options?: RememberOptions): Promise<MemoryRecord>;
    /** A mood every session of the character shares (a session's own mood wins). */
    setMood(mood: string | null, options?: {
        reason?: string;
    }): Promise<void>;
    /** A short-lived credential that opens a session already configured as this character. See `NurClient.clientSecret`. */
    clientSecret(options?: Parameters<NurClient["clientSecret"]>[1]): Promise<ClientSecret>;
    /**
     * Learn from a call a player's client opened with a client secret.
     * `event` is the `session.ended` webhook, verified with `verifyWebhook`
     * (`@eesi/sdk/node`); its transcript is what the player and the character
     * said. What was worth keeping becomes this player's memories (under the
     * memory policy's `rules`), and their next client secret starts with it.
     */
    learnFromSession(event: {
        type: string;
        session_id?: string;
        transcript?: Array<{
            role: string;
            text: string;
        }>;
    }, options: {
        playerId: string;
        playerName?: string | null;
    }): Promise<{
        added: MemoryRecord[];
        superseded: MemoryRecord[];
        forgotten: string[];
    }>;
    /**
     * Run one of the character's tools for a call a client forwarded to your
     * server (a session opened with a client secret). Same validation,
     * `allow` and `confirm` as in a session; `ctx.session` is null.
     */
    runTool(name: string, args: string | Record<string, unknown>, options?: {
        playerId?: string | null;
        callId?: string;
    }): Promise<string>;
    /** The character as JSON-ready data. Tools are listed by name; memory is not included. */
    toJSON(): Record<string, unknown>;
    /** A new character with these options changed (a variant, a new version). Tools, triggers and memory carry over. */
    clone(changes?: Partial<CharacterOptions>): Character;
}
/** Options from a saved character (`toJSON()`), in either SDK's form. */
export declare function characterOptionsFromJSON(data: Record<string, unknown>, tools?: Array<AnyTool>): CharacterOptions;
//# sourceMappingURL=character.d.ts.map