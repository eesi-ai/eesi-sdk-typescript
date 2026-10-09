// Talk to a character from Node by typing. Run with Node 22+:
//
//     EESI_API_KEY=sk-eesi-... node --experimental-strip-types examples/quickstart.ts
//
// (Node 23.6+ runs .ts files without the flag.)

import { createInterface } from "node:readline/promises";

import { NurClient, tool } from "@eesi/sdk";
import { fileMemory } from "@eesi/sdk/node";

const nur = new NurClient();

const openGate = tool({
    name: "open_gate",
    description: "Open one of the castle gates for the traveller.",
    parameters: { type: "object", properties: { gate: { type: "string", enum: ["north", "south"] } }, required: ["gate"] },
    run: ({ gate }) => `The ${gate} gate is now open.`,
});

const kael = nur.npc({
    name: "Kael",
    persona: "The gatekeeper of Eldermoor: wary of strangers, loyal to friends.",
    voice: "Atlas",
    memory: fileMemory("./.eesi/kael"),
    context: { realm: "Eldermoor", timeOfDay: "dusk" },
    tools: [openGate],
    turnTaking: "app",
});

const session = await kael.connect({ playerId: "local-player", context: { location: "the northern gate" } }).start();
session.on("tool.completed", (event) => console.log(`  [${event.name}] ${event.output}`));
console.log(`Kael: ${(await session.wait("response.completed")).text}`);

const terminal = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
    const line = (await terminal.question("you: ")).trim();
    if (!line || line === "bye") break;
    console.log(`Kael: ${(await session.ask(line)).text}`);
}
terminal.close();
await session.close(); // Kael remembers what mattered, in ./.eesi/kael
