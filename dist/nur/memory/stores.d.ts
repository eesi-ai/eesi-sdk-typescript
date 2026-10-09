import { type MemoryQuery, type MemoryRecord, type MemoryStore, type PlayerScope } from "./records.js";
/** The words of `text` worth searching for. */
export declare function queryTerms(text: string, limit?: number): string[];
/** Word-overlap relevance in 0..1, best first. */
export declare function scoreByTerms(records: MemoryRecord[], terms: string[], limit: number): Array<[MemoryRecord, number]>;
/** Records in memory: tests, demos and sessions that should leave no trace. */
export declare class InMemoryStore implements MemoryStore {
    protected records: Map<string, MemoryRecord>;
    put(record: MemoryRecord): Promise<void>;
    get(id: string): Promise<MemoryRecord | null>;
    delete(ids: string[]): Promise<number>;
    query({ namespace, characterId, playerIds, kinds, includeInactive, limit }: MemoryQuery): Promise<MemoryRecord[]>;
    search(text: string, scope: {
        namespace: string;
        characterId: string | null;
        playerIds: Array<string | null>;
        limit?: number;
    }): Promise<Array<[MemoryRecord, number]>>;
    touch(ids: string[], at: number): Promise<void>;
    erase(scope: {
        namespace: string;
        characterId?: string | null;
        playerId?: PlayerScope;
    }): Promise<number>;
    /** Every record, for a store that persists them (see `FileMemoryStore`). */
    all(): MemoryRecord[];
}
/** A record as exported (snake_case), the same form the Python SDK writes. */
export declare function toPortable(record: MemoryRecord): Record<string, unknown>;
/** A record from its portable form (snake_case or camelCase). */
export declare function fromPortable(data: Record<string, unknown>): MemoryRecord;
//# sourceMappingURL=stores.d.ts.map