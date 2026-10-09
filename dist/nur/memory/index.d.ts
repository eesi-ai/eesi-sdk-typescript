import { type RecallWeights } from "./recall.js";
import { type MemoryKind, type MemoryRecord, type MemoryStore, type PlayerScope } from "./records.js";
import { type Chat, type ExtractionResult, type Extractor } from "./extraction.js";
export * from "./records.js";
export * from "./recall.js";
export * from "./extraction.js";
export * from "./stores.js";
export declare const EXPORT_FORMAT = "eesi.memory";
/** What a character may keep, and for how long. The defaults learn from every conversation. */
export interface MemoryPolicy {
    /** Learn memories from each finished conversation. Default true. */
    extract?: boolean;
    /** Episodic memories (events, promises, summaries) expire after this many days. */
    retentionDays?: number;
    /** The oldest, least important memories of a player are dropped past this count. Default 500. */
    maxRecordsPerPlayer?: number;
    /** Applied to every text before it is stored, e.g. to strip e-mail addresses. */
    redact?: (text: string) => string;
    /** The `memory` block's size in bytes. Default 3000. */
    blockBytes?: number;
    /** Search memories for what the player just said, and refresh the recall block. Default true. */
    recallOnTurn?: boolean;
    weights?: RecallWeights;
    /** Your own extraction model; the default asks nur-llm-v1 with your key. */
    extractor?: Extractor;
    /** What may be remembered, in your words, for the default extractor: "Only game facts... never age, school, location or social accounts." */
    rules?: string;
}
/** A store plus a policy: what you pass as a character's `memory`. */
export declare class Memory {
    readonly store: MemoryStore;
    readonly namespace: string;
    readonly policy: Required<Omit<MemoryPolicy, "redact" | "extractor" | "retentionDays" | "rules">> & Pick<MemoryPolicy, "redact" | "extractor" | "retentionDays" | "rules">;
    constructor(store?: MemoryStore, policy?: MemoryPolicy, namespace?: string);
}
export interface RememberOptions {
    playerId?: string | null;
    kind?: MemoryKind;
    importance?: number;
    key?: string | null;
    /** Seconds until it is forgotten. */
    ttl?: number;
    tags?: string[];
    source?: string;
    confidence?: number;
    sessionId?: string | null;
    replaces?: string | null;
}
/** One character's memory: every player's, and its own world knowledge. */
export declare class CharacterMemory {
    readonly memory: Memory;
    readonly characterId: string;
    readonly characterName: string;
    private readonly chat;
    readonly store: MemoryStore;
    readonly namespace: string;
    constructor(memory: Memory, characterId: string, characterName: string, chat?: Chat | null);
    get policy(): Memory["policy"];
    forPlayer(playerId: string): PlayerMemory;
    private clean;
    private expiry;
    private scope;
    /** Keep `text`. With `key`, it replaces the player's earlier record of that key. */
    remember(text: string, options?: RememberOptions): Promise<MemoryRecord>;
    /** Edit a record in place (your own correction of what is stored). */
    update(id: string, changes: {
        text?: string;
        importance?: number;
        kind?: MemoryKind;
        tags?: string[];
        ttl?: number;
    }): Promise<MemoryRecord | null>;
    /** Replace a memory that was wrong, keeping the old one as history. */
    correct(id: string, text: string): Promise<MemoryRecord | null>;
    /** Delete records for good. */
    forget(...ids: string[]): Promise<number>;
    /** Delete everything about one player, or with no player given, everything this character remembers. */
    erase(options?: {
        playerId?: PlayerScope;
    }): Promise<number>;
    get(id: string): Promise<MemoryRecord | null>;
    /** Records, newest first. `playerId: null` lists the character's world memory. */
    list(options?: {
        playerId?: PlayerScope;
        kinds?: MemoryKind[];
        includeInactive?: boolean;
        limit?: number;
    }): Promise<MemoryRecord[]>;
    /** Records matching `query`: the player's and the character's world memory. */
    search(query: string, options?: {
        playerId?: string | null;
        limit?: number;
    }): Promise<Array<[MemoryRecord, number]>>;
    /** What the character would bring to mind: ranked by relevance to `query`, importance and recency. */
    recall(options?: {
        playerId?: string | null;
        query?: string;
        limit?: number;
    }): Promise<Array<[MemoryRecord, number]>>;
    /** The `memory` block for a session, and the records in it. */
    block(options: {
        playerId: string | null;
        playerName?: string | null;
        query?: string;
        sessionPreferences?: Record<string, string>;
    }): Promise<{
        text: string;
        used: MemoryRecord[];
    }>;
    /**
     * Extract and keep what a conversation is worth remembering. `transcript`
     * is `[speaker, text]` lines: "player", "event", or the character's name.
     * Use it for a conversation the SDK did not hold (a client that
     * connected with a client secret and sent you its transcript).
     */
    learn(transcript: Array<[string, string]>, options: {
        playerId: string;
        playerName?: string | null;
        sessionId?: string | null;
        skipKinds?: MemoryKind[];
    }): Promise<{
        added: MemoryRecord[];
        superseded: MemoryRecord[];
        forgotten: string[];
    }>;
    /** Write an extraction's memories: dedupe, supersede corrections, upsert keyed preferences. */
    apply(result: ExtractionResult, options: {
        playerId: string;
        sessionId?: string | null;
        existing?: MemoryRecord[];
    }): Promise<{
        added: MemoryRecord[];
        superseded: MemoryRecord[];
        forgotten: string[];
    }>;
    private prune;
    /** Every record in scope, in the portable JSON the Python SDK also reads and writes. */
    export(options?: {
        playerId?: PlayerScope;
    }): Promise<Record<string, unknown>>;
    /** Load records exported by either SDK into this character. */
    importRecords(data: Record<string, unknown> | Array<Record<string, unknown>>): Promise<number>;
    private owned;
}
/** One player's memories with one character: inspect, edit, delete. */
export declare class PlayerMemory {
    readonly character: CharacterMemory;
    readonly playerId: string;
    constructor(character: CharacterMemory, playerId: string);
    remember(text: string, options?: Omit<RememberOptions, "playerId">): Promise<MemoryRecord>;
    list(options?: {
        kinds?: MemoryKind[];
        includeInactive?: boolean;
    }): Promise<MemoryRecord[]>;
    search(query: string, options?: {
        limit?: number;
    }): Promise<Array<[MemoryRecord, number]>>;
    recall(query?: string, options?: {
        limit?: number;
    }): Promise<Array<[MemoryRecord, number]>>;
    preferences(): Promise<Record<string, string>>;
    correct(id: string, text: string): Promise<MemoryRecord | null>;
    forget(...ids: string[]): Promise<number>;
    erase(): Promise<number>;
    export(): Promise<Record<string, unknown>>;
}
/** Copy every record of a namespace from one store to another (ids kept). */
export declare function migrate(source: MemoryStore, target: MemoryStore, namespace?: string): Promise<number>;
//# sourceMappingURL=index.d.ts.map