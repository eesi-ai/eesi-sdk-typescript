import type { Proactive } from "./proactive.js";
export interface Preset {
    name: string;
    /** Who the character is in the world, after "You are <name>". */
    role: string;
    rules: string[];
    defaults: {
        greeting?: boolean;
        verbosity?: "brief" | "normal" | "expansive";
        party?: boolean;
        turnTaking?: "natural" | "app" | "director";
        proactive?: Proactive;
    };
}
export declare const PRESETS: Readonly<Record<string, Preset>>;
export type PresetName = "npc" | "multiplayer_npc" | "companion" | "storyteller" | "support_agent" | "assistant";
//# sourceMappingURL=presets.d.ts.map