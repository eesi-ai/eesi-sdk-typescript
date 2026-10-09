// Several players, one character, one conversation.
//
// When your server already receives every player's microphone (your game's
// voice chat runs through it), a room mixes them into one session with the
// character. Everyone hears the same character and the character hears
// everyone, so it can talk to the group, answer two people at once and
// greet whoever walks up.
//
// Who said what comes from the audio itself. The room knows which player was
// loudest while each turn was spoken, and binds Nur Live's `Speaker N`
// labels to players by that, so it does not depend on people introducing
// themselves:
//
//     const room = kael.room([{ name: "Ana", id: "p1", language: "ar" }, { name: "Ben", id: "p2" }]);
//     room.on("audio.output.chunk", (event) => voiceChat.toEveryone(event.pcm));
//     room.on("speech.interrupted", () => voiceChat.stopCharacter());
//     await room.start();
//     voiceChat.onMicrophone((playerId, pcm) => room.feed(playerId, pcm));
//
// With players speaking different languages, the character answers each in
// their own (give each player a `language`).

import { pcmToSamples, Resampler, samplesToPcm } from "./audio.js";
import type { Character, ConnectOptions } from "./character.js";
import type { EventPattern, Handler } from "./events.js";
import { describeLanguage } from "./languages.js";
import { type AttributedTurn, asPlayers, type Player, playerKey } from "./multiplayer.js";
import { INPUT_SAMPLE_RATE, splitSpeakerTurns } from "./protocol.js";
import type { Session } from "./session.js";

