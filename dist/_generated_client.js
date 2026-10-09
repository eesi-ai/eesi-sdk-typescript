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
export class _GeneratedClient {
    /** Archive an API key (soft delete). */
    async archiveApiKey(apiKeyId) {
        return this.request("DELETE", `/user/api-keys/${apiKeyId}`);
    }
    /** Chat completions. `body` is an OpenAI chat-completions request and is forwarded verbatim; the parsed completion is returned. Streaming (`stream: true`) is not supported by this method — use an OpenAI client for that. */
    async chatCompletions(opts) {
        return this.request("POST", "/chat/completions", { json: opts.body });
    }
    /** Mint a one-use credential that opens a realtime session already configured as you specify, for a client that must not hold your key. */
    async createRealtimeClientSecret(opts) {
        return this.request("POST", "/realtime/client_secrets", { json: opts.body });
    }
    /** Create speech. */
    async createSpeech(opts) {
        return this.request("POST", "/audio/speech", { json: opts.body, raw: true });
    }
    /** Create transcription. */
    async createTranscription(opts) {
        const form = new FormData();
        form.append("file", opts.file);
        form.append("model", String(opts.model));
        if (opts.language !== undefined)
            form.append("language", String(opts.language));
        if (opts.prompt !== undefined)
            form.append("prompt", String(opts.prompt));
        if (opts.responseFormat !== undefined)
            form.append("response_format", String(opts.responseFormat));
        if (opts.temperature !== undefined)
            form.append("temperature", String(opts.temperature));
        if (opts.timestampGranularities !== undefined)
            for (const v of opts.timestampGranularities)
                form.append("timestamp_granularities[]", String(v));
        if (opts.stream !== undefined)
            form.append("stream", String(opts.stream));
        return this.request("POST", "/audio/transcriptions", { form });
    }
    /** Clone a voice from 3-10 seconds of reference audio. */
    async createVoice(opts) {
        const form = new FormData();
        form.append("file", opts.file);
        form.append("name", String(opts.name));
        if (opts.consentAttested !== undefined)
            form.append("consent_attested", String(opts.consentAttested));
        if (opts.refText !== undefined)
            form.append("ref_text", String(opts.refText));
        if (opts.engine !== undefined)
            form.append("engine", String(opts.engine));
        if (opts.category !== undefined)
            form.append("category", String(opts.category));
        if (opts.description !== undefined)
            form.append("description", String(opts.description));
        if (opts.language !== undefined)
            form.append("language", String(opts.language));
        if (opts.gender !== undefined)
            form.append("gender", String(opts.gender));
        if (opts.accent !== undefined)
            form.append("accent", String(opts.accent));
        if (opts.preferIsolated !== undefined)
            form.append("prefer_isolated", String(opts.preferIsolated));
        return this.request("POST", "/voices", { form });
    }
    /** Delete a cloned voice. */
    async deleteVoice(voiceId) {
        return this.request("DELETE", `/voices/${voiceId}`);
    }
    /** Get all API keys for the user's selected organization. */
    async getApiKeys(opts = {}) {
        const params = {
            ...(opts.includeArchived !== undefined ? { "include_archived": opts.includeArchived } : {}),
        };
        return this.request("GET", "/user/api-keys", { params });
    }
    /** Return the organization's prepaid credit balance and paginated ledger. */
    async getBillingCredits(opts = {}) {
        const params = {
            ...(opts.page !== undefined ? { "page": opts.page } : {}),
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
        };
        return this.request("GET", "/organizations/billing/credits", { params });
    }
    /** Get current reporting-period usage for the user's organization. */
    async getCurrentPeriodUsage() {
        return this.request("GET", "/organizations/usage/current-period");
    }
    /** Get daily usage breakdown for the last N days. Only available for organizations with pricing. */
    async getDailyUsageBreakdown(opts = {}) {
        const params = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request("GET", "/organizations/usage/daily-breakdown", { params });
    }
    /** One interaction failure. */
    async getFailure(failureId) {
        return this.request("GET", `/failures/${failureId}`);
    }
    /** Per runtime bundle: sessions, how they ended, evidence coverage, reply latency and failures — the scorecard a release is judged by. */
    async getFailureScorecard(opts = {}) {
        const params = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request("GET", "/failures/scorecard", { params });
    }
    /** Organization-wide per-turn latency summary over an optional day window. */
    async getOrganizationTurnMetricsSummary(opts = {}) {
        const params = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request("GET", "/organizations/turn-metrics/summary", { params });
    }
    /** Get usage cost broken down by kind, model and API key for the organization. */
    async getUsageBreakdown(opts = {}) {
        const params = {
            ...(opts.days !== undefined ? { "days": opts.days } : {}),
        };
        return this.request("GET", "/organizations/usage/breakdown", { params });
    }
    /** Get the organization's paginated realtime session history. */
    async getUsageHistory(opts = {}) {
        const params = {
            ...(opts.startDate !== undefined ? { "start_date": opts.startDate } : {}),
            ...(opts.endDate !== undefined ? { "end_date": opts.endDate } : {}),
            ...(opts.page !== undefined ? { "page": opts.page } : {}),
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
        };
        return this.request("GET", "/organizations/usage/runs", { params });
    }
    /** Get voice. */
    async getVoice(voiceId) {
        return this.request("GET", `/voices/${voiceId}`);
    }
    /** The recording and the voice separated out of it, to compare. */
    async getVoiceIsolation(voiceId) {
        return this.request("GET", `/voices/${voiceId}/isolation`);
    }
    /** Interaction failures raised from this organization's sessions, ranked by severity × confidence. */
    async listFailures(opts = {}) {
        const params = {
            ...(opts.status !== undefined ? { "status": opts.status } : {}),
            ...(opts.signal !== undefined ? { "signal": opts.signal } : {}),
            ...(opts.severity !== undefined ? { "severity": opts.severity } : {}),
            ...(opts.sessionId !== undefined ? { "session_id": opts.sessionId } : {}),
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
            ...(opts.offset !== undefined ? { "offset": opts.offset } : {}),
        };
        return this.request("GET", "/failures", { params });
    }
    /** List past text-to-speech generations. */
    async listGenerations(opts = {}) {
        const params = {
            ...(opts.limit !== undefined ? { "limit": opts.limit } : {}),
            ...(opts.offset !== undefined ? { "offset": opts.offset } : {}),
            ...(opts.voice !== undefined ? { "voice": opts.voice } : {}),
            ...(opts.search !== undefined ? { "search": opts.search } : {}),
        };
        return this.request("GET", "/generations", { params });
    }
    /** List speech models. */
    async listSpeechModels() {
        return this.request("GET", "/audio/models");
    }
    /** List the organization's cloned voices. */
    async listVoices() {
        return this.request("GET", "/voices");
    }
    /** Separate a voice from what was recorded around it, without storing either. */
    async separateReferenceClip(opts) {
        const form = new FormData();
        form.append("file", opts.file);
        return this.request("POST", "/voices/separate", { form });
    }
    /** Speak from the recording, or from the voice isolated out of it. */
    async setVoiceIsolation(voiceId, opts) {
        return this.request("POST", `/voices/${voiceId}/isolation`, { json: opts.body });
    }
    /** Move a failure through triage (status) and record what was found (notes). */
    async updateFailure(failureId, opts) {
        return this.request("PATCH", `/failures/${failureId}`, { json: opts.body });
    }
    /** Rename a cloned voice. */
    async updateVoice(voiceId, opts) {
        return this.request("PATCH", `/voices/${voiceId}`, { json: opts.body });
    }
    /** The serving backend's accepted voice-design vocabulary. */
    async voiceDesignOptions() {
        return this.request("GET", "/audio/voice-design");
    }
}
//# sourceMappingURL=_generated_client.js.map