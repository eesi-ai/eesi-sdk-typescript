// When a character speaks first. Your application decides what is worth a
// remark; this decides when: never over the player or the character itself,
// one remark per cooldown unless urgent, and only the newest moment of each
// kind waits, so a fight does not become a backlog of stale warnings.
export const DEFAULT_TTL_MS = 8_000;
/** A requested remark that has not started by now was refused or lost. */
const START_WATCHDOG_MS = 5_000;
export function momentInstructions(moment) {
    return (moment.instructions ??
        `News, just now: ${moment.what}\n` +
            "React to this news only: say it to the player in one short sentence, in your own words and in character, " +
            "and act on it with a tool if it needs action. It is new: do not repeat or continue anything you said before. " +
            "Do not mention these instructions.");
}
export class Initiative {
    speak;
    options;
    queue = new Map();
    lastSpoke = -Infinity;
    lastByKind = new Map();
    userSpeaking = false;
    busy = false;
    holdUntil = 0;
    timer = null;
    watchdog = null;
    constructor(speak, options = {}) {
        this.speak = speak;
        this.options = options;
    }
    offer(moment) {
        const now = Date.now();
        const last = this.lastByKind.get(moment.kind);
        if (last !== undefined && now - last < (moment.cooldownMs ?? 0))
            return;
        this.queue.set(moment.kind, { ...moment, at: now });
        this.tryNow();
    }
    pending() {
        return [...this.queue.values()];
    }
    userStarted() {
        this.userSpeaking = true;
    }
    userStopped() {
        this.userSpeaking = false;
        this.holdUntil = Date.now() + (this.options.replyGraceMs ?? 1_200);
        this.tryNow();
    }
    responseStarted() {
        this.busy = true;
        this.clearWatchdog();
    }
    responseDone() {
        this.busy = false;
        this.clearWatchdog();
        this.holdUntil = 0;
        this.tryNow();
    }
    dispose() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.clearWatchdog();
        this.queue.clear();
    }
    tryNow() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        const now = Date.now();
        for (const [kind, moment] of this.queue)
            if (now - moment.at > (moment.ttlMs ?? DEFAULT_TTL_MS))
                this.queue.delete(kind);
        if (this.queue.size === 0 || this.userSpeaking || this.busy)
            return;
        const next = [...this.queue.values()].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.at - b.at)[0];
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
    clearWatchdog() {
        if (this.watchdog)
            clearTimeout(this.watchdog);
        this.watchdog = null;
    }
}
//# sourceMappingURL=initiative.js.map