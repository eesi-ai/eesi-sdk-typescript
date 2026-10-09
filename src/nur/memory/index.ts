// Long-term memory for characters.
//
//     const kael = nur.npc({ name: "Kael", memory: true });          // in memory; Node: memory: fileMemory("./kael")
//     await kael.remember("The northern bridge collapsed.");          // every player's Kael knows
//     await kael.remember("They betrayed the alliance.", { playerId: "p42" });  // only p42's sessions
//     await kael.memory!.forPlayer("p42").list();                     // inspect
//     await kael.memory!.erase({ playerId: "p42" });                  // forget them completely
//
// Layers: working memory is the live conversation, held by the runtime.
// Episodic memories are what happened; semantic ones what is true of the
// player; world ones belong to no player. A player's memories are only ever
// recalled into that player's sessions. A session starts with the most
// relevant memories as a `memory` block, recalls more as the player talks,
// and learns what was worth keeping when it ends.

import { composeBlock, DEFAULT_BLOCK_BYTES, DEFAULT_WEIGHTS, rank, type RecallWeights } from "./recall.js";
import {
    ALL_PLAYERS,
    isActive,
    KINDS,
    makeRecord,
    type MemoryKind,
    type MemoryRecord,
    type MemoryStore,
    type PlayerScope,
} from "./records.js";
import { type Chat, type ExtractionResult, type Extractor, llmExtractor } from "./extraction.js";
import { fromPortable, InMemoryStore, queryTerms, toPortable } from "./stores.js";

export * from "./records.js";
export * from "./recall.js";
export * from "./extraction.js";
export * from "./stores.js";

export const EXPORT_FORMAT = "eesi.memory";

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
}

/** A store plus a policy: what you pass as a character's `memory`. */
export class Memory {
    readonly policy: Required<Omit<MemoryPolicy, "redact" | "extractor" | "retentionDays">> & Pick<MemoryPolicy, "redact" | "extractor" | "retentionDays">;

    constructor(
        readonly store: MemoryStore = new InMemoryStore(),
        policy: MemoryPolicy = {},
        readonly namespace = "default",
    ) {
        if (!/^[\w.:-]{1,128}$/.test(namespace)) throw new Error("namespace must be 1-128 letters, digits, '_', '.', ':' or '-'.");
        this.policy = {
            extract: policy.extract ?? true,
            maxRecordsPerPlayer: policy.maxRecordsPerPlayer ?? 500,
            blockBytes: policy.blockBytes ?? DEFAULT_BLOCK_BYTES,
            recallOnTurn: policy.recallOnTurn ?? true,
            weights: policy.weights ?? DEFAULT_WEIGHTS,
            redact: policy.redact,
            extractor: policy.extractor,
            retentionDays: policy.retentionDays,
        };
    }
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

function similar(a: string, b: string): boolean {
    const left = new Set(queryTerms(a, 64));
    const right = new Set(queryTerms(b, 64));
    if (left.size === 0 || right.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
    const shared = [...left].filter((word) => right.has(word)).length;
    return shared / new Set([...left, ...right]).size >= 0.8;
}

/** One character's memory: every player's, and its own world knowledge. */
export class CharacterMemory {
    readonly store: MemoryStore;
    readonly namespace: string;

    constructor(
        readonly memory: Memory,
        readonly characterId: string,
        readonly characterName: string,
        private readonly chat: Chat | null = null,
    ) {
        this.store = memory.store;
        this.namespace = memory.namespace;
    }

    get policy(): Memory["policy"] {
        return this.memory.policy;
    }

    forPlayer(playerId: string): PlayerMemory {
        return new PlayerMemory(this, playerId);
    }

    private clean(text: string): string {
        const tidy = String(text).split(/\s+/).join(" ").trim();
        return this.policy.redact ? this.policy.redact(tidy) : tidy;
    }

    private expiry(kind: MemoryKind, created: number, ttl?: number): number | null {
        if (ttl !== undefined) return created + ttl;
        if (this.policy.retentionDays !== undefined && KINDS[kind] === "episodic") return created + this.policy.retentionDays * 86_400;
        return null;
    }

    private scope(playerId: string | null, kinds?: MemoryKind[]): Promise<MemoryRecord[]> {
        return this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds: [playerId], kinds });
    }

