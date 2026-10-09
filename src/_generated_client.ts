// GENERATED — do not edit. Source: filtered OpenAPI from `api.app`.
//
// Regenerate with `./scripts/generate_sdk.sh`.
//
// `EESIClient` extends this base to get HTTP methods for every route
// decorated with `sdk_expose(...)`. Request/response types come from
// `_generated_models` (openapi-typescript output, --root-types).
//
// Multipart uploads take a `Blob`; pass a `File` (a named Blob) so the server
// sees a filename and media type — it keys off both for voice references.

import type {
    ApiKeyResponse,
    BillingCreditsResponse,
    ClientSecretRequest,
    ClientSecretResponse,
    CurrentUsageResponse,
    DailyUsageBreakdownResponse,
    GenerationListResponse,
    InteractionFailure,
    InteractionFailureList,
    InteractionFailureUpdate,
    ListenerBrief,
    ListenerEvents,
    ListenerState,
    OrganizationTurnMetricsSummaryResponse,
    PhoneCall,
    PhoneCallRequest,
    PhoneNumber,
    PhoneNumberConfirmation,
    PhoneNumberList,
    PhoneNumberRequest,
    ScorecardResponse,
    SeparatedClip,
    SpeechModelsResponse,
    SpeechRequest,
    TextRequest,
    UsageBreakdownResponse,
    UsageHistoryResponse,
    VoiceIsolation,
    VoiceIsolationRequest,
    VoiceResponse,
    VoiceUpdateRequest,
    VoicesListResponse,
} from "./_generated_models.js";

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
export type VerifyPhoneNumberBody = PhoneNumberRequest;

export abstract class _GeneratedClient {
    protected abstract request<T = unknown>(
        method: string,
        path: string,
        opts?: {
            json?: unknown;
            params?: Record<string, unknown>;
            form?: FormData;
            raw?: boolean;
        },
    ): Promise<T>;

    /** Archive an API key (soft delete). */
    async archiveApiKey(apiKeyId: number): Promise<unknown> {
        return this.request("DELETE", `/user/api-keys/${apiKeyId}`);
    }

    /** Chat completions. `body` is an OpenAI chat-completions request and is forwarded verbatim; the parsed completion is returned. Streaming (`stream: true`) is not supported by this method — use an OpenAI client for that. */
    async chatCompletions(opts: { body: Record<string, unknown> }): Promise<unknown> {
        return this.request("POST", "/chat/completions", { json: opts.body });
    }

    /** Enter the code Nur phoned in; the number is confirmed for its calls. */
    async confirmPhoneNumber(opts: { body: PhoneNumberConfirmation }): Promise<PhoneNumber> {
        return this.request<PhoneNumber>("POST", "/phone/numbers/confirm", { json: opts.body });
    }

    /** Have Nur call a phone number: say what the call is about, and Nur has the conversation. Fetch the call afterwards for its transcript. */
    async createPhoneCall(opts: { body: PhoneCallRequest }): Promise<unknown> {
        return this.request("POST", "/phone/calls", { json: opts.body });
    }

    /** Mint a one-use credential that opens a realtime session already configured as you specify, for a client that must not hold your key. */
    async createRealtimeClientSecret(opts: { body: ClientSecretRequest }): Promise<ClientSecretResponse> {
        return this.request<ClientSecretResponse>("POST", "/realtime/client_secrets", { json: opts.body });
    }

    /** Create speech. */
    async createSpeech(opts: { body: SendableBody<SpeechRequest, "response_format" | "speed" | "stream_format" | "normalize_text"> }): Promise<Uint8Array> {
        return this.request<Uint8Array>("POST", "/audio/speech", { json: opts.body, raw: true });
    }

    /** Create transcription. */
    async createTranscription(opts: { file: Blob; model: string; language?: string; prompt?: string; responseFormat?: "json" | "text" | "verbose_json" | "srt" | "vtt"; temperature?: number; timestampGranularities?: ("word" | "segment")[]; stream?: boolean }): Promise<unknown> {
        const form = new FormData();
        form.append("file", opts.file);
        form.append("model", String(opts.model));
        if (opts.language !== undefined) form.append("language", String(opts.language));
        if (opts.prompt !== undefined) form.append("prompt", String(opts.prompt));
        if (opts.responseFormat !== undefined) form.append("response_format", String(opts.responseFormat));
        if (opts.temperature !== undefined) form.append("temperature", String(opts.temperature));
        if (opts.timestampGranularities !== undefined) for (const v of opts.timestampGranularities) form.append("timestamp_granularities[]", String(v));
        if (opts.stream !== undefined) form.append("stream", String(opts.stream));
        return this.request("POST", "/audio/transcriptions", { form });
    }

