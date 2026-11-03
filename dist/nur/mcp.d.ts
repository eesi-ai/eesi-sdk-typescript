import type { AnyEventInit } from "./events.js";
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
/** Servers checked: a usable label and URL each, no label twice. */
export declare function checkMcpServers(servers: McpServer[]): McpServer[];
/** The server as the session's `tools` carries it. */
export declare function mcpServerWire(server: McpServer): Record<string, unknown>;
/**
 * @internal Reads the MCP part of a session's server events into typed
 * events. The wire is OpenAI's: `mcp_list_tools` / `mcp_call` /
 * `mcp_approval_request` items, and `mcp_list_tools.*` and
 * `response.mcp_call.*` events that name an item by its id.
 */
export declare class McpEvents {
    private readonly items;
    private readonly asked;
    read(kind: string, event: Record<string, unknown>): AnyEventInit[];
}
/** @internal A session's `tools` and `tool_choice`: its functions, then its MCP servers, always restated so a tools update never drops one. */
export declare function toolPatch(specs: unknown[], servers: McpServer[]): {
    tools: unknown[];
    tool_choice: "auto" | "none";
};
//# sourceMappingURL=mcp.d.ts.map