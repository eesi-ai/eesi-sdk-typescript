export declare const SDK_BLOCK_ORDER: readonly ["memory", "world", "mood", "party", "roster", "scene"];
export declare const SDK_LAST_BLOCKS: readonly ["recall"];
/** `key: value` lines in insertion order; nested objects become `key.sub: value`. */
export declare function renderFields(fields: Record<string, unknown>): string;
/** Named blocks of live state. A character's is shared by all its sessions; a session's is its own. */
export declare class LiveContext {
    readonly defaultBlock: string;
    private readonly clock;
    private blocksByName;
    private listeners;
    private expiry;
    constructor(defaultBlock: string, clock?: () => number);
    /** The live fields of a block (expired ones are gone). */
    get(block?: string): Record<string, unknown>;
    /** Every live field of every block, later blocks winning a shared name. */
    allFields(): Record<string, unknown>;
    blocks(): string[];
    render(block: string): string;
    /** Every block's text exactly as the model reads it. */
    snapshot(): Record<string, string>;
    /** Starting fields, set without notifying anyone (before any session exists). */
    seed(values: Record<string, unknown>, block?: string): void;
    /** Merge fields into a block. `null`/`undefined` removes a field; `ttlMs` expires the ones set. */
    update(values: Record<string, unknown>, options?: {
        block?: string;
        ttlMs?: number;
    }): Promise<void>;
    /** Replace a whole block: with text as written, with fields, or remove it (null or ""). */
    set(block: string, content: string | Record<string, unknown> | null): Promise<void>;
    remove(fields: string[], options?: {
        block?: string;
    }): Promise<void>;
    /** Remove one block, or every block. */
    clear(block?: string): Promise<void>;
    /** Call `listener(block)` whenever a block changes. Returns an unsubscribe function. */
    subscribe(listener: (block: string) => void): () => void;
    close(): void;
    private ensure;
    private checkSize;
    private changed;
    private scheduleExpiry;
}
/**
 * One session's view of every context source, sent as it changes: throttled
 * per block, only changed text, a stable order, and everything again after a
 * resume (the gateway does not keep blocks across one).
 */
export declare class ContextPublisher {
    private readonly send;
    private readonly sources;
    private readonly options;
    private extra;
    private sent;
    private lastAt;
    private timers;
    private ready;
    private refusedAll;
    private unsubscribe;
    private chain;
    constructor(send: (key: string, text: string) => Promise<void>, sources: LiveContext[], options?: {
        minIntervalMs?: number;
        onSent?: (key: string, text: string) => void;
        onError?: (error: Error) => void;
    });
    /** An SDK block (memory, party, mood, recall); empty text removes it. */
    setBlock(name: string, text: string): void;
    /** What the model holds now, by block. */
    current(): Record<string, string>;
    /** Every block's latest text, in send order. */
    desired(): Record<string, string>;
    validate(texts: Record<string, string>): void;
    /** Send everything (a new or resumed session). */
    start(): Promise<void>;
    stop(): void;
    /** The gateway does not take context at all: keep blocks, stop sending. */
    refused(): void;
    /** Send every changed block now, ignoring the throttle. Sends run one at a time, in order. */
    flush(only?: string): Promise<void>;
    close(): void;
    private changed;
}
//# sourceMappingURL=context.d.ts.map