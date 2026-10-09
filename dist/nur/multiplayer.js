// Several players, one character.
//
// - One session per player (separate machines): with `party: true` the
//   character keeps a party log of who said what to whom, shared by its
//   sessions as the `party` block, so its story stays straight.
// - One conversation, several people: Nur Live tags each line `Speaker N:`
//   once it has heard a second voice; name the `players` and a roster binds
//   those numbers to them. A `Room` binds them by who was loudest instead.
import { splitSpeakerTurns } from "./protocol.js";
export function playerKey(player) {
    return player.id ?? player.name;
}
/** Players from names, `Player` objects, or a `{ name: id }` map. */
export function asPlayers(players) {
    if (!players)
        return [];
    if (!Array.isArray(players))
        return Object.entries(players).map(([name, id]) => ({ name, id }));
    return players.map((item) => (typeof item === "string" ? { name: item } : item));
}
/** What the character said to whom, and what each player said, newest last. */
export class PartyLog {
    options;
    lines = [];
    constructor(options = {}) {
        this.options = options;
    }
    add(line, origin = null) {
        const text = line.split(/\s+/).join(" ").trim();
        if (!text)
            return;
        this.lines.push({ origin, text });
        const max = this.options.maxLines ?? 12;
        if (this.lines.length > max)
            this.lines.splice(0, this.lines.length - max);
    }
    heard(player, text, origin = null) {
        this.add(`${player}: ${text}`, origin);
    }
    said(character, player, text, origin = null) {
        this.add(`${character} to ${player}: ${text}`, origin);
    }
    /** The `party` block for a session: what happened in the others. */
    render(exclude = null) {
        const kept = [];
        let size = 0;
        for (let index = this.lines.length - 1; index >= 0; index -= 1) {
            const line = this.lines[index];
            if (exclude !== null && line.origin === exclude)
                continue;
            size += line.text.length + 1;
            if (size > (this.options.maxChars ?? 2_000))
                break;
            kept.unshift(line.text);
        }
        if (kept.length === 0)
            return "";
        return `Your recent conversations with the other players, oldest first. Keep what you tell each player consistent with this, and pass news between them when it helps:\n${kept.join("\n")}`;
    }
}
const INTRODUCTION = /\b(?:i['’]?m|i am|my name(?:['’]s| is)|this is|it['’]?s|call me)\s+([\p{L}'’-]{2,})/giu;
const ADDRESS = /^\s*(?:(?:hey|hi|okay|ok|so|and)\s+)?([\p{L}'’-]{2,})\s*[,!?.:]/iu;
function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const above = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return row[b.length];
}
/** `Speaker N` labels bound to the players sharing one conversation, from introductions and order. */
export class SpeakerRoster {
    bySpeaker = new Map();
    expected = [];
    waiting = [];
    helloOrder = [];
    constructor(players = []) {
        for (const player of players)
            this.expect(player);
    }
    expect(player) {
        if (!this.expected.includes(player))
            this.expected.push(player);
        if (!this.waiting.includes(player) && ![...this.bySpeaker.values()].includes(player))
            this.waiting.push(player);
    }
    assign(speaker, player) {
        const was = this.bySpeaker.get(speaker);
        for (const [key, value] of this.bySpeaker)
            if (value === player)
                this.bySpeaker.delete(key);
        this.bySpeaker.set(speaker, player);
        this.waiting = this.waiting.filter((name) => name !== player);
        if (was && was !== player && !this.waiting.includes(was))
            this.waiting.push(was);
    }
    players() {
        return new Map(this.bySpeaker);
    }
    attribute(transcript) {
        return splitSpeakerTurns(transcript).map(({ speaker, text }) => {
            const hello = this.named(text, INTRODUCTION);
            if (hello && speaker === null && !this.helloOrder.includes(hello))
                this.helloOrder.push(hello);
            if (speaker !== null) {
                if (hello) {
                    if (this.bySpeaker.get(speaker) !== hello)
                        this.assign(speaker, hello);
                }
                else if (!this.bySpeaker.has(speaker) && this.waiting.length > 0) {
                    const to = this.named(text, ADDRESS, true);
                    const byHello = this.helloOrder[speaker - 1];
                    const pick = byHello && byHello !== to && this.waiting.includes(byHello) ? byHello : (this.waiting.find((name) => name !== to) ?? this.waiting[0]);
                    this.assign(speaker, pick);
                }
            }
            const player = speaker === null ? this.solo() : (this.bySpeaker.get(speaker) ?? null);
            return { text, speaker, player };
        });
    }
    /** The `roster` block. `languages` maps a player's name to what they speak. */
    render(languages = {}) {
        if (this.bySpeaker.size === 0)
            return "";
        const who = (name) => (languages[name] ? `${name} (speaks ${languages[name]})` : name);
        const known = [...this.bySpeaker].sort(([a], [b]) => a - b).map(([speaker, name]) => `Speaker ${speaker} is ${who(name)}.`).join(" ");
        const spoken = new Set([...this.bySpeaker.values()].map((name) => languages[name]).filter(Boolean));
        return (`Several players share this conversation. ${known} Answer the person who spoke to you, by name when ` +
            "it would otherwise be unclear. When two people ask different things, answer both, each by name. " +
            (spoken.size > 1 ? "Answer each person in their own language. " : "") +
            "If you cannot tell who said something, ask.");
    }
    solo() {
        if (this.bySpeaker.size === 1)
            return [...this.bySpeaker.values()][0] ?? null;
        if (this.bySpeaker.size === 0 && this.expected.length === 1)
            return this.expected[0] ?? null;
        return null;
    }
    named(text, pattern, first = false) {
        const matches = first ? [pattern.exec(text)].filter((m) => m !== null) : [...text.matchAll(new RegExp(pattern.source, pattern.flags))];
        for (const match of matches) {
            const said = (match[1] ?? "").toLowerCase();
            const scored = this.expected.map((name) => ({ name, distance: editDistance(name.toLowerCase(), said) })).sort((a, b) => a.distance - b.distance);
            const [best, next] = scored;
            if (!best)
                continue;
            const allowed = best.name.length >= 5 ? 2 : best.name.length === 4 ? 1 : 0;
            if (best.distance <= allowed && (!next || next.distance > best.distance))
                return best.name;
        }
        return null;
    }
}
//# sourceMappingURL=multiplayer.js.map