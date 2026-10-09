import { type AudioInput, type AudioOutput } from "../nur/audio.js";
import { InMemoryStore, Memory, type MemoryPolicy, type MemoryRecord } from "../nur/memory/index.js";
import { INPUT_SAMPLE_RATE } from "../nur/protocol.js";
import { Trace, type TraceOptions } from "../nur/trace.js";
/**
 * Records kept in one JSON file, in the portable form both SDKs export and
 * import. Every change rewrites the file through a temporary one, so a crash
 * never leaves half a file. Right for a game server's or a desktop app's
 * memory, up to tens of thousands of records; past that, implement
 * `MemoryStore` over your database.
 */
export declare class FileMemoryStore extends InMemoryStore {
    readonly path: string;
    private writing;
    constructor(path: string);
    put(record: MemoryRecord): Promise<void>;
    delete(ids: string[]): Promise<number>;
    touch(ids: string[], at: number): Promise<void>;
    close(): Promise<void>;
    private save;
}
/** A character's memory in a JSON file: a path ending in `.json`, or a directory to keep `memory.json` in. */
export declare function fileMemory(path?: string, policy?: MemoryPolicy, namespace?: string): Memory;
/** A trace appended to a JSONL file. */
export declare function fileTrace(path: string, options?: Omit<TraceOptions, "onClose">): Trace;
export interface WavAudio {
    sampleRate: number;
    /** 16-bit mono PCM (several channels are averaged). */
    pcm: Uint8Array;
}
/** A 16-bit PCM WAV file's audio, as mono. */
export declare function readWav(path: string): WavAudio;
/** 16-bit mono PCM as WAV file bytes. */
export declare function wavBytes(pcm: Uint8Array, sampleRate: number): Uint8Array;
/**
 * A WAV file as a microphone: played in real time in 20 ms frames, then
 * silence for as long as the session listens (a person who stopped talking).
 * `startAfterMs` waits before speaking, say for the character's greeting.
 */
export declare function wavInput(path: string, options?: {
    startAfterMs?: number;
    realtime?: boolean;
}): AudioInput;
/**
 * A speaker that records: what the character says is written to a WAV file
 * when the session closes, with the pauses between replies, and minus
 * whatever a barge-in cut before it would have played.
 */
export declare class WavRecorder implements AudioOutput {
    readonly path: string;
    readonly sampleRate: number;
    private readonly clock;
    private chunks;
    private length;
    private lastEnd;
    private written;
    constructor(path: string, sampleRate?: number);
    play(pcm: Uint8Array): void;
    flush(): void;
    bufferedSeconds(): number;
    /** The recording so far, as 16-bit mono PCM. */
    pcm(): Uint8Array;
    close(): void;
    private append;
}
/** A webhook post whose signature or age does not check out. */
export declare class WebhookVerificationError extends Error {
    constructor(message: string);
}
/** One post from a client secret's webhook: a reply, or the session's end. */
export interface WebhookEvent {
    id: string;
    type: "response.completed" | "session.ended" | string;
    created_at: number;
    session_id: string;
    metadata: Record<string, string>;
    response?: {
        id: string;
        status: string;
        text: string;
    };
    reason?: string;
    duration_seconds?: number;
}
/**
 * Check a webhook post from a client secret's session and return its event.
 * `body` is the raw request body, exactly as received (not re-serialized
 * JSON); `headers` the request's headers. Throws `WebhookVerificationError`
 * when the `EESI-Signature` does not match or the post is older than
 * `toleranceSeconds` (a replay).
 *
 *     app.post("/nur", express.raw({ type: "application/json" }), (req, res) => {
 *         const event = verifyWebhook(req.body, req.headers, process.env.NUR_WEBHOOK_SECRET!);
 *         ...
 *     });
 */
export declare function verifyWebhook(body: string | Uint8Array, headers: Record<string, string | string[] | undefined> | Headers, secret: string, options?: {
    toleranceSeconds?: number;
    now?: number;
}): WebhookEvent;
export { INPUT_SAMPLE_RATE };
//# sourceMappingURL=index.d.ts.map