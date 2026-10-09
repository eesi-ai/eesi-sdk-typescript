// Characters that speak first.
//
// - `session.cue("The player drew a sword.")`: something happened; the
//   character reacts as soon as nobody is talking.
// - `npc.when((state) => Number(state.health) < 20, "The player is badly hurt.")`:
//   a trigger on live state, fired once each time the condition turns true.
// - `proactive: { idleAfterMs: 20_000 }`: after a quiet stretch the
//   character asks itself whether something is worth saying, out of band and
//   text only, and says it only if so.
//
// Remarks never talk over anyone: they wait for the floor and keep a cooldown.
export const IDLE_SKIP = "SKIP";
const IDLE_PROMPT = "Nobody has said anything for a while. Decide whether you, in character, would naturally speak up " +
    "right now: to ask how they are doing, to remark on what is happening around you, to follow up on " +
    "something you remember about them, or to offer help. Speak up only if it would feel natural and " +
    "welcome, not to fill silence, and only with something new: never repeat, rephrase or apologise " +
    "again for anything you already said. If you would, reply with exactly what you would say, in one " +
    "or two short spoken sentences, in the language of the conversation. If not, reply with the single " +
    `word ${IDLE_SKIP}.`;
export function idlePrompt(proactive) {
    return proactive.guidance ? `${IDLE_PROMPT} What you might bring up: ${proactive.guidance.trim()}` : IDLE_PROMPT;
}
let triggerCount = 0;
/** A remark the character makes when live state turns a condition true. */
export class Trigger {
    condition;
    what;
    options;
    kind;
    wasTrue = false;
    fired = false;
    constructor(condition, what, options = {}) {
        this.condition = condition;
        this.what = what;
        this.options = options;
        triggerCount += 1;
        this.kind = options.kind ?? `trigger:${triggerCount}`;
    }
    /** The remark to offer now, if the condition just became true. */
    check(state) {
        let now = false;
        try {
            now = Boolean(this.condition(state));
        }
        catch {
            now = false;
        }
        const rising = now && !this.wasTrue;
        this.wasTrue = now;
        if (!rising || (this.options.once && this.fired))
            return null;
        this.fired = true;
        return typeof this.what === "function" ? this.what(state) : this.what;
    }
    /** This trigger with no history, for a new session. */
    fresh() {
        return new Trigger(this.condition, this.what, { ...this.options, kind: this.kind });
    }
}
//# sourceMappingURL=proactive.js.map