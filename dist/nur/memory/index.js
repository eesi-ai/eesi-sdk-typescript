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
import { composeBlock, DEFAULT_BLOCK_BYTES, DEFAULT_WEIGHTS, rank } from "./recall.js";
import { ALL_PLAYERS, isActive, KINDS, makeRecord, } from "./records.js";
import { llmExtractor } from "./extraction.js";
import { fromPortable, InMemoryStore, queryTerms, toPortable } from "./stores.js";
export * from "./records.js";
export * from "./recall.js";
export * from "./extraction.js";
export * from "./stores.js";
export const EXPORT_FORMAT = "eesi.memory";
/** A store plus a policy: what you pass as a character's `memory`. */
export class Memory {
    store;
    namespace;
    policy;
    constructor(store = new InMemoryStore(), policy = {}, namespace = "default") {
        this.store = store;
        this.namespace = namespace;
        if (!/^[\w.:-]{1,128}$/.test(namespace))
            throw new Error("namespace must be 1-128 letters, digits, '_', '.', ':' or '-'.");
        this.policy = {
            extract: policy.extract ?? true,
            maxRecordsPerPlayer: policy.maxRecordsPerPlayer ?? 500,
            blockBytes: policy.blockBytes ?? DEFAULT_BLOCK_BYTES,
            recallOnTurn: policy.recallOnTurn ?? true,
            weights: policy.weights ?? DEFAULT_WEIGHTS,
            redact: policy.redact,
            extractor: policy.extractor,
            retentionDays: policy.retentionDays,
            rules: policy.rules,
        };
    }
}
function similar(a, b) {
    const left = new Set(queryTerms(a, 64));
    const right = new Set(queryTerms(b, 64));
    if (left.size === 0 || right.size === 0)
        return a.trim().toLowerCase() === b.trim().toLowerCase();
    const shared = [...left].filter((word) => right.has(word)).length;
    return shared / new Set([...left, ...right]).size >= 0.8;
}
/** One character's memory: every player's, and its own world knowledge. */
export class CharacterMemory {
    memory;
    characterId;
    characterName;
    chat;
    store;
    namespace;
    constructor(memory, characterId, characterName, chat = null) {
        this.memory = memory;
        this.characterId = characterId;
        this.characterName = characterName;
        this.chat = chat;
        this.store = memory.store;
        this.namespace = memory.namespace;
    }
    get policy() {
        return this.memory.policy;
    }
    forPlayer(playerId) {
        return new PlayerMemory(this, playerId);
    }
    clean(text) {
        const tidy = String(text).split(/\s+/).join(" ").trim();
        return this.policy.redact ? this.policy.redact(tidy) : tidy;
    }
    expiry(kind, created, ttl) {
        if (ttl !== undefined)
            return created + ttl;
        if (this.policy.retentionDays !== undefined && KINDS[kind] === "episodic")
            return created + this.policy.retentionDays * 86_400;
        return null;
    }
    scope(playerId, kinds) {
        return this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds: [playerId], kinds });
    }
    /** Keep `text`. With `key`, it replaces the player's earlier record of that key. */
    async remember(text, options = {}) {
        const cleaned = this.clean(text);
        if (!cleaned)
            throw new Error("A memory needs some text.");
        const kind = options.kind ?? "fact";
        if (!(kind in KINDS))
            throw new Error(`kind must be one of ${Object.keys(KINDS).join(", ")}.`);
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
            for (const old of await this.scope(playerId, [kind]))
                if (old.key === options.key)
                    replaces = replaces ?? old.id;
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
    async update(id, changes) {
        const record = await this.owned(id);
        if (!record)
            return null;
        const updated = { ...record, updatedAt: Date.now() / 1000 };
        if (changes.text !== undefined)
            updated.text = this.clean(changes.text);
        if (changes.importance !== undefined)
            updated.importance = Math.min(1, Math.max(0, changes.importance));
        if (changes.kind !== undefined)
            updated.kind = changes.kind;
        if (changes.tags !== undefined)
            updated.tags = [...changes.tags];
        if (changes.ttl !== undefined)
            updated.expiresAt = Date.now() / 1000 + changes.ttl;
        await this.store.put(updated);
        return updated;
    }
    /** Replace a memory that was wrong, keeping the old one as history. */
    async correct(id, text) {
        const old = await this.owned(id);
        if (!old)
            return null;
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
    async forget(...ids) {
        const owned = [];
        for (const id of ids)
            if (await this.owned(id))
                owned.push(id);
        return this.store.delete(owned);
    }
    /** Delete everything about one player, or with no player given, everything this character remembers. */
    async erase(options = {}) {
        return this.store.erase({ namespace: this.namespace, characterId: this.characterId, playerId: options.playerId ?? ALL_PLAYERS });
    }
    async get(id) {
        return this.owned(id);
    }
    /** Records, newest first. `playerId: null` lists the character's world memory. */
    async list(options = {}) {
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
    async search(query, options = {}) {
        const playerIds = options.playerId ? [options.playerId, null] : [null];
        return this.store.search(query, { namespace: this.namespace, characterId: this.characterId, playerIds, limit: options.limit ?? 10 });
    }
    /** What the character would bring to mind: ranked by relevance to `query`, importance and recency. */
    async recall(options = {}) {
        const playerIds = options.playerId ? [options.playerId, null] : [null];
        const candidates = await this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds, limit: 400 });
        const relevance = new Map();
        if (options.query) {
            for (const [record, score] of await this.store.search(options.query, { namespace: this.namespace, characterId: this.characterId, playerIds, limit: 40 })) {
                relevance.set(record.id, score);
            }
        }
        return rank(candidates, relevance, this.policy.weights).slice(0, options.limit ?? 12);
    }
    /** The `memory` block for a session, and the records in it. */
    async block(options) {
        const playerIds = options.playerId ? [options.playerId, null] : [null];
        const candidates = await this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds, limit: 400 });
        const relevance = new Map();
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
        if (result.used.length > 0)
            await this.store.touch(result.used.map((record) => record.id), Date.now() / 1000);
        return result;
    }
    /**
     * Extract and keep what a conversation is worth remembering. `transcript`
     * is `[speaker, text]` lines: "player", "event", or the character's name.
     * Use it for a conversation the SDK did not hold (a client that
     * connected with a client secret and sent you its transcript).
     */
    async learn(transcript, options) {
        const extractor = this.policy.extractor ?? (this.chat ? llmExtractor(this.chat, { rules: this.policy.rules }) : null);
        if (!extractor || !transcript.some(([, text]) => text.trim()))
            return { added: [], superseded: [], forgotten: [] };
        const existing = (await this.scope(options.playerId)).filter((record) => record.kind !== "summary").slice(0, 60);
        let result = await extractor({
            characterName: this.characterName,
            playerId: options.playerId,
            playerName: options.playerName ?? null,
            transcript,
            existing,
        });
        if (options.skipKinds?.length)
            result = { ...result, memories: result.memories.filter((memory) => !options.skipKinds.includes(memory.kind)) };
        return this.apply(result, { playerId: options.playerId, sessionId: options.sessionId ?? null, existing });
    }
    /** Write an extraction's memories: dedupe, supersede corrections, upsert keyed preferences. */
    async apply(result, options) {
        const existing = options.existing ?? (await this.scope(options.playerId));
        const added = [];
        const superseded = [];
        const forgotten = result.forget.filter((id) => existing.some((record) => record.id === id));
        if (forgotten.length > 0)
            await this.store.delete(forgotten);
        const live = existing.filter((record) => !forgotten.includes(record.id));
        for (const candidate of result.memories) {
            if (candidate.replaces === null && candidate.key === null && live.some((record) => similar(candidate.text, record.text)))
                continue;
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
            if (old)
                superseded.push(old);
        }
        if (result.summary) {
            added.push(await this.remember(result.summary, {
                playerId: options.playerId,
                kind: "summary",
                importance: 0.5,
                source: "extraction",
                confidence: 0.8,
                sessionId: options.sessionId ?? null,
            }));
        }
        await this.prune(options.playerId);
        return { added, superseded, forgotten };
    }
    async prune(playerId) {
        const limit = this.policy.maxRecordsPerPlayer;
        const records = await this.store.query({ namespace: this.namespace, characterId: this.characterId, playerIds: [playerId], includeInactive: true });
        if (records.length <= limit)
            return;
        const inactive = records.filter((record) => !isActive(record));
        const ranked = rank(records.filter((record) => isActive(record)), new Map(), this.policy.weights);
        const excess = records.length - limit;
        const doomed = inactive.map((record) => record.id).slice(0, excess);
        for (const [record] of ranked.reverse()) {
            if (doomed.length >= excess)
                break;
            doomed.push(record.id);
        }
        await this.store.delete(doomed);
    }
    /** Every record in scope, in the portable JSON the Python SDK also reads and writes. */
    async export(options = {}) {
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
    async importRecords(data) {
        const items = Array.isArray(data) ? data : (data.records ?? []);
        for (const item of items) {
            const record = fromPortable(item);
            await this.store.put({ ...record, characterId: this.characterId, namespace: this.namespace });
        }
        return items.length;
    }
    async owned(id) {
        const record = await this.store.get(id);
        return record && record.characterId === this.characterId && record.namespace === this.namespace ? record : null;
    }
}
/** One player's memories with one character: inspect, edit, delete. */
export class PlayerMemory {
    character;
    playerId;
    constructor(character, playerId) {
        this.character = character;
        this.playerId = playerId;
    }
    remember(text, options = {}) {
        return this.character.remember(text, { ...options, playerId: this.playerId });
    }
    list(options = {}) {
        return this.character.list({ ...options, playerId: this.playerId });
    }
    search(query, options = {}) {
        return this.character.search(query, { ...options, playerId: this.playerId });
    }
    recall(query, options = {}) {
        return this.character.recall({ playerId: this.playerId, query, limit: options.limit });
    }
    async preferences() {
        const records = await this.list({ kinds: ["preference"] });
        return Object.fromEntries(records.map((record) => [record.key ?? record.id, record.text]));
    }
    async correct(id, text) {
        const record = await this.character.get(id);
        return record && record.playerId === this.playerId ? this.character.correct(id, text) : null;
    }
    async forget(...ids) {
        const mine = [];
        for (const id of ids) {
            const record = await this.character.get(id);
            if (record && record.playerId === this.playerId)
                mine.push(id);
        }
        return this.character.forget(...mine);
    }
    erase() {
        return this.character.erase({ playerId: this.playerId });
    }
    export() {
        return this.character.export({ playerId: this.playerId });
    }
}
/** Copy every record of a namespace from one store to another (ids kept). */
export async function migrate(source, target, namespace = "default") {
    const records = await source.query({ namespace, characterId: null, playerIds: ALL_PLAYERS, includeInactive: true });
    for (const record of records)
        await target.put(record);
    return records.length;
}
//# sourceMappingURL=index.js.map