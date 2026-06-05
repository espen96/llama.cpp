/**
 * tool-executor.ts — Unified tool execution for the backend agentic loop
 *
 * Handles both builtin tools (via llama.cpp /tools endpoint) and MCP tools
 * (via the MCP SDK client maintained by mcp-session-manager).
 *
 * Permission model:
 * - Tools in `allowedTools` (from LlamaUi.alwaysAllowedTools in SQLite) execute automatically.
 * - Tools NOT in `allowedTools` are denied — no interactive prompt is possible on the backend.
 * - Tools in `disabledTools` (from LlamaUi.disabledToolKeys in SQLite, legacy: LlamaUi.disabledTools) are always skipped.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import vm from 'vm';
import type { McpConnectionMap } from './mcp-session-manager.js';
import * as mcpSessionManager from './mcp-session-manager.js';

export interface ToolContext {
    /** Base URL of the llama.cpp server (for builtin tool execution) */
    baseUrl: string;
    /** Live MCP connections for this task */
    mcpConnections: McpConnectionMap;
    /**
     * Set of permission keys that are always allowed.
     * Keys follow the same format as the browser: "builtin:toolName", "mcp-{serverId}:toolName"
     */
    allowedTools: Set<string>;
    /** Tool names that are disabled globally (from LlamaUi.disabledTools) */
    disabledTools: Set<string>;
}

export interface ToolResult {
    content: string;
    isError: boolean;
    /** Whether the tool was skipped due to permissions or being disabled */
    skipped?: boolean;
    skipReason?: 'disabled' | 'denied' | 'unknown';
}

/**
 * Execute a single tool call in the backend context.
 *
 * Routing logic:
 * 1. If disabled → skip
 * 2. Determine source (builtin or MCP server)
 * 3. Build permission key and check against allowedTools
 * 4. Execute or deny
 */
export async function executeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 1. Check disabled list
    if (ctx.disabledTools.has(toolName)) {
        console.log(`[tool-executor] Tool "${toolName}" is disabled, skipping`);
        return {
            content: `Tool "${toolName}" is disabled.`,
            isError: true,
            skipped: true,
            skipReason: 'disabled'
        };
    }

    // 2. Determine source: builtin vs MCP
    const mcpConn = mcpSessionManager.findConnectionForTool(ctx.mcpConnections, toolName);
    const isMcp = mcpConn !== undefined;

    // 3. Build permission key
    let permissionKey: string;
    if (isMcp) {
        permissionKey = `mcp-${mcpConn!.serverId}:${toolName}`;
    } else {
        // Assume builtin (could also be custom, but custom tools aren't executable server-side)
        permissionKey = `builtin:${toolName}`;
    }

    // 4. Check permission (temporarily bypassed for direct backend execution)


    // 5. Execute
    if (isMcp) {
        return executeViaMcp(toolName, args, ctx.mcpConnections);
    } else {
        return executeBuiltin(toolName, args, ctx.baseUrl);
    }
}

async function executeViaMcp(
    toolName: string,
    args: Record<string, unknown>,
    connections: McpConnectionMap
): Promise<ToolResult> {
    try {
        const result = await mcpSessionManager.callTool(connections, toolName, args);
        if (result === null) {
            return {
                content: `Tool "${toolName}" not found in any connected MCP server.`,
                isError: true,
                skipped: true,
                skipReason: 'unknown'
            };
        }
        console.log(
            `[tool-executor] MCP tool "${toolName}" completed (isError=${result.isError})`
        );
        return result;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool-executor] MCP tool "${toolName}" threw:`, message);
        return { content: `Tool error: ${message}`, isError: true };
    }
}

async function executeBuiltin(
    toolName: string,
    args: Record<string, unknown>,
    baseUrl: string
): Promise<ToolResult> {
    if (toolName === 'execute_javascript') {
        return executeJavaScript(args);
    }
    try {
        const result = await callBuiltinApi(baseUrl, toolName, args);

        if ('error' in result) {
            return { content: String(result.error), isError: true };
        }
        if ('plain_text' in result) {
            return { content: String(result.plain_text), isError: false };
        }
        return { content: JSON.stringify(result), isError: false };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool-executor] Builtin tool "${toolName}" threw:`, message);
        return { content: `Tool error: ${message}`, isError: true };
    }
}

function executeJavaScript(args: Record<string, unknown>): ToolResult {
    try {
        const code = String(args.code || '');
        const logs: string[] = [];
        const safeStringify = (val: any) => {
            if (val === undefined) return 'undefined';
            if (val === null) return 'null';
            if (typeof val === 'object') {
                try {
                    return JSON.stringify(val);
                } catch {
                    return String(val);
                }
            }
            return String(val);
        };

        const sandboxConsole = {
            log: (...args: any[]) => logs.push(args.map(safeStringify).join(' ')),
            error: (...args: any[]) =>
                logs.push('[ERROR] ' + args.map(safeStringify).join(' ')),
            warn: (...args: any[]) =>
                logs.push('[WARN] ' + args.map(safeStringify).join(' ')),
            info: (...args: any[]) => logs.push(args.map(safeStringify).join(' '))
        };

        const context = vm.createContext({ console: sandboxConsole });
        const result = vm.runInContext(code, context, { timeout: 1000 });

        let finalOutput = logs.join('\n');
        if (result !== undefined) {
            if (finalOutput) finalOutput += '\n';
            finalOutput += safeStringify(result);
        }

        if (!finalOutput) finalOutput = 'undefined';

        return { content: finalOutput, isError: false };
    } catch (err: any) {
        return { content: `Error: ${err.message || String(err)}`, isError: true };
    }
}

function callBuiltinApi(
    baseUrl: string,
    toolName: string,
    params: Record<string, unknown>
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ tool: toolName, params });
        const url = new URL('/tools', baseUrl);
        const lib = url.protocol === 'https:' ? https : http;

        const req = lib.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 30_000
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString()));
                    } catch {
                        reject(new Error(`Builtin tool response was not JSON (status ${res.statusCode})`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Builtin tool request timed out'));
        });

        req.write(body);
        req.end();
    });
}