    /** Keep `text`. With `key`, it replaces the player's earlier record of that key. */
    async remember(text: string, options: RememberOptions = {}): Promise<MemoryRecord> {
        const cleaned = this.clean(text);
        if (!cleaned) throw new Error("A memory needs some text.");
        const kind = options.kind ?? "fact";
        if (!(kind in KINDS)) throw new Error(`kind must be one of ${Object.keys(KINDS).join(", ")}.`);
        const playerId = options.playerId ?? null;
        const now = Date.now() / 1000;
        const record = makeRecord({
            text: cleaned,
            kind,
            playerId,
            characterId: this.characterId,
            namespace: this.namespace,
            importance: options.importance ?? 0.6,
            confidence: options.confidence ?? 1,
            source: options.source ?? "app",
            key: options.key ?? null,
            sessionId: options.sessionId ?? null,
            tags: options.tags ?? [],
            createdAt: now,
            expiresAt: this.expiry(kind, now, options.ttl),
        });
        let replaces = options.replaces ?? null;
        if (options.key) {
            for (const old of await this.scope(playerId, [kind])) if (old.key === options.key) replaces = replaces ?? old.id;
        }
        await this.store.put(record);
        if (replaces) {
            const old = await this.store.get(replaces);
            if (old && old.characterId === this.characterId && old.playerId === playerId) {
                await this.store.put({ ...old, supersededBy: record.id, updatedAt: now });
            }
        }
        return record;
    }

    /** Edit a record in place (your own correction of what is stored). */
    async update(id: string, changes: { text?: string; importance?: number; kind?: MemoryKind; tags?: string[]; ttl?: number }): Promise<MemoryRecord | null> {
        const record = await this.owned(id);
        if (!record) return null;
        const updated: MemoryRecord = { ...record, updatedAt: Date.now() / 1000 };
        if (changes.text !== undefined) updated.text = this.clean(changes.text);
        if (changes.importance !== undefined) updated.importance = Math.min(1, Math.max(0, changes.importance));
        if (changes.kind !== undefined) updated.kind = changes.kind;
        if (changes.tags !== undefined) updated.tags = [...changes.tags];
        if (changes.ttl !== undefined) updated.expiresAt = Date.now() / 1000 + changes.ttl;
        await this.store.put(updated);
        return updated;
    }

    /** Replace a memory that was wrong, keeping the old one as history. */
    async correct(id: string, text: string): Promise<MemoryRecord | null> {
        const old = await this.owned(id);
        if (!old) return null;
        return this.remember(text, {
            playerId: old.playerId,
            kind: old.kind,
            importance: old.importance,
            key: old.key,
            tags: old.tags,
            source: "correction",
            replaces: old.id,
        });
    }

    /** Delete records for good. */
    async forget(...ids: string[]): Promise<number> {
        const owned: string[] = [];
        for (const id of ids) if (await this.owned(id)) owned.push(id);
        return this.store.delete(owned);
    }

    /** Delete everything about one player, or with no player given, everything this character remembers. */
    async erase(options: { playerId?: PlayerScope } = {}): Promise<number> {
        return this.store.erase({ namespace: this.namespace, characterId: this.characterId, playerId: options.playerId ?? ALL_PLAYERS });
    }

    async get(id: string): Promise<MemoryRecord | null> {
        return this.owned(id);
    }

    /** Records, newest first. `playerId: null` lists the character's world memory. */
    async list(options: { playerId?: PlayerScope; kinds?: MemoryKind[]; includeInactive?: boolean; limit?: number } = {}): Promise<MemoryRecord[]> {
        const scope = options.playerId === undefined || options.playerId === ALL_PLAYERS ? ALL_PLAYERS : [options.playerId];
        return this.store.query({
            namespace: this.namespace,
            characterId: this.characterId,
            playerIds: scope,
            kinds: options.kinds,
            includeInactive: options.includeInactive,
            limit: options.limit,
        });
    }

    /** Records matching `query`: the player's and the character's world memory. */
    async search(query: string, options: { playerId?: string | null; limit?: number } = {}): Promise<Array<[MemoryRecord, number]>> {
        const playerIds = options.playerId ? [options.playerId, null] : [null];
        return this.store.search(query, { namespace: this.namespace, characterId: this.characterId, playerIds, limit: options.limit ?? 10 });
    }

