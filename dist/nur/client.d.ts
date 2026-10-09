import { EESIClient, type EESIFetch } from "../client.js";
import { Character, type CharacterOptions } from "./character.js";
import type { Logger } from "./events.js";
import { type Player } from "./multiplayer.js";
import type { Proactive } from "./proactive.js";
import { type Transport, type WebSocketFactory } from "./session.js";
import type { AnyTool } from "./tools.js";
export declare const DEFAULT_BASE_URL = "https://api.eesi.ai";
export declare const DEFAULT_MODEL = "nur-live-v1";
export interface NurClientOptions {
    /** Defaults to `EESI_API_KEY`. */
    apiKey?: string;
    /** Defaults to `EESI_API_URL`, then https://api.eesi.ai. */
    baseUrl?: string;
    /** The realtime model characters run on. */
    model?: string;
    /** The players' timezone (IANA), so the character knows the time of day. Defaults to this machine's. */
    timezone?: string | null;
    logger?: Logger;
    fetch?: EESIFetch;
    /** How to open a WebSocket, where the platform has none (`(url) => new WebSocket(url)` with the `ws` package). */
    webSocket?: WebSocketFactory;
    /**
     * An API key in a web page is readable by everyone who opens it. Mint
     * client secrets on your server instead; set this only for local tools.
     */
    dangerouslyAllowBrowser?: boolean;
}
export interface Voice {
    id: string;
    name: string;
    isBuiltin: boolean;
    status: string;
    language: string | null;
    gender: string | null;
    category: string | null;
    description: string | null;
}
/**
 * A voice described in words, created once in your organization's library
 * and reused by name. `description` uses the voice-design vocabulary
 * (`GET /v1/audio/voice-design`), e.g. "male, elderly, low pitch, british accent".
 */
export interface VoiceDesign {
    readonly name: string;
    readonly description: string;
    readonly language?: string;
}
/** What a client secret can stop the client from changing. */
export type LockName = "instructions" | "tools" | "voice" | "turn_detection" | "context" | "conversation";
export interface ClientSecretOptions {
    /** Whose memories the session starts with: your id for the player. */
    playerId?: string;
    playerName?: string;
    /** The people sharing the conversation (several on one microphone). */
    players?: Array<Player | string> | Record<string, string>;
    /** Pin the session to one language: a code ("ar-EG") or a name. */
    language?: string;
    /** The session's starting live state (its `scene` block). */
    context?: Record<string, unknown>;
    /** Extra instructions for this session only. */
    instructions?: string;
    greeting?: boolean | string;
    /** How long the secret can be redeemed, 10 to 600 seconds. Default 60. The session itself lasts as long as any. */
    expiresInSeconds?: number;
    /**
     * What the client may not change. By default the instructions and tools.
     * `"context"` makes the state you pass here final; `"conversation"` makes
     * the replies the client asks for plain and lets it add only the player's
     * own messages and tool results. `"all"` locks everything.
     */
    lock?: LockName[] | "all";
    /**
     * Open a server control channel too, and steer the session from your
     * server with `character.control(secret)`: live state, tools, cues,
     * remarks, memory, while the client only plays and records audio. Tool
     * calls are then your server's (`true` or `"server"`); `"client"` leaves them to the client.
     */
    control?: boolean | "server" | "client";
}
/**
 * Everything a player's client needs to join a session, and nothing it must
 * not have. JSON-safe: send it to the client as it is, and pass it to
 * `joinSession()` there.
 */
