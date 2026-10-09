// Learning memories from a finished conversation.
//
// After a session the SDK can ask a language model what is worth keeping:
// who the player is, what they prefer, what happened, what was promised, how
// the relationship changed, and which old memories a correction replaces.
// The default extractor asks EESI's text model (`nur-llm-v1`) with your API
// key; pass `extractor` in the memory policy to use your own, or
// `extract: false` to learn nothing on your behalf. This updates a memory
// store. It does not train or fine-tune any model.
/** Preferences the SDK knows how to apply, beside free-form ones. */
export const PREFERENCE_KEYS = ["language", "verbosity", "pace", "formality", "name"];
const IMPORTANCE = { low: 0.3, medium: 0.6, high: 0.9 };
const EXTRACTED_KINDS = new Set(["fact", "preference", "event", "promise", "relationship", "note"]);
/** The tail of a long conversation the extractor reads, in characters. */
export const MAX_TRANSCRIPT_CHARS = 16_000;
/** The system prompt, word for word the Python SDK's. */
export const EXTRACTION_SYSTEM = "You keep the long-term memory of {character}, a character who talks with a player by voice. Read the conversation and decide what {character} should remember about this player next time they meet.\n\nAnswer with JSON only, in exactly this shape:\n{\"summary\": \"...\", \"memories\": [{\"text\": \"...\", \"kind\": \"fact\", \"importance\": \"medium\", \"key\": null, \"replaces\": null}], \"forget\": []}\n\nRules:\n- \"summary\": one or two sentences on what happened in this conversation, from {character}'s point of view. Use \"\" if nothing happened.\n- \"memories\": at most 8 things worth remembering next time: facts about the player (their name, background, situation), their preferences, events that happened to or with them, promises either side made, and changes in how the player and {character} stand. Each \"text\" is one short sentence about the player in the third person (\"They ...\", or their name).\n- \"kind\" is one of: fact, preference, event, promise, relationship.\n- \"importance\" is one of: low, medium, high.\n- For a preference about how to talk with them, \"key\" is one of: language, verbosity, pace, formality, name. Otherwise \"key\" is null.\n- If a memory corrects or updates an existing memory below, \"replaces\" is that memory's id (like \"m2\"). Otherwise null.\n- \"forget\": ids of existing memories the player asked {character} to forget, or that the conversation showed to be wrong.\n- Remember only what the conversation shows. Never invent. Skip small talk, and skip what {character} said about itself.\n- Lines marked [event] are things that happened in the game, not words the player said.";
function transcriptText(request) {
    const lines = [];
    for (const [speaker, raw] of request.transcript) {
        const text = raw.split(/\s+/).join(" ").trim();
        if (!text)
            continue;
        const label = speaker === "player" ? request.playerName || "Player" : speaker === "event" ? "[event]" : speaker;
        lines.push(`${label}: ${text}`);
    }
    const joined = lines.join("\n");
    return joined.length > MAX_TRANSCRIPT_CHARS ? `…${joined.slice(-MAX_TRANSCRIPT_CHARS)}` : joined;
}
/** The model's answer as a result; tolerant of code fences and chatter around the JSON. */
export function parseExtraction(text, ids) {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match)
        return { summary: null, memories: [], forget: [], raw: text };
    let data;
    try {
        data = JSON.parse(match[0]);
    }
    catch {
        return { summary: null, memories: [], forget: [], raw: text };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data))
        return { summary: null, memories: [], forget: [], raw: text };
    const object = data;
    const memories = [];
    for (const item of Array.isArray(object.memories) ? object.memories : []) {
        if (typeof item !== "object" || item === null)
            continue;
        const entry = item;
        if (typeof entry.text !== "string" || !entry.text.trim())
            continue;
        const kind = (EXTRACTED_KINDS.has(String(entry.kind)) ? entry.kind : "fact");
        const importance = typeof entry.importance === "number" ? entry.importance : (IMPORTANCE[String(entry.importance).toLowerCase()] ?? 0.6);
        const key = typeof entry.key === "string" && entry.key ? entry.key : null;
        const replaces = entry.replaces ? (ids.get(String(entry.replaces)) ?? null) : null;
        memories.push({
            text: entry.text.split(/\s+/).join(" ").trim().slice(0, 500),
            kind,
            importance: Math.min(1, Math.max(0, importance)),
            key: kind === "preference" ? key : null,
            replaces,
        });
    }
    const forget = (Array.isArray(object.forget) ? object.forget : [])
        .map((id) => ids.get(String(id)))
        .filter((id) => typeof id === "string");
    const summary = typeof object.summary === "string" && object.summary.trim() ? object.summary.split(/\s+/).join(" ").trim().slice(0, 600) : null;
    return { summary, memories: memories.slice(0, 8), forget, raw: text };
}
/** Memory extraction with a chat model. */
export function llmExtractor(chat) {
    return async (request) => {
        const transcript = transcriptText(request);
        if (!transcript.trim())
            return { summary: null, memories: [], forget: [] };
        const ids = new Map(request.existing.map((record, index) => [`m${index + 1}`, record.id]));
        const existing = request.existing.map((record, index) => `m${index + 1}: ${record.text.split(/\s+/).join(" ").trim()}`).join("\n") || "(none)";
        const who = request.playerName || "the player";
        const reply = await chat([
            { role: "system", content: EXTRACTION_SYSTEM.replaceAll("{character}", request.characterName) },
            {
                role: "user",
                content: `The player is ${who}.\n\nExisting memories about them:\n${existing}\n\nConversation, oldest first:\n${transcript}\n\nAnswer with the JSON only.`,
            },
        ]);
        return parseExtraction(reply, ids);
    };
}
//# sourceMappingURL=extraction.js.map