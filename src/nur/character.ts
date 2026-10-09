// A character: who it is, how it sounds, what it knows and can do.
//
// A character is defined once and talked to by many players, each in their
// own session. Identity, voice, tools, shared world context and world
// knowledge belong to the character; a session holds one conversation, its
// own live context, and one player's memories. Nothing about one player ever
// reaches another player's session.

import type { AudioDevices, AudioInput, AudioOutput } from "./audio.js";
import type { ClientSecret, NurClient, VoiceDesign } from "./client.js";
import { LiveContext } from "./context.js";
import { ConfigurationError } from "./errors.js";
import { EventBus, type EventPattern, type Handler } from "./events.js";
import { describeLanguage } from "./languages.js";
import { CharacterMemory, Memory, type MemoryRecord, type MemoryStore, type RememberOptions } from "./memory/index.js";
import { type Player, PartyLog } from "./multiplayer.js";
import { PRESETS, type Preset, type PresetName } from "./presets.js";
import { type Proactive, type State, Trigger, type TriggerOptions } from "./proactive.js";
import { byteLength, MAX_INSTRUCTIONS_BYTES, OUTPUT_SAMPLE_RATE } from "./protocol.js";
import { Room, type RoomOptions } from "./room.js";
import { Session } from "./session.js";
import type { Trace } from "./trace.js";
import { type AnyTool, type ToolContext, ToolRunner } from "./tools.js";

/**
 * Who decides when the character speaks.
 * - `natural` (default): Nur Live's own full-duplex floor control.
 * - `app`: the SDK asks for a reply after each finished turn, once fresh state
 *   and memories are in place. Tool use is most reliable here.
 * - `director`: the character only speaks when your code says so.
 */
export type TurnTaking = "natural" | "app" | "director";
export type Verbosity = "brief" | "normal" | "expansive";

const VERBOSITY: Record<Verbosity, string> = {
    brief: "This is a live spoken conversation: answer in one or two short sentences unless asked for more.",
    normal: "This is a live spoken conversation: answer in a few natural sentences, longer only when it helps.",
    expansive:
        "This is a live spoken conversation: you may speak at length when it serves the moment, but pause at natural points so the other person can come in.",
};
const SPOKEN =
    "Everything you write is spoken aloud in your voice: no lists, markdown, emojis, stage directions or sound effects. When someone talks over you, stop and listen.";

export interface CharacterOptions {
    name: string;
    persona?: string;
    instructions?: string;
    /** A built-in voice name ("Atlas"), a voice id ("ev_…"), or `nur.voiceDesign(...)`. */
    voice?: string | VoiceDesign;
    /** One language (a code or a name) to speak, several to choose from, or none to follow the player. */
    language?: string | string[];
    /** The variety's name when a code is not enough ("Kansai Japanese"). */
    languageName?: string;
    traits?: string[];
    speakingStyle?: string;
    goals?: string | string[];
    boundaries?: string | string[];
    knowledge?: string | string[];
    /** Lines in the character's voice, for style only. */
    examples?: string[];
    /** Speak first when a session starts: true, false, or a line to say. */
    greeting?: boolean | string;
    verbosity?: Verbosity;
    tools?: Array<AnyTool>;
    /** The character's shared live state (its `world` block). */
    context?: Record<string, unknown>;
    /** true (in memory), a `Memory`, or a `MemoryStore`. Node: `fileMemory("./dir")` from `@eesi/sdk/node`. */
    memory?: boolean | Memory | MemoryStore;
    /** Keep a party log shared by every player's session. */
    party?: boolean;
    turnTaking?: TurnTaking;
    /** `deliberate` sends every request through the reasoning lane: slower, steadier with tools. */
    thinking?: "fast" | "deliberate";
    interruptible?: boolean;
    silenceMs?: number;
    /** Voice speed, 0.5 to 2. */
    speed?: number;
    /** Names and words the speech recognizer should expect. */
    hotwords?: string[];
    model?: string;
    /** A stable id; memories are keyed by it (defaults to the name in lowercase-dashes). */
    id?: string;
    preset?: PresetName | Preset;
    /** Learn players' preferences from conversations. Default true. */
    personalize?: boolean;
    /** Close the session once the character says goodbye. Default true. */
    endOnHangup?: boolean;
    outputSampleRate?: 16_000 | 24_000;
    version?: string;
    metadata?: Record<string, unknown>;
    /** Speak up after a quiet stretch: true for defaults, or settings. */
    proactive?: Proactive | boolean;
}

