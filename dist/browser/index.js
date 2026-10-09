// Audio for web pages: the microphone, and the character through the speakers.
//
//     import { joinSession } from "@eesi/sdk";
//     import { browserAudio } from "@eesi/sdk/browser";
//
//     talkButton.onclick = async () => {        // browsers start audio only after a click or a key
//         const join = await (await fetch("/api/nur/join", { method: "POST" })).json();
//         const audio = await browserAudio();
//         const session = await joinSession(join, { audio });
//         session.on("transcript.final", (event) => show(event.text));
//     };
//
// The microphone runs through the browser's echo cancellation, so the
// character does not hear itself, and through an AudioWorklet, off the main
// thread. The character's voice is scheduled sample-exact, so replies play
// without gaps, and a barge-in silences it at once.
import { floatToPcm, pcmToFloat } from "../nur/audio.js";
import { OUTPUT_SAMPLE_RATE } from "../nur/protocol.js";
export { forwardTools, joinSession } from "../nur/join.js";
// Batches 20 ms per message: one postMessage per 128-sample render quantum is ~375 a second.
const CAPTURE_PROCESSOR = `
class EesiCapture extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.size = options.processorOptions.size;
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) {
            let offset = 0;
            while (offset < channel.length) {
                const count = Math.min(channel.length - offset, this.size - this.filled);
                this.buffer.set(channel.subarray(offset, offset + count), this.filled);
                this.filled += count;
                offset += count;
                if (this.filled === this.size) {
                    this.port.postMessage(this.buffer.slice(0));
                    this.filled = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor("eesi-capture", EesiCapture);
`;
/** How far ahead of now the first chunk of a reply is scheduled, to absorb network jitter. */
const START_MARGIN_S = 0.03;
/** The most microphone audio held for a session that is not reading it; older audio is dropped. */
const MAX_QUEUED_FRAMES = 100;
/**
 * Open the microphone and the speakers. Call it from a click or a key press:
 * browsers start audio only after one. Needs https (or localhost).
 */
export async function browserAudio(options = {}) {
    const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!devices?.getUserMedia)
        throw new Error("This page cannot use the microphone: it needs https (or localhost) and a browser that allows it.");
    const stream = await devices.getUserMedia({
        audio: {
            deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
            channelCount: 1,
            echoCancellation: options.echoCancellation ?? true,
            noiseSuppression: options.noiseSuppression ?? true,
            autoGainControl: options.autoGainControl ?? true,
        },
    });
    const ownContext = !options.context;
    const context = options.context ?? new AudioContext({ latencyHint: "interactive" });
    try {
        if (context.state === "suspended")
            await context.resume();
        const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR], { type: "application/javascript" }));
        try {
            await context.audioWorklet.addModule(url);
        }
        finally {
            URL.revokeObjectURL(url);
        }
    }
    catch (error) {
        for (const track of stream.getTracks())
            track.stop();
        if (ownContext)
            void context.close();
        throw error;
    }
    // ── the microphone ───────────────────────────────────────────────────
    const source = context.createMediaStreamSource(stream);
    // Nothing above 7 kHz reaches the 16 kHz the session sends, so resampling folds nothing back.
    const lowpass = [7_000, 7_000].map((frequency) => new BiquadFilterNode(context, { type: "lowpass", frequency, Q: Math.SQRT1_2 }));
    const capture = new AudioWorkletNode(context, "eesi-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { size: Math.round(context.sampleRate * 0.02) },
    });
    // A node only runs while it leads somewhere; this one leads to silence.
    const sink = new GainNode(context, { gain: 0 });
    source.connect(lowpass[0]);
    lowpass[0].connect(lowpass[1]);
    lowpass[1].connect(capture);
    capture.connect(sink);
    sink.connect(context.destination);
    const queue = [];
    let wake = null;
    let micClosed = false;
    let micLevel = 0;
    capture.port.onmessage = (event) => {
        const floats = event.data;
        let energy = 0;
        for (let index = 0; index < floats.length; index += 1)
            energy += floats[index] ** 2;
        micLevel = Math.sqrt(energy / Math.max(1, floats.length));
        if (queue.length >= MAX_QUEUED_FRAMES)
            queue.shift();
        queue.push(floatToPcm(floats));
        wake?.();
    };
    const input = {
        sampleRate: context.sampleRate,
        async *frames() {
            while (!micClosed) {
                const next = queue.shift();
                if (next) {
                    yield next;
                    continue;
                }
                await new Promise((resolve) => {
                    wake = resolve;
                });
                wake = null;
            }
        },
        close() {
            if (micClosed)
                return;
            micClosed = true;
            wake?.();
            capture.port.onmessage = null;
            for (const node of [source, ...lowpass, capture, sink])
                node.disconnect();
            for (const track of stream.getTracks())
                track.stop();
            release();
        },
    };
    // ── the speakers ─────────────────────────────────────────────────────
    const rate = options.outputSampleRate ?? OUTPUT_SAMPLE_RATE;
    let volume = Math.max(0, Math.min(1, options.volume ?? 1));
    const gain = new GainNode(context, { gain: volume });
    gain.connect(options.destination ?? context.destination);
    const playing = new Set();
    let playhead = 0;
    let ducked = false;
    let speakerClosed = false;
    const output = {
        sampleRate: rate,
        play(pcm) {
            if (speakerClosed)
                return;
            const floats = pcmToFloat(pcm);
            if (!floats.length)
                return;
            // The browser resamples a buffer at the voice's own rate to the device's, well.
            const buffer = context.createBuffer(1, floats.length, rate);
            buffer.getChannelData(0).set(floats);
            const node = new AudioBufferSourceNode(context, { buffer });
            node.connect(gain);
            const start = Math.max(playhead, context.currentTime + START_MARGIN_S);
            node.start(start);
            playhead = start + buffer.duration;
            playing.add(node);
            node.onended = () => {
                playing.delete(node);
                node.disconnect();
            };
        },
        flush() {
            for (const node of playing) {
                try {
                    node.stop();
                }
                catch {
                    // Not started yet, or already over.
                }
            }
            playing.clear();
            playhead = context.currentTime;
        },
        bufferedSeconds() {
            return Math.max(0, playhead - context.currentTime);
        },
        duck(down) {
            ducked = down;
            gain.gain.setTargetAtTime(down ? volume * 0.3 : volume, context.currentTime, 0.04);
        },
        close() {
            if (speakerClosed)
                return;
            output.flush();
            speakerClosed = true;
            gain.disconnect();
            release();
        },
    };
    let released = false;
    function release() {
        if (released || !micClosed || !speakerClosed)
            return;
        released = true;
        if (ownContext)
            void context.close();
    }
    return {
        input,
        output,
        context,
        stream,
        level: () => micLevel,
        setVolume(next) {
            volume = Math.max(0, Math.min(1, next));
            gain.gain.setTargetAtTime(ducked ? volume * 0.3 : volume, context.currentTime, 0.02);
        },
        close() {
            input.close?.();
            output.close?.();
        },
    };
}
//# sourceMappingURL=index.js.map