export interface JoinInfo {
    /** The WebSocket URL to open, as it is. It works once, until `expiresAt`. */
    url: string;
    /** Seconds since the epoch. */
    expiresAt: number;
    character: string;
    model: string;
    /** What the client does about replies: nothing (`natural`), ask after each turn (`app`), or only when its code says (`director`). */
    turnTaking: "natural" | "app" | "director";
    /** Who answers tool calls. */
    tools: "client" | "server";
    /** Your server steers this session over a control channel. */
    controlled: boolean;
    /** The greeting's instructions, when the client opens the conversation. */
    greeting: string | null;
    /** Idle remarks the client asks for, when it does. */
    proactive: Proactive | null;
    outputSampleRate: 16_000 | 24_000;
    playerId: string | null;
    playerName: string | null;
}
/** A one-use credential that opens a session already configured as a character, for a client that holds no key. */
export interface ClientSecret {
    /** The credential. Spent by the first socket that presents it. */
    value: string;
    /** The WebSocket to open as it is; it carries `value`. */
    url: string;
    /** When `value` stops opening sockets, in seconds since the epoch. */
    expiresAt: number;
    /** The session as bound: instructions, voice, tools, turn detection. */
    session: Record<string, unknown>;
    /** What the client may not change. */
    lock: LockName[];
    /** The control channel, when minted with `control`. Never give it to the client; it is no use to one. */
    controlId: string | null;
    controlTools: "server" | "client" | null;
    playerId: string | null;
    playerName: string | null;
    players: Player[];
    language: string | null;
    /** What to send the player's client. */
    join: JoinInfo;
}
/** Characters on Nur Live. */
export declare class NurClient {
    readonly baseUrl: string;
    readonly realtimeUrl: string;
    readonly model: string;
    readonly timezone: string | null;
    readonly logger: Logger;
    /** The full EESI REST API, with this client's key. */
    readonly rest: EESIClient;
    private readonly http;
    private readonly webSocket;
    private voiceCache;
    private voicesLoading;
    constructor(options?: NurClientOptions);
    /** Any character: a persona and options, or a `preset`. */
    character(options: CharacterOptions): Character;
    /** A character who lives in your game's world (preset `npc`). */
    npc(options: CharacterOptions): Character;
    /** An NPC several players talk to, keeping its story straight between them (preset `multiplayer_npc`, with a party log). */
    multiplayerNpc(options: CharacterOptions): Character;
    /** A personal companion with long memory, who checks in after a quiet stretch (preset `companion`). */
    companion(options: CharacterOptions): Character;
    /** An interactive storyteller (preset `storyteller`). */
    storyteller(options: CharacterOptions): Character;
    /** A support agent that answers only from its knowledge and tools (preset `support_agent`). */
    supportAgent(options: CharacterOptions): Character;
    /** A plain voice assistant (preset `assistant`). */
    assistant(options: CharacterOptions): Character;
    /**
     * A character saved with `character.toJSON()` (by either SDK). Functions
     * are not saved: pass its `tools` again.
     */
    loadCharacter(saved: string | Record<string, unknown>, options?: {
        tools?: Array<AnyTool>;
    } & Partial<CharacterOptions>): Character;
    /** Built-in voices and your organization's own. */
    voices(options?: {
        refresh?: boolean;
    }): Promise<Voice[]>;
    /** A voice id (`ev_…`) for a name, an id or a `VoiceDesign`. */
    resolveVoice(voice: string | VoiceDesign | undefined | null): Promise<string | null>;
    /** A described voice, created on first use and reused by name after that. */
    voiceDesign(name: string, description: string, options?: {
        language?: string;
    }): VoiceDesign;
    /**
     * Create a voice from a description, or return your voice already named
     * `name`. It is synthesized once and saved to your library like a clone,
     * so it sounds the same in every session. No person's recording is used.
     */
    designVoice(name: string, description: string, options?: {
        language?: string;
        waitMs?: number;
    }): Promise<Voice>;
    /** One completion from EESI's text model (`/v1/chat/completions`). Memory extraction uses it. */
    chat(messages: Array<{
        role: string;
        content: string;
    }>, options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        json?: boolean;
    }): Promise<string>;
    /** A one-shot WebSocket ticket (`rt_…`), for a client that configures the session itself. */
    ticket(): Promise<string>;
    /**
     * A credential that opens a session already configured as `character`,
     * for one player's browser or game client. Your server keeps the API key;
     * the client gets `secret.join` (or just `secret.url`) and nothing else.
     *
     * The session it opens has the character's instructions, voice and tools,
     * the player's memories and the context you pass, composed now. The
     * client cannot change what `lock` names. With `control`, your server
     * also steers the session: `character.control(secret)`.
     */
    clientSecret(character: Character, options?: ClientSecretOptions): Promise<ClientSecret>;
    /** @internal How a character's sessions reach the gateway. */
    transport(target: {
        kind: "owned";
        model: string;
    } | {
        kind: "control";
        controlId: string;
    }): Transport;
}
//# sourceMappingURL=client.d.ts.map