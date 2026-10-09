// The SDK on the oldest Node it supports (18): what a game server does without
// a live socket. Mint a client secret with a player's memories, then learn from
// the call's session.ended webhook. Plain JavaScript, so any Node runs it.
//
//     npm run build && node tests/smoke.mjs

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { Memory, NurClient } from "../dist/index.js";
import { verifyWebhook } from "../dist/node/index.js";

const secrets = [];
const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/realtime/client_secrets") {
        const body = JSON.parse(init.body);
        secrets.push(body);
        return new Response(JSON.stringify({ value: "rt_secret_1", expires_at: 1, session: body.session, eesi_lock: ["instructions", "tools"] }), { status: 200 });
    }
    if (path === "/v1/chat/completions") {
        const content = JSON.stringify({ summary: "", memories: [{ text: "They are building a treehouse.", kind: "fact", importance: "medium", key: null, replaces: null }], forget: [] });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
};

const nur = new NurClient({ apiKey: "sk-eesi-test", baseUrl: "http://gateway.test", fetch, timezone: null });
const sage = nur.npc({ name: "Sage", memory: new Memory(undefined, { rules: "Only game facts." }) });

// After a call: verify the webhook, then learn from it.
const body = JSON.stringify({ id: "whk_1", type: "session.ended", session_id: "conv_1", transcript: [{ role: "player", text: "I'm building a treehouse." }, { role: "character", text: "Use oak." }] });
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac("sha256", "s".repeat(32)).update(`whk_1.${timestamp}.${body}`).digest("hex");
const event = verifyWebhook(body, { "eesi-webhook-id": "whk_1", "eesi-webhook-timestamp": String(timestamp), "eesi-signature": `v1=${signature}` }, "s".repeat(32));
const learned = await sage.learnFromSession(event, { playerId: "p-123" });
assert.deepEqual(learned.added.map((record) => record.text), ["They are building a treehouse."]);

// The next call starts with it.
const secret = await sage.clientSecret({ playerId: "p-123", lock: "all" });
assert.match(secrets[0].eesi_context.memory, /treehouse/);
assert.equal(secret.join.token, "rt_secret_1");
console.log(`ok on Node ${process.version}`);