export const FRAME_MS = 20;
const FRAME_SAMPLES = (INPUT_SAMPLE_RATE * FRAME_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 2;
/** A player's level (RMS, 0..1) below this does not count toward who spoke. */
export const SPEECH_FLOOR = 0.01;
/** The most audio buffered per player; older audio is dropped, never delayed. */
const MAX_BUFFER_BYTES = INPUT_SAMPLE_RATE * 2;
/** How much level history attribution can look back on. */
const TIMELINE_FRAMES = 300_000 / FRAME_MS;

export interface RoomOptions extends Omit<ConnectOptions, "players" | "input" | "audio" | "playerId" | "playerName" | "memory"> {
    /** Greet players who join after the start. Default true. */
    greetJoiners?: boolean;
    /** true (default): each player's memories, recalled for them and learned from their own words. */
    memory?: boolean | "read";
}

/** A player's microphone audio waiting for the next frame. */
class PcmBuffer {
    private data = new Uint8Array(0);

    push(bytes: Uint8Array): void {
        const merged = new Uint8Array(this.data.byteLength + bytes.byteLength);
        merged.set(this.data);
        merged.set(bytes, this.data.byteLength);
        const keep = merged.byteLength - (merged.byteLength % 2);
        this.data = keep > MAX_BUFFER_BYTES ? merged.slice(keep - MAX_BUFFER_BYTES, keep) : merged;
    }

    take(count: number): Uint8Array {
        const out = this.data.subarray(0, Math.min(count, this.data.byteLength - (this.data.byteLength % 2)));
        this.data = this.data.subarray(out.byteLength);
        return out;
    }
}

/** A character and a group of players in one conversation. Make one with `character.room()`. */
export class Room {
    readonly character: Character;
    readonly players: Player[];
    readonly session: Session;
    greetJoiners: boolean;
    private buffers = new Map<string, PcmBuffer>();
    private resamplers = new Map<string, Resampler>();
    private timeline: Array<{ frame: number; levels: Record<string, number> }> = [];
    private frame = 0;
    private bound = new Map<number, string>();
    private lastSpeaker: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private clockStart = 0;
    private ticks = 0;

    constructor(character: Character, players: Array<Player | string> | Record<string, string>, options: RoomOptions = {}) {
        const { greetJoiners, ...connect } = options;
        this.character = character;
        this.players = asPlayers(players);
        this.greetJoiners = greetJoiners ?? true;
        this.session = character.connect({ ...connect, players: this.players });
        this.session.attributor = (text) => this.attribute(text);
        for (const player of this.players) this.buffers.set(playerKey(player), new PcmBuffer());
        this.session.on("reconnected", () => {
            // A resumed conversation counts its audio from zero again.
            this.frame = 0;
            this.timeline = [];
        });
        this.session.on("transcript.final", (event) => {
            const named = event.turns.filter((turn) => turn.playerId).map((turn) => this.nameOf(turn.playerId) ?? (turn.playerId as string));
            if (named.length) this.lastSpeaker = named[named.length - 1] as string;
            this.session.publisher.setBlock("roster", this.render());
        });
    }

    /** Resolves when the conversation is over. */
    get ended(): Promise<void> {
        return this.session.ended;
    }

    async start(): Promise<this> {
        await this.session.start();
        this.clockStart = performance.now();
        this.ticks = 0;
        this.tick();
        return this;
    }

    async close(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.session.close();
    }

    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void {
        return this.session.on(pattern, handler);
    }

    // ── players ──────────────────────────────────────────────────────────

    /** A player's microphone audio (PCM16 mono), as it arrives. Never blocks. */
    feed(playerId: string, pcm: Uint8Array, options: { sampleRate?: number } = {}): void {
        const buffer = this.buffers.get(playerId);
        if (!buffer) return; // Not in the room.
        const rate = options.sampleRate ?? INPUT_SAMPLE_RATE;
        if (rate !== INPUT_SAMPLE_RATE) {
            const key = `${playerId}:${rate}`;
            let resampler = this.resamplers.get(key);
            if (!resampler) {
                resampler = new Resampler(rate, INPUT_SAMPLE_RATE);
                this.resamplers.set(key, resampler);
            }
            buffer.push(resampler.process(pcm));
            return;
        }
        buffer.push(pcm);
    }

    /** Someone joined. The character greets them unless `greetJoiners` is off. */
    async addPlayer(player: Player | string): Promise<void> {
        const made: Player = typeof player === "string" ? { name: player } : player;
        const key = playerKey(made);
        if (this.buffers.has(key)) return;
        this.players.push(made);
        this.buffers.set(key, new PcmBuffer());
        const session = this.session;
        session.players.push(made);
        session.playerIds[made.name] = key;
        if (made.language) session.languages[made.name] = describeLanguage(made.language)[1];
        session.roster?.expect(made.name);
        session.publisher.setBlock("roster", this.render());
        if (this.greetJoiners && session.ready) await session.cue(`${made.name} just joined the group.`);
    }

    removePlayer(playerId: string): void {
        this.buffers.delete(playerId);
        const index = this.players.findIndex((player) => playerKey(player) === playerId);
        if (index >= 0) this.players.splice(index, 1);
        for (const [speaker, key] of [...this.bound]) if (key === playerId) this.bound.delete(speaker);
        if (this.session.ready) this.session.publisher.setBlock("roster", this.render());
    }

    // ── mixing ───────────────────────────────────────────────────────────

    /** Every 20 ms: one frame from each player, summed and sent; levels kept for attribution. */
    private tick(): void {
        if (this.session.closed) return;
        this.ticks += 1;
        const due = this.clockStart + this.ticks * FRAME_MS;
        this.timer = setTimeout(() => this.tick(), Math.max(0, due - performance.now()));
        if (this.session.ready) this.mix();
    }

    private mix(): void {
        const sum = new Int32Array(FRAME_SAMPLES);
        const levels: Record<string, number> = {};
        for (const [key, buffer] of this.buffers) {
            const chunk = buffer.take(FRAME_BYTES);
            if (!chunk.byteLength) continue;
            const samples = pcmToSamples(chunk);
            let energy = 0;
            for (let index = 0; index < samples.length; index += 1) {
                const value = samples[index] as number;
                energy += value * value;
                sum[index] = (sum[index] as number) + value;
            }
            levels[key] = Math.sqrt(energy / samples.length) / 32768;
        }
        const mixed = new Int16Array(FRAME_SAMPLES);
        for (let index = 0; index < FRAME_SAMPLES; index += 1) mixed[index] = Math.max(-32768, Math.min(32767, sum[index] as number));
        this.timeline.push({ frame: this.frame, levels });
        if (this.timeline.length > TIMELINE_FRAMES + 1_000) this.timeline.splice(0, 1_000);
        this.frame += 1;
        try {
            this.session.sendAudio(samplesToPcm(mixed));
        } catch {
            // The session ended.
        }
    }

    /** The `roster` block: who is here, what they speak, who spoke last. */
    render(): string {
        if (!this.players.length) return "";
        const languages = this.session.languages;
        const who = (player: Player) => (languages[player.name] ? `${player.name} (speaks ${languages[player.name]})` : player.name);
        const lines = [`You are in one conversation with a group: ${this.players.map(who).join(", ")}.`];
        const bound = [...this.bound]
            .sort(([a], [b]) => a - b)
            .map(([speaker, key]) => [speaker, this.nameOf(key)] as const)
            .filter(([, name]) => name)
            .map(([speaker, name]) => `Speaker ${speaker} is ${name}.`);
        if (bound.length) lines.push(bound.join(" "));
        if (this.lastSpeaker) lines.push(`${this.lastSpeaker} spoke last.`);
        lines.push("Answer the person who spoke to you, by name when it would otherwise be unclear. When two people ask different things, answer both, each by name.");
        if (new Set(Object.values(languages)).size > 1) lines.push("Answer each person in their own language.");
        return lines.join(" ");
    }

    // ── who said what ────────────────────────────────────────────────────

    /** Player ids by how much they spoke between two points of the audio sent, loudest first. */
    loudest(startMs: number | null, endMs: number | null): string[] {
        const first = startMs === null ? 0 : Math.floor(startMs / FRAME_MS);
        const last = endMs === null ? this.frame : Math.max(first, Math.floor(endMs / FRAME_MS));
        const totals = new Map<string, number>();
        for (const { frame, levels } of this.timeline) {
            if (frame < first || frame > last) continue;
            for (const [key, level] of Object.entries(levels)) if (level >= SPEECH_FLOOR) totals.set(key, (totals.get(key) ?? 0) + level);
        }
        return [...totals].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    }

    private nameOf(key: string | null): string | null {
        return this.players.find((player) => playerKey(player) === key)?.name ?? null;
    }

    private attribute(text: string): AttributedTurn[] {
        const ranking = this.loudest(...this.session.speechWindow);
        const roster = this.session.roster;
        return splitSpeakerTurns(text).map(({ speaker, text: words }) => {
            let key: string | null;
            if (speaker === null) {
                key = ranking[0] ?? null;
            } else {
                key = this.bound.get(speaker) ?? null;
                if (key === null) {
                    const taken = new Set(this.bound.values());
                    key = ranking.find((candidate) => !taken.has(candidate)) ?? ranking[0] ?? null;
                    if (key !== null) {
                        this.bound.set(speaker, key);
                        const name = this.nameOf(key);
                        if (roster && name) roster.assign(speaker, name);
                    }
                }
            }
            return { text: words, speaker, player: this.nameOf(key) };
        });
    }
}
