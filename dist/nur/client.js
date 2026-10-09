// The entry point: credentials, characters, voices, and the credentials
// browsers and game clients join with.
//
//     import { NurClient } from "@eesi/sdk";
//
//     const nur = new NurClient();   // EESI_API_KEY and EESI_API_URL from the environment
//     const kael = nur.npc({ name: "Kael", persona: "An elven merchant who distrusts kings.", voice: "Atlas", memory: true });
//     const session = await kael.connect({ playerId: "p42" }).start();
//
// Keep the API key on a machine you control. A browser or a game build gets
// a client secret instead (`kael.clientSecret()`), which opens one session
// already configured as the character and cannot change what you lock.
import { EESIClient } from "../client.js";
import { ApiError } from "../errors.js";
import { Character, characterOptionsFromJSON } from "./character.js";
import { ConfigurationError, NurError } from "./errors.js";
import { asPlayers } from "./multiplayer.js";
import { defaultWebSocket, Session } from "./session.js";
export const DEFAULT_BASE_URL = "https://api.eesi.ai";
export const DEFAULT_MODEL = "nur-live-v1";
/** A sentence a designed voice is frozen from; it becomes the clone's reference text. Shared with the Python SDK. */
const DESIGN_SENTENCES = {
    en: "Every voice carries a story, and how we say it matters.",
    ar: "لكل صوت حكاية، وطريقة قولها لا تقل أهمية عن الكلمات.",
};
const VOICE_CACHE_MS = 300_000;
function env(name) {
    return globalThis.process?.env?.[name];
}
function localTimezone() {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return zone && zone.includes("/") ? zone : null;
    }
    catch {
        return null;
    }
}
function quietLogger() {
    return { warn: (...args) => console.warn("[eesi]", ...args), error: (...args) => console.error("[eesi]", ...args) };
}
/** Exposes the REST client's request method for routes it has no method for. */
class Rest extends EESIClient {
    call(method, path, options) {
        return this.request(method, path, options);
    }
}
/** Characters on Nur Live. */
export class NurClient {
    baseUrl;
    realtimeUrl;
    model;
    timezone;
    logger;
    /** The full EESI REST API, with this client's key. */
    rest;
    http;
    webSocket;
    voiceCache = null;
    voicesLoading = null;
    constructor(options = {}) {
        const apiKey = options.apiKey ?? env("EESI_API_KEY");
        if (!apiKey) {
            throw new ConfigurationError("No API key: set EESI_API_KEY or pass new NurClient({ apiKey }). Create one on the API keys page of your EESI console. In a browser, use joinSession() with a client secret from your server instead.");
        }
        if (typeof globalThis.document !== "undefined" && !options.dangerouslyAllowBrowser) {
            throw new ConfigurationError("An API key in a web page is readable by everyone who opens it. Mint client secrets on your server (character.clientSecret()) and call joinSession() here; pass dangerouslyAllowBrowser: true only for a local tool.");
        }
        let base = (options.baseUrl ?? env("EESI_API_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        if (base.endsWith("/v1"))
            base = base.slice(0, -3);
        let parsed;
        try {
            parsed = new URL(base);
        }
        catch {
            throw new ConfigurationError(`baseUrl must look like https://api.eesi.ai, not ${JSON.stringify(base)}.`);
        }
        const http = { "ws:": "http:", "wss:": "https:" }[parsed.protocol] ?? parsed.protocol;
        const ws = { "http:": "ws:", "https:": "wss:" }[parsed.protocol] ?? parsed.protocol;
        if (!["http:", "https:"].includes(http))
            throw new ConfigurationError(`baseUrl must be http(s) or ws(s), not ${parsed.protocol}`);
        const path = parsed.pathname.replace(/\/+$/, "");
        this.baseUrl = `${http}//${parsed.host}${path}`;
        this.realtimeUrl = `${ws}//${parsed.host}${path}/v1/realtime`;
        this.model = options.model ?? DEFAULT_MODEL;
        this.timezone = options.timezone === undefined ? localTimezone() : options.timezone;
        this.logger = options.logger ?? quietLogger();
        this.webSocket = options.webSocket ?? defaultWebSocket();
        this.http = new Rest({ apiKey, baseUrl: this.baseUrl, fetch: options.fetch });
        this.rest = this.http;
    }
    // ── characters ───────────────────────────────────────────────────────
    /** Any character: a persona and options, or a `preset`. */
    character(options) {
        return new Character(this, options);
    }
    /** A character who lives in your game's world (preset `npc`). */
    npc(options) {
        return new Character(this, { preset: "npc", ...options });
    }
    /** An NPC several players talk to, keeping its story straight between them (preset `multiplayer_npc`, with a party log). */
    multiplayerNpc(options) {
        return new Character(this, { preset: "multiplayer_npc", ...options });
    }
    /** A personal companion with long memory, who checks in after a quiet stretch (preset `companion`). */
    companion(options) {
        return new Character(this, { preset: "companion", memory: true, ...options });
    }
    /** An interactive storyteller (preset `storyteller`). */
    storyteller(options) {
        return new Character(this, { preset: "storyteller", ...options });
    }
    /** A support agent that answers only from its knowledge and tools (preset `support_agent`). */
    supportAgent(options) {
        return new Character(this, { preset: "support_agent", ...options });
    }
    /** A plain voice assistant (preset `assistant`). */
    assistant(options) {
        return new Character(this, { preset: "assistant", ...options });
    }
    /**
     * A character saved with `character.toJSON()` (by either SDK). Functions
     * are not saved: pass its `tools` again.
     */
    loadCharacter(saved, options = {}) {
        const data = typeof saved === "string" ? JSON.parse(saved) : saved;
        const { tools = [], ...overrides } = options;
        const expected = new Set(Array.isArray(data.tools) ? data.tools : []);
        const missing = [...expected].filter((name) => !tools.some((item) => item.name === name));
        if (missing.length)
            this.logger.warn(`the loaded character expects tools you did not pass: ${missing.sort().join(", ")}`);
        return new Character(this, { ...characterOptionsFromJSON(data, tools), ...overrides });
    }
    // ── voices ───────────────────────────────────────────────────────────
    /** Built-in voices and your organization's own. */
    async voices(options = {}) {
        if (!options.refresh && this.voiceCache && Date.now() - this.voiceCache.at < VOICE_CACHE_MS)
            return [...this.voiceCache.voices];
        this.voicesLoading ??= this.http
            .call("GET", "/voices")
            .then((body) => {
            const voices = (body?.data ?? [])
                .filter((item) => item.voice_id || item.id)
                .map((item) => ({
                id: String(item.voice_id ?? item.id),
                name: String(item.name ?? ""),
                isBuiltin: Boolean(item.is_builtin),
                status: String(item.status ?? "ready"),
                language: item.language ?? null,
                gender: item.gender ?? null,
                category: item.category ?? null,
                description: item.description ?? null,
            }));
            this.voiceCache = { at: Date.now(), voices };
            return voices;
        })
            .finally(() => {
            this.voicesLoading = null;
        });
        return [...(await this.voicesLoading)];
    }
    /** A voice id (`ev_…`) for a name, an id or a `VoiceDesign`. */
    async resolveVoice(voice) {
        if (voice === undefined || voice === null)
            return null;
        if (typeof voice === "object")
            return (await this.designVoice(voice.name, voice.description, { language: voice.language })).id;
        if (voice.startsWith("ev_"))
            return voice;
        const wanted = voice.trim().toLowerCase();
        const voices = await this.voices();
        const found = voices.find((item) => item.name.toLowerCase() === wanted || item.id.toLowerCase() === wanted);
        if (found)
            return found.id;
        const names = [...new Set(voices.filter((item) => item.status === "ready").map((item) => item.name))].sort().join(", ");
        throw new ConfigurationError(`There is no voice named ${JSON.stringify(voice)}. Available: ${names}. Use a voice id (ev_…), or describe one with voice: nur.voiceDesign("Kael", "male, elderly, low pitch, british accent").`);
    }
    /** A described voice, created on first use and reused by name after that. */
    voiceDesign(name, description, options = {}) {
        return { name, description, language: options.language ?? "en" };
    }
    /**
     * Create a voice from a description, or return your voice already named
     * `name`. It is synthesized once and saved to your library like a clone,
     * so it sounds the same in every session. No person's recording is used.
     */
    async designVoice(name, description, options = {}) {
        const language = options.language ?? "en";
        const existing = (await this.voices()).find((item) => item.name.toLowerCase() === name.toLowerCase() && !item.isBuiltin);
        if (existing)
            return existing;
        const sentence = DESIGN_SENTENCES[language] ?? DESIGN_SENTENCES.en;
        const audio = await this.http.createSpeech({
            body: { model: "nur-tts-v1", input: sentence, voice: "auto", instructions: description, language, response_format: "wav" },
        });
        // Built by hand so the file keeps its name on every runtime (Node 18 has no global File).
        const form = new FormData();
        form.append("file", new Blob([audio.slice().buffer], { type: "audio/wav" }), `${name}.wav`);
        form.append("name", name);
        // A designed voice is synthetic: no person's voice is cloned.
        form.append("consent_attested", "true");
        form.append("ref_text", sentence);
        form.append("language", language);
        form.append("category", "characters");
        form.append("description", `Designed: ${description}`.slice(0, 500));
        const created = await this.http.call("POST", "/voices", { form });
        const id = String(created.voice_id ?? created.id);
        let status = String(created.status ?? "processing");
        const deadline = Date.now() + (options.waitMs ?? 60_000);
        while (status !== "ready" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const current = await this.http.call("GET", `/voices/${encodeURIComponent(id)}`);
            status = String(current.status ?? status);
            if (status === "failed")
                throw new NurError(`Designing the voice ${JSON.stringify(name)} failed.`);
        }
        this.voiceCache = null;
        return { id, name, isBuiltin: false, status, language, gender: null, category: "characters", description };
    }
    // ── text and credentials ─────────────────────────────────────────────
    /** One completion from EESI's text model (`/v1/chat/completions`). Memory extraction uses it. */
    async chat(messages, options = {}) {
        const body = {
            model: options.model ?? "nur-llm-v1",
            messages,
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 900,
        };
        const json = options.json ?? true;
        if (json)
            body.response_format = { type: "json_object" };
        let data;
        try {
            data = await this.http.chatCompletions({ body });
        }
        catch (error) {
            if (!(json && error instanceof ApiError && error.statusCode === 400))
                throw error;
            delete body.response_format;
            data = await this.http.chatCompletions({ body });
        }
        const choices = data?.choices ?? [];
        const content = choices[0]?.message?.content;
        return typeof content === "string" ? content : "";
    }
    /** A one-shot WebSocket ticket (`rt_…`), for a client that configures the session itself. */
    async ticket() {
        const body = await this.http.call("POST", "/realtime/ticket");
        return body.ticket;
    }
    /**
     * A credential that opens a session already configured as `character`,
     * for one player's browser or game client. Your server keeps the API key;
     * the client gets `secret.join` (or just `secret.url`) and nothing else.
     *
     * The session it opens has the character's instructions, voice and tools,
     * the player's memories and the context you pass, composed now. The
     * client cannot change what `lock` names. With `control`, your server
     * also steers the session: `character.control(secret)`.
     */
    async clientSecret(character, options = {}) {
        const control = options.control === true ? "server" : options.control || null;
        if (control !== null && control !== "server" && control !== "client")
            throw new ConfigurationError('control is true, "server" or "client".');
        const players = asPlayers(options.players);
        const probe = new Session(character, {
            playerId: options.playerId,
            playerName: options.playerName,
            players: options.players,
            language: options.language,
            context: options.context,
            instructions: options.instructions,
            greeting: options.greeting,
        }, this.transport({ kind: "owned", model: character.model }));
        const { config, blocks, greeting } = await probe.prepare();
        const seconds = Math.round(options.expiresInSeconds ?? 60);
        const body = {
            session: { type: "realtime", model: character.model, ...config },
            expires_after: { anchor: "created_at", seconds },
            eesi_context: blocks,
        };
        if (options.lock !== undefined)
            body.eesi_lock = options.lock;
        if (control)
            body.eesi_control = { tools: control };
        const limits = {};
        if (options.maxDurationSeconds !== undefined)
            limits.max_duration_seconds = Math.round(options.maxDurationSeconds);
        if (options.silenceHangupSeconds !== undefined)
            limits.silence_hangup_seconds = Math.round(options.silenceHangupSeconds);
        if (Object.keys(limits).length)
            body.eesi_limits = limits;
        if (options.webhook)
            body.eesi_webhook = { url: options.webhook.url, secret: options.webhook.secret };
        if (options.metadata && Object.keys(options.metadata).length)
            body.eesi_metadata = options.metadata;
        if (options.train === false || options.record === false)
            body.eesi_data = { train: options.train ?? true, record: options.record ?? true };
        let data;
        try {
            data = (await this.http.call("POST", "/realtime/client_secrets", { json: body })) ?? {};
        }
        catch (error) {
            if (error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 405)) {
                throw new ConfigurationError("This EESI deployment cannot bind a character to a client secret yet. Use nur.ticket() and send await character.sessionConfig() from the client as its first session.update.");
            }
            throw error;
        }
        const nested = (data.client_secret ?? {});
        const value = String(data.value ?? nested.value ?? "");
        const query = new URLSearchParams({ model: character.model, source: "sdk-client", token: value });
        const url = `${this.realtimeUrl}?${query.toString()}`;
        const expiresAt = Number(data.expires_at ?? Date.now() / 1000 + seconds);
        const lock = (Array.isArray(data.eesi_lock) ? data.eesi_lock : ["instructions", "tools"]);
        const channel = (data.eesi_control ?? null);
        const controlId = channel?.id ?? null;
        const controlTools = channel?.tools === "client" ? "client" : channel?.tools === "server" ? "server" : null;
        const controlled = controlId !== null;
        const turnTaking = character.turnTaking === "natural" ? "natural" : controlled ? "director" : character.turnTaking;
        return {
            value,
            url,
            expiresAt,
            session: data.session ?? body.session,
            lock,
            controlId,
            controlTools,
            playerId: options.playerId ?? null,
            playerName: options.playerName ?? null,
            players,
            language: options.language ?? null,
            join: {
                url,
                token: value,
                callsUrl: `${this.baseUrl}/v1/realtime/calls`,
                expiresAt,
                character: character.name,
                model: character.model,
                turnTaking,
                tools: controlled && controlTools === "server" ? "server" : "client",
                controlled,
                // A controlled session's greeting and remarks are the server's.
                greeting: controlled ? null : greeting,
                proactive: controlled || lock.includes("conversation") ? null : character.proactive,
                outputSampleRate: character.outputSampleRate,
                playerId: options.playerId ?? null,
                playerName: options.playerName ?? null,
            },
        };
    }
    /** @internal How a character's sessions reach the gateway. */
    transport(target) {
        const base = { webSocket: this.webSocket, logger: this.logger };
        if (target.kind === "control") {
            return {
                ...base,
                kind: "control",
                url: async () => `${this.realtimeUrl}/control/${encodeURIComponent(target.controlId)}?${new URLSearchParams({ token: await this.ticket() }).toString()}`,
            };
        }
        return {
            ...base,
            kind: "owned",
            url: async (resume) => {
                const query = new URLSearchParams({ model: target.model, source: "sdk" });
                if (this.timezone)
                    query.set("timezone", this.timezone);
                if (resume) {
                    query.set("resume", resume.resume);
                    query.set("resume_token", resume.resume_token);
                }
                query.set("token", await this.ticket());
                return `${this.realtimeUrl}?${query.toString()}`;
            },
        };
    }
}
//# sourceMappingURL=client.js.map