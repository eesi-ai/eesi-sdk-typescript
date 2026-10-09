import { EESISdkError } from "../errors.js";
/** Base class for everything the Nur SDK throws on purpose. */
export declare class NurError extends EESISdkError {
    constructor(message: string);
}
/** An option is missing or cannot work: no API key, an unknown voice. */
export declare class ConfigurationError extends NurError {
    constructor(message: string);
}
/** The gateway refused the credential. */
export declare class AuthenticationError extends NurError {
    constructor(message: string);
}
/**
 * The realtime session could not be reached, or was lost for good.
 * `kind` says whether retrying can help: `at-limit` (capacity or quota; try
 * again later), `unavailable` (the backend is down) or `dropped`.
 */
export declare class RealtimeConnectionError extends NurError {
    readonly code: number | null;
    readonly kind: "at-limit" | "unavailable" | "dropped";
    constructor(message: string, options?: {
        code?: number | null;
        kind?: "at-limit" | "unavailable" | "dropped";
    });
}
/** An operation needed a live session, and this one has ended. */
export declare class SessionClosedError extends NurError {
    constructor(message?: string);
}
/** A live-context update the gateway would refuse: a bad key or a block over its limit. */
export declare class ContextError extends NurError {
    constructor(message: string);
}
/** A tool cannot be offered: a bad name, a duplicate, a schema that is not an object. */
export declare class ToolDefinitionError extends NurError {
    constructor(message: string);
}
/** A memory store could not read or write. */
export declare class MemoryStoreError extends NurError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map