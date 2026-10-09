import type { MemoryKind, MemoryRecord } from "./records.js";
/** Preferences the SDK knows how to apply, beside free-form ones. */
export declare const PREFERENCE_KEYS: readonly ["language", "verbosity", "pace", "formality", "name"];
/** The tail of a long conversation the extractor reads, in characters. */
export declare const MAX_TRANSCRIPT_CHARS = 16000;
export interface ExtractionRequest {
    characterName: string;
    playerId: string;
    playerName: string | null;
    /** `[speaker, text]` lines, oldest first: "player", "event", or the character's name. */
    transcript: Array<[string, string]>;
    existing: MemoryRecord[];
}
export interface MemoryCandidate {
    text: string;
    kind: MemoryKind;
    importance: number;
    key: string | null;
    /** The id of an existing memory this one corrects or updates. */
    replaces: string | null;
}
export interface ExtractionResult {
    summary: string | null;
    memories: MemoryCandidate[];
    /** Ids of existing memories to delete: the player asked, or they proved false. */
    forget: string[];
    raw?: string;
}
export type Extractor = (request: ExtractionRequest) => Promise<ExtractionResult>;
export type Chat = (messages: Array<{
    role: string;
    content: string;
}>) => Promise<string>;
/** The system prompt, word for word the Python SDK's. */
export declare const EXTRACTION_SYSTEM = "You keep the long-term memory of {character}, a character who talks with a player by voice. Read the conversation and decide what {character} should remember about this player next time they meet.\n\nAnswer with JSON only, in exactly this shape:\n{\"summary\": \"...\", \"memories\": [{\"text\": \"...\", \"kind\": \"fact\", \"importance\": \"medium\", \"key\": null, \"replaces\": null}], \"forget\": []}\n\nRules:\n- \"summary\": one or two sentences on what happened in this conversation, from {character}'s point of view. Use \"\" if nothing happened.\n- \"memories\": at most 8 things worth remembering next time: facts about the player (their name, background, situation), their preferences, events that happened to or with them, promises either side made, and changes in how the player and {character} stand. Each \"text\" is one short sentence about the player in the third person (\"They ...\", or their name).\n- \"kind\" is one of: fact, preference, event, promise, relationship.\n- \"importance\" is one of: low, medium, high.\n- For a preference about how to talk with them, \"key\" is one of: language, verbosity, pace, formality, name. Otherwise \"key\" is null.\n- If a memory corrects or updates an existing memory below, \"replaces\" is that memory's id (like \"m2\"). Otherwise null.\n- \"forget\": ids of existing memories the player asked {character} to forget, or that the conversation showed to be wrong.\n- Remember only what the conversation shows. Never invent. Skip small talk, and skip what {character} said about itself.\n- Lines marked [event] are things that happened in the game, not words the player said.";
/** The model's answer as a result; tolerant of code fences and chatter around the JSON. */
export declare function parseExtraction(text: string, ids: Map<string, string>): ExtractionResult;
/** How a game's own rules are added to the extraction prompt. Shared with the Python SDK. */
export declare const RULES_SUFFIX = "\n\nWhat {character} may remember, set by the game, which wins over the rules above where they differ:\n{rules}";
/**
 * Memory extraction with a chat model. `rules` narrow what may be kept, in
 * your words: "Only game facts: what they build, their favourite items, the
 * name they use in the game. Never age, school, location or social accounts."
 */
export declare function llmExtractor(chat: Chat, options?: {
    rules?: string;
}): Extractor;
//# sourceMappingURL=extraction.d.ts.map