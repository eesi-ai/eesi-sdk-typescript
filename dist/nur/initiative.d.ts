export declare const DEFAULT_TTL_MS = 8000;
export interface Moment {
    /** One kind at a time: a newer moment replaces a queued one of its kind. */
    kind: string;
    /** What happened, for the character to put in its own words. */
    what: string;
    /** Instructions for this one reply; the default asks for one short sentence. */
    instructions?: string;
    /** Urgent moments skip the global cooldown and go first. */
    urgent?: boolean;
    /** No second moment of this kind within this long. */
    cooldownMs?: number;
    /** A moment older than this is stale and dropped. */
    ttlMs?: number;
}
export declare function momentInstructions(moment: Moment): string;
export declare class Initiative {
    private readonly speak;
    private readonly options;
    private queue;
    private lastSpoke;
    private lastByKind;
    private userSpeaking;
    private busy;
    private holdUntil;
    private timer;
    private watchdog;
    constructor(speak: (moment: Moment) => void, options?: {
        globalCooldownMs?: number;
        replyGraceMs?: number;
    });
    offer(moment: Moment): void;
    pending(): Moment[];
    userStarted(): void;
    userStopped(): void;
    responseStarted(): void;
    responseDone(): void;
    dispose(): void;
    private tryNow;
    private clearWatchdog;
}
//# sourceMappingURL=initiative.d.ts.map