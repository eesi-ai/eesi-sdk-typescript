import type { Character, ConnectOptions } from "./character.js";
import type { EventPattern, Handler } from "./events.js";
import { type Player } from "./multiplayer.js";
import type { Session } from "./session.js";
export declare const FRAME_MS = 20;
/** A player's level (RMS, 0..1) below this does not count toward who spoke. */
export declare const SPEECH_FLOOR = 0.01;
export interface RoomOptions extends Omit<ConnectOptions, "players" | "input" | "audio" | "playerId" | "playerName" | "memory"> {
    /** Greet players who join after the start. Default true. */
    greetJoiners?: boolean;
    /** true (default): each player's memories, recalled for them and learned from their own words. */
    memory?: boolean | "read";
}
/** A character and a group of players in one conversation. Make one with `character.room()`. */
export declare class Room {
    readonly character: Character;
    readonly players: Player[];
    readonly session: Session;
    greetJoiners: boolean;
    private buffers;
    private resamplers;
    private timeline;
    private frame;
    private bound;
    private lastSpeaker;
    private timer;
    private clockStart;
    private ticks;
    constructor(character: Character, players: Array<Player | string> | Record<string, string>, options?: RoomOptions);
    /** Resolves when the conversation is over. */
    get ended(): Promise<void>;
    start(): Promise<this>;
    close(): Promise<void>;
    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void;
    /** A player's microphone audio (PCM16 mono), as it arrives. Never blocks. */
    feed(playerId: string, pcm: Uint8Array, options?: {
        sampleRate?: number;
    }): void;
    /** Someone joined. The character greets them unless `greetJoiners` is off. */
    addPlayer(player: Player | string): Promise<void>;
    removePlayer(playerId: string): void;
    /** Every 20 ms: one frame from each player, summed and sent; levels kept for attribution. */
    private tick;
    private mix;
    /** The `roster` block: who is here, what they speak, who spoke last. */
    render(): string;
    /** Player ids by how much they spoke between two points of the audio sent, loudest first. */
    loudest(startMs: number | null, endMs: number | null): string[];
    private nameOf;
    private attribute;
}
//# sourceMappingURL=room.d.ts.map