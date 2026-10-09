// Functions a character can call.
//
//     const openGate = tool({
//         name: "open_gate",
//         description: "Open one of the castle gates.",
//         parameters: {
//             type: "object",
//             properties: { gate: { type: "string", enum: ["north", "south"] } },
//             required: ["gate"],
//         },
//         run: async ({ gate }) => game.openGate(gate),   // gate: "north" | "south"
//     });
//
// The arguments the model sends are validated against `parameters` before
// `run` sees them; a bad call is answered with what was wrong, so the model
// can try again. What a tool may do is decided in code, never by its
// description: `allow` is checked before every call, `confirm` makes the
// character ask the player first (a conversational check, not an
// authorization). A tool that takes a while returns `started(...)` and the
// character keeps talking; one that runs past `timeoutMs` is reported as
// still running. Either way the result is told to the character when it lands.

import type { Character } from "./character.js";
import { clipBytes, MAX_TOOL_RESULT_BYTES } from "./protocol.js";
import { type FromSchema, type ObjectSchema, validateSchema } from "./schema.js";
import type { Session } from "./session.js";
import { ToolDefinitionError } from "./errors.js";

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

export function started(message: string, done: Promise<unknown>): Started {
    return { started: true, message, done };
}

function isStarted(value: unknown): value is Started {
    return typeof value === "object" && value !== null && (value as Started).started === true;
}

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

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const EMPTY: ObjectSchema = { type: "object", properties: {}, required: [] };

/** A tool of any argument type, as characters and sessions hold them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

/** A function the character can call. Make one with `tool()`. */
export class Tool<A = Record<string, unknown>> {
    readonly name: string;
    readonly description: string;
    readonly parameters: ObjectSchema;
    readonly definition: ToolDefinition<ObjectSchema, A>;

    constructor(definition: ToolDefinition<ObjectSchema, A>) {
        if (!NAME.test(definition.name)) {
            throw new ToolDefinitionError(`Tool name ${JSON.stringify(definition.name)} must be 1-64 letters, digits, '_' or '-'.`);
        }
        const parameters = definition.parameters ?? EMPTY;
        if (parameters.type !== "object") throw new ToolDefinitionError(`Tool ${definition.name}: parameters must be an object schema.`);
        this.name = definition.name;
        this.description = definition.description.trim() || definition.name.replace(/_/g, " ");
        this.definition = definition;
        this.parameters =
            definition.confirm === true
                ? {
                      ...parameters,
                      properties: {
                          ...(parameters.properties ?? {}),
                          confirmed: { type: "boolean", description: "true only after the player clearly agreed to this action in the conversation." },
                      },
                  }
                : parameters;
    }

    spec(): { type: "function"; name: string; description: string; parameters: ObjectSchema } {
        return { type: "function", name: this.name, description: this.description, parameters: this.parameters };
    }
}

/** Make a tool. Argument types come from `parameters`. */
export function tool<const S extends ObjectSchema = typeof EMPTY, A = FromSchema<S>>(definition: ToolDefinition<S, A>): Tool<A> {
    return new Tool(definition as unknown as ToolDefinition<ObjectSchema, A>);
}

/** A tool's return value as the text the model reads. */
export function renderResult(value: unknown): string {
    if (value === undefined || value === null) return "Done.";
    if (typeof value === "string") return value || "Done.";
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

export interface Outcome {
    output: string;
    speakAfter: boolean;
    later: Promise<unknown> | null;
}

export type ToolEvent =
    | { kind: "tool.started"; callId: string; name: string; arguments: Record<string, unknown> }
    | { kind: "tool.completed"; callId: string; name: string; arguments: Record<string, unknown>; result: unknown; output: string; duration: number }
    | { kind: "tool.failed"; callId: string; name: string; arguments: Record<string, unknown>; reason: string; error: string };

class Timeout extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Timeout()), ms);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** One session's calls: validate, authorize, run, time out, answer once. */
export class ToolRunner {
    readonly tools = new Map<string, AnyTool>();
    readonly disabled = new Set<string>();
    private seenIds = new Set<string>();

    constructor(
        tools: Iterable<AnyTool>,
        private readonly context: (callId: string, args: Record<string, unknown>) => ToolContext,
        private readonly onEvent: (event: ToolEvent) => void,
    ) {
        for (const item of tools) {
            if (this.tools.has(item.name)) throw new ToolDefinitionError(`Two tools are named ${item.name}.`);
            this.tools.set(item.name, item);
        }
    }

    specs(): ReturnType<Tool["spec"]>[] {
        return [...this.tools.values()].filter((item) => !this.disabled.has(item.name)).map((item) => item.spec());
    }

