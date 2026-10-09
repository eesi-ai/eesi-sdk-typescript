// The wire: client events the SDK sends and the server events it reads.
//
// Nur Live speaks the OpenAI Realtime protocol plus a few `eesi.*` events
// (https://docs.eesi.ai/realtime/live). Builders return plain objects so a
// trace shows exactly what went out. Server event names have aliases across
// protocol versions; `canonicalType` collapses them to one name.
/** The gateway's native input rate: 16-bit mono PCM unless the session says otherwise. */
export const INPUT_SAMPLE_RATE = 16_000;
/** The rate the SDK asks the character's voice at. 16 kHz is also accepted. */
export const OUTPUT_SAMPLE_RATE = 24_000;
/** Limits the gateway enforces on context blocks, tool results and instructions. */
export const MAX_CONTEXT_KEYS = 8;
export const MAX_CONTEXT_BLOCK_BYTES = 8_000;
export const MAX_CONTEXT_TOTAL_BYTES = 24_000;
export const MAX_TOOL_RESULT_BYTES = 16_000;
export const MAX_INSTRUCTIONS_BYTES = 64_000;
export const CONTEXT_KEY = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const ALIASES = {
    "response.audio.delta": "response.output_audio.delta",
    "response.audio.done": "response.output_audio.done",
    "response.audio_transcript.delta": "response.output_audio_transcript.delta",
    "response.audio_transcript.done": "response.output_audio_transcript.done",
    "response.text.delta": "response.output_text.delta",
    "response.text.done": "response.output_text.done",
};
/** One name per server event, whichever protocol version sent it. */
export function canonicalType(kind) {
    return ALIASES[kind] ?? kind;
}
export function eventId() {
    return `evt_${randomHex(20)}`;
}
/**
 * Random bytes for ids (events, items, memories), never for secrets. Web
 * Crypto where the platform has it; Node 18 does not expose it to modules.
 */
export function randomBytes(length) {
    const bytes = new Uint8Array(length);
    const webCrypto = globalThis.crypto;
    if (webCrypto?.getRandomValues)
        webCrypto.getRandomValues(bytes);
    else
        for (let index = 0; index < length; index += 1)
            bytes[index] = Math.floor(Math.random() * 256);
    return bytes;
}
export function randomHex(length) {
    const bytes = randomBytes(Math.ceil(length / 2));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}
// ── client events ────────────────────────────────────────────────────────
export function sessionUpdate(session) {
    return { type: "session.update", session: { type: "realtime", ...session } };
}
export function contextUpdate(key, text) {
    return { type: "eesi.context.update", key, text };
}
export function appendAudio(base64) {
    return { type: "input_audio_buffer.append", audio: base64 };
}
export function userText(text, itemId) {
    const item = { type: "message", role: "user", content: [{ type: "input_text", text }] };
    if (itemId)
        item.id = itemId;
    return { type: "conversation.item.create", item };
}
export function toolOutput(callId, output) {
    return { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } };
}
/**
 * A reply. `instructions` steer this one reply; the character still stands,
 * because the gateway composes them after the session's own instructions.
 */
export function responseCreate(options = {}) {
    const response = { ...(options.extra ?? {}) };
    if (options.instructions)
        response.instructions = options.instructions;
    if (options.toolChoice)
        response.tool_choice = options.toolChoice;
    if (options.input)
        response.input = options.input;
    const event = { type: "response.create", event_id: eventId() };
    if (Object.keys(response).length > 0)
        event.response = response;
    return event;
}
/**
 * A reply to something that happened in the application. The event joins
 * the conversation as its newest turn, labelled as the application's; with it
 * only in the instructions, the model often answered the player's previous
 * question again instead of reacting to the event.
 */
export function eventReply(event, instructions) {
    return responseCreate({
        instructions,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `[Game event, not the player speaking] ${event}` }] }],
    });
}
export function responseCancel() {
    return { type: "response.cancel" };
}
export function keepalive() {
    return { type: "eesi.keepalive" };
}
/** What the speaker has played, so a cut keeps only what was heard. An estimate, never proof. */
export function outputStatus(status) {
    const active = status.bufferedMs > 0;
    return {
        type: "eesi.output.status",
        active,
        available: true,
        buffered_ms: status.bufferedMs,
        playback: status.responseId
            ? {
                response_id: status.responseId,
                sample_rate: status.sampleRate,
                received_samples: status.received,
                rendered_samples: status.rendered,
                discarded_samples: status.discarded,
                flushed: status.flushed,
                clock_running: active,
                muted: false,
            }
            : null,
    };
}
// ── server events ────────────────────────────────────────────────────────
export function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
export function str(value) {
    return typeof value === "string" ? value : "";
}
export function responseIdOf(event) {
    const response = record(event.response);
    return str(response.id) || str(event.response_id);
}
export function errorOf(event) {
    const error = record(event.error);
    return { message: str(error.message) || "Unknown realtime error", code: str(error.code) || str(error.type) || null };
}
export function responseStatus(event) {
    const response = record(event.response);
    const details = record(response.status_details);
    return { status: str(response.status) || null, reason: str(details.reason) || null };
}
const SPEAKER_LINE = /^\s*speaker\s+(\d+)\s*:\s*(.*)$/i;
/**
 * `Speaker N:` tagged lines back into `{speaker, text}` runs. An untagged
 * line continues whoever spoke last; a transcript with no tags is one
 * unattributed turn. Nur Live tags lines once a session has heard a second voice.
 */
export function splitSpeakerTurns(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const lines = trimmed.split("\n");
    const speakerOf = (line) => {
        const match = SPEAKER_LINE.exec(line);
        if (!match)
            return null;
        const n = Number(match[1]);
        return Number.isSafeInteger(n) && n >= 1 ? n : null;
    };
    if (!lines.some((line) => speakerOf(line) !== null))
        return [{ speaker: null, text: trimmed }];
    const turns = [];
    for (const line of lines) {
        const speaker = speakerOf(line);
        const match = SPEAKER_LINE.exec(line);
        if (speaker !== null && match) {
            const body = (match[2] ?? "").trim();
            const last = turns[turns.length - 1];
            if (last && last.speaker === speaker)
                last.text = `${last.text} ${body}`.trim();
            else
                turns.push({ speaker, text: body });
            continue;
        }
        const body = line.trim();
        if (!body)
            continue;
        const last = turns[turns.length - 1];
        if (last)
            last.text = `${last.text} ${body}`.trim();
        else
            turns.push({ speaker: null, text: body });
    }
    return turns.filter((turn) => turn.text);
}
const encoder = new TextEncoder();
export function byteLength(text) {
    return encoder.encode(text).length;
}
/** `text` cut to at most `limit` UTF-8 bytes on a character boundary, marked with an ellipsis. */
export function clipBytes(text, limit) {
    if (byteLength(text) <= limit)
        return text;
    let end = Math.min(text.length, limit);
    while (end > 0 && byteLength(text.slice(0, end)) > limit - 3)
        end -= 1;
    return `${text.slice(0, end)}…`;
}
//# sourceMappingURL=protocol.js.map