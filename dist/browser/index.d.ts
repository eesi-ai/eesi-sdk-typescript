import { type AudioDevices, type AudioInput, type AudioOutput } from "../nur/audio.js";
export { forwardTools, joinSession } from "../nur/join.js";
export type { JoinOptions } from "../nur/join.js";
export interface BrowserAudioOptions {
    /** A specific microphone: a `deviceId` from `navigator.mediaDevices.enumerateDevices()`. */
    deviceId?: string;
    /** The browser's echo cancellation. Default true; turn it off only with headphones. */
    echoCancellation?: boolean;
    /** Default true. */
    noiseSuppression?: boolean;
    /** Default true. */
    autoGainControl?: boolean;
    /** The rate the session sends the character's voice at: 24000 (default) or 16000. */
    outputSampleRate?: number;
    /** The character's volume, 0 to 1. */
    volume?: number;
    /** An AudioContext of your own, to mix the character into your game's audio. */
    context?: AudioContext;
    /** Where the character's voice goes in that context (default: its destination). */
    destination?: AudioNode;
}
/** The microphone and the speakers of this page. Pass it as a session's `audio`. */
export interface BrowserAudio extends AudioDevices {
    readonly input: AudioInput;
    readonly output: AudioOutput;
    readonly context: AudioContext;
    readonly stream: MediaStream;
    /** The microphone's level just now, 0 to 1, for a meter. */
    level(): number;
    setVolume(volume: number): void;
    /** Stop the microphone and release the audio context (unless it was yours). */
    close(): void;
}
/**
 * Open the microphone and the speakers. Call it from a click or a key press:
 * browsers start audio only after one. Needs https (or localhost).
 */
export declare function browserAudio(options?: BrowserAudioOptions): Promise<BrowserAudio>;
//# sourceMappingURL=index.d.ts.map