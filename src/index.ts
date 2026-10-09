/**
 * EESI SDK for TypeScript: characters you can talk to in real time on Nur
 * Live (`NurClient`, `joinSession`), and a typed client for the rest of the
 * EESI REST API (`EESIClient`).
 *
 * The REST client:
 *
 * Every method on `EESIClient` is generated from the backend's own OpenAPI
 * schema (see `scripts/generate_sdk.sh`), so the surface here is exactly the
 * set of routes carrying an `@sdk_expose` decorator — care, voices,
 * generations, organization usage and the speech endpoints.
 *
 * @example
 * ```ts
 * import { EESIClient } from "@eesi/sdk";
 *
 * const client = new EESIClient({
 *   baseUrl: "https://api.eesi.ai",
 *   apiKey: process.env.EESI_API_KEY,
 * });
 *
 * const voices = await client.listVoices();
 * ```
 */

export {
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_READ_TIMEOUT_MS,
    EESIClient,
} from "./client.js";
export type {
    EESIClientOptions,
    EESIFetch,
    EESIFetchInit,
    EESIFetchResponse,
} from "./client.js";
export { ApiError, EESISdkError, RequestTimeoutError } from "./errors.js";
// Every request and response shape the client methods take or return —
// `SpeechRequest`, `VoiceResponse`, `CarePatientCreateRequest`, … — plus the
// raw `paths` / `components` / `operations` maps for anyone building on them.
export type * from "./_generated_models.js";
// The body each method actually accepts (`CreateSpeechBody`, …). A response
// model is not it: the server's defaulted fields are typed as always present
// there, so declaring a body as one demands you restate every default.
export type * from "./_generated_client.js";
// Nur: characters, sessions, tools, live context, memory, multiplayer.
export * from "./nur/index.js";
