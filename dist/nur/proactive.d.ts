export declare const IDLE_SKIP = "SKIP";
/** When a character may speak up on its own. */
export interface Proactive {
    /** Quiet before it considers a remark. Default 25000; null turns idle remarks off. */
    idleAfterMs?: number | null;
    /** The least time between two considerations, spoken or not (each is one short model call). Default 60000. */
    cooldownMs?: number;
    /** A cap on idle remarks per session. */
    maxRemarks?: number | null;
    /** What kind of remark you want ("point out quest hints"), added to the character's own judgement. */
    guidance?: string | null;
}
export declare function idlePrompt(proactive: Proactive): string;
export type State = Record<string, unknown>;
export interface TriggerOptions {
    kind?: string;
    cooldownMs?: number;
    urgent?: boolean;
    /** Fire only the first time in a session. */
    once?: boolean;
    instructions?: string;
}
/** A remark the character makes when live state turns a condition true. */
export declare class Trigger {
    readonly condition: (state: State) => boolean;
    readonly what: string | ((state: State) => string);
    readonly options: TriggerOptions;
    readonly kind: string;
    private wasTrue;
    private fired;
    constructor(condition: (state: State) => boolean, what: string | ((state: State) => string), options?: TriggerOptions);
    /** The remark to offer now, if the condition just became true. */
    check(state: State): string | null;
    /** This trigger with no history, for a new session. */
    fresh(): Trigger;
}
//# sourceMappingURL=proactive.d.ts.map