export interface ConnectOptions {
    /** Whose memories this session reads and writes: your id, not a name. */
    playerId?: string;
    playerName?: string;
    /** The people sharing this conversation (one microphone, or a room). */
    players?: Array<Player | string> | Record<string, string>;
    input?: AudioInput;
    output?: AudioOutput;
    /** A microphone and a speaker together, like `browserAudio()`. */
    audio?: AudioDevices;
    /** This session's starting live state (its `scene` block). */
    context?: Record<string, unknown>;
    /** true (default), "read" to recall without learning, or false. */
    memory?: boolean | "read";
    trace?: Trace;
    tools?: Array<AnyTool>;
    greeting?: boolean | string;
    /** Extra instructions for this session only. */
    instructions?: string;
    /** Pin this session to one language: a code ("ar-EG") or a name. */
    language?: string;
    /** Resume an earlier conversation: `[sessionId, resumeToken]`. */
    resume?: [string, string];
    connectTimeoutMs?: number;
}

function slug(name: string): string {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "character"
    );
}

function lines(items: string | string[] | undefined): string[] {
    if (!items) return [];
    return (typeof items === "string" ? [items] : items).map((item) => String(item).trim()).filter(Boolean);
}

function languageRule(language: string | string[] | undefined | null, name?: string): string {
    if (language === undefined || language === null) return "Answer in the language the other person speaks, and switch when they switch.";
    if (typeof language === "string") return `Speak ${describeLanguage(language, name)[1]}.`;
    const names = language.map((code) => describeLanguage(code)[1]);
    if (names.length === 1) return `Speak ${names[0]}.`;
    return `You speak ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}; answer in whichever of these the other person uses.`;
}

/** A character. Make one with `nur.character()` (or `nur.npc()`, `nur.companion()`, …). */
export class Character {
    readonly client: NurClient;
    readonly name: string;
    readonly id: string;
    readonly persona: string;
    readonly instructions: string;
    readonly voice: string | VoiceDesign | undefined;
    readonly language: string | string[] | undefined;
    readonly languageName: string | undefined;
    readonly traits: string[];
    readonly speakingStyle: string | undefined;
    readonly goals: string[];
    readonly boundaries: string[];
    readonly knowledge: string[];
    readonly examples: string[];
    readonly greeting: boolean | string;
    readonly verbosity: Verbosity;
    readonly turnTaking: TurnTaking;
    readonly thinking: "fast" | "deliberate";
    readonly interruptible: boolean;
    readonly silenceMs: number | undefined;
    readonly speed: number | undefined;
    readonly hotwords: string[];
    readonly model: string;
    readonly preset: Preset | null;
    readonly personalize: boolean;
    readonly endOnHangup: boolean;
    readonly outputSampleRate: 16_000 | 24_000;
    readonly version: string | undefined;
    readonly metadata: Record<string, unknown>;
    readonly proactive: Proactive | null;
    tools: Array<AnyTool>;
    readonly triggers: Trigger[] = [];
    /** The character's shared live state: its `world` block, in every session. */
    readonly context = new LiveContext("world");
    readonly memory: CharacterMemory | null;
    readonly party: PartyLog | null;
    /** @internal */
    readonly bus: EventBus;
    /** @internal */
    readonly liveSessions = new Set<Session>();
    private readonly options: CharacterOptions;