    /** Record `callId`; true when it was already handled (a duplicate frame). */
    seen(callId: string): boolean {
        if (this.seenIds.has(callId)) return true;
        this.seenIds.add(callId);
        if (this.seenIds.size > 512) this.seenIds.delete(this.seenIds.values().next().value as string);
        return false;
    }

    /** Answer one call. Never throws. */
    async run(callId: string, name: string, rawArguments: string): Promise<Outcome> {
        const startedAt = Date.now();
        let args: Record<string, unknown>;
        try {
            const parsed: unknown = rawArguments.trim() ? JSON.parse(rawArguments) : {};
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
            args = parsed as Record<string, unknown>;
        } catch {
            return this.fail(callId, name, {}, "invalid_arguments", "The arguments were not a JSON object.");
        }
        const item = this.tools.get(name);
        if (!item || this.disabled.has(name)) {
            return this.fail(callId, name, args, "unknown_tool", `No tool named ${name} is available.`);
        }
        const definition = item.definition as ToolDefinition<ObjectSchema, unknown>;
        const { confirmed, ...values } = args;
        const problems = validateSchema(definition.parameters ?? EMPTY, values);
        if (problems.length > 0) {
            return this.fail(callId, name, args, "invalid_arguments", `The arguments were not valid: ${problems.slice(0, 5).join("; ")}.`);
        }
        let typed: unknown = values;
        if (definition.validate) {
            try {
                typed = definition.validate(values);
            } catch (error) {
                return this.fail(callId, name, args, "invalid_arguments", `The arguments were not valid: ${message(error)}.`);
            }
        }
        const ctx = this.context(callId, args);
        if (definition.allow) {
            let verdict: boolean | string;
            try {
                verdict = await definition.allow(ctx);
            } catch (error) {
                verdict = `the permission check failed (${message(error)})`;
            }
            if (verdict === false || typeof verdict === "string") {
                const reason = typeof verdict === "string" ? verdict : "not permitted for this player right now";
                return this.fail(callId, name, args, "not_allowed", `Not allowed: ${reason}. Nothing was done.`);
            }
        }
        if (definition.confirm === true && confirmed !== true) {
            return this.fail(
                callId,
                name,
                args,
                "not_confirmed",
                `Nothing was done yet. Ask the player to confirm (${item.description.replace(/\.$/, "")}) and call ${name} again with confirmed=true only if they clearly agree.`,
            );
        }
        if (typeof definition.confirm === "function") {
            let approved = false;
            try {
                approved = (await within(Promise.resolve(definition.confirm(ctx)), definition.timeoutMs ?? 8_000)) === true;
            } catch {
                approved = false;
            }
            if (!approved) return this.fail(callId, name, args, "not_confirmed", "The player did not confirm. Nothing was done.");
        }
        this.onEvent({ kind: "tool.started", callId, name, arguments: args });
        const work = Promise.resolve().then(() => definition.run(typed, ctx));
        let value: unknown;
        try {
            value = await within(work, definition.timeoutMs ?? 8_000);
        } catch (error) {
            if (error instanceof Timeout) {
                const later = within(work, definition.maxDurationMs ?? 300_000);
                later.catch(() => undefined);
                return {
                    output: `${name} is still working; you will be told when it finishes. Do not claim it is done.`,
                    speakAfter: false,
                    later,
                };
            }
            return this.fail(callId, name, args, "exception", `That failed: ${message(error)}`);
        }
        const duration = (Date.now() - startedAt) / 1000;
        if (isStarted(value)) {
            const output = clipBytes(value.message || "Started.", MAX_TOOL_RESULT_BYTES);
            this.onEvent({ kind: "tool.completed", callId, name, arguments: args, result: value, output, duration });
            const later = within(value.done, definition.maxDurationMs ?? 300_000);
            later.catch(() => undefined);
            return { output, speakAfter: definition.speakAfter === true, later };
        }
        const output = clipBytes(renderResult(value), MAX_TOOL_RESULT_BYTES);
        this.onEvent({ kind: "tool.completed", callId, name, arguments: args, result: value, output, duration });
        return { output, speakAfter: definition.speakAfter ?? (value !== undefined && value !== null), later: null };
    }

    private fail(callId: string, name: string, args: Record<string, unknown>, reason: string, error: string): Outcome {
        this.onEvent({ kind: "tool.failed", callId, name, arguments: args, reason, error });
        return { output: clipBytes(error, MAX_TOOL_RESULT_BYTES), speakAfter: true, later: null };
    }
}
