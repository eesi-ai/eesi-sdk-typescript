// Live context: what is true right now, beside the conversation.
//
//     await kael.context.update({ timeOfDay: "dusk", weather: "rain" });   // every session of Kael
//     await session.context.update({ location: "Northern Gate", health: "6/20" });  // this session only
//
// Context is kept in named blocks, each sent to the gateway as one
// `eesi.context.update` and placed after the character's instructions. A
// block never enters the conversation history and never starts a reply by
// itself; when it disagrees with something said earlier, it wins. Your
// application stays the authority: nothing the model says changes a block.
//
// Updates merge field by field (`null` or `undefined` removes a field), may
// expire (`ttlMs`), and are sent at most a few times a second and only when
// a block's text changed, so a game can update every frame. Blocks go out in
// a stable order, slow-changing first (`memory`, the character's `world`,
// `mood`, `party`, `roster`, the session's `scene`, your own blocks) and
// `recall` last, so a change never invalidates the cached prompt before it.

import { ContextError } from "./errors.js";
import { byteLength, CONTEXT_KEY, MAX_CONTEXT_BLOCK_BYTES, MAX_CONTEXT_KEYS, MAX_CONTEXT_TOTAL_BYTES } from "./protocol.js";

export const SDK_BLOCK_ORDER = ["memory", "world", "mood", "party", "roster", "scene"] as const;
export const SDK_LAST_BLOCKS = ["recall"] as const;

interface Field {
    value: unknown;
    expiresAt: number | null;
}

function renderValue(value: unknown): string {
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (Array.isArray(value)) {
        if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
            return value.length ? value.map(renderValue).join(", ") : "none";
        }
        return JSON.stringify(value);
    }
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return String(value);
}

/** `key: value` lines in insertion order; nested objects become `key.sub: value`. */
export function renderFields(fields: Record<string, unknown>): string {
    const lines: string[] = [];
    const walk = (prefix: string, value: unknown) => {
        if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
            for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
                walk(prefix ? `${prefix}.${key}` : key, inner);
            }
            return;
        }
        lines.push(`${prefix}: ${renderValue(value)}`);
    };
    for (const [key, value] of Object.entries(fields)) walk(key, value);
    return lines.join("\n");
}

class Block {
    fields = new Map<string, Field>();
    text: string | null = null;

    constructor(readonly name: string) {}

    render(now: number): string {
        if (this.text !== null) return this.text;
        const live: Record<string, unknown> = {};
        for (const [key, field] of this.fields) if (field.expiresAt === null || field.expiresAt > now) live[key] = field.value;
        return renderFields(live);
    }

    nextExpiry(now: number): number | null {
        let soonest: number | null = null;
        for (const field of this.fields.values()) {
            if (field.expiresAt !== null && field.expiresAt > now && (soonest === null || field.expiresAt < soonest)) soonest = field.expiresAt;
        }
        return soonest;
    }

    prune(now: number): boolean {
        let changed = false;
        for (const [key, field] of this.fields) {
            if (field.expiresAt !== null && field.expiresAt <= now) {
                this.fields.delete(key);
                changed = true;
            }
        }
        return changed;
    }
}

function checkName(name: string): string {
    if (!CONTEXT_KEY.test(name)) throw new ContextError(`Context block name ${JSON.stringify(name)} must be 1-48 lowercase letters, digits, '_', '.' or '-'.`);
    return name;
}

/** Named blocks of live state. A character's is shared by all its sessions; a session's is its own. */
export class LiveContext {
    private blocksByName = new Map<string, Block>();
    private listeners = new Set<(block: string) => void>();
    private expiry: ReturnType<typeof setTimeout> | null = null;

    constructor(
        readonly defaultBlock: string,
        private readonly clock: () => number = Date.now,
    ) {}

    /** The live fields of a block (expired ones are gone). */
    get(block?: string): Record<string, unknown> {
        const found = this.blocksByName.get(block ?? this.defaultBlock);
        if (!found) return {};
        const now = this.clock();
        const live: Record<string, unknown> = {};
        for (const [key, field] of found.fields) if (field.expiresAt === null || field.expiresAt > now) live[key] = field.value;
        return live;
    }

    /** Every live field of every block, later blocks winning a shared name. */
    allFields(): Record<string, unknown> {
        const merged: Record<string, unknown> = {};
        for (const name of this.blocksByName.keys()) Object.assign(merged, this.get(name));
        return merged;
    }

    blocks(): string[] {
        return [...this.blocksByName.keys()];
    }

