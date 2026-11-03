import type { MemoryRecord } from "./memory/records.js";
export interface EventBase {
    /** Seconds since the session started. */
    at: number;
    sessionId: string | null;
    playerId: string | null;
}
/** One person's part of a transcript several voices share. */
export interface SpeakerTurn {
    text: string;
    /** `Speaker N` as tagged; null for an unlabelled or explicitly unknown voice. */
    speaker: number | null;
    /** The player the SDK attributes it to, when it knows. */
    playerId: string | null;
    /** Explicit unknown attribution; never an ordinary unlabelled solo turn. */
    unattributed?: true;
}
export interface SessionStarted extends EventBase {
    type: "session.started";
    model: string;
    /** Whether this session continues an earlier one. */
    resumed: boolean;
    /** Whether the organization records this session; show `disclosure` to people when it does. */
    recorded: boolean;
    disclosure: string | null;
}
export interface SessionEnded extends EventBase {
    type: "session.ended";
    /** `closed`, `hangup`, `limit`, `ended`, `connection_lost` or `server_closed`. */
    reason: string;
    code: number | null;
    message: string | null;
}
export interface AudioInputStarted extends EventBase {
    type: "audio.input.started";
    /** The character was speaking at the time. */
    whileSpeaking: boolean;
    /** Where the speech starts in the audio sent so far, in ms, when the server says. */
    audioStartMs: number | null;
}
export interface AudioInputEnded extends EventBase {
    type: "audio.input.ended";
    audioEndMs: number | null;
}
export interface TranscriptPartial extends EventBase {
    type: "transcript.partial";
    /** What the player is saying so far. Each one replaces the last. */
    text: string;
    itemId: string | null;
}
export interface TranscriptFinal extends EventBase {
    type: "transcript.final";
    text: string;
    itemId: string | null;
    turns: SpeakerTurn[];
}
export interface ResponseStarted extends EventBase {
    type: "response.started";
    responseId: string;
}
/** A receipt of serialized text-model input, when the server provides one.
 * It proves input coverage, never comprehension, task completion or heard audio.
 */
