/** The gateway's native input rate: 16-bit mono PCM unless the session says otherwise. */
export declare const INPUT_SAMPLE_RATE = 16000;
/** The rate the SDK asks the character's voice at. 16 kHz is also accepted. */
export declare const OUTPUT_SAMPLE_RATE = 24000;
/** Limits the gateway enforces on context blocks, tool results and instructions. */
export declare const MAX_CONTEXT_KEYS = 8;
export declare const MAX_CONTEXT_BLOCK_BYTES = 200000;
export declare const MAX_CONTEXT_TOTAL_BYTES = 256000;
export declare const MAX_TOOL_RESULT_BYTES = 16000;
export declare const MAX_INSTRUCTIONS_BYTES = 64000;
export declare const CONTEXT_KEY: RegExp;
/**
 * How the voice says a phrase (`session.replace`): this many phrases at most,
 * each this long (letters, digits, apostrophes, spaces), said as at most this many characters.
 */
export declare const MAX_PRONUNCIATIONS = 200;
export declare const MAX_PRONUNCIATION_PHRASE_CHARS = 100;
export declare const MAX_PRONUNCIATION_SPOKEN_CHARS = 128;
/** Words the transcript should expect (`audio.input.transcription.keyterms`). */
export declare const MAX_KEYTERMS = 100;
export declare const MAX_KEYTERM_CHARS = 50;
/** `audio.input.transport` / `audio.output.transport`: base64 in JSON, or binary frames. */
export declare const AUDIO_TRANSPORTS: readonly ["json", "binary"];
/** The longest line a `force_message` says word for word. */
export declare const MAX_SCRIPTED_LINE_CHARS = 4096;
export type ClientEvent = {
    type: string;
} & Record<string, unknown>;
export type ServerEvent = {
    type: string;
} & Record<string, unknown>;
/** One name per server event, whichever protocol version sent it. */
export declare function canonicalType(kind: string): string;
export declare function eventId(): string;
/**
 * Random bytes for ids (events, items, memories), never for secrets. Web
 * Crypto where the platform has it; Node 18 does not expose it to modules.
 */
export declare function randomBytes(length: number): Uint8Array;
export declare function randomHex(length: number): string;
export declare function sessionUpdate(session: Record<string, unknown>): ClientEvent;
export declare function contextUpdate(key: string, text: string): ClientEvent;
export declare function appendAudio(base64: string): ClientEvent;
export declare function userText(text: string, itemId?: string): ClientEvent;
/**
 * A line the voice says word for word, without the model: it is the turn, so
 * no `response.create` follows. With `interruptible: false`, nobody can talk over it.
 */
export declare function forceMessage(text: string, options?: {
    interruptible?: boolean;
    itemId?: string;
}): ClientEvent;
/** Drop the audio turn detection has not picked up yet. */
export declare function clearInputAudio(): ClientEvent;
/** Take an item out of what the character reads next. */
export declare function deleteItem(itemId: string): ClientEvent;
export declare function toolOutput(callId: string, output: string): ClientEvent;
/**
 * A reply. `instructions` steer this one reply; the character still stands,
 * because the gateway composes them after the session's own instructions.
 */
export declare function responseCreate(options?: {
    instructions?: string;
    toolChoice?: string;
    input?: unknown[];
    extra?: Record<string, unknown>;
}): ClientEvent;
/**
 * A reply to something that happened in the application. The event joins
 * the conversation as its newest turn, labelled as the application's; with it
 * only in the instructions, the model often answered the player's previous
 * question again instead of reacting to the event.
 */
export declare function eventReply(event: string, instructions: string): ClientEvent;
export declare function responseCancel(): ClientEvent;
export declare function keepalive(): ClientEvent;
/** What the speaker has played, so a cut keeps only what was heard. An estimate, never proof. */
export declare function outputStatus(status: {
    responseId: string;
    sampleRate: number;
    received: number;
    rendered: number;
    discarded: number;
    flushed: boolean;
    bufferedMs: number;
}): ClientEvent;
export declare function record(value: unknown): Record<string, unknown>;
export declare function str(value: unknown): string;
export declare function responseIdOf(event: ServerEvent): string;
export declare function errorOf(event: ServerEvent): {
    message: string;
    code: string | null;
};
export declare function responseStatus(event: ServerEvent): {
    status: string | null;
    reason: string | null;
};
/**
 * `Speaker N:` tagged lines back into `{speaker, text}` runs. An untagged
 * line continues whoever spoke last; a transcript with no tags is one
 * unlabelled turn. An explicit unknown voice remains distinct from a solo
 * caller; consumers must not bind it to the previous or only player.
 */
export declare function splitSpeakerTurns(text: string): Array<{
    speaker: number | null;
    text: string;
    unattributed?: true;
}>;
export declare function byteLength(text: string): number;
/** `text` cut to at most `limit` UTF-8 bytes on a character boundary, marked with an ellipsis. */
export declare function clipBytes(text: string, limit: number): string;
//# sourceMappingURL=protocol.d.ts.map