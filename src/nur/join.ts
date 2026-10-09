// A browser or game client joining a session its server prepared.
//
// The server keeps the API key and mints a client secret for the player:
//
//     const secret = await kael.clientSecret({ playerId: user.id, playerName: user.name, control: true });
//     res.json(secret.join);                       // to the player's client
//     const session = await kael.control(secret).start();   // and steer it from here
//
// The client holds no key. It opens the session with what the server sent,
// streams the microphone and plays the character, straight to EESI:
//
//     import { joinSession } from "@eesi/sdk";
//     import { browserAudio } from "@eesi/sdk/browser";
//
//     const join = await (await fetch("/api/nur/join")).json();
//     const session = await joinSession(join, { audio: await browserAudio() });
//
// The session it opens is already the character, with the player's memories
// and the state the server composed; the client cannot change what the
// secret locks. Tool calls go wherever the secret says: to the server's
// control channel, or to this client's `tools` and `onToolCall`.

import type { AudioDevices, AudioInput, AudioOutput } from "./audio.js";
import { DEFAULT_MODEL, type JoinInfo } from "./client.js";
import { LiveContext } from "./context.js";
import { ConfigurationError } from "./errors.js";
import { EventBus, type Logger } from "./events.js";
import type { Proactive, Trigger } from "./proactive.js";
import { defaultWebSocket, Session, type SessionHost, type ToolCall, type WebSocketFactory } from "./session.js";
import type { AnyTool } from "./tools.js";
import type { Trace } from "./trace.js";

export interface JoinOptions {
    input?: AudioInput;
    output?: AudioOutput;
    /** A microphone and a speaker together, like `browserAudio()`. */
    audio?: AudioDevices;
    /** Tools this client answers itself, when the session's tools are the client's. */
    tools?: Array<AnyTool>;
    /**
     * Answer a call no local tool does: usually by asking your server, which
     * runs `character.runTool(name, args, { playerId })` and returns its text.
     */
    onToolCall?: (call: ToolCall) => unknown;
    /** This session's own live state (its `scene` block), unless the secret locked context. */
    context?: Record<string, unknown>;
    /** The greeting's instructions: `false` keeps the client quiet; a string replaces the server's. */
    greeting?: boolean | string;
    trace?: Trace;
    webSocket?: WebSocketFactory;
    logger?: Logger;
    connectTimeoutMs?: number;
}

const DEFAULT_GREETING = "Open the conversation: greet the person who just came up to you in one short sentence, in character.";

/** The character as a joined client knows it: what the server's join says, nothing more. */
class JoinedCharacter implements SessionHost {
    readonly name: string;
    readonly model: string;
    readonly turnTaking: "natural" | "app" | "director";
    readonly endOnHangup = true;
    readonly personalize = false;
    readonly outputSampleRate: 16_000 | 24_000;
    readonly greeting: boolean | string;
    readonly proactive: Proactive | null;
    readonly triggers: Trigger[] = [];
    readonly tools: Array<AnyTool> = [];
    readonly context = new LiveContext("world");
    readonly memory = null;
    readonly party = null;
    readonly bus: EventBus;
    readonly liveSessions = new Set<Session>();

    constructor(join: JoinInfo, greeting: boolean | string | undefined, logger: Logger) {
        this.name = join.character;
        this.model = join.model;
        this.turnTaking = join.turnTaking;
        this.outputSampleRate = join.outputSampleRate;
        this.greeting = greeting === false ? false : typeof greeting === "string" ? greeting : (join.greeting ?? false);
        this.proactive = join.proactive;
        this.bus = new EventBus(logger);
    }

    greetingInstructions(greeting: boolean | string): string {
        return typeof greeting === "string" ? greeting : DEFAULT_GREETING;
    }
}

function asJoin(join: JoinInfo | string): JoinInfo {
    if (typeof join !== "string") {
        if (!join || typeof join.url !== "string") throw new ConfigurationError("joinSession needs the join your server sent (secret.join), or its url.");
        return join;
    }
    return {
        url: join,
        token: new URL(join).searchParams.get("token") ?? "",
        callsUrl: "",
        expiresAt: 0,
        character: "Character",
        model: DEFAULT_MODEL,
        turnTaking: "natural",
        tools: "client",
        controlled: false,
        greeting: null,
        proactive: null,
        outputSampleRate: 24_000,
        playerId: null,
        playerName: null,
    };
}

/**
 * Open the session a client secret prepared, and resolve once the character
 * is ready. A secret works once: when the connection is lost, ask your
 * server for a new one and join again.
 */
export async function joinSession(join: JoinInfo | string, options: JoinOptions = {}): Promise<Session> {
    const info = asJoin(join);
    const logger: Logger = options.logger ?? { warn: (...args) => console.warn("[eesi]", ...args), error: (...args) => console.error("[eesi]", ...args) };
    const webSocket = options.webSocket ?? defaultWebSocket();
    const host = new JoinedCharacter(info, options.greeting, logger);
    const session = new Session(
        host,
        {
            playerId: info.playerId ?? undefined,
            playerName: info.playerName ?? undefined,
            input: options.input,
            output: options.output,
            audio: options.audio,
            tools: info.tools === "client" ? options.tools : [],
            onToolCall: info.tools === "client" ? options.onToolCall : undefined,
            context: options.context,
            trace: options.trace,
            connectTimeoutMs: options.connectTimeoutMs,
        },
        { kind: "joined", url: async () => info.url, webSocket, logger },
    );
    return session.start();
}

/**
 * An `onToolCall` that asks your server: each call is POSTed as JSON
 * (`{ name, arguments, callId, playerId }`) to `url`, and the reply's text is
 * what the character is told. On the server, run it with
 * `character.runTool(call.name, call.arguments, { playerId })`, taking the
 * player from your own authentication, never from the request body.
 */
export function forwardTools(url: string, init: { headers?: Record<string, string>; credentials?: "omit" | "same-origin" | "include" } = {}): (call: ToolCall) => Promise<string> {
    return async (call) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...init.headers },
            credentials: init.credentials ?? "same-origin",
            body: JSON.stringify(call),
        });
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return response.text();
    };
}