    render(block: string): string {
        return this.blocksByName.get(block)?.render(this.clock()) ?? "";
    }

    /** Every block's text exactly as the model reads it. */
    snapshot(): Record<string, string> {
        const now = this.clock();
        const out: Record<string, string> = {};
        for (const [name, block] of this.blocksByName) {
            const text = block.render(now);
            if (text) out[name] = text;
        }
        return out;
    }

    /** Starting fields, set without notifying anyone (before any session exists). */
    seed(values: Record<string, unknown>, block?: string): void {
        const target = this.ensure(checkName(block ?? this.defaultBlock));
        for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) target.fields.set(key, { value, expiresAt: null });
        this.checkSize(target.name);
    }

    /** Merge fields into a block. `null`/`undefined` removes a field; `ttlMs` expires the ones set. */
    async update(values: Record<string, unknown>, options: { block?: string; ttlMs?: number } = {}): Promise<void> {
        const name = checkName(options.block ?? this.defaultBlock);
        const target = this.ensure(name);
        const before = new Map(target.fields);
        const text = target.text;
        target.text = null;
        const expiresAt = options.ttlMs !== undefined ? this.clock() + options.ttlMs : null;
        for (const [key, value] of Object.entries(values)) {
            if (value === null || value === undefined) target.fields.delete(key);
            else target.fields.set(key, { value, expiresAt });
        }
        try {
            this.checkSize(name);
        } catch (error) {
            target.fields = before;
            target.text = text;
            throw error;
        }
        this.changed(name);
    }

    /** Replace a whole block: with text as written, with fields, or remove it (null or ""). */
    async set(block: string, content: string | Record<string, unknown> | null): Promise<void> {
        const name = checkName(block);
        if (content === null || content === "") {
            if (this.blocksByName.delete(name)) this.changed(name);
            return;
        }
        const previous = this.blocksByName.get(name);
        const target = new Block(name);
        if (typeof content === "string") target.text = content.trim();
        else for (const [key, value] of Object.entries(content)) if (value !== null && value !== undefined) target.fields.set(key, { value, expiresAt: null });
        this.blocksByName.set(name, target);
        try {
            this.checkSize(name);
        } catch (error) {
            if (previous) this.blocksByName.set(name, previous);
            else this.blocksByName.delete(name);
            throw error;
        }
        this.changed(name);
    }

    async remove(fields: string[], options: { block?: string } = {}): Promise<void> {
        const name = options.block ?? this.defaultBlock;
        const target = this.blocksByName.get(name);
        if (!target) return;
        for (const key of fields) target.fields.delete(key);
        this.changed(name);
    }

    /** Remove one block, or every block. */
    async clear(block?: string): Promise<void> {
        for (const name of block ? [block] : [...this.blocksByName.keys()]) {
            if (this.blocksByName.delete(name)) this.changed(name);
        }
    }

    /** Call `listener(block)` whenever a block changes. Returns an unsubscribe function. */
    subscribe(listener: (block: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    close(): void {
        if (this.expiry) clearTimeout(this.expiry);
        this.expiry = null;
        this.listeners.clear();
    }

    private ensure(name: string): Block {
        let block = this.blocksByName.get(name);
        if (!block) {
            block = new Block(name);
            this.blocksByName.set(name, block);
        }
        return block;
    }

    private checkSize(name: string): void {
        const size = byteLength(this.render(name));
        if (size > MAX_CONTEXT_BLOCK_BYTES) {
            throw new ContextError(
                `Context block ${JSON.stringify(name)} would be ${size.toLocaleString("en-US")} bytes; one block holds at most ${MAX_CONTEXT_BLOCK_BYTES.toLocaleString("en-US")}. Keep live state a digest, not a save file.`,
            );
        }
    }

    private changed(name: string): void {
        this.scheduleExpiry();
        for (const listener of [...this.listeners]) listener(name);
    }

    private scheduleExpiry(): void {
        if (this.expiry) clearTimeout(this.expiry);
        this.expiry = null;
        const now = this.clock();
        let soonest: number | null = null;
        for (const block of this.blocksByName.values()) {
            const at = block.nextExpiry(now);
            if (at !== null && (soonest === null || at < soonest)) soonest = at;
        }
        if (soonest === null) return;
        this.expiry = setTimeout(() => {
            this.expiry = null;
            const at = this.clock();
            for (const block of this.blocksByName.values()) {
                if (block.prune(at)) for (const listener of [...this.listeners]) listener(block.name);
            }
            this.scheduleExpiry();
        }, Math.max(0, soonest - now) + 10);
    }
}

/**
 * One session's view of every context source, sent as it changes: throttled
 * per block, only changed text, a stable order, and everything again after a
 * resume (the gateway does not keep blocks across one).
 */
export class ContextPublisher {
    private extra = new Map<string, string>();
    private sent = new Map<string, string>();
    private lastAt = new Map<string, number>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private ready = false;
    private refusedAll = false;
    private unsubscribe: Array<() => void>;
    private chain: Promise<void> = Promise.resolve();

    constructor(
        private readonly send: (key: string, text: string) => Promise<void>,
        private readonly sources: LiveContext[],
        private readonly options: { minIntervalMs?: number; onSent?: (key: string, text: string) => void; onError?: (error: Error) => void } = {},
    ) {
        this.unsubscribe = sources.map((source) => source.subscribe((block) => this.changed(block)));
    }

    /** An SDK block (memory, party, mood, recall); empty text removes it. */
    setBlock(name: string, text: string): void {
        if (text) this.extra.set(name, text);
        else this.extra.delete(name);
        this.changed(name);
    }

    /** What the model holds now, by block. */
    current(): Record<string, string> {
        return Object.fromEntries(this.sent);
    }

    /** Every block's latest text, in send order. */
    desired(): Record<string, string> {
        const texts: Record<string, string> = {};
        for (const source of this.sources) Object.assign(texts, source.snapshot());
        for (const [name, text] of this.extra) texts[name] = text;
        const names = Object.keys(texts);
        const known = SDK_BLOCK_ORDER.filter((name) => name in texts);
        const last = SDK_LAST_BLOCKS.filter((name) => name in texts);
        const isSdk = (name: string) => (SDK_BLOCK_ORDER as readonly string[]).includes(name) || (SDK_LAST_BLOCKS as readonly string[]).includes(name);
        const sentFirst = [...this.sent.keys()].filter((name) => name in texts && !isSdk(name));
        const rest = names.filter((name) => !isSdk(name) && !sentFirst.includes(name));
        const ordered: Record<string, string> = {};
        for (const name of [...known, ...sentFirst, ...rest, ...last]) ordered[name] = texts[name] as string;
        return ordered;
    }

    validate(texts: Record<string, string>): void {
        const names = Object.keys(texts);
        if (names.length > MAX_CONTEXT_KEYS) {
            throw new ContextError(
                `A session holds at most ${MAX_CONTEXT_KEYS} context blocks; this one would have ${names.length} (${names.join(", ")}). Group related fields into one block.`,
            );
        }
        const total = Object.values(texts).reduce((sum, text) => sum + byteLength(text), 0);
        if (total > MAX_CONTEXT_TOTAL_BYTES) {
            throw new ContextError(
                `Context blocks together would be ${total.toLocaleString("en-US")} bytes; a session holds at most ${MAX_CONTEXT_TOTAL_BYTES.toLocaleString("en-US")}. Trim the largest blocks.`,
            );
        }
    }

    /** Send everything (a new or resumed session). */
    async start(): Promise<void> {
        this.ready = true;
        this.sent.clear();
        await this.flush();
    }

    stop(): void {
        this.ready = false;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    /** The gateway does not take context at all: keep blocks, stop sending. */
    refused(): void {
        this.refusedAll = true;
    }

    /** Send every changed block now, ignoring the throttle. Sends run one at a time, in order. */
    flush(only?: string): Promise<void> {
        const run = async () => {
            if (!this.ready || this.refusedAll) return;
            const desired = this.desired();
            this.validate(desired);
            const names = only ? [only] : [...Object.keys(desired), ...[...this.sent.keys()].filter((name) => !(name in desired))];
            for (const name of names) {
                const text = desired[name] ?? "";
                if ((this.sent.get(name) ?? "") === text) continue;
                await this.send(name, text);
                this.lastAt.set(name, Date.now());
                if (text) this.sent.set(name, text);
                else this.sent.delete(name);
                this.options.onSent?.(name, text);
            }
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }

    close(): void {
        this.stop();
        for (const unsubscribe of this.unsubscribe) unsubscribe();
        this.unsubscribe = [];
    }

    private changed(name: string): void {
        if (!this.ready || this.refusedAll || this.timers.has(name)) return;
        const since = Date.now() - (this.lastAt.get(name) ?? -Infinity);
        const delay = Math.max(0, (this.options.minIntervalMs ?? 300) - since);
        this.timers.set(
            name,
            setTimeout(() => {
                this.timers.delete(name);
                this.flush(name).catch((error: Error) => this.options.onError?.(error));
            }, delay),
        );
    }
}
