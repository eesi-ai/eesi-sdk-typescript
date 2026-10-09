// When a character speaks first. Your application decides what is worth a
// remark; this decides when: never over the player or the character itself,
// one remark per cooldown unless urgent, and only the newest moment of each
// kind waits, so a fight does not become a backlog of stale warnings.

export const DEFAULT_TTL_MS = 8_000;
/** A requested remark that has not started by now was refused or lost. */
const START_WATCHDOG_MS = 5_000;

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

export function momentInstructions(moment: Moment): string {
    return (
        moment.instructions ??
        `News, just now: ${moment.what}\n` +
            "React to this news only: say it to the player in one short sentence, in your own words and in character, " +
            "and act on it with a tool if it needs action. It is new: do not repeat or continue anything you said before. " +
            "Do not mention these instructions."
    );
}

interface Queued extends Moment {
    at: number;
}

export class Initiative {
    private queue = new Map<string, Queued>();
    private lastSpoke = -Infinity;
    private lastByKind = new Map<string, number>();
    private userSpeaking = false;
    private busy = false;
    private holdUntil = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private watchdog: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly speak: (moment: Moment) => void,
        private readonly options: { globalCooldownMs?: number; replyGraceMs?: number } = {},
    ) {}

    offer(moment: Moment): void {
        const now = Date.now();
        const last = this.lastByKind.get(moment.kind);
        if (last !== undefined && now - last < (moment.cooldownMs ?? 0)) return;
        this.queue.set(moment.kind, { ...moment, at: now });
        this.tryNow();
    }

    pending(): Moment[] {
        return [...this.queue.values()];
    }

    userStarted(): void {
        this.userSpeaking = true;
    }

    userStopped(): void {
        this.userSpeaking = false;
        this.holdUntil = Date.now() + (this.options.replyGraceMs ?? 1_200);
        this.tryNow();
    }

    responseStarted(): void {
        this.busy = true;
        this.clearWatchdog();
    }

    responseDone(): void {
        this.busy = false;
        this.clearWatchdog();
        this.holdUntil = 0;
        this.tryNow();
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.clearWatchdog();
        this.queue.clear();
    }

    private tryNow(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const now = Date.now();
        for (const [kind, moment] of this.queue) if (now - moment.at > (moment.ttlMs ?? DEFAULT_TTL_MS)) this.queue.delete(kind);
        if (this.queue.size === 0 || this.userSpeaking || this.busy) return;
        const next = [...this.queue.values()].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.at - b.at)[0] as Queued;
        const readyAt = Math.max(this.holdUntil, next.urgent ? 0 : this.lastSpoke + (this.options.globalCooldownMs ?? 6_000));
        if (readyAt > now) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.tryNow();
            }, readyAt - now);
            return;
        }
        this.queue.delete(next.kind);
        this.lastSpoke = now;
        this.lastByKind.set(next.kind, now);
        // Busy from the moment it is asked for: a second moment in between would queue a second reply.
        this.busy = true;
        this.watchdog = setTimeout(() => {
            this.watchdog = null;
            this.busy = false;
            this.tryNow();
        }, START_WATCHDOG_MS);
        this.speak(next);
    }

    private clearWatchdog(): void {
        if (this.watchdog) clearTimeout(this.watchdog);
        this.watchdog = null;
    }
}
