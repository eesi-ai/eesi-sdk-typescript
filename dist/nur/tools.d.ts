import type { Character } from "./character.js";
import { type FromSchema, type ObjectSchema } from "./schema.js";
import type { Session } from "./session.js";
/** Who is asking. Every tool receives it as its second argument. */
export interface ToolContext {
    /** The session the call came from; null when your server runs a call a client forwarded. */
    session: Session | null;
    /** The character; null in a session a client joined with a client secret. */
    character: Character | null;
    playerId: string | null;
    callId: string;
    arguments: Record<string, unknown>;
}
/** Work that has begun and will finish later. The character hears `message` now and the result when `done` settles. */
export interface Started {
    readonly started: true;
    message: string;
    done: Promise<unknown>;
}
export declare function started(message: string, done: Promise<unknown>): Started;
export interface ToolDefinition<S extends ObjectSchema, A> {
    /** 1-64 letters, digits, `_` or `-`. */
    name: string;
    description: string;
    /** JSON Schema of the arguments (an object). Left out: the tool takes none. */
    parameters?: S;
    run(args: A, ctx: ToolContext): unknown;
    /** Your own validation (zod, valibot…): return the arguments or throw. Runs after the schema check. */
    validate?(args: unknown): A;
    /** Checked in code before every call. Return false or a reason to refuse. */
    allow?(ctx: ToolContext): boolean | string | Promise<boolean | string>;
    /** true: the character asks the player and calls again with `confirmed: true`. A function: your own confirmation. */
    confirm?: boolean | ((ctx: ToolContext) => boolean | Promise<boolean>);
    /** How long before the character is told the tool is still working (default 8000). */
    timeoutMs?: number;
    /** The longest the work may run after that (default 300000). */
    maxDurationMs?: number;
    /** Whether the character speaks again once the result is in. Default: unless the tool returned nothing. */
    speakAfter?: boolean;
}
declare const EMPTY: ObjectSchema;
/** A tool of any argument type, as characters and sessions hold them. */
export type AnyTool = Tool<any>;
/** A function the character can call. Make one with `tool()`. */
export declare class Tool<A = Record<string, unknown>> {
    readonly name: string;
    readonly description: string;
    readonly parameters: ObjectSchema;
    readonly definition: ToolDefinition<ObjectSchema, A>;
    constructor(definition: ToolDefinition<ObjectSchema, A>);
    spec(): {
        type: "function";
        name: string;
        description: string;
        parameters: ObjectSchema;
    };
}
/** Make a tool. Argument types come from `parameters`. */
export declare function tool<const S extends ObjectSchema = typeof EMPTY, A = FromSchema<S>>(definition: ToolDefinition<S, A>): Tool<A>;
/** A tool's return value as the text the model reads. */
export declare function renderResult(value: unknown): string;
export interface Outcome {
    output: string;
    speakAfter: boolean;
    later: Promise<unknown> | null;
}
export type ToolEvent = {
    kind: "tool.started";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
} | {
    kind: "tool.completed";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    result: unknown;
    output: string;
    duration: number;
} | {
    kind: "tool.failed";
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    reason: string;
    error: string;
};
/** One session's calls: validate, authorize, run, time out, answer once. */
export declare class ToolRunner {
    private readonly context;
    private readonly onEvent;
    readonly tools: Map<string, AnyTool>;
    readonly disabled: Set<string>;
    private seenIds;
    constructor(tools: Iterable<AnyTool>, context: (callId: string, args: Record<string, unknown>) => ToolContext, onEvent: (event: ToolEvent) => void);
    specs(): ReturnType<Tool["spec"]>[];
    /** Record `callId`; true when it was already handled (a duplicate frame). */
    seen(callId: string): boolean;
    /** Answer one call. Never throws. */
    run(callId: string, name: string, rawArguments: string): Promise<Outcome>;
    private fail;
}
export {};
//# sourceMappingURL=tools.d.ts.map