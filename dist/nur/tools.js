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
import { clipBytes, MAX_TOOL_RESULT_BYTES } from "./protocol.js";
import { validateSchema } from "./schema.js";
import { ToolDefinitionError } from "./errors.js";
export function started(message, done) {
    return { started: true, message, done };
}
function isStarted(value) {
    return typeof value === "object" && value !== null && value.started === true;
}
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const EMPTY = { type: "object", properties: {}, required: [] };
/** A function the character can call. Make one with `tool()`. */
export class Tool {
    name;
    description;
    parameters;
    definition;
    constructor(definition) {
        if (!NAME.test(definition.name)) {
            throw new ToolDefinitionError(`Tool name ${JSON.stringify(definition.name)} must be 1-64 letters, digits, '_' or '-'.`);
        }
        const parameters = definition.parameters ?? EMPTY;
        if (parameters.type !== "object")
            throw new ToolDefinitionError(`Tool ${definition.name}: parameters must be an object schema.`);
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
    spec() {
        return { type: "function", name: this.name, description: this.description, parameters: this.parameters };
    }
}
/** Make a tool. Argument types come from `parameters`. */
export function tool(definition) {
    return new Tool(definition);
}
/** A tool's return value as the text the model reads. */
export function renderResult(value) {
    if (value === undefined || value === null)
        return "Done.";
    if (typeof value === "string")
        return value || "Done.";
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
class Timeout extends Error {
}
function within(work, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Timeout()), ms);
        work.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
/** One session's calls: validate, authorize, run, time out, answer once. */
export class ToolRunner {
    context;
    onEvent;
    tools = new Map();
    disabled = new Set();
    seenIds = new Set();
    constructor(tools, context, onEvent) {
        this.context = context;
        this.onEvent = onEvent;
        for (const item of tools) {
            if (this.tools.has(item.name))
                throw new ToolDefinitionError(`Two tools are named ${item.name}.`);
            this.tools.set(item.name, item);
        }
    }
    specs() {
        return [...this.tools.values()].filter((item) => !this.disabled.has(item.name)).map((item) => item.spec());
    }
    /** Record `callId`; true when it was already handled (a duplicate frame). */
    seen(callId) {
        if (this.seenIds.has(callId))
            return true;
        this.seenIds.add(callId);
        if (this.seenIds.size > 512)
            this.seenIds.delete(this.seenIds.values().next().value);
        return false;
    }
    /** Answer one call. Never throws. */
    async run(callId, name, rawArguments) {
        const startedAt = Date.now();
        let args;
        try {
            const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
                throw new Error();
            args = parsed;
        }
        catch {
            return this.fail(callId, name, {}, "invalid_arguments", "The arguments were not a JSON object.");
        }
        const item = this.tools.get(name);
        if (!item || this.disabled.has(name)) {
            return this.fail(callId, name, args, "unknown_tool", `No tool named ${name} is available.`);
        }
        const definition = item.definition;
        const { confirmed, ...values } = args;
        const problems = validateSchema(definition.parameters ?? EMPTY, values);
        if (problems.length > 0) {
            return this.fail(callId, name, args, "invalid_arguments", `The arguments were not valid: ${problems.slice(0, 5).join("; ")}.`);
        }
        let typed = values;
        if (definition.validate) {
            try {
                typed = definition.validate(values);
            }
            catch (error) {
                return this.fail(callId, name, args, "invalid_arguments", `The arguments were not valid: ${message(error)}.`);
            }
        }
        const ctx = this.context(callId, args);
        if (definition.allow) {
            let verdict;
            try {
                verdict = await definition.allow(ctx);
            }
            catch (error) {
                verdict = `the permission check failed (${message(error)})`;
            }
            if (verdict === false || typeof verdict === "string") {
                const reason = typeof verdict === "string" ? verdict : "not permitted for this player right now";
                return this.fail(callId, name, args, "not_allowed", `Not allowed: ${reason}. Nothing was done.`);
            }
        }
        if (definition.confirm === true && confirmed !== true) {
            return this.fail(callId, name, args, "not_confirmed", `Nothing was done yet. Ask the player to confirm (${item.description.replace(/\.$/, "")}) and call ${name} again with confirmed=true only if they clearly agree.`);
        }
        if (typeof definition.confirm === "function") {
            let approved = false;
            try {
                approved = (await within(Promise.resolve(definition.confirm(ctx)), definition.timeoutMs ?? 8_000)) === true;
            }
            catch {
                approved = false;
            }
            if (!approved)
                return this.fail(callId, name, args, "not_confirmed", "The player did not confirm. Nothing was done.");
        }
        this.onEvent({ kind: "tool.started", callId, name, arguments: args });
        const work = Promise.resolve().then(() => definition.run(typed, ctx));
        let value;
        try {
            value = await within(work, definition.timeoutMs ?? 8_000);
        }
        catch (error) {
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
    fail(callId, name, args, reason, error) {
        this.onEvent({ kind: "tool.failed", callId, name, arguments: args, reason, error });
        return { output: clipBytes(error, MAX_TOOL_RESULT_BYTES), speakAfter: true, later: null };
    }
}
//# sourceMappingURL=tools.js.map