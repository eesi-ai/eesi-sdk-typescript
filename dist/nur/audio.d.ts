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
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(base64: string): Uint8Array;
/** PCM16 bytes as samples (little-endian, the wire's order). */
export declare function pcmToSamples(pcm: Uint8Array): Int16Array;
export declare function samplesToPcm(samples: Int16Array): Uint8Array;
/** Float samples in -1..1 as PCM16 bytes (what a Web Audio graph produces). */
export declare function floatToPcm(samples: Float32Array): Uint8Array;
export declare function pcmToFloat(pcm: Uint8Array): Float32Array;
/** Root-mean-square level of PCM16, 0..1. */
export declare function rms(pcm: Uint8Array): number;
/**
 * Linear resampling of a PCM16 stream whose output does not depend on how it
 * is chunked: the next output position is carried across calls as an exact
 * rational offset with the last input sample, so resampling in pieces gives
 * the same samples as resampling whole.
 */
export declare class Resampler {
    readonly from: number;
    readonly to: number;
    private position;
    private last;
    constructor(from: number, to: number);
    reset(): void;
    process(pcm: Uint8Array): Uint8Array;
}
/** When queued audio will have played, for outputs that play on their own. An estimate, never proof. */
export declare class PlayoutClock {
    readonly sampleRate: number;
    private readonly clock;
    private endsAt;
    constructor(sampleRate: number, clock?: () => number);
    push(samples: number): void;
    bufferedSeconds(): number;
    flush(): void;
}
/** An output nobody hears that keeps real-time playout, so barge-in behaves (tests, servers). */
export declare class SilentOutput implements AudioOutput {
    readonly sampleRate: number;
    private readonly clock;
    constructor(sampleRate?: number);
    play(pcm: Uint8Array): void;
    flush(): void;
    bufferedSeconds(): number;
}
//# sourceMappingURL=audio.d.ts.map