    constructor(client: NurClient, options: CharacterOptions) {
        if (!options.name?.trim()) throw new ConfigurationError("A character needs a name.");
        const preset = typeof options.preset === "string" ? PRESETS[options.preset] : options.preset;
        if (typeof options.preset === "string" && !preset) throw new ConfigurationError(`Unknown preset ${options.preset}; choose one of ${Object.keys(PRESETS).join(", ")}.`);
        const defaults = preset?.defaults ?? {};
        this.options = options;
        this.client = client;
        this.preset = preset ?? null;
        this.name = options.name.trim();
        this.id = options.id ?? slug(this.name);
        this.persona = (options.persona ?? "").trim();
        this.instructions = (options.instructions ?? "").trim();
        this.voice = options.voice;
        this.language = options.language;
        this.languageName = options.languageName;
        this.traits = [...(options.traits ?? [])];
        this.speakingStyle = options.speakingStyle;
        this.goals = lines(options.goals);
        this.boundaries = lines(options.boundaries);
        this.knowledge = lines(options.knowledge);
        this.examples = [...(options.examples ?? [])];
        this.greeting = options.greeting ?? defaults.greeting ?? true;
        this.verbosity = options.verbosity ?? defaults.verbosity ?? "brief";
        if (!(this.verbosity in VERBOSITY)) throw new ConfigurationError("verbosity must be brief, normal or expansive.");
        this.turnTaking = options.turnTaking ?? defaults.turnTaking ?? "natural";
        this.thinking = options.thinking ?? "fast";
        this.interruptible = options.interruptible ?? true;
        this.silenceMs = options.silenceMs;
        if (options.speed !== undefined && (options.speed < 0.5 || options.speed > 2)) throw new ConfigurationError("speed must be between 0.5 and 2.");
        this.speed = options.speed;
        this.hotwords = [...(options.hotwords ?? [])];
        this.model = options.model ?? client.model;
        this.personalize = options.personalize ?? true;
        this.endOnHangup = options.endOnHangup ?? true;
        this.outputSampleRate = options.outputSampleRate ?? OUTPUT_SAMPLE_RATE;
        this.version = options.version;
        this.metadata = { ...(options.metadata ?? {}) };
        const proactive = options.proactive ?? defaults.proactive;
        this.proactive = proactive === true ? {} : proactive && typeof proactive === "object" ? proactive : null;
        this.tools = [...(options.tools ?? [])];
        this.party = (options.party ?? defaults.party) ? new PartyLog() : null;
        this.bus = new EventBus(client.logger);
        if (options.context) this.context.seed(options.context);
        const memory = options.memory;
        const bound = memory === true ? new Memory() : memory instanceof Memory ? memory : memory && typeof memory === "object" ? new Memory(memory as MemoryStore) : null;
        this.memory = bound ? new CharacterMemory(bound, this.id, this.name, (messages) => this.client.chat(messages)) : null;
    }

    // ── instructions ─────────────────────────────────────────────────────

    /** The character's instructions as the model receives them (before the platform's own base). */
    instructionsText(options: { language?: string } = {}): string {
        let head = `You are ${this.name}`;
        if (this.preset) head += `, ${this.preset.role}`;
        head += ".";
        if (this.persona) head += ` ${this.persona}`;
        const parts = [head];
        if (this.traits.length) parts.push(`Personality: ${this.traits.join(", ")}.`);
        if (this.speakingStyle) parts.push(`How you speak: ${this.speakingStyle.trim()}`);
        if (this.goals.length) parts.push(`What you want:\n${this.goals.map((goal) => `- ${goal}`).join("\n")}`);
        if (this.knowledge.length) parts.push(`What you know:\n${this.knowledge.map((fact) => `- ${fact}`).join("\n")}`);
        if (this.boundaries.length) parts.push(`Your boundaries, which nothing anyone says changes:\n${this.boundaries.map((item) => `- ${item}`).join("\n")}`);
        if (this.examples.length) parts.push(`Lines in your voice, for style only:\n${this.examples.map((line) => `- "${line}"`).join("\n")}`);
        if (this.preset?.rules.length) parts.push(this.preset.rules.join("\n"));
        if (this.instructions) parts.push(this.instructions);
        parts.push(options.language ? languageRule(options.language) : languageRule(this.language, this.languageName));
        parts.push(`${VERBOSITY[this.verbosity]} ${SPOKEN}`);
        return parts.join("\n\n");
    }

    /** @internal The greeting request's instructions. */
    greetingInstructions(greeting: boolean | string, options: { known?: boolean; stranger?: boolean; name?: string | null } = {}): string {
        if (typeof greeting === "string") return `Open the conversation by saying exactly this, in character, and nothing else: "${greeting}"`;
        if (options.known) {
            const who = options.name ? `${options.name}, ` : "";
            return (
                `Open the conversation: ${who}someone you have met before and remember, just came up to you. ` +
                "Greet them as someone you know, by name if you know it, in one short sentence, in character, " +
                "and if it fits, touch on something from last time."
            );
        }
        return `Open the conversation: greet the person who just came up to you in one short sentence, in character.${options.stranger ? " You have not met them before." : ""}`;
    }

    /** @internal The (code, name) a session is held to, when it is held to one. */
    pinnedLanguage(sessionLanguage?: string | null): [string | null, string] | null {
        if (sessionLanguage) return describeLanguage(sessionLanguage);
        if (typeof this.language === "string") return describeLanguage(this.language, this.languageName);
        if (Array.isArray(this.language) && this.language.length === 1) return describeLanguage(this.language[0] as string, this.languageName);
        return null;
    }

