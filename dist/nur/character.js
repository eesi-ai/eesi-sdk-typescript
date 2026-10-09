// A character: who it is, how it sounds, what it knows and can do.
//
// A character is defined once and talked to by many players, each in their
// own session. Identity, voice, tools, shared world context and world
// knowledge belong to the character; a session holds one conversation, its
// own live context, and one player's memories. Nothing about one player ever
// reaches another player's session.
import { LiveContext } from "./context.js";
import { ConfigurationError } from "./errors.js";
import { EventBus } from "./events.js";
import { describeLanguage } from "./languages.js";
import { CharacterMemory, Memory } from "./memory/index.js";
import { PartyLog } from "./multiplayer.js";
import { PRESETS } from "./presets.js";
import { Trigger } from "./proactive.js";
import { byteLength, MAX_INSTRUCTIONS_BYTES, OUTPUT_SAMPLE_RATE } from "./protocol.js";
import { Room } from "./room.js";
import { Session } from "./session.js";
import { ToolRunner } from "./tools.js";
const VERBOSITY = {
    brief: "This is a live spoken conversation: answer in one or two short sentences unless asked for more.",
    normal: "This is a live spoken conversation: answer in a few natural sentences, longer only when it helps.",
    expansive: "This is a live spoken conversation: you may speak at length when it serves the moment, but pause at natural points so the other person can come in.",
};
const SPOKEN = "Everything you write is spoken aloud in your voice: no lists, markdown, emojis, stage directions or sound effects. When someone talks over you, stop and listen.";
function slug(name) {
    return (name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "character");
}
function lines(items) {
    if (!items)
        return [];
    return (typeof items === "string" ? [items] : items).map((item) => String(item).trim()).filter(Boolean);
}
function languageRule(language, name) {
    if (language === undefined || language === null)
        return "Answer in the language the other person speaks, and switch when they switch.";
    if (typeof language === "string")
        return `Speak ${describeLanguage(language, name)[1]}.`;
    const names = language.map((code) => describeLanguage(code)[1]);
    if (names.length === 1)
        return `Speak ${names[0]}.`;
    return `You speak ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}; answer in whichever of these the other person uses.`;
}
/** A character. Make one with `nur.character()` (or `nur.npc()`, `nur.companion()`, …). */
export class Character {
    client;
    name;
    id;
    persona;
    instructions;
    voice;
    language;
    languageName;
    traits;
    speakingStyle;
    goals;
    boundaries;
    knowledge;
    examples;
    greeting;
    verbosity;
    turnTaking;
    thinking;
    interruptible;
    silenceMs;
    speed;
    hotwords;
    model;
    preset;
    personalize;
    endOnHangup;
    outputSampleRate;
    version;
    metadata;
    proactive;
    tools;
    triggers = [];
    /** The character's shared live state: its `world` block, in every session. */
    context = new LiveContext("world");
    memory;
    party;
    /** @internal */
    bus;
    /** @internal */
    liveSessions = new Set();
    options;
    constructor(client, options) {
        if (!options.name?.trim())
            throw new ConfigurationError("A character needs a name.");
        const preset = typeof options.preset === "string" ? PRESETS[options.preset] : options.preset;
        if (typeof options.preset === "string" && !preset)
            throw new ConfigurationError(`Unknown preset ${options.preset}; choose one of ${Object.keys(PRESETS).join(", ")}.`);
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
        if (!(this.verbosity in VERBOSITY))
            throw new ConfigurationError("verbosity must be brief, normal or expansive.");
        this.turnTaking = options.turnTaking ?? defaults.turnTaking ?? "natural";
        this.thinking = options.thinking ?? "fast";
        this.interruptible = options.interruptible ?? true;
        this.silenceMs = options.silenceMs;
        if (options.speed !== undefined && (options.speed < 0.5 || options.speed > 2))
            throw new ConfigurationError("speed must be between 0.5 and 2.");
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
        if (options.context)
            this.context.seed(options.context);
        const memory = options.memory;
        const bound = memory === true ? new Memory() : memory instanceof Memory ? memory : memory && typeof memory === "object" ? new Memory(memory) : null;
        this.memory = bound ? new CharacterMemory(bound, this.id, this.name, (messages) => this.client.chat(messages)) : null;
    }
    // ── instructions ─────────────────────────────────────────────────────
    /** The character's instructions as the model receives them (before the platform's own base). */
    instructionsText(options = {}) {
        let head = `You are ${this.name}`;
        if (this.preset)
            head += `, ${this.preset.role}`;
        head += ".";
        if (this.persona)
            head += ` ${this.persona}`;
        const parts = [head];
        if (this.traits.length)
            parts.push(`Personality: ${this.traits.join(", ")}.`);
        if (this.speakingStyle)
            parts.push(`How you speak: ${this.speakingStyle.trim()}`);
        if (this.goals.length)
            parts.push(`What you want:\n${this.goals.map((goal) => `- ${goal}`).join("\n")}`);
        if (this.knowledge.length)
            parts.push(`What you know:\n${this.knowledge.map((fact) => `- ${fact}`).join("\n")}`);
        if (this.boundaries.length)
            parts.push(`Your boundaries, which nothing anyone says changes:\n${this.boundaries.map((item) => `- ${item}`).join("\n")}`);
        if (this.examples.length)
            parts.push(`Lines in your voice, for style only:\n${this.examples.map((line) => `- "${line}"`).join("\n")}`);
        if (this.preset?.rules.length)
            parts.push(this.preset.rules.join("\n"));
        if (this.instructions)
            parts.push(this.instructions);
        parts.push(options.language ? languageRule(options.language) : languageRule(this.language, this.languageName));
        parts.push(`${VERBOSITY[this.verbosity]} ${SPOKEN}`);
        return parts.join("\n\n");
    }
    /** @internal The greeting request's instructions. */
    greetingInstructions(greeting, options = {}) {
        if (typeof greeting === "string")
            return `Open the conversation by saying exactly this, in character, and nothing else: "${greeting}"`;
        if (options.known) {
            const who = options.name ? `${options.name}, ` : "";
            return (`Open the conversation: ${who}someone you have met before and remember, just came up to you. ` +
                "Greet them as someone you know, by name if you know it, in one short sentence, in character, " +
                "and if it fits, touch on something from last time.");
        }
        return `Open the conversation: greet the person who just came up to you in one short sentence, in character.${options.stranger ? " You have not met them before." : ""}`;
    }
    /** @internal The (code, name) a session is held to, when it is held to one. */
    pinnedLanguage(sessionLanguage) {
        if (sessionLanguage)
            return describeLanguage(sessionLanguage);
        if (typeof this.language === "string")
            return describeLanguage(this.language, this.languageName);
        if (Array.isArray(this.language) && this.language.length === 1)
            return describeLanguage(this.language[0], this.languageName);
        return null;
    }
    /** @internal The `session.update` body for a session. */
    async buildSessionConfig(session) {
        const voiceId = await this.client.resolveVoice(this.voice);
        const pinned = this.pinnedLanguage(session.language);
        let instructions = this.instructionsText({ language: session.language ?? undefined });
        if (session.extraInstructions)
            instructions += `\n\n${session.extraInstructions.trim()}`;
        if (byteLength(instructions) > MAX_INSTRUCTIONS_BYTES) {
            throw new ConfigurationError(`${this.name}'s instructions are ${byteLength(instructions)} bytes; the limit is ${MAX_INSTRUCTIONS_BYTES}. Move world knowledge into memory or context.`);
        }
        const output = {};
        if (this.outputSampleRate === 24_000)
            output.format = { type: "audio/pcm", rate: 24_000 };
        if (voiceId)
            output.voice = voiceId;
        if (this.speed !== undefined)
            output.speed = this.speed;
        const turnDetection = { type: "server_vad", interrupt_response: this.interruptible };
        if (this.turnTaking !== "natural")
            turnDetection.create_response = false;
        if (this.silenceMs !== undefined)
            turnDetection.silence_duration_ms = Math.round(this.silenceMs);
        const words = [this.name, ...this.hotwords, ...session.playerNames, ...(session.playerName ? [session.playerName] : [])];
        const transcription = { prompt: [...new Set(words.filter(Boolean))].join(", ") };
        const config = {
            instructions,
            audio: { output, input: { turn_detection: turnDetection, transcription } },
            tools: session.toolSpecs,
            tool_choice: session.toolSpecs.length ? "auto" : "none",
        };
        if (pinned) {
            const [code, name] = pinned;
            // The code makes the greeting, and anything said before the player's
            // first words, come out in this language; the name holds every reply to it.
            if (code)
                transcription.language = code;
            config.eesi_language_name = name;
        }
        if (this.thinking === "deliberate") {
            config.reasoning = { effort: "low" };
            config.eesi_delegation = "every_request";
        }
        return config;
    }
    /** The `session.update` body this character sends, for clients you build yourself. */
    sessionConfig(options = {}) {
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
    connect(options = {}) {
        return new Session(this, options, this.client.transport({ kind: "owned", model: this.model }));
    }
    /**
     * Steer, from your server, a session a player's client opened with `secret`
     * (minted with `clientSecret({ control: true })`). The client holds the
     * audio; this session sees everything else and acts in it: live context,
     * tools, cues, proactive remarks, memory. It becomes ready when the client
     * connects, so `connectTimeoutMs` (default ten minutes) is how long to wait.
     */
    control(secret, options = {}) {
        const minted = typeof secret === "string" ? null : secret;
        const controlId = minted ? minted.controlId : secret;
        if (!controlId)
            throw new ConfigurationError("This client secret has no control channel: mint it with clientSecret({ control: true }).");
        return new Session(this, {
            ...options,
            playerId: options.playerId ?? minted?.playerId ?? undefined,
            playerName: options.playerName ?? minted?.playerName ?? undefined,
            players: options.players ?? minted?.players ?? undefined,
            language: minted?.language ?? undefined,
            connectTimeoutMs: options.connectTimeoutMs ?? 600_000,
            controlTools: minted?.controlTools ?? "server",
        }, this.client.transport({ kind: "control", controlId: controlId }));
    }
    /** Several players in one conversation with this character; see `Room`. */
    room(players, options = {}) {
        return new Room(this, players, options);
    }
    /** Live sessions of this character. */
    get sessions() {
        return [...this.liveSessions];
    }
    /** Subscribe to events from every session of this character. */
    on(pattern, handler) {
        return this.bus.on(pattern, handler);
    }
    /** Register a tool (or several); live sessions are offered it at once. */
    tool(...tools) {
        for (const item of tools) {
            this.tools = [...this.tools.filter((existing) => existing.name !== item.name), item];
            for (const session of this.liveSessions)
                session.addTool(item);
        }
        return this;
    }
    /** Have the character remark when live state turns `condition` true, in every session. */
    when(condition, what, options = {}) {
        const trigger = new Trigger(condition, what, options);
        this.triggers.push(trigger);
        for (const session of this.liveSessions)
            session.addTrigger(trigger.fresh());
        return trigger;
    }
    /** Keep something. Without `playerId` it is the character's world knowledge, known to every session. */
    async remember(text, options = {}) {
        if (!this.memory)
            throw new ConfigurationError(`${this.name} has no memory. Create it with memory: true or a store.`);
        const record = await this.memory.remember(text, options);
        for (const session of this.liveSessions) {
            if (!options.playerId || session.playerId === options.playerId)
                await session.refreshMemory();
        }
        return record;
    }
    /** A mood every session of the character shares (a session's own mood wins). */
    async setMood(mood, options = {}) {
        if (!mood)
            return this.context.set("mood", null);
        const because = options.reason ? ` (${options.reason})` : "";
        return this.context.set("mood", `Your mood right now: ${mood}${because}. Let it colour how you speak; it does not change who you are.`);
    }
    /** A short-lived credential that opens a session already configured as this character. See `NurClient.clientSecret`. */
    clientSecret(options = {}) {
        return this.client.clientSecret(this, options);
    }
    /**
     * Run one of the character's tools for a call a client forwarded to your
     * server (a session opened with a client secret). Same validation,
     * `allow` and `confirm` as in a session; `ctx.session` is null.
     */
    async runTool(name, args, options = {}) {
        const runner = new ToolRunner(this.tools, (callId, toolArgs) => ({ session: null, character: this, playerId: options.playerId ?? null, callId, arguments: toolArgs }), () => undefined);
        const outcome = await runner.run(options.callId ?? `call_${Date.now().toString(36)}`, name, typeof args === "string" ? args : JSON.stringify(args));
        return outcome.output;
    }
    // ── portability ──────────────────────────────────────────────────────
    /** The character as JSON-ready data. Tools are listed by name; memory is not included. */
    toJSON() {
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
    clone(changes = {}) {
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
export function characterOptionsFromJSON(data, tools = []) {
    const get = (snake, camel) => (data[snake] ?? data[camel] ?? undefined);
    const voice = data.voice;
    const proactive = data.proactive;
    const options = {
        name: String(data.name),
        id: get("id", "id"),
        persona: get("persona", "persona"),
        instructions: get("instructions", "instructions"),
        voice: voice && typeof voice === "object" && "design" in voice ? (voice.design) : (voice ?? undefined),
        language: get("language", "language") ?? undefined,
        languageName: get("language_name", "languageName") ?? undefined,
        traits: get("traits", "traits"),
        speakingStyle: get("speaking_style", "speakingStyle") ?? undefined,
        goals: get("goals", "goals"),
        boundaries: get("boundaries", "boundaries"),
        knowledge: get("knowledge", "knowledge"),
        examples: get("examples", "examples"),
        greeting: get("greeting", "greeting"),
        verbosity: get("verbosity", "verbosity"),
        turnTaking: get("turn_taking", "turnTaking"),
        thinking: get("thinking", "thinking"),
        interruptible: get("interruptible", "interruptible"),
        silenceMs: get("silence_ms", "silenceMs") ?? undefined,
        speed: get("speed", "speed") ?? undefined,
        hotwords: get("hotwords", "hotwords"),
        model: get("model", "model"),
        preset: (get("preset", "preset") ?? undefined),
        party: get("party", "party"),
        personalize: get("personalize", "personalize"),
        endOnHangup: get("end_on_hangup", "endOnHangup"),
        version: get("version", "version") ?? undefined,
        metadata: get("metadata", "metadata"),
        context: get("context", "context"),
        tools,
        proactive: proactive
            ? {
                idleAfterMs: proactive.idle_after === null ? null : Number(proactive.idle_after ?? 25) * 1000,
                cooldownMs: Number(proactive.cooldown ?? 60) * 1000,
                maxRemarks: proactive.max_remarks ?? undefined,
                guidance: proactive.guidance ?? undefined,
            }
            : undefined,
    };
    return options;
}
//# sourceMappingURL=character.js.map