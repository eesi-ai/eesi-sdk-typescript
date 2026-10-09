import type { NurEvent } from "./events.js";
export interface TraceOptions {
    /** Record the words people said, not only their length. Default false. */
    content?: boolean;
    /** Called once when the session closes the trace. */
    onClose?: () => void;
}
/** A JSONL timeline of one session. `lines` keeps the latest 5000. */
export declare class Trace {
    private readonly sink;
    private readonly options;
    readonly content: boolean;
    readonly lines: Array<Record<string, unknown>>;
    private t0;
    constructor(sink?: ((line: string) => void) | null, options?: TraceOptions);
    open(): void;
    write(kind: string, data?: Record<string, unknown>): void;
    event(event: NurEvent): void;
    close(): void;
}
/** A trace as a readable timeline. */
export declare function formatTrace(lines: Array<Record<string, unknown>>): string;
//# sourceMappingURL=trace.d.ts.map