    /** What the character would bring to mind: ranked by relevance to `query`, importance and recency. */
    async recall(options: { playerId?: string | null; query?: string; limit?: number } = {}): Promise<Array<[MemoryRecord, number]>> {
        const playerIds = options.playerId ? [options.playerId, null] : [null];
        const candidates = await this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds, limit: 400 });
        const relevance = new Map<string, number>();
        if (options.query) {
            for (const [record, score] of await this.store.search(options.query, { namespace: this.namespace, characterId: this.characterId, playerIds, limit: 40 })) {
                relevance.set(record.id, score);
            }
        }
        return rank(candidates, relevance, this.policy.weights).slice(0, options.limit ?? 12);
    }

    /** The `memory` block for a session, and the records in it. */
    async block(options: { playerId: string | null; playerName?: string | null; query?: string; sessionPreferences?: Record<string, string> }): Promise<{ text: string; used: MemoryRecord[] }> {
        const playerIds = options.playerId ? [options.playerId, null] : [null];
        const candidates = await this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds, limit: 400 });
        const relevance = new Map<string, number>();
        if (options.query) {
            for (const [record, score] of await this.store.search(options.query, { namespace: this.namespace, characterId: this.characterId, playerIds, limit: 40 })) {
                relevance.set(record.id, score);
            }
        }
        const result = composeBlock(rank(candidates, relevance, this.policy.weights), {
            playerName: options.playerName ?? null,
            firstMeeting: options.playerId !== null,
            budgetBytes: this.policy.blockBytes,
            sessionPreferences: options.sessionPreferences,
        });
        if (result.used.length > 0) await this.store.touch(result.used.map((record) => record.id), Date.now() / 1000);
        return result;
    }

    /**
     * Extract and keep what a conversation is worth remembering. `transcript`
     * is `[speaker, text]` lines: "player", "event", or the character's name.
     * Use it for a conversation the SDK did not hold (a client that
     * connected with a client secret and sent you its transcript).
     */
    async learn(
        transcript: Array<[string, string]>,
        options: { playerId: string; playerName?: string | null; sessionId?: string | null; skipKinds?: MemoryKind[] },
    ): Promise<{ added: MemoryRecord[]; superseded: MemoryRecord[]; forgotten: string[] }> {
        const extractor = this.policy.extractor ?? (this.chat ? llmExtractor(this.chat) : null);
        if (!extractor || !transcript.some(([, text]) => text.trim())) return { added: [], superseded: [], forgotten: [] };
        const existing = (await this.scope(options.playerId)).filter((record) => record.kind !== "summary").slice(0, 60);
        let result = await extractor({
            characterName: this.characterName,
            playerId: options.playerId,
            playerName: options.playerName ?? null,
            transcript,
            existing,
        });
        if (options.skipKinds?.length) result = { ...result, memories: result.memories.filter((memory) => !options.skipKinds!.includes(memory.kind)) };
        return this.apply(result, { playerId: options.playerId, sessionId: options.sessionId ?? null, existing });
    }

    /** Write an extraction's memories: dedupe, supersede corrections, upsert keyed preferences. */
    async apply(
        result: ExtractionResult,
        options: { playerId: string; sessionId?: string | null; existing?: MemoryRecord[] },
    ): Promise<{ added: MemoryRecord[]; superseded: MemoryRecord[]; forgotten: string[] }> {
        const existing = options.existing ?? (await this.scope(options.playerId));
        const added: MemoryRecord[] = [];
        const superseded: MemoryRecord[] = [];
        const forgotten = result.forget.filter((id) => existing.some((record) => record.id === id));
        if (forgotten.length > 0) await this.store.delete(forgotten);
        const live = existing.filter((record) => !forgotten.includes(record.id));
        for (const candidate of result.memories) {
            if (candidate.replaces === null && candidate.key === null && live.some((record) => similar(candidate.text, record.text))) continue;
            const replaces = live.some((record) => record.id === candidate.replaces) ? candidate.replaces : null;
            const record = await this.remember(candidate.text, {
                playerId: options.playerId,
                kind: candidate.kind,
                importance: candidate.importance,
                key: candidate.key,
                source: "extraction",
                confidence: 0.8,
                sessionId: options.sessionId ?? null,
                replaces,
            });
            added.push(record);
            live.push(record);
            const old = replaces ? existing.find((item) => item.id === replaces) : undefined;
            if (old) superseded.push(old);
        }
        if (result.summary) {
            added.push(
                await this.remember(result.summary, {
                    playerId: options.playerId,
                    kind: "summary",
                    importance: 0.5,
                    source: "extraction",
                    confidence: 0.8,
                    sessionId: options.sessionId ?? null,
                }),
            );
        }
        await this.prune(options.playerId);
        return { added, superseded, forgotten };
    }

    private async prune(playerId: string): Promise<void> {
        const limit = this.policy.maxRecordsPerPlayer;
        const records = await this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds: [playerId], includeInactive: true });
        if (records.length <= limit) return;
        const inactive = records.filter((record) => !isActive(record));
        const ranked = rank(records.filter((record) => isActive(record)), new Map(), this.policy.weights);
        const excess = records.length - limit;
        const doomed = inactive.map((record) => record.id).slice(0, excess);
        for (const [record] of ranked.reverse()) {
            if (doomed.length >= excess) break;
            doomed.push(record.id);
        }
        await this.store.delete(doomed);
    }

    /** Every record in scope, in the portable JSON the Python SDK also reads and writes. */
    async export(options: { playerId?: PlayerScope } = {}): Promise<Record<string, unknown>> {
        const records = await this.list({ playerId: options.playerId, includeInactive: true });
        return {
            format: EXPORT_FORMAT,
            version: 1,
            exported_at: Date.now() / 1000,
            namespace: this.namespace,
            character_id: this.characterId,
            records: records.map(toPortable),
        };
    }

    /** Load records exported by either SDK into this character. */
    async importRecords(data: Record<string, unknown> | Array<Record<string, unknown>>): Promise<number> {
        const items = Array.isArray(data) ? data : ((data.records as Array<Record<string, unknown>> | undefined) ?? []);
        for (const item of items) {
            const record = fromPortable(item);
            await this.store.put({ ...record, characterId: this.characterId, namespace: this.namespace });
        }
        return items.length;
    }

    private async owned(id: string): Promise<MemoryRecord | null> {
        const record = await this.store.get(id);
        return record && record.characterId === this.characterId && record.namespace === this.namespace ? record : null;
    }
}

