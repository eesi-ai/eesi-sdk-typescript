// What a session heard, remembered, decided, said and did, on one timeline.
//
//     const trace = new Trace((line) => log.write(line + "\n"));   // Node: fileTrace("./traces/kael.jsonl")
//     const session = kael.connect({ playerId: "p42", trace });
//     ...
//     console.log(formatTrace(trace.lines));
//
// Each line is one JSON object with `t` (seconds since the session started)
// and `kind`, in the same form the Python SDK writes, so either SDK's tools
// read either's traces. By default a trace holds no words: transcripts,
// replies, tool arguments and results and memory texts are replaced by their
// length, so a trace can be kept and shared without keeping what people
// said. Pass `{ content: true }` to record the words while you debug.
//
// Latency here is measured at the client: from the end of the player's turn
// to the first audio of the reply reaching the SDK. It does not include the
// speaker's own buffering.
const CONTENT_FIELDS = new Set(["text", "arguments", "result", "output", "disclosure", "error", "message", "query"]);
const STAMP_FIELDS = new Set(["at", "sessionId", "playerId", "type"]);
function snake(name) {
    return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function redact(value) {
    if (typeof value === "string")
        return { chars: value.length };
    if (value && typeof value === "object" && !Array.isArray(value))
        return { keys: Object.keys(value).sort() };
    return { redacted: true };
}
/** A field's value as written: audio as its size, everything else as it is (your tool arguments keep their own keys). */
function plain(value) {
    return value instanceof Uint8Array ? { bytes: value.byteLength } : value;
}
function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
/** A JSONL timeline of one session. `lines` keeps the latest 5000. */
export class Trace {
    sink;
    options;
    content;
    lines = [];
    t0 = now();
    constructor(sink = null, options = {}) {
        this.sink = sink;
        this.options = options;
        this.content = options.content ?? false;
    }
    open() {
        this.t0 = now();
        this.write("trace.start", { wall: Date.now() / 1000, content: this.content });
    }
    write(kind, data = {}) {
        const line = { t: Math.round(now() - this.t0) / 1000, kind };
        for (const [key, value] of Object.entries(data))
            line[snake(key)] = plain(value);
        this.lines.push(line);
        if (this.lines.length > 5_000)
            this.lines.splice(0, 1_000);
        try {
            this.sink?.(JSON.stringify(line));
        }
        catch {
            // A trace never breaks a session.
        }
    }
    event(event) {
        if (event.type === "audio.output.chunk")
            return;
        const data = {};
        for (const [key, value] of Object.entries(event)) {
            if (STAMP_FIELDS.has(key))
                continue;
            if (key === "records") {
                data.records = value.map((record) => ({
                    id: record.id,
                    kind: record.kind,
                    player: Boolean(record.playerId),
                    ...(this.content ? { text: record.text } : {}),
                }));
            }
            else if (key === "added" || key === "updated") {
                data[key] = value.map((record) => ({ id: record.id, kind: record.kind, ...(this.content ? { text: record.text } : {}) }));
            }
            else if (key === "turns") {
                data.turns = value.map((turn) => ({
                    speaker: turn.speaker,
                    player: turn.playerId,
                    ...(this.content ? { text: turn.text } : { chars: turn.text.length }),
                }));
            }
            else if (CONTENT_FIELDS.has(key) && !this.content && value !== null && value !== undefined && value !== "" && !(typeof value === "object" && Object.keys(value).length === 0)) {
                data[key] = redact(value);
            }
            else {
                data[key] = value;
            }
        }
        this.write(event.type, data);
    }
    close() {
        this.options.onClose?.();
    }
}
function who(turn) {
    if (turn.player)
        return String(turn.player);
    if (turn.speaker)
        return `Speaker ${turn.speaker}`;
    return "player";
}
function pad(text, width) {
    return text.length >= width ? text : text + " ".repeat(width - text.length);
}
/** A trace as a readable timeline. */
export function formatTrace(lines) {
    const out = [];
    for (const line of lines) {
        const t = `${Number(line.t ?? 0).toFixed(2).padStart(8)}s`;
        const kind = String(line.kind ?? "");
        const text = line.text;
        const words = typeof text === "string" ? text : "";
        const rest = Object.fromEntries(Object.entries(line).filter(([key]) => key !== "t" && key !== "kind"));
        switch (kind) {
            case "transcript.final": {
                const turns = line.turns ?? [];
                const heard = turns.map((turn) => `${who(turn)}: ${typeof turn.text === "string" ? turn.text : "…"}`).join(" / ") || words || "…";
                out.push(`${t}  heard     ${heard}`);
                break;
            }
            case "response.completed": {
                if (!words && !(text && typeof text === "object"))
                    break; // A reply that was only tool calls.
                const latency = typeof line.latency === "number" ? ` (${line.latency.toFixed(2)}s)` : "";
                out.push(`${t}  said${pad(latency, 9)} ${words || "…"}`);
                break;
            }
            case "response.cancelled":
                out.push(`${t}  cut off   ${words || "…"} [${String(line.reason)}]`);
                break;
            case "speech.interrupted":
                out.push(`${t}  interrupted by the player`);
                break;
            case "tool.completed":
            case "tool.failed": {
                const output = kind === "tool.completed" ? line.output : line.error;
                const args = line.arguments;
                const shown = args && typeof args === "object" && !("keys" in args) ? JSON.stringify(args) : "…";
                out.push(`${t}  ${pad(kind === "tool.completed" ? "tool" : "tool ✗", 9)} ${String(line.name)}(${shown}) → ${typeof output === "string" ? output : "…"}`);
                break;
            }
            case "context.updated": {
                const size = text && typeof text === "object" ? Number(text.chars ?? 0) : words.length;
                out.push(`${t}  context   [${String(line.block)}] ${words ? words.replace(/\n/g, " | ") : `(${size} chars)`}`);
                break;
            }
            case "memory.retrieved": {
                const records = line.records ?? [];
                out.push(`${t}  recalled  ${records.length} memories${records.slice(0, 6).map((record) => `\n${" ".repeat(12)}- ${String(record.text ?? record.id)}`).join("")}`);
                break;
            }
            case "memory.updated": {
                const added = line.added ?? [];
                out.push(`${t}  learned   ${added.length} memories${added.slice(0, 8).map((record) => `\n${" ".repeat(12)}+ ${String(record.text ?? record.id)}`).join("")}`);
                break;
            }
            case "session.started":
            case "session.ended":
            case "reconnecting":
            case "reconnected":
            case "session.hangup":
            case "error":
                out.push(`${t}  ${pad(kind, 9)} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}`);
                break;
            case "metrics":
                out.push(`${t}  metrics   ${JSON.stringify(rest)}`);
                break;
            default:
                break;
        }
    }
    return out.join("\n");
}
//# sourceMappingURL=trace.js.map