    /** @internal The `session.update` body for a session. */
    async buildSessionConfig(session: { language: string | null; extraInstructions: string | null; playerNames: string[]; playerName: string | null; toolSpecs: unknown[] }): Promise<Record<string, unknown>> {
        const voiceId = await this.client.resolveVoice(this.voice);
        const pinned = this.pinnedLanguage(session.language);
        let instructions = this.instructionsText({ language: session.language ?? undefined });
        if (session.extraInstructions) instructions += `\n\n${session.extraInstructions.trim()}`;
        if (byteLength(instructions) > MAX_INSTRUCTIONS_BYTES) {
            throw new ConfigurationError(
                `${this.name}'s instructions are ${byteLength(instructions)} bytes; the limit is ${MAX_INSTRUCTIONS_BYTES}. Move world knowledge into memory or context.`,
            );
        }
        const output: Record<string, unknown> = {};
        if (this.outputSampleRate === 24_000) output.format = { type: "audio/pcm", rate: 24_000 };
        if (voiceId) output.voice = voiceId;
        if (this.speed !== undefined) output.speed = this.speed;
        const turnDetection: Record<string, unknown> = { type: "server_vad", interrupt_response: this.interruptible };
        if (this.turnTaking !== "natural") turnDetection.create_response = false;
        if (this.silenceMs !== undefined) turnDetection.silence_duration_ms = Math.round(this.silenceMs);
        const words = [this.name, ...this.hotwords, ...session.playerNames, ...(session.playerName ? [session.playerName] : [])];
        const transcription: Record<string, unknown> = { prompt: [...new Set(words.filter(Boolean))].join(", ") };
        const config: Record<string, unknown> = {
            instructions,
            audio: { output, input: { turn_detection: turnDetection, transcription } },
            tools: session.toolSpecs,
            tool_choice: session.toolSpecs.length ? "auto" : "none",
        };
        if (pinned) {
            const [code, name] = pinned;
            // The code makes the greeting, and anything said before the player's
            // first words, come out in this language; the name holds every reply to it.
            if (code) transcription.language = code;
            config.eesi_language_name = name;
        }
        if (this.thinking === "deliberate") {
            config.reasoning = { effort: "low" };
            config.eesi_delegation = "every_request";
        }
        return config;
    }

    /** The `session.update` body this character sends, for clients you build yourself. */
    sessionConfig(options: { playerName?: string; language?: string } = {}): Promise<Record<string, unknown>> {
        return this.buildSessionConfig({
            language: options.language ?? null,
            extraInstructions: null,
            playerNames: [],
            playerName: options.playerName ?? null,
            toolSpecs: this.tools.map((item) => item.spec()),
        });
    }

    // ── sessions ─────────────────────────────────────────────────────────

    /** A conversation with one player (or a group), under your API key. `await session.start()`, then `close()`. */
    connect(options: ConnectOptions = {}): Session {
        return new Session(this, options, this.client.transport({ kind: "owned", model: this.model }));
    }

    /**
     * Steer, from your server, a session a player's client opened with `secret`
     * (minted with `clientSecret({ control: true })`). The client holds the
     * audio; this session sees everything else and acts in it: live context,
     * tools, cues, proactive remarks, memory. It becomes ready when the client
     * connects, so `connectTimeoutMs` (default ten minutes) is how long to wait.
     */
    control(secret: ClientSecret | string, options: Omit<ConnectOptions, "input" | "output" | "audio" | "resume" | "language"> = {}): Session {
        const minted = typeof secret === "string" ? null : secret;
        const controlId = minted ? minted.controlId : secret;
        if (!controlId) throw new ConfigurationError("This client secret has no control channel: mint it with clientSecret({ control: true }).");
        return new Session(
            this,
            {
                ...options,
                playerId: options.playerId ?? minted?.playerId ?? undefined,
                playerName: options.playerName ?? minted?.playerName ?? undefined,
                players: options.players ?? minted?.players ?? undefined,
                language: minted?.language ?? undefined,
                connectTimeoutMs: options.connectTimeoutMs ?? 600_000,
                controlTools: minted?.controlTools ?? "server",
            },
            this.client.transport({ kind: "control", controlId: controlId as string }),
        );
    }

    /** Several players in one conversation with this character; see `Room`. */
    room(players: Array<Player | string>, options: RoomOptions = {}): Room {
        return new Room(this, players, options);
    }

    /** Live sessions of this character. */
    get sessions(): Session[] {
        return [...this.liveSessions];
    }

