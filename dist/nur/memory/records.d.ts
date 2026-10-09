/**
 * What a memory is about, and which layer it belongs to.
 *
 * - semantic: stable facts about the player (`fact`), how they like to be
 *   spoken to (`preference`), how they and the character stand
 *   (`relationship`), anything else worth keeping (`note`).
 * - episodic: things that happened (`event`), promises (`promise`) and what
 *   each conversation was about (`summary`).
 * - world: knowledge that is not about one player (`lore`, and any record
 *   with no player), shared by every session of the character.
 */
export declare const KINDS: {
    readonly fact: "semantic";
    readonly preference: "semantic";
    readonly relationship: "semantic";
    readonly note: "semantic";
    readonly event: "episodic";
    readonly promise: "episodic";
    readonly summary: "episodic";
    readonly lore: "world";
};
export type MemoryKind = keyof typeof KINDS;
export type MemoryLayer = "semantic" | "episodic" | "world";
/** Every player's records (and the character's world memory), for inspection and erasure. */
export declare const ALL_PLAYERS: unique symbol;
export type PlayerScope = string | null | typeof ALL_PLAYERS;
/**
 * One thing a character remembers.
 *
 * `playerId` null means character-wide knowledge every player's session may
 * use; anything about one person carries their id and is never shown to
 * another player's session. `key` makes a record the current value of
 * something (the `language` preference): writing the same key replaces it.
 * `supersededBy` marks a memory a correction replaced; it is kept for
 * history and never recalled.
 */
export interface MemoryRecord {
    id: string;
    text: string;
    kind: MemoryKind;
    playerId: string | null;
    characterId: string;
    namespace: string;
    /** 0..1: how much this matters to the relationship. */
    importance: number;
    /** 0..1: how sure we are. App writes are 1; learned memories less. */
    confidence: number;
    /** `app`, `player`, `extraction`, `correction` or `import`. */
    source: string;
    key: string | null;
    sessionId: string | null;
    tags: string[];
    /** Seconds since the epoch, like every time here. */
    createdAt: number;
    updatedAt: number;
    expiresAt: number | null;
    lastRecalledAt: number | null;
    recallCount: number;
    supersededBy: string | null;
}
export declare function layerOf(record: Pick<MemoryRecord, "kind" | "playerId">): MemoryLayer;
export declare function isActive(record: MemoryRecord, now?: number): boolean;
export declare function newMemoryId(): string;
/** A record with defaults for everything not given. */
export declare function makeRecord(fields: Partial<MemoryRecord> & {
    text: string;
}): MemoryRecord;
export interface MemoryQuery {
    namespace: string;
    characterId: string | null;
    /** Specific players (null for world memory), or every one. */
    playerIds: Array<string | null> | typeof ALL_PLAYERS;
    kinds?: MemoryKind[];
    includeInactive?: boolean;
    limit?: number;
}
/**
 * Where records live. Implement this to keep memory in your own database.
 * Every scope is explicit on every call: a store never infers which player
 * a read is for.
 */
export interface MemoryStore {
    put(record: MemoryRecord): Promise<void>;
    get(id: string): Promise<MemoryRecord | null>;
    /** Remove records for good; returns how many there were. */
    delete(ids: string[]): Promise<number>;
    /** Records in scope, newest first. */
    query(query: MemoryQuery): Promise<MemoryRecord[]>;
    /** Active records matching `text`, each with a relevance in 0..1, best first. */
    search(text: string, scope: {
        namespace: string;
        characterId: string | null;
        playerIds: Array<string | null>;
        limit?: number;
    }): Promise<Array<[MemoryRecord, number]>>;
    /** Note that these records were recalled. */
    touch(ids: string[], at: number): Promise<void>;
    /** Remove every record in scope for good. */
    erase(scope: {
        namespace: string;
        characterId?: string | null;
        playerId?: PlayerScope;
    }): Promise<number>;
    close?(): Promise<void>;
}
//# sourceMappingURL=records.d.ts.map