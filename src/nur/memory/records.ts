// What a memory is, and where memories are kept.

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
export const KINDS = {
    fact: "semantic",
    preference: "semantic",
    relationship: "semantic",
    note: "semantic",
    event: "episodic",
    promise: "episodic",
    summary: "episodic",
    lore: "world",
} as const;

export type MemoryKind = keyof typeof KINDS;
export type MemoryLayer = "semantic" | "episodic" | "world";

/** Every player's records (and the character's world memory), for inspection and erasure. */
export const ALL_PLAYERS: unique symbol = Symbol("ALL_PLAYERS");
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

export function layerOf(record: Pick<MemoryRecord, "kind" | "playerId">): MemoryLayer {
    return record.playerId === null ? "world" : KINDS[record.kind];
}

export function isActive(record: MemoryRecord, now = Date.now() / 1000): boolean {
    return record.supersededBy === null && (record.expiresAt === null || record.expiresAt > now);
}

export function newMemoryId(): string {
    const bytes = new Uint8Array(10);
    globalThis.crypto.getRandomValues(bytes);
    return `mem_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A record with defaults for everything not given. */
export function makeRecord(fields: Partial<MemoryRecord> & { text: string }): MemoryRecord {
    const now = Date.now() / 1000;
    const createdAt = fields.createdAt ?? now;
    return {
        id: fields.id ?? newMemoryId(),
        text: fields.text,
        kind: fields.kind ?? "fact",
        playerId: fields.playerId ?? null,
        characterId: fields.characterId ?? "",
        namespace: fields.namespace ?? "default",
        importance: Math.min(1, Math.max(0, fields.importance ?? 0.5)),
        confidence: Math.min(1, Math.max(0, fields.confidence ?? 1)),
        source: fields.source ?? "app",
        key: fields.key ?? null,
        sessionId: fields.sessionId ?? null,
        tags: [...(fields.tags ?? [])],
        createdAt,
        updatedAt: fields.updatedAt ?? createdAt,
        expiresAt: fields.expiresAt ?? null,
        lastRecalledAt: fields.lastRecalledAt ?? null,
        recallCount: fields.recallCount ?? 0,
        supersededBy: fields.supersededBy ?? null,
    };
}

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
    search(text: string, scope: { namespace: string; characterId: string | null; playerIds: Array<string | null>; limit?: number }): Promise<Array<[MemoryRecord, number]>>;
    /** Note that these records were recalled. */
    touch(ids: string[], at: number): Promise<void>;
    /** Remove every record in scope for good. */
    erase(scope: { namespace: string; characterId?: string | null; playerId?: PlayerScope }): Promise<number>;
    close?(): Promise<void>;
}
