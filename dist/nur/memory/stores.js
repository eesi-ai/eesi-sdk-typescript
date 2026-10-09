// A memory store that needs nothing: records in a Map. Node keeps them in a
// file with `FileMemoryStore` from `@eesi/sdk/node`; anything else (your own
// database) implements `MemoryStore`.
import { ALL_PLAYERS, isActive, layerOf } from "./records.js";
const STOPWORDS = new Set(`a an and are as at be but by can could did do does for from had has have he her him his how i if in
    into is it its just me my no not of on or our she so than that the their them then there these they this
    to too us was we were what when where which who why will with would you your yes ok okay oh um uh`.split(/\s+/));
const WORD = /[\p{L}\p{N}_]{2,}/gu;
/** The words of `text` worth searching for. */
export function queryTerms(text, limit = 24) {
    const seen = [];
    for (const match of text.toLowerCase().matchAll(WORD)) {
        const word = match[0];
        if (STOPWORDS.has(word) || (/^\d+$/.test(word) && word.length < 3) || seen.includes(word))
            continue;
        seen.push(word);
        if (seen.length >= limit)
            break;
    }
    return seen;
}
/** Word-overlap relevance in 0..1, best first. */
export function scoreByTerms(records, terms, limit) {
    if (terms.length === 0)
        return [];
    const scored = [];
    for (const record of records) {
        const words = new Set(record.text.toLowerCase().match(WORD) ?? []);
        let hits = 0;
        for (const term of terms) {
            if (words.has(term) || (term.length >= 4 && [...words].some((word) => word.startsWith(term))))
                hits += 1;
        }
        if (hits > 0)
            scored.push([record, hits / terms.length / (1 + Math.log1p(words.size) / 10)]);
    }
    if (scored.length === 0)
        return [];
    const best = Math.max(...scored.map(([, score]) => score)) || 1;
    return scored
        .map(([record, score]) => [record, score / best])
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}
function inScope(record, namespace, characterId, playerIds) {
    if (record.namespace !== namespace)
        return false;
    if (characterId !== null && record.characterId !== characterId)
        return false;
    return playerIds === ALL_PLAYERS || playerIds.includes(record.playerId);
}
function copy(record) {
    return { ...record, tags: [...record.tags] };
}
/** Records in memory: tests, demos and sessions that should leave no trace. */
export class InMemoryStore {
    records = new Map();
    async put(record) {
        this.records.set(record.id, copy(record));
    }
    async get(id) {
        const record = this.records.get(id);
        return record ? copy(record) : null;
    }
    async delete(ids) {
        let count = 0;
        for (const id of ids)
            if (this.records.delete(id))
                count += 1;
        return count;
    }
    async query({ namespace, characterId, playerIds, kinds, includeInactive, limit }) {
        const now = Date.now() / 1000;
        const found = [...this.records.values()]
            .filter((record) => inScope(record, namespace, characterId, playerIds))
            .filter((record) => !kinds || kinds.includes(record.kind))
            .filter((record) => includeInactive || isActive(record, now))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(copy);
        return limit ? found.slice(0, limit) : found;
    }
    async search(text, scope) {
        const records = await this.query({ namespace: scope.namespace, characterId: scope.characterId, playerIds: scope.playerIds });
        return scoreByTerms(records, queryTerms(text), scope.limit ?? 20);
    }
    async touch(ids, at) {
        for (const id of ids) {
            const record = this.records.get(id);
            if (record) {
                record.lastRecalledAt = at;
                record.recallCount += 1;
            }
        }
    }
    async erase(scope) {
        const doomed = [...this.records.values()]
            .filter((record) => record.namespace === scope.namespace &&
            (scope.characterId === undefined || scope.characterId === null || record.characterId === scope.characterId) &&
            (scope.playerId === undefined || scope.playerId === ALL_PLAYERS || record.playerId === scope.playerId))
            .map((record) => record.id);
        return this.delete(doomed);
    }
    /** Every record, for a store that persists them (see `FileMemoryStore`). */
    all() {
        return [...this.records.values()].map(copy);
    }
}
// ── the portable JSON form, shared with the Python SDK ───────────────────
/** A record as exported (snake_case), the same form the Python SDK writes. */
export function toPortable(record) {
    return {
        id: record.id,
        text: record.text,
        kind: record.kind,
        player_id: record.playerId,
        character_id: record.characterId,
        namespace: record.namespace,
        importance: record.importance,
        confidence: record.confidence,
        source: record.source,
        key: record.key,
        session_id: record.sessionId,
        tags: [...record.tags],
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        expires_at: record.expiresAt,
        last_recalled_at: record.lastRecalledAt,
        recall_count: record.recallCount,
        superseded_by: record.supersededBy,
        layer: layerOf(record),
    };
}
/** A record from its portable form (snake_case or camelCase). */
export function fromPortable(data) {
    const pick = (snake, camel, fallback) => (data[snake] ?? data[camel] ?? fallback);
    return {
        id: pick("id", "id", ""),
        text: pick("text", "text", ""),
        kind: pick("kind", "kind", "fact"),
        playerId: pick("player_id", "playerId", null),
        characterId: pick("character_id", "characterId", ""),
        namespace: pick("namespace", "namespace", "default"),
        importance: pick("importance", "importance", 0.5),
        confidence: pick("confidence", "confidence", 1),
        source: pick("source", "source", "import"),
        key: pick("key", "key", null),
        sessionId: pick("session_id", "sessionId", null),
        tags: [...pick("tags", "tags", [])],
        createdAt: pick("created_at", "createdAt", Date.now() / 1000),
        updatedAt: pick("updated_at", "updatedAt", Date.now() / 1000),
        expiresAt: pick("expires_at", "expiresAt", null),
        lastRecalledAt: pick("last_recalled_at", "lastRecalledAt", null),
        recallCount: pick("recall_count", "recallCount", 0),
        supersededBy: pick("superseded_by", "supersededBy", null),
    };
}
//# sourceMappingURL=stores.js.map