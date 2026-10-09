// A game server that lets players talk to Kael from their browsers, without
// ever relaying audio and without the API key leaving this machine.
//
//     EESI_API_KEY=sk-eesi-... node --experimental-strip-types examples/game-server.ts
//
// The player's page asks POST /join and opens the session itself:
//
//     import { joinSession } from "@eesi/sdk";
//     import { browserAudio } from "@eesi/sdk/browser";
//     const join = await (await fetch("/join", { method: "POST" })).json();
//     const session = await joinSession(join, { audio: await browserAudio() });

import { createServer } from "node:http";

import { NurClient, tool } from "@eesi/sdk";
import { fileMemory } from "@eesi/sdk/node";

const nur = new NurClient();

// The game's state: the server is the authority, the character only reads it.
const world = { gates: { north: "closed", south: "closed" } as Record<string, string> };

const openGate = tool({
    name: "open_gate",
    description: "Open one of the castle gates for the player.",
    parameters: { type: "object", properties: { gate: { type: "string", enum: ["north", "south"] } }, required: ["gate"] },
    allow: (ctx) => ctx.playerId !== null || "only known players",
    run: ({ gate }) => {
        world.gates[gate] = "open";
        return `The ${gate} gate is now open.`;
    },
});

const kael = nur.multiplayerNpc({
    name: "Kael",
    persona: "The gatekeeper of Eldermoor.",
    voice: "Atlas",
    memory: fileMemory("./.eesi/kael"),
    tools: [openGate],
    proactive: { idleAfterMs: 45_000, guidance: "what is happening at the gates" },
});
kael.when((state) => state.alarm === "ringing", "The alarm bell is ringing.");

let players = 0;

createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/join") {
        response.writeHead(404).end();
        return;
    }
    // Your own authentication decides who the player is; never the request body.
    players += 1;
    const playerId = `player-${players}`;
    const secret = await kael.clientSecret({
        playerId,
        playerName: `Traveller ${players}`,
        context: { location: "the northern gate", gates: world.gates },
        lock: "all",
        control: true,
    });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(secret.join));

    // Steer the session the player opens: state, tools and remarks happen here.
    const session = await kael.control(secret).start();
    session.on("transcript.final", (event) => console.log(`${playerId}: ${event.text}`));
    session.on("response.completed", (event) => console.log(`Kael to ${playerId}: ${event.text}`));
    const tick = setInterval(() => void session.context.update({ gates: world.gates }), 1_000);
    await session.ended;
    clearInterval(tick);
}).listen(8080, () => console.log("POST http://localhost:8080/join"));
