// Audio between your application and a session: 16-bit mono PCM.
//
// A session needs no audio at all: without it, it is a text conversation
// with a voice you receive as `audio.output.chunk` events, and you can feed
// microphone audio yourself with `session.sendAudio()` (a game server
// relaying a player's microphone). With an `AudioInput`/`AudioOutput` it
// runs the microphone and speaker for you; `@eesi/sdk/browser` has both for
// web pages, and `@eesi/sdk/node` reads and writes WAV files. The session sends 16 kHz and receives 24 kHz; anything else is
// resampled here, chunk by chunk, without clicks at the joins.

/** A microphone: PCM16 chunks at `sampleRate`, in real time. */
export interface AudioInput {
    readonly sampleRate: number;
    frames(): AsyncIterable<Uint8Array>;
    close?(): void;
}

/** A microphone and a speaker together, like `browserAudio()`. Either may be left out. */
export interface AudioDevices {
    input?: AudioInput | null;
    output?: AudioOutput | null;
}

/** A speaker. `play` returns at once; `flush` drops everything queued. */
export interface AudioOutput {
    readonly sampleRate: number;
    play(pcm: Uint8Array): void;
    flush(): void;
    /** Seconds of audio still queued to play. */
    bufferedSeconds(): number;
    /** Lower the voice while the floor is being decided. */
    duck?(ducked: boolean): void;
    close?(): void;
}

type BufferLike = { from(data: ArrayBuffer | string, offset?: number | string, length?: number): Uint8Array & { toString(encoding: string): string } };

function nodeBuffer(): BufferLike | null {
    return ((globalThis as unknown as { Buffer?: BufferLike }).Buffer ?? null) as BufferLike | null;
}

export function bytesToBase64(bytes: Uint8Array): string {
    const buffer = nodeBuffer();
    if (buffer) return buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const buffer = nodeBuffer();
    if (buffer) {
        const decoded = buffer.from(base64, "base64");
        return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** PCM16 bytes as samples (little-endian, the wire's order). */
export function pcmToSamples(pcm: Uint8Array): Int16Array {
    const count = Math.floor(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
    const samples = new Int16Array(count);
    for (let index = 0; index < count; index += 1) samples[index] = view.getInt16(index * 2, true);
    return samples;
}

export function samplesToPcm(samples: Int16Array): Uint8Array {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index] as number, true);
    return bytes;
}

/** Float samples in -1..1 as PCM16 bytes (what a Web Audio graph produces). */
export function floatToPcm(samples: Float32Array): Uint8Array {
    const ints = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index] as number));
        ints[index] = Math.round(value * 32767);
    }
    return samplesToPcm(ints);
}

export function pcmToFloat(pcm: Uint8Array): Float32Array {
    const ints = pcmToSamples(pcm);
    const floats = new Float32Array(ints.length);
    for (let index = 0; index < ints.length; index += 1) floats[index] = (ints[index] as number) / 32768;
    return floats;
}

/** Root-mean-square level of PCM16, 0..1. */
export function rms(pcm: Uint8Array): number {
    const samples = pcmToSamples(pcm);
    if (samples.length === 0) return 0;
    let sum = 0;
    for (const value of samples) sum += value * value;
    return Math.sqrt(sum / samples.length) / 32768;
}

/**
 * Linear resampling of a PCM16 stream whose output does not depend on how it
 * is chunked: the next output position is carried across calls as an exact
 * rational offset with the last input sample, so resampling in pieces gives
 * the same samples as resampling whole.
 */
export class Resampler {
    private position = 0;
    private last: number[] = [];

    constructor(
        readonly from: number,
        readonly to: number,
    ) {
        if (from <= 0 || to <= 0) throw new Error("Sample rates must be positive.");
    }

    reset(): void {
        this.position = 0;
        this.last = [];
    }

    process(pcm: Uint8Array): Uint8Array {
        if (this.from === this.to) return pcm.subarray(0, pcm.byteLength - (pcm.byteLength % 2));
        const data = [...this.last, ...pcmToSamples(pcm)];
        if (data.length < 2) {
            this.last = data;
            return new Uint8Array(0);
        }
        const limit = (data.length - 1) * this.to;
        const count = Math.max(0, Math.ceil((limit - this.position) / this.from));
        const out = new Int16Array(count);
        for (let k = 0; k < count; k += 1) {
            const position = this.position + k * this.from;
            const index = Math.floor(position / this.to);
            const fraction = (position % this.to) / this.to;
            const value = Math.round((data[index] as number) * (1 - fraction) + (data[index + 1] as number) * fraction);
            out[k] = Math.max(-32768, Math.min(32767, value));
        }
        const next = this.position + count * this.from;
        const keepFrom = Math.min(Math.floor(next / this.to), data.length);
        this.last = data.slice(keepFrom);
        this.position = next - keepFrom * this.to;
        return samplesToPcm(out);
    }
}

/** When queued audio will have played, for outputs that play on their own. An estimate, never proof. */
export class PlayoutClock {
    private endsAt = 0;

    constructor(
        readonly sampleRate: number,
        private readonly clock: () => number = () => performance.now() / 1000,
    ) {}

    push(samples: number): void {
        this.endsAt = Math.max(this.endsAt, this.clock()) + samples / this.sampleRate;
    }

    bufferedSeconds(): number {
        return Math.max(0, this.endsAt - this.clock());
    }

    flush(): void {
        this.endsAt = this.clock();
    }
}

/** An output nobody hears that keeps real-time playout, so barge-in behaves (tests, servers). */
export class SilentOutput implements AudioOutput {
    readonly sampleRate: number;
    private readonly clock: PlayoutClock;

    constructor(sampleRate = 24_000) {
        this.sampleRate = sampleRate;
        this.clock = new PlayoutClock(sampleRate);
    }

    play(pcm: Uint8Array): void {
        this.clock.push(pcm.byteLength / 2);
    }

    flush(): void {
        this.clock.flush();
    }

    bufferedSeconds(): number {
        return this.clock.bufferedSeconds();
    }
}
