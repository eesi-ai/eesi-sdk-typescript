// What a memory is, and where memories are kept.
import { randomHex } from "../protocol.js";
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
};
/** Every player's records (and the character's world memory), for inspection and erasure. */
export const ALL_PLAYERS = Symbol("ALL_PLAYERS");
export function layerOf(record) {
    return record.playerId === null ? "world" : KINDS[record.kind];
}
export function isActive(record, now = Date.now() / 1000) {
    return record.supersededBy === null && (record.expiresAt === null || record.expiresAt > now);
}
export function newMemoryId() {
    return `mem_${randomHex(20)}`;
}
/** A record with defaults for everything not given. */
export function makeRecord(fields) {
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
//# sourceMappingURL=records.js.map