    /** Clone a voice from 3-10 seconds of reference audio. */
    async createVoice(opts: { file: Blob; name: string; consentAttested?: boolean; refText?: string; engine?: "nur-tts-v1" | "omnivoice"; category?: "general" | "conversational" | "narrative" | "podcast" | "customer-service" | "corporate" | "advertising" | "characters"; description?: string; language?: string; gender?: "female" | "male" | "neutral"; accent?: string; preferIsolated?: boolean }): Promise<VoiceResponse> {
        const form = new FormData();
        form.append("file", opts.file);
        form.append("name", String(opts.name));
        if (opts.consentAttested !== undefined) form.append("consent_attested", String(opts.consentAttested));
        if (opts.refText !== undefined) form.append("ref_text", String(opts.refText));
        if (opts.engine !== undefined) form.append("engine", String(opts.engine));
        if (opts.category !== undefined) form.append("category", String(opts.category));
        if (opts.description !== undefined) form.append("description", String(opts.description));
        if (opts.language !== undefined) form.append("language", String(opts.language));
        if (opts.gender !== undefined) form.append("gender", String(opts.gender));
        if (opts.accent !== undefined) form.append("accent", String(opts.accent));
        if (opts.preferIsolated !== undefined) form.append("prefer_isolated", String(opts.preferIsolated));
        return this.request<VoiceResponse>("POST", "/voices", { form });
    }

    /** Delete a cloned voice. */
    async deleteVoice(voiceId: string): Promise<VoiceResponse> {
        return this.request<VoiceResponse>("DELETE", `/voices/${voiceId}`);
    }

    /** Stop Nur's calls to a number on the shared line until it is confirmed again. */
    async forgetPhoneNumber(number: string): Promise<unknown> {
        return this.request("DELETE", `/phone/numbers/${number}`);
    }

    /** Get all API keys for the user's selected organization. */
    async getApiKeys(opts: { includeArchived?: boolean } = {}): Promise<ApiKeyResponse[]> {
        const params: Record<string, unknown> = {
            ...(opts.includeArchived !== undefined ? { "include_archived": opts.includeArchived } : {}),
        };
        return this.request<ApiKeyResponse[]>("GET", "/user/api-keys", { params });
    }

    /** Return the organization's prepaid credit balance and paginated ledger. */
    async getBillingCredits(opts: { page?: number; limit?: number } = {}): Promise<BillingCreditsResponse> {
        const params: Record<string, unknown> = {
            ...(opts.page !== undefined ? { "page": opts.page } : {}),
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
        };
        return this.request<BillingCreditsResponse>("GET", "/organizations/billing/credits", { params });
    }

    /** Get current reporting-period usage for the user's organization. */
    async getCurrentPeriodUsage(): Promise<CurrentUsageResponse> {
        return this.request<CurrentUsageResponse>("GET", "/organizations/usage/current-period");
    }

    /** Get daily usage breakdown for the last N days. Only available for organizations with pricing. */
    async getDailyUsageBreakdown(opts: { days?: number } = {}): Promise<DailyUsageBreakdownResponse> {
        const params: Record<string, unknown> = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request<DailyUsageBreakdownResponse>("GET", "/organizations/usage/daily-breakdown", { params });
    }

    /** One interaction failure. */
    async getFailure(failureId: string): Promise<InteractionFailure> {
        return this.request<InteractionFailure>("GET", `/failures/${failureId}`);
    }

    /** Per runtime bundle: sessions, how they ended, evidence coverage, reply latency and failures — the scorecard a release is judged by. */
    async getFailureScorecard(opts: { days?: number } = {}): Promise<ScorecardResponse> {
        const params: Record<string, unknown> = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request<ScorecardResponse>("GET", "/failures/scorecard", { params });
    }

    /** Organization-wide per-turn latency summary over an optional day window. */
    async getOrganizationTurnMetricsSummary(opts: { days?: number } = {}): Promise<OrganizationTurnMetricsSummaryResponse> {
        const params: Record<string, unknown> = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request<OrganizationTurnMetricsSummaryResponse>("GET", "/organizations/turn-metrics/summary", { params });
    }

    /** A call Nur placed: its status, and once it has ended, its transcript. */
    async getPhoneCall(callId: string): Promise<PhoneCall> {
        return this.request<PhoneCall>("GET", `/phone/calls/${callId}`);
    }

    /** Get usage cost broken down by kind, model and API key for the organization. */
    async getUsageBreakdown(opts: { days?: number } = {}): Promise<UsageBreakdownResponse> {
        const params: Record<string, unknown> = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request<UsageBreakdownResponse>("GET", "/organizations/usage/breakdown", { params });
    }

    /** Get the organization's paginated realtime session history. */
    async getUsageHistory(opts: { startDate?: string; endDate?: string; page?: number; limit?: number } = {}): Promise<UsageHistoryResponse> {
        const params: Record<string, unknown> = {
            ...(opts.startDate !== undefined ? { "start_date": opts.startDate } : {}),
            ...(opts.endDate !== undefined ? { "end_date": opts.endDate } : {}),
            ...(opts.page !== undefined ? { "page": opts.page } : {}),
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
        };
        return this.request<UsageHistoryResponse>("GET", "/organizations/usage/runs", { params });
    }

