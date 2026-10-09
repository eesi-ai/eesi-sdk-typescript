// Node helpers: memory kept in a file, WAV files as a microphone and a
// speaker, and traces on disk.
//
//     import { NurClient } from "@eesi/sdk";
//     import { fileMemory, fileTrace, wavInput, WavRecorder } from "@eesi/sdk/node";
//
//     const kael = nur.npc({ name: "Kael", memory: fileMemory("./.eesi/kael.json") });
//     const session = await kael.connect({
//         playerId: "p42",
//         audio: { input: wavInput("./question.wav"), output: new WavRecorder("./answer.wav") },
//         trace: fileTrace("./traces/kael.jsonl"),
//     }).start();
import { createWriteStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { PlayoutClock, pcmToSamples, samplesToPcm } from "../nur/audio.js";
import { EXPORT_FORMAT, fromPortable, InMemoryStore, Memory, toPortable } from "../nur/memory/index.js";
import { INPUT_SAMPLE_RATE } from "../nur/protocol.js";
import { Trace } from "../nur/trace.js";
// ── memory ───────────────────────────────────────────────────────────────
/**
 * Records kept in one JSON file, in the portable form both SDKs export and
 * import. Every change rewrites the file through a temporary one, so a crash
 * never leaves half a file. Right for a game server's or a desktop app's
 * memory, up to tens of thousands of records; past that, implement
 * `MemoryStore` over your database.
 */
export class FileMemoryStore extends InMemoryStore {
    path;
    writing = Promise.resolve();
    constructor(path) {
        super();
        this.path = path;
        let text = null;
        try {
            text = readFileSync(path, "utf8");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (text) {
            const data = JSON.parse(text);
            for (const item of Array.isArray(data) ? data : (data.records ?? [])) {
                const record = fromPortable(item);
                this.records.set(record.id, record);
            }
        }
    }
    async put(record) {
        await super.put(record);
        await this.save();
    }
    async delete(ids) {
        const count = await super.delete(ids);
        if (count)
            await this.save();
        return count;
    }
    async touch(ids, at) {
        await super.touch(ids, at);
        await this.save();
    }
    async close() {
        await this.writing;
    }
    save() {
        const write = () => {
            mkdirSync(dirname(this.path), { recursive: true });
            const temporary = `${this.path}.${process.pid}.tmp`;
            writeFileSync(temporary, JSON.stringify({ format: EXPORT_FORMAT, version: 1, records: this.all().map(toPortable) }));
            renameSync(temporary, this.path);
        };
        this.writing = this.writing.then(write, write);
        return this.writing;
    }
}
/** A character's memory in a JSON file: a path ending in `.json`, or a directory to keep `memory.json` in. */
export function fileMemory(path = ".eesi/memory", policy = {}, namespace = "default") {
    const file = extname(path) === ".json" ? path : join(path, "memory.json");
    return new Memory(new FileMemoryStore(file), policy, namespace);
}
// ── traces ───────────────────────────────────────────────────────────────
/** A trace appended to a JSONL file. */
export function fileTrace(path, options = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "a" });
    return new Trace((line) => stream.write(`${line}\n`), { ...options, onClose: () => stream.end() });
}
/** A 16-bit PCM WAV file's audio, as mono. */
export function readWav(path) {
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
        throw new Error(`${path} is not a WAV file.`);
    let offset = 12;
    let channels = 1;
    let sampleRate = 0;
    let bits = 0;
    let data = null;
    while (offset + 8 <= bytes.byteLength) {
        const id = tag(offset);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === "fmt ") {
            const format = view.getUint16(body, true);
            channels = view.getUint16(body + 2, true);
            sampleRate = view.getUint32(body + 4, true);
            bits = view.getUint16(body + 14, true);
            if ((format !== 1 && format !== 0xfffe) || bits !== 16)
                throw new Error(`${path} must be 16-bit PCM (it is format ${format}, ${bits}-bit).`);
        }
        else if (id === "data") {
            data = bytes.subarray(body, Math.min(bytes.byteLength, body + size));
        }
        offset = body + size + (size % 2);
    }
    if (!data || !sampleRate)
        throw new Error(`${path} has no audio.`);
    const samples = pcmToSamples(data);
    if (channels === 1)
        return { sampleRate, pcm: samplesToPcm(samples) };
    const mono = new Int16Array(Math.floor(samples.length / channels));
    for (let frame = 0; frame < mono.length; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1)
            sum += samples[frame * channels + channel];
        mono[frame] = Math.round(sum / channels);
    }
    return { sampleRate, pcm: samplesToPcm(mono) };
}
/** 16-bit mono PCM as WAV file bytes. */
export function wavBytes(pcm, sampleRate) {
    const header = new DataView(new ArrayBuffer(44));
    const write = (offset, text) => [...text].forEach((char, index) => header.setUint8(offset + index, char.charCodeAt(0)));
    write(0, "RIFF");
    header.setUint32(4, 36 + pcm.byteLength, true);
    write(8, "WAVE");
    write(12, "fmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, sampleRate, true);
    header.setUint32(28, sampleRate * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    write(36, "data");
    header.setUint32(40, pcm.byteLength, true);
    const out = new Uint8Array(44 + pcm.byteLength);
    out.set(new Uint8Array(header.buffer), 0);
    out.set(pcm, 44);
    return out;
}
/**
 * A WAV file as a microphone: played in real time in 20 ms frames, then
 * silence for as long as the session listens (a person who stopped talking).
 * `startAfterMs` waits before speaking, say for the character's greeting.
 */
export function wavInput(path, options = {}) {
    const { sampleRate, pcm } = readWav(path);
    const frameBytes = Math.round(sampleRate * 0.02) * 2;
    const silence = new Uint8Array(frameBytes);
    let closed = false;
    return {
        sampleRate,
        async *frames() {
            const realtime = options.realtime ?? true;
            const started = performance.now();
            let sent = 0;
            const pace = async () => {
                sent += 1;
                if (!realtime)
                    return;
                const due = started + sent * 20;
                const wait = due - performance.now();
                if (wait > 0)
                    await new Promise((resolve) => setTimeout(resolve, wait));
            };
            const lead = Math.round((options.startAfterMs ?? 0) / 20);
            for (let index = 0; index < lead && !closed; index += 1) {
                yield silence;
                await pace();
            }
            for (let offset = 0; offset < pcm.byteLength && !closed; offset += frameBytes) {
                yield pcm.subarray(offset, Math.min(pcm.byteLength, offset + frameBytes));
                await pace();
            }
            while (!closed) {
                yield silence;
                await pace();
            }
        },
        close() {
            closed = true;
        },
    };
}
/**
 * A speaker that records: what the character says is written to a WAV file
 * when the session closes, with the pauses between replies, and minus
 * whatever a barge-in cut before it would have played.
 */
export class WavRecorder {
    path;
    sampleRate;
    clock;
    chunks = [];
    length = 0;
    lastEnd = performance.now() / 1000;
    written = false;
    constructor(path, sampleRate = 24_000) {
        this.path = path;
        this.sampleRate = sampleRate;
        this.clock = new PlayoutClock(sampleRate);
    }
    play(pcm) {
        const samples = pcmToSamples(pcm);
        if (!samples.length)
            return;
        const now = performance.now() / 1000;
        if (this.clock.bufferedSeconds() === 0 && this.length > 0) {
            const gap = Math.round(Math.max(0, now - this.lastEnd) * this.sampleRate);
            if (gap)
                this.append(new Int16Array(gap));
        }
        this.append(samples);
        this.clock.push(samples.length);
        this.lastEnd = now + this.clock.bufferedSeconds();
    }
    flush() {
        let unplayed = Math.round(this.clock.bufferedSeconds() * this.sampleRate);
        while (unplayed > 0 && this.chunks.length) {
            const last = this.chunks[this.chunks.length - 1];
            if (last.length <= unplayed) {
                this.chunks.pop();
                this.length -= last.length;
                unplayed -= last.length;
            }
            else {
                this.chunks[this.chunks.length - 1] = last.subarray(0, last.length - unplayed);
                this.length -= unplayed;
                unplayed = 0;
            }
        }
        this.clock.flush();
        this.lastEnd = performance.now() / 1000;
    }
    bufferedSeconds() {
        return this.clock.bufferedSeconds();
    }
    /** The recording so far, as 16-bit mono PCM. */
    pcm() {
        const all = new Int16Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
        }
        return samplesToPcm(all);
    }
    close() {
        if (this.written)
            return;
        this.written = true;
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, wavBytes(this.pcm(), this.sampleRate));
    }
    append(samples) {
        this.chunks.push(samples);
        this.length += samples.length;
    }
}
export { INPUT_SAMPLE_RATE };
//# sourceMappingURL=index.js.map