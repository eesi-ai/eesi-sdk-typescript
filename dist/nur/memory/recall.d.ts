import type { MemoryRecord } from "./records.js";
/** The memory block's default size: about 700 tokens, a fraction of the context. */
export declare const DEFAULT_BLOCK_BYTES = 3000;
export interface RecallWeights {
    relevance: number;
    importance: number;
    recency: number;
    /** A memory this many days old counts half as recent. */
    halfLifeDays: number;
}
export declare const DEFAULT_WEIGHTS: RecallWeights;
/** Records with a score in 0..1, best first. */
export declare function rank(records: MemoryRecord[], relevance?: Map<string, number>, weights?: RecallWeights, now?: number): Array<[MemoryRecord, number]>;
/** "today", "yesterday", "3 days ago", "5 weeks ago". */
export declare function relativeAge(then: number, now?: number): string;
/** The `memory` block's text and the records it used. */
export declare function composeBlock(ranked: Array<[MemoryRecord, number]>, options: {
    playerName: string | null;
    firstMeeting: boolean;
    budgetBytes?: number;
    sessionPreferences?: Record<string, string>;
    now?: number;
}): {
    text: string;
    used: MemoryRecord[];
};
//# sourceMappingURL=recall.d.ts.map