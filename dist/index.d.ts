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
export { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS, EESIClient, } from "./client.js";
export type { EESIClientOptions, EESIFetch, EESIFetchInit, EESIFetchResponse, } from "./client.js";
export { ApiError, EESISdkError, RequestTimeoutError } from "./errors.js";
export type * from "./_generated_models.js";
export type * from "./_generated_client.js";
export * from "./nur/index.js";
//# sourceMappingURL=index.d.ts.map