/**
 * mcp-session-manager.ts — Per-task MCP connection lifecycle
 *
 * Creates and manages MCP connections for the duration of a background generation
 * task. Mirrors the browser-side mcpStore.acquireConnection() / releaseConnection()
 * pattern, but runs on the Node backend.
 *
 * Design:
 * - Connections are established at task start, kept alive for all tool calls in that task.
 * - Uses the same @modelcontextprotocol/sdk transports as the browser (StreamableHTTP,
 *   SSE, WebSocket) — no custom transport logic.
 * - One Client per MCP server. Tools are indexed by name → serverId for routing.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';

export interface McpServerEntry {
    /** Unique server ID (matches the id in settings) */
    id: string;
    /** Full URL to the MCP server endpoint */
    url: string;
    /** Optional custom request headers (parsed from JSON string) */
    headers?: Record<string, string>;
    /** Request timeout in milliseconds */
    requestTimeoutMs?: number;
}

export interface McpConnection {
    client: Client;
    serverId: string;
    /** Tool names this server provides */
    toolNames: Set<string>;
}

export type McpConnectionMap = Map<string, McpConnection>;

/**
 * Connect to all provided MCP servers.
 * Returns a map of serverId → McpConnection.
 * Servers that fail to connect are silently skipped (logged as warnings).
 */
export async function connectAll(servers: McpServerEntry[]): Promise<McpConnectionMap> {
    const connections: McpConnectionMap = new Map();

    await Promise.allSettled(
        servers.map(async (server) => {
            try {
                const conn = await connectOne(server);
                connections.set(server.id, conn);
                console.log(
                    `[mcp-session-manager] Connected to ${server.id} (${conn.toolNames.size} tools)`
                );
            } catch (err) {
                console.warn(
                    `[mcp-session-manager] Failed to connect to ${server.id} (${server.url}):`,
                    err instanceof Error ? err.message : String(err)
                );
            }
        })
    );

    return connections;
}

async function connectOne(server: McpServerEntry): Promise<McpConnection> {
    const url = new URL(server.url);

    const requestInit: RequestInit = {};
    if (server.headers) {
        requestInit.headers = server.headers;
    }

    // Choose transport based on URL — same heuristic as the browser-side MCPService
    let transport: InstanceType<typeof StreamableHTTPClientTransport>
        | InstanceType<typeof SSEClientTransport>
        | InstanceType<typeof WebSocketClientTransport>;

    const urlStr = server.url;
    if (urlStr.startsWith('ws://') || urlStr.startsWith('wss://')) {
        transport = new WebSocketClientTransport(url);
    } else if (urlStr.includes('/sse')) {
        transport = new SSEClientTransport(url, { requestInit });
    } else {
        // Default: StreamableHTTP, fall back to SSE on failure
        try {
            transport = new StreamableHTTPClientTransport(url, { requestInit });
        } catch {
            transport = new SSEClientTransport(url, { requestInit });
        }
    }

    const client = new Client(
        { name: 'llama-ui-backend', version: '1.0.0' },
        { capabilities: {} }
    );

    await client.connect(transport);

    // Discover tools
    let toolNames = new Set<string>();
    try {
        const result = await client.listTools();
        for (const tool of result.tools ?? []) {
            toolNames.add(tool.name);
        }
    } catch (err) {
        console.warn(
            `[mcp-session-manager] Failed to list tools for ${server.id}:`,
            err instanceof Error ? err.message : String(err)
        );
    }

    return { client, serverId: server.id, toolNames };
}

/**
 * Find which connection owns a tool by name.
 */
export function findConnectionForTool(
    connections: McpConnectionMap,
    toolName: string
): McpConnection | undefined {
    for (const conn of connections.values()) {
        if (conn.toolNames.has(toolName)) {
            return conn;
        }
    }
    return undefined;
}

/**
 * Call a tool on the correct MCP server.
 * Returns null if no server owns the tool.
 */
export async function callTool(
    connections: McpConnectionMap,
    toolName: string,
    args: Record<string, unknown>
): Promise<{ content: string; isError: boolean } | null> {
    const conn = findConnectionForTool(connections, toolName);
    if (!conn) {
        return null;
    }

    const result = await conn.client.callTool({ name: toolName, arguments: args }) as {
        content?: Array<{ type: string; text?: string; data?: string; resource?: unknown }>;
        isError?: boolean;
    };

    const content = Array.isArray(result.content)
        ? result.content
            .map((item) => {
                if (item.type === 'text') return item.text ?? '';
                if (item.type === 'resource') return JSON.stringify(item.resource);
                if (item.type === 'image') return `[image data: ${item.data?.slice(0, 30)}...]`;
                return JSON.stringify(item);
            })
            .filter(Boolean)
            .join('\n')
        : JSON.stringify(result);

    return { content, isError: result.isError ?? false };
}

/**
 * Cleanly disconnect all MCP connections.
 */
export async function disconnectAll(connections: McpConnectionMap): Promise<void> {
    await Promise.allSettled(
        Array.from(connections.values()).map(async (conn) => {
            try {
                await conn.client.close();
            } catch (err) {
                console.warn(
                    `[mcp-session-manager] Error disconnecting ${conn.serverId}:`,
                    err instanceof Error ? err.message : String(err)
                );
            }
        })
    );
    connections.clear();
}
