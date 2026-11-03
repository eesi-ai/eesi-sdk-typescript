// Remote MCP servers a character can use. EESI connects to them and runs the calls.
//
//     const deepwiki: McpServer = {
//         url: "https://mcp.deepwiki.com/mcp",
//         label: "deepwiki",
//         description: "Answers questions about public GitHub repositories.",
//         allowedTools: ["ask_wiki_question", "read_wiki_structure"],
//     };
//     const sage = nur.character({ name: "Sage", mcpServers: [deepwiki] });
//
// When a session starts, EESI lists the server's tools and offers them to the
// character as `<label>__<tool>`. Every call runs on EESI's side: your code
// never runs or answers them, and watches them as events instead
// (`mcp.tools.listed`, `mcp.call.started`, `mcp.call.completed` …). A tool the
// server marks destructive, or one named in `requireApproval`, waits for the
// player's yes: the character asks, and the player answers out loud, or your
// UI calls `session.approveMcp(requestId)` on `mcp.approval.requested`.
//
// `authorization` and `headers` go to the server and nowhere else, and
// `toJSON()` names a server only by its label.

import { ConfigurationError } from "./errors.js";
import type { AnyEventInit } from "./events.js";
import { record, str } from "./protocol.js";

/** One remote MCP server, as a session's `{"type": "mcp"}` tool entry. */
export interface McpServer {
    url: string;
    /** 1 to 32 letters, digits, `_` or `-`; unique among a character's servers. */
    label: string;
    /** What the server is for; the character reads it beside each tool. */
    description?: string;
    /** The tool names to offer; leave it out (or empty) to offer all of them. */
    allowedTools?: string[];
    /** Sent as `Authorization: Bearer <token>`. */
    authorization?: string;
    headers?: Record<string, string>;
    /** `"always"`, or tool names, to make the character ask the player first. A tool the server marks destructive always waits for a yes. */
    requireApproval?: "always" | "never" | string[];
}

const LABEL = /^[A-Za-z0-9_-]{1,32}$/;

/** Servers checked: a usable label and URL each, no label twice. */
export function checkMcpServers(servers: McpServer[]): McpServer[] {
    const labels = new Set<string>();
    for (const server of servers) {
        if (!LABEL.test(server.label)) throw new ConfigurationError("An MCP server's label is 1 to 32 letters, digits, '_' or '-'.");
        let url: URL;
        try {
            url = new URL(server.url);
        } catch {
            throw new ConfigurationError(`${server.label}: the URL must be https://…`);
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigurationError(`${server.label}: the URL must be https://…`);
        if (labels.has(server.label)) throw new ConfigurationError("Two MCP servers share a label.");
        labels.add(server.label);
    }
    return [...servers];
}

/** The server as the session's `tools` carries it. */
export function mcpServerWire(server: McpServer): Record<string, unknown> {
    const entry: Record<string, unknown> = { type: "mcp", server_label: server.label, server_url: server.url };
    if (server.description) entry.server_description = server.description;
    if (server.allowedTools) entry.allowed_tools = [...server.allowedTools];
    if (server.authorization) entry.authorization = server.authorization;
    if (server.headers && Object.keys(server.headers).length) entry.headers = { ...server.headers };
    if (typeof server.requireApproval === "string") entry.require_approval = server.requireApproval;
    else if (server.requireApproval) entry.require_approval = { always: { tool_names: [...server.requireApproval] } };
    return entry;
}

const ITEM_EVENTS = new Set(["response.output_item.added", "response.output_item.done", "conversation.item.added", "conversation.item.done"]);

/**
 * @internal Reads the MCP part of a session's server events into typed
 * events. The wire is OpenAI's: `mcp_list_tools` / `mcp_call` /
 * `mcp_approval_request` items, and `mcp_list_tools.*` and
 * `response.mcp_call.*` events that name an item by its id.
 */
export class McpEvents {
    private readonly items = new Map<string, Record<string, unknown>>();
    private readonly asked = new Set<string>();

    read(kind: string, event: Record<string, unknown>): AnyEventInit[] {
        if (ITEM_EVENTS.has(kind)) {
            const item = record(event.item);
            if (!str(item.type).startsWith("mcp_")) return [];
            const id = str(item.id);
            if (!id) return [];
            this.items.set(id, item);
            if (this.items.size > 256) this.items.delete(this.items.keys().next().value as string);
            if (item.type === "mcp_approval_request" && !this.asked.has(id)) {
                this.asked.add(id);
                return [{ type: "mcp.approval.requested", requestId: id, serverLabel: str(item.server_label), name: str(item.name), arguments: str(item.arguments) }];
            }
            return [];
        }
        if (!kind.startsWith("mcp_list_tools.") && !kind.startsWith("response.mcp_call.")) return [];
        const itemId = str(event.item_id);
        const item = this.items.get(itemId) ?? {};
        const serverLabel = str(event.server_label) || str(item.server_label);
        if (kind === "mcp_list_tools.completed") {
            const tools = Array.isArray(item.tools) ? item.tools : [];
            return [{ type: "mcp.tools.listed", serverLabel, tools: tools.map((tool) => str(record(tool).name)).filter(Boolean) }];
        }
        if (kind === "mcp_list_tools.failed") {
            const error = record(event.error);
            return [{ type: "mcp.tools.failed", serverLabel, code: str(error.code), message: str(error.message) }];
        }
        const call = { itemId, serverLabel, name: str(item.name), arguments: str(item.arguments) };
        if (kind === "response.mcp_call.in_progress") return [{ type: "mcp.call.started", ...call }];
        if (kind === "response.mcp_call.completed") return [{ type: "mcp.call.completed", ...call, output: str(item.output) }];
        if (kind === "response.mcp_call.failed") {
            const error = record(item.error);
            return [{ type: "mcp.call.failed", ...call, kind: str(error.type), error: str(error.message) }];
        }
        return [];
    }
}

/** @internal A session's `tools` and `tool_choice`: its functions, then its MCP servers, always restated so a tools update never drops one. */
export function toolPatch(specs: unknown[], servers: McpServer[]): { tools: unknown[]; tool_choice: "auto" | "none" } {
    const tools = [...specs, ...servers.map(mcpServerWire)];
    return { tools, tool_choice: tools.length ? "auto" : "none" };
}
