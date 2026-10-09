import type { ApiKeyResponse, BillingCreditsResponse, ClientSecretRequest, ClientSecretResponse, CurrentUsageResponse, DailyUsageBreakdownResponse, GenerationListResponse, InteractionFailure, InteractionFailureList, InteractionFailureUpdate, ListenerBrief, ListenerEvents, ListenerState, OrganizationTurnMetricsSummaryResponse, PhoneCall, PhoneCallRequest, PhoneNumber, PhoneNumberConfirmation, PhoneNumberList, PhoneNumberRequest, ScorecardResponse, SeparatedClip, SpeechModelsResponse, SpeechRequest, TextRequest, UsageBreakdownResponse, UsageHistoryResponse, VoiceIsolation, VoiceIsolationRequest, VoiceResponse, VoiceUpdateRequest, VoicesListResponse } from "./_generated_models.js";
/**
 * A request body as you send it, rather than as it comes back.
 *
 * The generated models type a defaulted field (`response_format`, `speed`,
 * `stream_format`, …) as always present, which is true of a response — the
 * server filled it in. On the way out it makes the caller restate every
 * server default to get a body past the compiler, so `K` is optional here.
 */
export type SendableBody<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
/** The body `confirmPhoneNumber` takes. */
export type ConfirmPhoneNumberBody = PhoneNumberConfirmation;
/** The body `createPhoneCall` takes. */
export type CreatePhoneCallBody = PhoneCallRequest;
/** The body `createRealtimeClientSecret` takes. */
export type CreateRealtimeClientSecretBody = ClientSecretRequest;
/** The body `createSpeech` takes. */
export type CreateSpeechBody = SendableBody<SpeechRequest, "response_format" | "speed" | "stream_format" | "normalize_text">;
/** The body `publishPhoneListener` takes. */
export type PublishPhoneListenerBody = ListenerBrief;
/** The body `sendText` takes. */
export type SendTextBody = TextRequest;
/** The body `setVoiceIsolation` takes. */
export type SetVoiceIsolationBody = VoiceIsolationRequest;
/** The body `updateFailure` takes. */
export type UpdateFailureBody = InteractionFailureUpdate;
/** The body `updateVoice` takes. */
export type UpdateVoiceBody = VoiceUpdateRequest;
/** The body `verifyPhoneNumber` takes. */
export type VerifyPhoneNumberBody = SendableBody<PhoneNumberRequest, "channel">;
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
    /** Enter the code sent to the number; it is confirmed for Nur's calls and texts. */
    confirmPhoneNumber(opts: {
        body: PhoneNumberConfirmation;
    }): Promise<PhoneNumber>;
    /** Have Nur call a phone number: say what the call is about, and Nur has the conversation. Fetch the call afterwards for its transcript. */
    createPhoneCall(opts: {
        body: PhoneCallRequest;
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
    /** Stop Nur's calls to a number on the shared line until it is confirmed again. */
    forgetPhoneNumber(number: string): Promise<unknown>;
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
    /** A call Nur placed: its status, and once it has ended, its transcript. */
    getPhoneCall(callId: string): Promise<PhoneCall>;
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
    /** The numbers confirmed for Nur's calls on the shared EESI line. */
    listPhoneNumbers(): Promise<PhoneNumberList>;
    /** List speech models. */
    listSpeechModels(): Promise<SpeechModelsResponse>;
    /** List the organization's cloned voices. */
    listVoices(): Promise<VoicesListResponse>;
    /** Calls to the code line that have ended, and texts to it, since you last asked; waits up to `wait` seconds for one. */
    phoneListenerEvents(opts?: {
        wait?: number;
    }): Promise<ListenerEvents>;
    /** Brief the code line: what a call about your code should know. Publish again before it expires; calls to the code line use the latest. */
    publishPhoneListener(opts: {
        body: ListenerBrief;
    }): Promise<ListenerState>;
    /** Text a number. On the shared EESI line: a confirmed number, from the code line, so a reply reaches Nur. */
    sendText(opts: {
        body: TextRequest;
    }): Promise<unknown>;
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
    /** Send a number a six-digit code, by text (or a call); entering it confirms the number for Nur's calls and texts on the shared EESI line. */
    verifyPhoneNumber(opts: {
        body: SendableBody<PhoneNumberRequest, "channel">;
    }): Promise<PhoneNumber>;
    /** The serving backend's accepted voice-design vocabulary. */
    voiceDesignOptions(): Promise<unknown>;
}
//# sourceMappingURL=_generated_client.d.ts.map