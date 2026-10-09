// What happens in a session, as typed events.
//
// Every event has a `type` ("transcript.final", "tool.completed") and `at`,
// the seconds since the session started. Subscribe with a callback, wait for
// one, or iterate:
//
//     session.on("transcript.final", (event) => console.log(event.playerId, event.text));
//     const reply = await session.wait("response.completed");
//     for await (const event of session.stream()) { … }
//
// Callbacks may be async; a slow one never holds up the audio, and one that
// throws is logged and the session goes on. `on("tool.*")` matches every
// tool event, `on("*")` every event. Audio chunks reach callbacks that ask
// for them by name, and reach `stream()` only with `{ includeAudio: true }`.
function matches(pattern, type) {
    if (pattern === "*")
        return true;
    if (pattern.endsWith(".*"))
        return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
}
/** Fan-out of events to callbacks, waiters and async iterators. */
export class EventBus {
    logger;
    parent;
    handlers = [];
    streams = new Set();
    constructor(logger = console, parent = null) {
        this.logger = logger;
        this.parent = parent;
    }
    /** Call `handler` for events matching `pattern`. Returns a function that unsubscribes. */
    on(pattern, handler) {
        const entry = { pattern, handler: handler };
        this.handlers.push(entry);
        return () => {
            this.handlers = this.handlers.filter((item) => item !== entry);
        };
    }
    off(handler) {
        this.handlers = this.handlers.filter((item) => item.handler !== handler);
    }
    /** Deliver an event now. Never throws; never waits on a handler. */
    emit(event) {
        for (const { pattern, handler } of [...this.handlers]) {
            if (pattern === "*" && event.type === "audio.output.chunk")
                continue;
            if (!matches(pattern, event.type))
                continue;
            try {
                const result = handler(event);
                if (result && typeof result.then === "function") {
                    result.catch((error) => this.logger.error(`event handler for ${event.type} failed`, error));
                }
            }
            catch (error) {
                this.logger.error(`event handler for ${event.type} failed`, error);
            }
        }
        for (const stream of this.streams) {
            if (event.type === "audio.output.chunk" && !stream.includeAudio)
                continue;
            if (stream.queue.length >= 1000) {
                this.logger.warn(`event stream is full; dropped ${event.type} (read events faster)`);
                continue;
            }
            stream.queue.push(event);
            stream.wake?.();
        }
        this.parent?.emit(event);
    }
    /** The next event matching `pattern` (and `predicate`), or a rejection after `timeoutMs`. */
    wait(pattern, options = {}) {
        return new Promise((resolve, reject) => {
            let timer;
            const unsubscribe = this.on(pattern, (event) => {
                if (options.predicate && !options.predicate(event))
                    return;
                if (timer)
                    clearTimeout(timer);
                unsubscribe();
                resolve(event);
            });
            if (options.timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    unsubscribe();
                    reject(new Error(`no ${pattern} event within ${options.timeoutMs} ms`));
                }, options.timeoutMs);
            }
        });
    }
    /** Events from now until `close()`. */
    async *stream(options = {}) {
        const stream = { queue: [], wake: null, includeAudio: options.includeAudio ?? false, closed: false };
        this.streams.add(stream);
        try {
            for (;;) {
                const next = stream.queue.shift();
                if (next) {
                    yield next;
                    continue;
                }
                if (stream.closed)
                    return;
                await new Promise((wake) => {
                    stream.wake = wake;
                });
                stream.wake = null;
            }
        }
        finally {
            this.streams.delete(stream);
        }
    }
    /** End every `stream()`. */
    close() {
        for (const stream of this.streams) {
            stream.closed = true;
            stream.wake?.();
        }
    }
}
//# sourceMappingURL=events.js.map