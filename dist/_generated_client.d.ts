import type { ApiKeyResponse, BillingCreditsResponse, ClientSecretRequest, ClientSecretResponse, CurrentUsageResponse, DailyUsageBreakdownResponse, GenerationListResponse, InteractionFailure, InteractionFailureList, InteractionFailureUpdate, OrganizationTurnMetricsSummaryResponse, ScorecardResponse, SeparatedClip, SpeechModelsResponse, SpeechRequest, UsageBreakdownResponse, UsageHistoryResponse, VoiceIsolation, VoiceIsolationRequest, VoiceResponse, VoiceUpdateRequest, VoicesListResponse } from "./_generated_models.js";
/**
 * A request body as you send it, rather than as it comes back.
 *
 * The generated models type a defaulted field (`response_format`, `speed`,
 * `stream_format`, …) as always present, which is true of a response — the
 * server filled it in. On the way out it makes the caller restate every
 * server default to get a body past the compiler, so `K` is optional here.
 */
export type SendableBody<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
/** The body `createRealtimeClientSecret` takes. */
export type CreateRealtimeClientSecretBody = ClientSecretRequest;
/** The body `createSpeech` takes. */
export type CreateSpeechBody = SendableBody<SpeechRequest, "response_format" | "speed" | "stream_format" | "normalize_text">;
/** The body `setVoiceIsolation` takes. */
export type SetVoiceIsolationBody = VoiceIsolationRequest;
/** The body `updateFailure` takes. */
export type UpdateFailureBody = InteractionFailureUpdate;
/** The body `updateVoice` takes. */
export type UpdateVoiceBody = VoiceUpdateRequest;
export declare abstract class _GeneratedClient {
    protected abstract request<T = unknown>(method: string, path: string, opts?: {
        json?: unknown;
        params?: Record<string, unknown>;
        form?: FormData;
        raw?: boolean;
    }): Promise<T>;
    /** Archive an API key (soft delete). */
    archiveApiKey(apiKeyId: number): Promise<unknown>;
    /** Chat completions. `body` is an OpenAI chat-completions request and is forwarded verbatim; the parsed completion is returned. Streaming (`stream: true`) is not supported by this method — use an OpenAI client for that. */
    chatCompletions(opts: {
        body: Record<string, unknown>;
    }): Promise<unknown>;
    /** Mint a one-use credential that opens a realtime session already configured as you specify, for a client that must not hold your key. */
    createRealtimeClientSecret(opts: {
        body: ClientSecretRequest;
    }): Promise<ClientSecretResponse>;
    /** Create speech. */
    createSpeech(opts: {
        body: SendableBody<SpeechRequest, "response_format" | "speed" | "stream_format" | "normalize_text">;
    }): Promise<Uint8Array>;
    /** Create transcription. */
    createTranscription(opts: {
        file: Blob;
        model: string;
        language?: string;
        prompt?: string;
        responseFormat?: "json" | "text" | "verbose_json" | "srt" | "vtt";
        temperature?: number;
        timestampGranularities?: ("word" | "segment")[];
        stream?: boolean;
    }): Promise<unknown>;
    /** Clone a voice from 3-10 seconds of reference audio. */
    createVoice(opts: {
        file: Blob;
        name: string;
        consentAttested?: boolean;
        refText?: string;
        engine?: "nur-tts-v1" | "omnivoice";
        category?: "general" | "conversational" | "narrative" | "podcast" | "customer-service" | "corporate" | "advertising" | "characters";
        description?: string;
        language?: string;
        gender?: "female" | "male" | "neutral";
        accent?: string;
        preferIsolated?: boolean;
    }): Promise<VoiceResponse>;
    /** Delete a cloned voice. */
    deleteVoice(voiceId: string): Promise<VoiceResponse>;
    /** Get all API keys for the user's selected organization. */
    getApiKeys(opts?: {
        includeArchived?: boolean;
    }): Promise<ApiKeyResponse[]>;
    /** Return the organization's prepaid credit balance and paginated ledger. */
    getBillingCredits(opts?: {
        page?: number;
        limit?: number;
    }): Promise<BillingCreditsResponse>;
    /** Get current reporting-period usage for the user's organization. */
    getCurrentPeriodUsage(): Promise<CurrentUsageResponse>;
    /** Get daily usage breakdown for the last N days. Only available for organizations with pricing. */
    getDailyUsageBreakdown(opts?: {
        days?: number;
    }): Promise<DailyUsageBreakdownResponse>;
    /** One interaction failure. */
    getFailure(failureId: string): Promise<InteractionFailure>;
    /** Per runtime bundle: sessions, how they ended, evidence coverage, reply latency and failures — the scorecard a release is judged by. */
    getFailureScorecard(opts?: {
        days?: number;
    }): Promise<ScorecardResponse>;
    /** Organization-wide per-turn latency summary over an optional day window. */
    getOrganizationTurnMetricsSummary(opts?: {
        days?: number;
    }): Promise<OrganizationTurnMetricsSummaryResponse>;
    /** Get usage cost broken down by kind, model and API key for the organization. */
    getUsageBreakdown(opts?: {
        days?: number;
    }): Promise<UsageBreakdownResponse>;
    /** Get the organization's paginated realtime session history. */
    getUsageHistory(opts?: {
        startDate?: string;
        endDate?: string;
        page?: number;
        limit?: number;
    }): Promise<UsageHistoryResponse>;
    /** Get voice. */
    getVoice(voiceId: string): Promise<VoiceResponse>;
    /** The recording and the voice separated out of it, to compare. */
    getVoiceIsolation(voiceId: string): Promise<VoiceIsolation>;
    /** Interaction failures raised from this organization's sessions, ranked by severity × confidence. */
    listFailures(opts?: {
        status?: string;
        signal?: string;
        severity?: string;
        sessionId?: string;
        limit?: number;
        offset?: number;
    }): Promise<InteractionFailureList>;
    /** List past text-to-speech generations. */
    listGenerations(opts?: {
        limit?: number;
        offset?: number;
        voice?: string;
        search?: string;
    }): Promise<GenerationListResponse>;
    /** List speech models. */
    listSpeechModels(): Promise<SpeechModelsResponse>;
    /** List the organization's cloned voices. */
    listVoices(): Promise<VoicesListResponse>;
    /** Separate a voice from what was recorded around it, without storing either. */
    separateReferenceClip(opts: {
        file: Blob;
    }): Promise<SeparatedClip>;
    /** Speak from the recording, or from the voice isolated out of it. */
    setVoiceIsolation(voiceId: string, opts: {
        body: VoiceIsolationRequest;
    }): Promise<VoiceResponse>;
    /** Move a failure through triage (status) and record what was found (notes). */
    updateFailure(failureId: string, opts: {
        body: InteractionFailureUpdate;
    }): Promise<InteractionFailure>;
    /** Rename a cloned voice. */
    updateVoice(voiceId: string, opts: {
        body: VoiceUpdateRequest;
    }): Promise<VoiceResponse>;
    /** The serving backend's accepted voice-design vocabulary. */
    voiceDesignOptions(): Promise<unknown>;
}
//# sourceMappingURL=_generated_client.d.ts.map