    /** Subscribe to events from every session of this character. */
    on<T extends EventPattern>(pattern: T, handler: Handler<T>): () => void {
        return this.bus.on(pattern, handler);
    }

    /** Register a tool (or several); live sessions are offered it at once. */
    tool(...tools: Array<AnyTool>): this {
        for (const item of tools) {
            this.tools = [...this.tools.filter((existing) => existing.name !== item.name), item];
            for (const session of this.liveSessions) session.addTool(item);
        }
        return this;
    }

    /** Have the character remark when live state turns `condition` true, in every session. */
    when(condition: (state: State) => boolean, what: string | ((state: State) => string), options: TriggerOptions = {}): Trigger {
        const trigger = new Trigger(condition, what, options);
        this.triggers.push(trigger);
        for (const session of this.liveSessions) session.addTrigger(trigger.fresh());
        return trigger;
    }

    /** Keep something. Without `playerId` it is the character's world knowledge, known to every session. */
    async remember(text: string, options: RememberOptions = {}): Promise<MemoryRecord> {
        if (!this.memory) throw new ConfigurationError(`${this.name} has no memory. Create it with memory: true or a store.`);
        const record = await this.memory.remember(text, options);
        for (const session of this.liveSessions) {
            if (!options.playerId || session.playerId === options.playerId) await session.refreshMemory();
        }
        return record;
    }

    /** A mood every session of the character shares (a session's own mood wins). */
    async setMood(mood: string | null, options: { reason?: string } = {}): Promise<void> {
        if (!mood) return this.context.set("mood", null);
        const because = options.reason ? ` (${options.reason})` : "";
        return this.context.set("mood", `Your mood right now: ${mood}${because}. Let it colour how you speak; it does not change who you are.`);
    }

    /** A short-lived credential that opens a session already configured as this character. See `NurClient.clientSecret`. */
    clientSecret(options: Parameters<NurClient["clientSecret"]>[1] = {}): Promise<ClientSecret> {
        return this.client.clientSecret(this, options);
    }

    /**
     * Learn from a call a player's client opened with a client secret.
     * `event` is the `session.ended` webhook, verified with `verifyWebhook`
     * (`@eesi/sdk/node`); its transcript is what the player and the character
     * said. What was worth keeping becomes this player's memories (under the
     * memory policy's `rules`), and their next client secret starts with it.
     */
    async learnFromSession(
        event: { type: string; session_id?: string; transcript?: Array<{ role: string; text: string }> },
        options: { playerId: string; playerName?: string | null },
    ): Promise<{ added: MemoryRecord[]; superseded: MemoryRecord[]; forgotten: string[] }> {
        if (!this.memory) throw new ConfigurationError(`${this.name} has no memory. Create it with memory: true or a store.`);
        if (event.type !== "session.ended" || !event.transcript?.length) return { added: [], superseded: [], forgotten: [] };
        const lines = event.transcript.map((line): [string, string] => [line.role === "player" ? "player" : this.name, String(line.text ?? "")]);
        return this.memory.learn(lines, {
            playerId: options.playerId,
            playerName: options.playerName ?? null,
            sessionId: event.session_id ?? null,
            skipKinds: this.personalize ? [] : ["preference"],
        });
    }

    /**
     * Run one of the character's tools for a call a client forwarded to your
     * server (a session opened with a client secret). Same validation,
     * `allow` and `confirm` as in a session; `ctx.session` is null.
     */
    async runTool(name: string, args: string | Record<string, unknown>, options: { playerId?: string | null; callId?: string } = {}): Promise<string> {
        const runner = new ToolRunner(
            this.tools,
            (callId, toolArgs): ToolContext => ({ session: null, character: this, playerId: options.playerId ?? null, callId, arguments: toolArgs }),
            () => undefined,
        );
        const outcome = await runner.run(options.callId ?? `call_${Date.now().toString(36)}`, name, typeof args === "string" ? args : JSON.stringify(args));
        return outcome.output;
    }

    // ── portability ──────────────────────────────────────────────────────