    /** Get voice. */
    async getVoice(voiceId: string): Promise<VoiceResponse> {
        return this.request<VoiceResponse>("GET", `/voices/${voiceId}`);
    }

    /** The recording and the voice separated out of it, to compare. */
    async getVoiceIsolation(voiceId: string): Promise<VoiceIsolation> {
        return this.request<VoiceIsolation>("GET", `/voices/${voiceId}/isolation`);
    }

    /** Interaction failures raised from this organization's sessions, ranked by severity × confidence. */
    async listFailures(opts: { status?: string; signal?: string; severity?: string; sessionId?: string; limit?: number; offset?: number } = {}): Promise<InteractionFailureList> {
        const params: Record<string, unknown> = {
            ...(opts.status !== undefined ? { "status": opts.status } : {}),
            ...(opts.signal !== undefined ? { "signal": opts.signal } : {}),
            ...(opts.severity !== undefined ? { "severity": opts.severity } : {}),
            ...(opts.sessionId !== undefined ? { "session_id": opts.sessionId } : {}),
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
            ...(opts.offset !== undefined ? { "offset": opts.offset } : {}),
        };
        return this.request<InteractionFailureList>("GET", "/failures", { params });
    }

    /** List past text-to-speech generations. */
    async listGenerations(opts: { limit?: number; offset?: number; voice?: string; search?: string } = {}): Promise<GenerationListResponse> {
        const params: Record<string, unknown> = {
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
            ...(opts.offset !== undefined ? { "offset": opts.offset } : {}),
            ...(opts.voice !== undefined ? { "voice": opts.voice } : {}),
            ...(opts.search !== undefined ? { "search": opts.search } : {}),
        };
        return this.request<GenerationListResponse>("GET", "/generations", { params });
    }

    /** The numbers confirmed for Nur's calls on the shared EESI line. */
    async listPhoneNumbers(): Promise<PhoneNumberList> {
        return this.request<PhoneNumberList>("GET", "/phone/numbers");
    }

    /** List speech models. */
    async listSpeechModels(): Promise<SpeechModelsResponse> {
        return this.request<SpeechModelsResponse>("GET", "/audio/models");
    }

    /** List the organization's cloned voices. */
    async listVoices(): Promise<VoicesListResponse> {
        return this.request<VoicesListResponse>("GET", "/voices");
    }

    /** Calls to the code line that have ended, and texts to it, since you last asked; waits up to `wait` seconds for one. */
    async phoneListenerEvents(opts: { wait?: number } = {}): Promise<ListenerEvents> {
        const params: Record<string, unknown> = {
            ...(opts.wait !== undefined ? { "wait": opts.wait } : {}),
        };
        return this.request<ListenerEvents>("GET", "/phone/listener/events", { params });
    }

    /** Brief the code line: what a call about your code should know. Publish again before it expires; calls to the code line use the latest. */
    async publishPhoneListener(opts: { body: ListenerBrief }): Promise<ListenerState> {
        return this.request<ListenerState>("PUT", "/phone/listener", { json: opts.body });
    }

    /** Text a number. On the shared EESI line: a confirmed number, from the code line, so a reply reaches Nur. */
    async sendText(opts: { body: TextRequest }): Promise<unknown> {
        return this.request("POST", "/phone/messages", { json: opts.body });
    }

    /** Separate a voice from what was recorded around it, without storing either. */
    async separateReferenceClip(opts: { file: Blob }): Promise<SeparatedClip> {
        const form = new FormData();
        form.append("file", opts.file);
        return this.request<SeparatedClip>("POST", "/voices/separate", { form });
    }

    /** Speak from the recording, or from the voice isolated out of it. */
    async setVoiceIsolation(voiceId: string, opts: { body: VoiceIsolationRequest }): Promise<VoiceResponse> {
        return this.request<VoiceResponse>("POST", `/voices/${voiceId}/isolation`, { json: opts.body });
    }

    /** Move a failure through triage (status) and record what was found (notes). */
    async updateFailure(failureId: string, opts: { body: InteractionFailureUpdate }): Promise<InteractionFailure> {
        return this.request<InteractionFailure>("PATCH", `/failures/${failureId}`, { json: opts.body });
    }

    /** Rename a cloned voice. */
    async updateVoice(voiceId: string, opts: { body: VoiceUpdateRequest }): Promise<VoiceResponse> {
        return this.request<VoiceResponse>("PATCH", `/voices/${voiceId}`, { json: opts.body });
    }

    /** Have Nur phone a number a six-digit code; entering it confirms the number for calls on the shared EESI line. */
    async verifyPhoneNumber(opts: { body: PhoneNumberRequest }): Promise<PhoneNumber> {
        return this.request<PhoneNumber>("POST", "/phone/numbers", { json: opts.body });
    }

    /** The serving backend's accepted voice-design vocabulary. */
    async voiceDesignOptions(): Promise<unknown> {
        return this.request("GET", "/audio/voice-design");
    }
}
