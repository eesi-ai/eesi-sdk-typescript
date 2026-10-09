// Errors the Nur SDK raises on purpose. Each says what to fix. REST failures
// keep the REST client's `ApiError`, which carries the server's status and
// message.
import { EESISdkError } from "../errors.js";
/** Base class for everything the Nur SDK throws on purpose. */
export class NurError extends EESISdkError {
    constructor(message) {
        super(message);
        this.name = "NurError";
    }
}
/** An option is missing or cannot work: no API key, an unknown voice. */
export class ConfigurationError extends NurError {
    constructor(message) {
        super(message);
        this.name = "ConfigurationError";
    }
}
/** The gateway refused the credential. */
export class AuthenticationError extends NurError {
    constructor(message) {
        super(message);
        this.name = "AuthenticationError";
    }
}
/**
 * The realtime session could not be reached, or was lost for good.
 * `kind` says whether retrying can help: `at-limit` (capacity or quota; try
 * again later), `unavailable` (the backend is down) or `dropped`.
 */
export class RealtimeConnectionError extends NurError {
    code;
    kind;
    constructor(message, options = {}) {
        super(message);
        this.name = "RealtimeConnectionError";
        this.code = options.code ?? null;
        this.kind = options.kind ?? "dropped";
    }
}
/** An operation needed a live session, and this one has ended. */
export class SessionClosedError extends NurError {
    constructor(message = "This session has ended.") {
        super(message);
        this.name = "SessionClosedError";
    }
}
/** A live-context update the gateway would refuse: a bad key or a block over its limit. */
export class ContextError extends NurError {
    constructor(message) {
        super(message);
        this.name = "ContextError";
    }
}
/** A tool cannot be offered: a bad name, a duplicate, a schema that is not an object. */
export class ToolDefinitionError extends NurError {
    constructor(message) {
        super(message);
        this.name = "ToolDefinitionError";
    }
}
/** A memory store could not read or write. */
export class MemoryStoreError extends NurError {
    constructor(message) {
        super(message);
        this.name = "MemoryStoreError";
    }
}
//# sourceMappingURL=errors.js.map