    /** The character as JSON-ready data. Tools are listed by name; memory is not included. */
    toJSON(): Record<string, unknown> {
        const voice = this.voice && typeof this.voice === "object" ? { design: this.voice } : (this.voice ?? null);
        return {
            format: "eesi.character",
            format_version: 1,
            name: this.name,
            id: this.id,
            persona: this.persona,
            instructions: this.instructions,
            voice,
            language: this.language ?? null,
            language_name: this.languageName ?? null,
            traits: this.traits,
            speaking_style: this.speakingStyle ?? null,
            goals: this.goals,
            boundaries: this.boundaries,
            knowledge: this.knowledge,
            examples: this.examples,
            greeting: this.greeting,
            verbosity: this.verbosity,
            turn_taking: this.turnTaking,
            thinking: this.thinking,
            interruptible: this.interruptible,
            silence_ms: this.silenceMs ?? null,
            speed: this.speed ?? null,
            hotwords: this.hotwords,
            model: this.model,
            preset: this.preset?.name ?? null,
            party: this.party !== null,
            personalize: this.personalize,
            end_on_hangup: this.endOnHangup,
            version: this.version ?? null,
            metadata: this.metadata,
            proactive: this.proactive
                ? {
                      idle_after: this.proactive.idleAfterMs === null ? null : (this.proactive.idleAfterMs ?? 25_000) / 1000,
                      cooldown: (this.proactive.cooldownMs ?? 60_000) / 1000,
                      max_remarks: this.proactive.maxRemarks ?? null,
                      guidance: this.proactive.guidance ?? null,
                  }
                : null,
            tools: this.tools.map((item) => item.name),
            context: this.context.get("world"),
        };
    }

    /** A new character with these options changed (a variant, a new version). Tools, triggers and memory carry over. */
    clone(changes: Partial<CharacterOptions> = {}): Character {
        const made = new Character(this.client, {
            ...this.options,
            tools: this.tools,
            memory: this.memory?.memory,
            context: this.context.get("world"),
            ...changes,
        });
        made.triggers.push(...this.triggers);
        return made;
    }
}

/** Options from a saved character (`toJSON()`), in either SDK's form. */
export function characterOptionsFromJSON(data: Record<string, unknown>, tools: Array<AnyTool> = []): CharacterOptions {
    const get = <T>(snake: string, camel: string): T | undefined => (data[snake] ?? data[camel] ?? undefined) as T | undefined;
    const voice = data.voice as unknown;
    const proactive = data.proactive as Record<string, unknown> | null | undefined;
    const options: CharacterOptions = {
        name: String(data.name),
        id: get<string>("id", "id"),
        persona: get<string>("persona", "persona"),
        instructions: get<string>("instructions", "instructions"),
        voice: voice && typeof voice === "object" && "design" in (voice as object) ? ((voice as { design: VoiceDesign }).design) : ((voice as string | null) ?? undefined),
        language: get<string | string[]>("language", "language") ?? undefined,
        languageName: get<string>("language_name", "languageName") ?? undefined,
        traits: get<string[]>("traits", "traits"),
        speakingStyle: get<string>("speaking_style", "speakingStyle") ?? undefined,
        goals: get<string[]>("goals", "goals"),
        boundaries: get<string[]>("boundaries", "boundaries"),
        knowledge: get<string[]>("knowledge", "knowledge"),
        examples: get<string[]>("examples", "examples"),
        greeting: get<boolean | string>("greeting", "greeting"),
        verbosity: get<Verbosity>("verbosity", "verbosity"),
        turnTaking: get<TurnTaking>("turn_taking", "turnTaking"),
        thinking: get<"fast" | "deliberate">("thinking", "thinking"),
        interruptible: get<boolean>("interruptible", "interruptible"),
        silenceMs: get<number>("silence_ms", "silenceMs") ?? undefined,
        speed: get<number>("speed", "speed") ?? undefined,
        hotwords: get<string[]>("hotwords", "hotwords"),
        model: get<string>("model", "model"),
        preset: (get<string>("preset", "preset") ?? undefined) as PresetName | undefined,
        party: get<boolean>("party", "party"),
        personalize: get<boolean>("personalize", "personalize"),
        endOnHangup: get<boolean>("end_on_hangup", "endOnHangup"),
        version: get<string>("version", "version") ?? undefined,
        metadata: get<Record<string, unknown>>("metadata", "metadata"),
        context: get<Record<string, unknown>>("context", "context"),
        tools,
        proactive: proactive
            ? {
                  idleAfterMs: proactive.idle_after === null ? null : Number(proactive.idle_after ?? 25) * 1000,
                  cooldownMs: Number(proactive.cooldown ?? 60) * 1000,
                  maxRemarks: (proactive.max_remarks as number | null) ?? undefined,
                  guidance: (proactive.guidance as string | null) ?? undefined,
              }
            : undefined,
    };
    return options;
}