/** One player's memories with one character: inspect, edit, delete. */
export class PlayerMemory {
    constructor(
        readonly character: CharacterMemory,
        readonly playerId: string,
    ) {}

    remember(text: string, options: Omit<RememberOptions, "playerId"> = {}): Promise<MemoryRecord> {
        return this.character.remember(text, { ...options, playerId: this.playerId });
    }

    list(options: { kinds?: MemoryKind[]; includeInactive?: boolean } = {}): Promise<MemoryRecord[]> {
        return this.character.list({ ...options, playerId: this.playerId });
    }

    search(query: string, options: { limit?: number } = {}): Promise<Array<[MemoryRecord, number]>> {
        return this.character.search(query, { ...options, playerId: this.playerId });
    }

    recall(query?: string, options: { limit?: number } = {}): Promise<Array<[MemoryRecord, number]>> {
        return this.character.recall({ playerId: this.playerId, query, limit: options.limit });
    }

    async preferences(): Promise<Record<string, string>> {
        const records = await this.list({ kinds: ["preference"] });
        return Object.fromEntries(records.map((record) => [record.key ?? record.id, record.text]));
    }

    async correct(id: string, text: string): Promise<MemoryRecord | null> {
        const record = await this.character.get(id);
        return record && record.playerId === this.playerId ? this.character.correct(id, text) : null;
    }

    async forget(...ids: string[]): Promise<number> {
        const mine: string[] = [];
        for (const id of ids) {
            const record = await this.character.get(id);
            if (record && record.playerId === this.playerId) mine.push(id);
        }
        return this.character.forget(...mine);
    }

    erase(): Promise<number> {
        return this.character.erase({ playerId: this.playerId });
    }

    export(): Promise<Record<string, unknown>> {
        return this.character.export({ playerId: this.playerId });
    }
}

/** Copy every record of a namespace from one store to another (ids kept). */
export async function migrate(source: MemoryStore, target: MemoryStore, namespace = "default"): Promise<number> {
    const records = await source.query({ namespace, characterId: null, playerIds: ALL_PLAYERS, includeInactive: true });
    for (const record of records) await target.put(record);
    return records.length;
}
