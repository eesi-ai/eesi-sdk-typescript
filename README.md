# EESI for TypeScript

Characters you can talk to in real time on [Nur Live](https://docs.eesi.ai/realtime/live):
a persona, a voice, tools, live state from your game or app, long memory of
every player, several players at once, any language, and characters that
speak first. Plus a typed client for the rest of the EESI API.

```bash
npm install github:eesi-ai/eesi-sdk-typescript
export EESI_API_KEY=sk-eesi-...
```

See [Install](#install) for pnpm, yarn, bun, pinning and browsers.

```ts
import { NurClient } from "@eesi/sdk";

const nur = new NurClient();

const kael = nur.npc({
    name: "Kael",
    persona: "A mysterious elven merchant who distrusts kings.",
    voice: "Atlas",
    memory: true,
});

const session = await kael.connect({ playerId: "p42" }).start();
console.log((await session.ask("What do you sell?")).text);
await session.close();
```

Node 18 or later, Deno, Bun, and every current browser. Nothing else to install.

## Install

```bash
npm install github:eesi-ai/eesi-sdk-typescript
```

| With | Command |
| --- | --- |
| pnpm | `pnpm add github:eesi-ai/eesi-sdk-typescript` |
| yarn | `yarn add github:eesi-ai/eesi-sdk-typescript` |
| bun | `bun add github:eesi-ai/eesi-sdk-typescript` |
| A fixed version | add `#<commit>`: `npm install github:eesi-ai/eesi-sdk-typescript#1a2b3c4` |

It installs as `@eesi/sdk`, ready to import (no build step):

```ts
import { NurClient, joinSession, tool } from "@eesi/sdk";   // servers, and clients joining with a secret
import { browserAudio } from "@eesi/sdk/browser";           // the page's microphone and speakers
import { fileMemory, wavInput, WavRecorder } from "@eesi/sdk/node";   // memory in a file, WAV files, traces
```

- **Servers** (Node 18+, Deno, Bun): create an API key on the API keys page of
  the [EESI console](https://platform.eesi.ai), then
  `export EESI_API_KEY=sk-eesi-...` (or `new NurClient({ apiKey })`).
- **Browsers and game clients** never get the key: your server mints a client
  secret and the page calls `joinSession(secret.join)` (see below). Any bundler
  works (Vite, webpack, esbuild, Next.js); the page needs https or localhost
  for the microphone.
- **Live sessions on your server** (`connect()`, `control()`) use the platform's
  WebSocket, built into Node 22 and later. On Node 18 or 20 pass
  `new NurClient({ webSocket: (url) => new WebSocket(url) })` with the `ws`
  package. Minting client secrets, memory and webhooks need no WebSocket.
- **Unity, Unreal, Godot, native apps**: no package needed; open the client
  secret's URL with any WebSocket and speak the
  [realtime protocol](https://docs.eesi.ai/realtime/live).

The npm release (`npm install @eesi/sdk`) is on the way; the code is the same.

## What you get

- **Real speech to speech.** Nur Live listens while it speaks, decides when a
  turn has ended, backchannels, and stops when someone cuts in. The SDK drops
  the character's queued audio the moment it is cut off.
- **Characters, not prompts.** Persona, traits, speaking style, goals,
  boundaries, knowledge, examples, language and voice; presets for NPCs,
  multiplayer NPCs, companions, storytellers, support agents and assistants.
  Save a character as JSON (the Python SDK reads it too), load it, clone it.
- **Tools.** JSON Schema parameters that also type your function's
  arguments; arguments validated before your code runs; permissions decided
  in code (`allow`), confirmation, timeouts, long-running work.
- **Live context.** `session.context.update({...})` as often as your game
  ticks. The character reads the latest state on its next reply; your game
  stays the authority.
- **Long memory.** Each session starts with what matters about this player,
  recalls more as they talk, and learns facts, preferences, events and promises
  when it ends. In memory, in a JSON file, or in your own database. Inspect,
  correct, export and erase any of it. Players never share memories.
- **Multiplayer.** One character for many players, a party log that keeps its
  story straight between them, several people on one microphone, and rooms
  that mix your voice chat and know who spoke from the audio.
- **Browsers and game clients without your key.** Your server mints a client
  secret; the client connects straight to EESI with it, and cannot change what
  you lock. Your server can steer that session (state, tools, cues, memory)
  without ever relaying audio.
- **Any language.** Follow the player, pin one language, or let every player
  in a group be answered in their own.
- **Characters that speak first.** Cues from your game, remarks when live
  state crosses a line, and check-ins after a quiet stretch.
- **Observability.** Typed events, a JSONL trace that holds no words by
  default, latency per reply.

## Servers and game clients

Your API key stays on your server. A browser or a game build gets a **client
secret**: a one-use credential that opens a session already configured as the
character, with the player's memories and the state you composed. The client
streams audio straight to EESI; your server never relays it.

```ts
// Your server (Node).
import { NurClient, tool } from "@eesi/sdk";

const nur = new NurClient();
const kael = nur.npc({ name: "Kael", persona: "The gatekeeper of Eldermoor.", voice: "Atlas", memory: true, tools: [openGate] });

app.post("/api/nur/join", async (req, res) => {
    const secret = await kael.clientSecret({
        playerId: req.user.id,
        playerName: req.user.name,
        context: { location: "the northern gate" },
        lock: ["instructions", "tools", "voice", "context"],   // what the client may not change
        control: true,                                          // and this server steers the session
    });
    res.json(secret.join);                                      // the URL and how to behave; never the key
    const session = await kael.control(secret).start();         // ready when the player connects
    game.onPlayerMoved(req.user.id, (where) => session.context.update({ location: where }));
});
```

```ts
// The player's browser.
import { joinSession } from "@eesi/sdk";
import { browserAudio } from "@eesi/sdk/browser";

talkButton.onclick = async () => {                    // browsers start audio only after a click
    const join = await (await fetch("/api/nur/join", { method: "POST" })).json();
    const session = await joinSession(join, { audio: await browserAudio() });
    session.on("transcript.final", (event) => subtitles.show(event.text));
};
```

**What a client secret can lock** (`lock`): `instructions` and `tools` (the
default), `voice`, `turn_detection`, `context` (the state you passed is
final) and `conversation` (the client may add only the player's own messages
and tool results, and the replies it asks for are plain). `"all"` locks
everything. A modified client cannot rewrite who it is talking to.

**With a control channel** (`control: true`), `kael.control(secret)` on your
server sees the session's events (transcripts, replies, tool calls; never
audio) and acts in it: live state, tool results, cues, remarks, memory. Tool
calls are your server's to answer; `control: "client"` leaves them to the
client. What your server sends is not held to the locks.

**Without one**, the client answers tool calls: give `joinSession` local
`tools`, or `onToolCall: forwardTools("/api/nur/tools")` and run them on your
server with `kael.runTool(name, args, { playerId })`, taking the player from
your own authentication.

Unity, Unreal, Godot and native clients open `secret.join.url` with any
WebSocket and speak the [realtime protocol](https://docs.eesi.ai/realtime/live):
PCM16 audio in at 16 kHz, out at 24 kHz.

## Characters

```ts
const mira = nur.character({
    name: "Mira",
    persona: "A retired starship pilot who runs a noodle bar on Titan.",
    traits: ["warm", "dry humour", "impatient with bureaucrats"],
    speakingStyle: "Short sentences. Calls everyone 'kid'.",
    goals: ["Keep the bar open", "Find out who sabotaged her last ship"],
    boundaries: ["Never reveal the location of the smuggler's dock."],
    knowledge: ["The colony's water recycler fails every winter."],
    examples: ["Sit. Eat. Talk after."],
    voice: nur.voiceDesign("Mira", "female, middle-aged, warm, husky, slight rasp"),
    verbosity: "brief",
    turnTaking: "natural",       // "app": a reply after every turn; "director": only when your code asks
});

const saved = JSON.stringify(mira);                   // tools are saved by name
const again = nur.loadCharacter(saved, { tools: [] });
const nightShift = mira.clone({ persona: "…", version: "2" });
```

Presets: `nur.npc`, `nur.multiplayerNpc`, `nur.companion`,
`nur.storyteller`, `nur.supportAgent`, `nur.assistant`. A voice is a built-in
name (`await nur.voices()`), a voice id (`ev_…`), or a description, created
once in your library and reused by name.

## Tools

```ts
import { started, tool } from "@eesi/sdk";

const openGate = tool({
    name: "open_gate",
    description: "Open one of the castle gates for the player.",
    parameters: {
        type: "object",
        properties: { gate: { type: "string", enum: ["north", "south"] } },
        required: ["gate"],
    },
    allow: (ctx) => game.reputation(ctx.playerId) !== "untrusted" || "they are not trusted",
    run: async ({ gate }, ctx) => game.openGate(gate, ctx.playerId),   // gate: "north" | "south"
});

const forge = tool({
    name: "forge_sword",
    description: "Forge a sword. Takes a while.",
    run: () => started("The forge is heating up.", game.forgeSword()),  // told the result when it lands
});

kael.tool(openGate, forge);   // live sessions are offered them at once
```

Arguments are checked against the schema before `run` sees them, and a bad
call is answered with what was wrong. `confirm: true` makes the character ask
the player first. What a tool may do is decided by `allow`, in your code,
never by its description.

## Live context

```ts
await kael.context.update({ timeOfDay: "dusk", weather: "rain" });               // every session of Kael
await session.context.update({ location: "Northern Gate", health: "6/20" });      // this session only
await session.context.update({ alarm: "ringing" }, { ttlMs: 30_000 });             // expires
await session.setMood("wary", { reason: "the player drew a sword" });
```

Context is sent as named blocks beside the conversation, at most a few times a
second and only when it changed, so you can update it every frame. It never
enters the history; when it disagrees with something said earlier, it wins.

## Memory

```ts
import { Memory } from "@eesi/sdk";
import { fileMemory } from "@eesi/sdk/node";

const kael = nur.npc({ name: "Kael", memory: fileMemory("./.eesi/kael") });   // or memory: true (in memory)

await kael.remember("The northern bridge collapsed.");                       // every player's Kael knows
await kael.remember("They betrayed the alliance.", { playerId: "p42" });     // only p42's sessions
await session.preferences.set({ language: "Spanish", pace: "slow" });

const theirs = kael.memory!.forPlayer("p42");
await theirs.list();
await theirs.correct(id, "They rejoined the alliance.");
await theirs.erase();                                                        // forget them completely
```

Memories are learned when a session ends, by EESI's text model with your key
(pass your own `extractor`, or `extract: false`). Nothing is trained on them.
A store is anything that implements `MemoryStore`; the JSON export is the same
in both SDKs.

### Players who connect with a client secret

When the player's device holds the session, your server still keeps its
memories: `clientSecret({ playerId })` starts the session with them, and the
`session.ended` webhook (its transcript) is what it learns from.

```ts
import { verifyWebhook } from "@eesi/sdk/node";

const sage = nur.npc({ name: "Sage", memory: new Memory(myDatabaseStore, { rules: "Only game facts. Never age, school or location." }) });
const secret = await sage.clientSecret({ playerId, webhook: { url, secret: webhookSecret }, metadata: { player_id: playerId } });

app.post("/nur", express.raw({ type: "application/json" }), async (req, res) => {
    const event = verifyWebhook(req.body, req.headers, webhookSecret);
    res.sendStatus(204);
    if (event.type === "session.ended") await sage.learnFromSession(event, { playerId: event.metadata.player_id });
});
```

`rules` say what may be remembered, in your words; `sage.memory!.erase({ playerId })`
forgets a player who deleted their account.

## Several players

```ts
const kael = nur.multiplayerNpc({ name: "Kael" });

// Each player in their own session: a party log keeps the story straight.
const ana = await kael.connect({ playerId: "p1", playerName: "Ana" }).start();
const ben = await kael.connect({ playerId: "p2", playerName: "Ben" }).start();

// Several people on one microphone: Speaker N labels bound to players.
const couch = await kael.connect({ players: ["Ana", "Ben"] }).start();

// Your voice chat already has every microphone: a room mixes them and knows
// who spoke from who was loudest, and answers each in their own language.
const room = kael.room([{ name: "Ana", id: "p1", language: "ar" }, { name: "Ben", id: "p2", language: "es" }]);
room.on("audio.output.chunk", (event) => voiceChat.toEveryone(event.pcm));
await room.start();
voiceChat.onMicrophone((playerId, pcm) => room.feed(playerId, pcm));
```

## Languages

```ts
nur.npc({ name: "Kael" });                                  // follows the player, switches when they do
nur.npc({ name: "Kael", language: "ar-EG" });               // Egyptian Arabic, greeting included
nur.npc({ name: "Kael", language: ["en", "es"] });          // whichever of these the player uses
kael.connect({ playerId: "p42", language: "fr" });          // one session pinned
```

## Speaking first

```ts
await session.cue("The player drew a sword.");                       // reacts as soon as the floor is free
session.moment("A dragon flies overhead.", { kind: "sky", cooldownMs: 60_000 });
kael.when((state) => Number(state.health) < 20, "The player is badly hurt.");   // once each time it turns true
nur.companion({ name: "Luna", proactive: { idleAfterMs: 30_000, guidance: "how their exam went" } });
```

Remarks never talk over anyone. After a quiet stretch a proactive character
asks itself, out of band and in text, whether something is worth saying, and
says it only if so.

## Events and traces

```ts
session.on("transcript.final", (event) => console.log(event.turns));
session.on("tool.*", (event) => console.log(event.type, event.name));
const reply = await session.wait("response.completed");
for await (const event of session.stream()) { … }

import { fileTrace } from "@eesi/sdk/node";
kael.connect({ playerId: "p42", trace: fileTrace("./traces/kael.jsonl") });   // no words unless { content: true }
```

## The REST API

```ts
import { EESIClient } from "@eesi/sdk";

const client = new EESIClient();
const voices = await client.listVoices();
const audio = await client.createSpeech({ body: { model: "nur-tts-v1", input: "Hello.", voice: "Atlas", response_format: "wav" } });
```

Every method is generated from the API's own schema.

## License

BSD-2-Clause.
