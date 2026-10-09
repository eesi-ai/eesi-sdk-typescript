// The Nur SDK: characters you can talk to in real time on Nur Live.
//
// Server (Node, Deno, Bun), with your API key:
//
//     import { NurClient, tool } from "@eesi/sdk";
//     const nur = new NurClient();
//     const kael = nur.npc({ name: "Kael", persona: "An elven merchant who distrusts kings.", voice: "Atlas", memory: true });
//     const session = await kael.connect({ playerId: "p42" }).start();
//     console.log((await session.ask("Who goes there?")).text);
//
// Browser or game client, with a client secret from your server:
//
//     import { joinSession } from "@eesi/sdk";
//     import { browserAudio } from "@eesi/sdk/browser";
//     const session = await joinSession(join, { audio: await browserAudio() });

export { DEFAULT_BASE_URL, DEFAULT_MODEL, NurClient } from "./client.js";
export type { ClientSecret, ClientSecretOptions, JoinInfo, LockName, NurClientOptions, Voice, VoiceDesign } from "./client.js";
export { Character, characterOptionsFromJSON } from "./character.js";
export type { CharacterOptions, ConnectOptions, TurnTaking, Verbosity } from "./character.js";
export { Preferences, Session, summarizeMetrics, TURN_SETTLE_MS } from "./session.js";
export type { MetricsSummary, SessionMetrics, ToolCall, WebSocketFactory, WebSocketLike } from "./session.js";
export { forwardTools, joinSession } from "./join.js";
export type { JoinOptions } from "./join.js";
export { FRAME_MS, Room, SPEECH_FLOOR } from "./room.js";
export type { RoomOptions } from "./room.js";
export { renderResult, started, Tool, tool } from "./tools.js";
export type { AnyTool, Started, ToolContext, ToolDefinition } from "./tools.js";
export { validateSchema } from "./schema.js";
export type { FromSchema, JSONSchema, ObjectSchema, SchemaType } from "./schema.js";
export { LiveContext, renderFields } from "./context.js";
export { EventBus } from "./events.js";
export type {
    AudioInputEnded,
    AudioInputStarted,
    AudioOutputChunk,
    ContextUpdated,
    ErrorEvent,
    EventBase,
    EventOf,
    EventPattern,
    Feedback,
    Handler,
    Hangup,
    Logger,
    MemoryRetrieved,
    MemoryUpdated,
    NurEvent,
    NurEventType,
    Reconnected,
    Reconnecting,
    ResponseCancelled,
    ResponseCompleted,
    ResponseStarted,
    ResponseTextDelta,
    SessionEnded,
    SessionStarted,
    SpeakerTurn,
    SpeechInterrupted,
    ToolCompleted,
    ToolFailed,
    ToolStarted,
    TranscriptFinal,
    TranscriptPartial,
} from "./events.js";
export * from "./memory/index.js";
export { asPlayers, PartyLog, playerKey, SpeakerRoster } from "./multiplayer.js";
export type { AttributedTurn, Player } from "./multiplayer.js";
export { IDLE_SKIP, Trigger } from "./proactive.js";
export type { Proactive, State, TriggerOptions } from "./proactive.js";
export type { Moment } from "./initiative.js";
export { describeLanguage, LANGUAGE_NAMES } from "./languages.js";
export { PRESETS } from "./presets.js";
export type { Preset, PresetName } from "./presets.js";
export { formatTrace, Trace } from "./trace.js";
export type { TraceOptions } from "./trace.js";
export {
    base64ToBytes,
    bytesToBase64,
    floatToPcm,
    pcmToFloat,
    pcmToSamples,
    PlayoutClock,
    Resampler,
    rms,
    samplesToPcm,
    SilentOutput,
} from "./audio.js";
export type { AudioDevices, AudioInput, AudioOutput } from "./audio.js";
export { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, splitSpeakerTurns } from "./protocol.js";
export {
    AuthenticationError,
    ConfigurationError,
    ContextError,
    MemoryStoreError,
    NurError,
    RealtimeConnectionError,
    SessionClosedError,
    ToolDefinitionError,
} from "./errors.js";
export { VERSION } from "./version.js";
