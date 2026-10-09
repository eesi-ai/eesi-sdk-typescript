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
import { DEFAULT_MODEL } from "./client.js";
import { LiveContext } from "./context.js";
import { ConfigurationError } from "./errors.js";
import { EventBus } from "./events.js";
import { defaultWebSocket, Session } from "./session.js";
const DEFAULT_GREETING = "Open the conversation: greet the person who just came up to you in one short sentence, in character.";
/** The character as a joined client knows it: what the server's join says, nothing more. */
class JoinedCharacter {
    name;
    model;
    turnTaking;
    endOnHangup = true;
    personalize = false;
    outputSampleRate;
    greeting;
    proactive;
    triggers = [];
    tools = [];
    context = new LiveContext("world");
    memory = null;
    party = null;
    bus;
    liveSessions = new Set();
    constructor(join, greeting, logger) {
        this.name = join.character;
        this.model = join.model;
        this.turnTaking = join.turnTaking;
        this.outputSampleRate = join.outputSampleRate;
        this.greeting = greeting === false ? false : typeof greeting === "string" ? greeting : (join.greeting ?? false);
        this.proactive = join.proactive;
        this.bus = new EventBus(logger);
    }
    greetingInstructions(greeting) {
        return typeof greeting === "string" ? greeting : DEFAULT_GREETING;
    }
}
function asJoin(join) {
    if (typeof join !== "string") {
        if (!join || typeof join.url !== "string")
            throw new ConfigurationError("joinSession needs the join your server sent (secret.join), or its url.");
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
export async function joinSession(join, options = {}) {
    const info = asJoin(join);
    const logger = options.logger ?? { warn: (...args) => console.warn("[eesi]", ...args), error: (...args) => console.error("[eesi]", ...args) };
    const webSocket = options.webSocket ?? defaultWebSocket();
    const host = new JoinedCharacter(info, options.greeting, logger);
    const session = new Session(host, {
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
    }, { kind: "joined", url: async () => info.url, webSocket, logger });
    return session.start();
}
/**
 * An `onToolCall` that asks your server: each call is POSTed as JSON
 * (`{ name, arguments, callId, playerId }`) to `url`, and the reply's text is
 * what the character is told. On the server, run it with
 * `character.runTool(call.name, call.arguments, { playerId })`, taking the
 * player from your own authentication, never from the request body.
 */
export function forwardTools(url, init = {}) {
    return async (call) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...init.headers },
            credentials: init.credentials ?? "same-origin",
            body: JSON.stringify(call),
        });
        if (!response.ok)
            throw new Error(`${url} answered ${response.status}`);
        return response.text();
    };
}
//# sourceMappingURL=join.js.map