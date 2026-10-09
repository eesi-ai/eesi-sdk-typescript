// Choosing what a character remembers right now, and how it reads.
//
// A session cannot carry everything a character ever learned about a player:
// the memory block has a budget. Records compete on relevance to what is
// happening, importance and recency; a few kinds always make it in because
// they change how every reply sounds: preferences, the relationship, and
// what happened last time. The wording matches the Python SDK's exactly.
import { byteLength } from "../protocol.js";
/** The memory block's default size: about 700 tokens, a fraction of the context. */
export const DEFAULT_BLOCK_BYTES = 3_000;
export const DEFAULT_WEIGHTS = { relevance: 0.55, importance: 0.25, recency: 0.2, halfLifeDays: 30 };
/** Records with a score in 0..1, best first. */
export function rank(records, relevance = new Map(), weights = DEFAULT_WEIGHTS, now = Date.now() / 1000) {
    return records
        .map((record) => {
        const ageDays = Math.max(0, now - record.updatedAt) / 86_400;
        const recency = 0.5 ** (ageDays / weights.halfLifeDays);
        const score = weights.relevance * (relevance.get(record.id) ?? 0) +
            weights.importance * record.importance * (0.5 + 0.5 * record.confidence) +
            weights.recency * recency;
        return [record, score];
    })
        .sort((a, b) => b[1] - a[1]);
}
/** "today", "yesterday", "3 days ago", "5 weeks ago". */
export function relativeAge(then, now = Date.now() / 1000) {
    const days = (now - then) / 86_400;
    if (days < 1 && new Date(then * 1000).getDate() === new Date(now * 1000).getDate())
        return "today";
    if (days < 2)
        return "yesterday";
    if (days < 14)
        return `${Math.floor(days)} days ago`;
    if (days < 60)
        return `${Math.floor(days / 7)} weeks ago`;
    if (days < 730)
        return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
}
function line(record, now) {
    const text = record.text.split(/\s+/).join(" ").trim();
    if (record.kind === "event" || record.kind === "promise" || record.source === "extraction") {
        return `- ${text} (${relativeAge(record.updatedAt, now)})`;
    }
    return `- ${text}`;
}
/** The `memory` block's text and the records it used. */
export function composeBlock(ranked, options) {
    const now = options.now ?? Date.now() / 1000;
    const budget = options.budgetBytes ?? DEFAULT_BLOCK_BYTES;
    const who = options.playerName || "this player";
    const used = [];
    const personal = ranked.filter(([record]) => record.playerId !== null);
    const world = ranked.filter(([record]) => record.playerId === null);
    const preferences = new Map();
    for (const [record] of personal) {
        if (record.kind !== "preference")
            continue;
        const key = record.key ?? record.text;
        if (!preferences.has(key)) {
            preferences.set(key, record.text);
            used.push(record);
        }
    }
    for (const [key, value] of Object.entries(options.sessionPreferences ?? {}))
        preferences.set(key, value);
    const relationship = personal.filter(([record]) => record.kind === "relationship").slice(0, 2).map(([record]) => record);
    const summaries = personal
        .filter(([record]) => record.kind === "summary")
        .map(([record]) => record)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 2);
    used.push(...relationship, ...summaries);
    const taken = new Set(used.map((record) => record.id));
    const lines = [];
    if (options.firstMeeting && personal.length === 0) {
        lines.push(`You have not met ${who} before: this is your first conversation with them.`);
    }
    else {
        lines.push(`What you remember about ${who} from earlier conversations. These are your own memories: ` +
            "use them naturally when they matter, never recite them as a list, and if the player " +
            "corrects one, believe the player.");
    }
    if (preferences.size > 0)
        lines.push(`How they like to be spoken to: ${[...preferences.values()].join("; ")}`);
    for (const record of relationship)
        lines.push(`Your relationship: ${record.text.split(/\s+/).join(" ").trim()}`);
    const latest = summaries[0];
    if (latest)
        lines.push(`Last conversation (${relativeAge(latest.updatedAt, now)}): ${latest.text.split(/\s+/).join(" ").trim()}`);
    const fits = (extra) => byteLength([...lines, extra].join("\n")) <= budget;
    for (const [record] of personal) {
        if (taken.has(record.id) || record.kind === "preference" || record.kind === "relationship" || record.kind === "summary")
            continue;
        const text = line(record, now);
        if (!fits(text))
            continue;
        lines.push(text);
        used.push(record);
        taken.add(record.id);
    }
    const worldLines = [];
    for (const [record] of world) {
        if (taken.has(record.id))
            continue;
        const text = line(record, now);
        if (!fits(["What you know from around the world:", ...worldLines, text].join("\n")))
            continue;
        worldLines.push(text);
        used.push(record);
        taken.add(record.id);
    }
    if (worldLines.length > 0)
        lines.push("What you know from around the world:", ...worldLines);
    if (used.length === 0 && !options.firstMeeting)
        return { text: "", used: [] };
    return { text: lines.join("\n"), used };
}
//# sourceMappingURL=recall.js.map