export interface ResponseContext extends EventBase {
    type: "response.context";
    responseId: string;
    receiptId: string;
    inputSha256: string;
    providerFormat: "chat_completions" | "responses";
    model: string;
    itemCount: number;
    coverage: "serialized_provider_input";
    turnId: string | null;
    turnRevision: number | null;
}
export interface ResponseTextDelta extends EventBase {
    type: "response.text.delta";
    responseId: string;
    text: string;
}
export interface ResponseCompleted extends EventBase {
    type: "response.completed";
    responseId: string;
    text: string;
    /** Seconds from the end of the player's turn to the first audio of this reply, when measured. */
    latency: number | null;
}
export interface ResponseCancelled extends EventBase {
    type: "response.cancelled";
    responseId: string;
    reason: string | null;
    /** What was generated before the cut; the player may have heard less. */
    text: string;
}
export interface AudioOutputChunk extends EventBase {
    type: "audio.output.chunk";
    responseId: string;
    /** 16-bit little-endian mono PCM. */
    pcm: Uint8Array;
    sampleRate: number;
}
export interface SpeechInterrupted extends EventBase {
    type: "speech.interrupted";
    responseId: string | null;
}
export interface MemoryRetrieved extends EventBase {
    type: "memory.retrieved";
    query: string | null;
    records: MemoryRecord[];
}
export interface MemoryUpdated extends EventBase {
    type: "memory.updated";
    added: MemoryRecord[];
    updated: MemoryRecord[];
    removed: string[];
    /** `app`, `player`, `extraction` or `correction`. */
    source: string;
}
export interface ContextUpdated extends EventBase {
    type: "context.updated";
    block: string;
    /** The block's text as the model now reads it; empty when removed. */
    text: string;
}
export interface ToolStarted extends EventBase {
    type: "tool.started";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface ToolCompleted extends EventBase {
    type: "tool.completed";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    /** What the function returned. */
    result: unknown;
    /** What the character was told. */
    output: string;
    duration: number;
}
export interface ToolFailed extends EventBase {
    type: "tool.failed";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    /** `exception`, `invalid_arguments`, `unknown_tool`, `not_allowed`, `not_confirmed` or `timeout`. */
    reason: string;
    error: string;
}
export interface ErrorEvent extends EventBase {
    type: "error";
    message: string;
    code: string | null;
}
export interface Reconnecting extends EventBase {
    type: "reconnecting";
    attempt: number;
    delay: number;
    code: number | null;
}
export interface Reconnected extends EventBase {
    type: "reconnected";
    /** Whether the conversation was resumed; false means a fresh one began. */
    resumed: boolean;
}
export interface Hangup extends EventBase {
    type: "session.hangup";
    reason: string;
}
export interface Feedback extends EventBase {
    type: "feedback";
    rating: number | string;
    note: string | null;
    responseId: string | null;
}
/** EESI listed a remote MCP server's tools; the character can use them now. */
export interface McpToolsListed extends EventBase {
    type: "mcp.tools.listed";
    serverLabel: string;
    /** The tools the character was offered, by the server's own names. */
    tools: string[];
}
/** A remote MCP server could not be listed; the character goes on without it. */
export interface McpToolsFailed extends EventBase {
    type: "mcp.tools.failed";
    serverLabel: string;
    /** `not_public`, `unreachable`, `unauthorized`, `timeout`, `http_error`, `protocol_error` or `redirect`. */
    code: string;
    message: string;
}
/** The character called a remote MCP tool; EESI is running it. */
export interface McpCallStarted extends EventBase {
    type: "mcp.call.started";
    itemId: string;
    serverLabel: string;
    name: string;
    /** The arguments, as JSON text. */
    arguments: string;
}
export interface McpCallCompleted extends EventBase {
    type: "mcp.call.completed";
    itemId: string;
    serverLabel: string;
    name: string;
    arguments: string;
    /** What the server returned, as the character read it. */
    output: string;
}
export interface McpCallFailed extends EventBase {
    type: "mcp.call.failed";
    itemId: string;
    serverLabel: string;
    name: string;
    arguments: string;
    /** `http_error`, `protocol_error` or `tool_execution_error`. */
    kind: string;
    error: string;
}
/** A tool that changes things waits for the player's yes. The character asks out loud; a button answers with `session.approveMcp(requestId)`. */
export interface McpApprovalRequested extends EventBase {
    type: "mcp.approval.requested";
    requestId: string;
    serverLabel: string;
    name: string;
    arguments: string;
}
export type NurEvent = SessionStarted | SessionEnded | AudioInputStarted | AudioInputEnded | TranscriptPartial | TranscriptFinal | ResponseStarted | ResponseContext | ResponseTextDelta | ResponseCompleted | ResponseCancelled | AudioOutputChunk | SpeechInterrupted | MemoryRetrieved | MemoryUpdated | ContextUpdated | ToolStarted | ToolCompleted | ToolFailed | ErrorEvent | Reconnecting | Reconnected | Hangup | Feedback | McpToolsListed | McpToolsFailed | McpCallStarted | McpCallCompleted | McpCallFailed | McpApprovalRequested;
export type NurEventType = NurEvent["type"];
/** An exact event type, a family (`"tool.*"`) or everything (`"*"`). */
export type EventPattern = NurEventType | "*" | `${string}.*`;
export type EventOf<T extends string> = T extends NurEventType ? Extract<NurEvent, {
    type: T;
}> : NurEvent;
export type Handler<T extends string = string> = (event: EventOf<T>) => unknown;
/** Event fields without the stamp the session adds. */
export type EventInit<E extends NurEvent> = Omit<E, keyof EventBase>;
/** Any one event's fields, without the stamp (which it may still override). */
export type AnyEventInit = NurEvent extends infer E ? (E extends NurEvent ? Omit<E, keyof EventBase> & Partial<EventBase> : never) : never;
export interface Logger {
    debug?(message: string, ...rest: unknown[]): void;
    warn(message: string, ...rest: unknown[]): void;
    error(message: string, ...rest: unknown[]): void;
}
/** Fan-out of events to callbacks, waiters and async iterators. */
export declare class EventBus {
    private readonly logger;
    private readonly parent;
    private handlers;
    private streams;
    constructor(logger?: Logger, parent?: EventBus | null);
    /** Call `handler` for events matching `pattern`. Returns a function that unsubscribes. */
    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void;
    off(handler: Handler): void;
    /** Deliver an event now. Never throws; never waits on a handler. */
    emit(event: NurEvent): void;
    /** The next event matching `pattern` (and `predicate`), or a rejection after `timeoutMs`. */
    wait<T extends EventPattern>(pattern: T, options?: {
        timeoutMs?: number;
        predicate?: (event: EventOf<T>) => boolean;
    }): Promise<EventOf<T>>;
    /** Events from now until `close()`. */
    stream(options?: {
        includeAudio?: boolean;
    }): AsyncIterableIterator<NurEvent>;
    /** End every `stream()`. */
    close(): void;
}
//# sourceMappingURL=events.d.ts.map