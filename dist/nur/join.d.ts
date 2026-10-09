import type { AudioDevices, AudioInput, AudioOutput } from "./audio.js";
import { type JoinInfo } from "./client.js";
import { type Logger } from "./events.js";
import { Session, type ToolCall, type WebSocketFactory } from "./session.js";
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
/**
 * Open the session a client secret prepared, and resolve once the character
 * is ready. A secret works once: when the connection is lost, ask your
 * server for a new one and join again.
 */
export declare function joinSession(join: JoinInfo | string, options?: JoinOptions): Promise<Session>;
/**
 * An `onToolCall` that asks your server: each call is POSTed as JSON
 * (`{ name, arguments, callId, playerId }`) to `url`, and the reply's text is
 * what the character is told. On the server, run it with
 * `character.runTool(call.name, call.arguments, { playerId })`, taking the
 * player from your own authentication, never from the request body.
 */
export declare function forwardTools(url: string, init?: {
    headers?: Record<string, string>;
    credentials?: "omit" | "same-origin" | "include";
}): (call: ToolCall) => Promise<string>;
//# sourceMappingURL=join.d.ts.map