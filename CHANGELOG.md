# Changelog

All notable changes to `@eesi/sdk` for TypeScript. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/). Before 1.0, a minor version
may change public APIs; such changes are listed under **Changed**.

## 0.3.0

### Added

- `character.learnFromSession(event, { playerId })`: learn a player's
  memories from a client-secret session's `session.ended` webhook, which now
  carries the whole transcript; `input.completed` posts what the player said.
- `MemoryPolicy.rules`: what may be remembered, in your words (for example,
  game facts only for young players).
- The Nur SDK, in the same package as the REST client:
  `import { NurClient, joinSession } from "@eesi/sdk"`.
- Characters: persona, traits, speaking style, goals, boundaries, knowledge,
  examples, language and voice; presets `npc`, `multiplayerNpc`, `companion`,
  `storyteller`, `supportAgent` and `assistant`; save, load and clone as JSON
  that the Python SDK reads too.
- Realtime sessions on Nur Live: turn-taking (`natural`, `app`, `director`),
  barge-in, resume after a dropped connection, typed events, `ask()`, `cue()`,
  `moment()`, `say()`, `interrupt()` and hangup handling.
- Tools with JSON Schema parameters that type their arguments, validation,
  `allow` permissions, confirmation, timeouts and long-running work (`started`).
- Live context in named blocks with expiry, throttling and the gateway's
  limits checked before sending.
- Long memory per player and character: recall by relevance, importance and
  recency; learning after each session; preferences; inspection, correction,
  export, import and erasure. In memory, or in a JSON file with
  `@eesi/sdk/node`'s `fileMemory`.
- Multiplayer: a party log across players' sessions, players bound to voices
  on a shared microphone, and `Room`, which mixes several microphones and
  attributes each turn by who was loudest.
- Client secrets (`character.clientSecret`) for browsers and game clients,
  with `lock` for what the client may not change and `control` for a server
  channel that steers the session (`character.control`); `joinSession` and
  `forwardTools` on the client.
- Languages: follow the player, pin one (greeting included), or answer each
  player in a group in their own.
- Speaking first: triggers on live state (`when`) and idle check-ins
  (`proactive`), decided out of band and spoken only when worth it.
- `@eesi/sdk/browser`: the microphone through an AudioWorklet with echo
  cancellation, and sample-exact playback that a barge-in silences at once.
- `@eesi/sdk/node`: file memory, WAV files as microphone and speaker, traces
  on disk.
- Traces that hold no words by default, in the Python SDK's format.

### Changed

- Node 18 or later. Live sessions on your server use the platform's WebSocket
  (Node 22+); on Node 18 or 20 pass `webSocket` from the `ws` package.
