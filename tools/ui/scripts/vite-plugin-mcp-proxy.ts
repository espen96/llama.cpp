import type { Plugin } from 'vite';
import { URL } from 'url';

interface MCPToolExecRequest {
	url: string;
	toolName: string;
	arguments: Record<string, unknown>;
	headers?: Record<string, string>;
}

export function mcpProxyPlugin(): Plugin {
	return {
		name: 'vite-plugin-mcp-proxy',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const urlObj = new URL(req.url || '', 'http://localhost');

				if (urlObj.pathname === '/api/mcp/execute' && req.method === 'POST') {
					const bodyChunks: Buffer[] = [];
					req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
					req.on('end', async () => {
						const bodyBuffer = Buffer.concat(bodyChunks);
						let bodyData: MCPToolExecRequest;
						try {
							bodyData = JSON.parse(bodyBuffer.toString());
						} catch {
							res.statusCode = 400;
							res.setHeader('Content-Type', 'application/json');
							res.end(JSON.stringify({ error: 'Invalid JSON body' }));
							return;
						}

						if (!bodyData.url || !bodyData.toolName) {
							res.statusCode = 400;
							res.setHeader('Content-Type', 'application/json');
							res.end(JSON.stringify({ error: 'Missing url or toolName' }));
							return;
						}

						try {
							const result = await executeMcpTool(bodyData);
							res.statusCode = 200;
							res.setHeader('Content-Type', 'application/json');
							res.end(JSON.stringify(result));
						} catch (err: any) {
							res.statusCode = 200;
							res.setHeader('Content-Type', 'application/json');
							res.end(
								JSON.stringify({
									error: err.message || String(err),
									isError: true
								})
							);
						}
					});
					return;
				}

				if (urlObj.pathname === '/api/mcp/health' && req.method === 'GET') {
					res.statusCode = 200;
					res.setHeader('Content-Type', 'application/json');
					res.end(JSON.stringify({ status: 'ok' }));
					return;
				}

				next();
			});
		}
	};
}

async function executeMcpTool(
	req: MCPToolExecRequest
): Promise<{ content: string; isError: boolean }> {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const { StreamableHTTPClientTransport } =
		await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
	const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
	const { WebSocketClientTransport } =
		await import('@modelcontextprotocol/sdk/client/websocket.js');

	const client = new Client({ name: 'llama-ui-mcp-proxy', version: '1.0.0' }, { capabilities: {} });

	try {
		const serverUrl = req.url;
		let transport: any;

		if (serverUrl.includes('/sse')) {
			transport = new SSEClientTransport(new URL(serverUrl));
		} else if (serverUrl.startsWith('ws') || serverUrl.includes('/ws')) {
			const wsUrl = serverUrl.startsWith('ws') ? serverUrl : serverUrl.replace(/^http/, 'ws');
			transport = new WebSocketClientTransport(new URL(wsUrl));
		} else {
			transport = new StreamableHTTPClientTransport(new URL(serverUrl));
		}

		await client.connect(transport);

		const result: any = await client.callTool({
			name: req.toolName,
			arguments: req.arguments
		});

		await client.close().catch(() => {});

		const content = Array.isArray(result.content)
			? result.content
					.map((item: any) => {
						if (item.type === 'text') return item.text;
						if (item.type === 'resource') return JSON.stringify(item.resource);
						return JSON.stringify(item);
					})
					.filter(Boolean)
					.join('\n')
			: JSON.stringify(result);

		return { content, isError: result.isError ?? false };
	} catch (err) {
		await client.close().catch(() => {});
		throw err;
	}
}
