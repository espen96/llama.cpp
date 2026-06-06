import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestHarness } from './express-harness';
import { createMockStream } from './mock-llm';
import { db } from '../../../scripts/sqlite/db';
import * as http from 'http';
import { AddressInfo } from 'net';

const app = setupTestHarness();
let server: http.Server;
let baseUrl: string;

describe('Backend Concurrency & LLM Streaming', () => {
	beforeAll(async () => {
		await new Promise<void>((resolve) => {
			server = app.listen(0, () => {
				const address = server.address() as AddressInfo;
				baseUrl = `http://localhost:${address.port}`;
				resolve();
			});
		});

		// Mock global fetch
		const originalFetch = global.fetch;
		global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			if (url.includes('/v1/chat/completions')) {
				const body = JSON.parse(init?.body as string || '{}');
				
				let mockConfig: any = { tps: 80 };
				if (body.user && body.user.startsWith('mock:')) {
					mockConfig = JSON.parse(body.user.slice(5));
				}
				
				// Prevent infinite loop by not calling the tool again if a tool call was already made in this context
				if (body.messages?.some((m: any) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls))) {
					mockConfig.tool = false;
				}
				
				const stream = createMockStream({
					tps: mockConfig.tps || 80,
					totalTokens: 200,
					includeToolCall: mockConfig.tool,
					toolName: mockConfig.toolName,
					toolArgs: mockConfig.toolArgs,
					toolCallDelayTokens: 50,
					includeReasoning: true
				});

				return new Response(stream, {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' }
				});
			}

			if (url.includes('/api/chat/title')) {
				return new Response(JSON.stringify({ title: 'Mock Title' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			return originalFetch(input, init);
		};
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	beforeEach(() => {
		// Clean db tables and insert a dummy MCP server
		db.exec(`
			DELETE FROM messages;
			DELETE FROM conversations;
			DELETE FROM user_settings;
		`);
		
		const defaultUserId = (db.prepare('SELECT id FROM users WHERE username = ?').get('default') as any).id;
		const mcpConfig = JSON.stringify({
			"mock-mcp": {
				"command": "node",
				"args": ["tests/unit/server/mock-mcp-server.ts"],
				"enabled": true
			}
		});
		db.prepare('INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(
			defaultUserId, 'mcpServers', mcpConfig, Date.now()
		);
	});

	it('should handle 4 concurrent streams with varying TPS and tool call interruptions', async () => {
		const configs = [
			{ tps: 20, tool: false },
			{ tps: 40, tool: true }, // normal scratchpad tool
			{ tps: 80, tool: true, toolName: 'execute_javascript', toolArgs: '{"code":"console.log(\\"Hello from JS\\"); return 42;"}' }, // Builtin JS tool
			{ tps: 160, tool: true, toolName: 'scratchpad', toolArgs: 'BROKEN_JSON' } // Malformed tool arguments
		];

		const activeStreams = await Promise.all(configs.map(async (cfg, i) => {

			const titleRes = await fetch(`${baseUrl}/conversations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: `Mock Stream ${i}` })
			});
			if (!titleRes.ok) throw new Error(`Failed to create conversation: ${await titleRes.text()}`);
			const conv = await titleRes.json();
			const conversationId = conv.id;

			const rootMsgRes = await fetch(`${baseUrl}/messages/root`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					convId: conversationId
				})
			});
			if (!rootMsgRes.ok) throw new Error(`Failed root msg: ${await rootMsgRes.text()}`);
			const rootMsgData = await rootMsgRes.json();
			const rootMsgId = rootMsgData.id;

			const userMsgRes = await fetch(`${baseUrl}/messages/branch`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: {
						convId: conversationId,
						type: 'normal',
						role: 'user',
						content: `Start stream ${i}`,
						timestamp: Date.now()
					},
					parentId: rootMsgId
				})
			});
			if (!userMsgRes.ok) throw new Error(`Failed user msg: ${await userMsgRes.text()}`);
			const userMsgData = await userMsgRes.json();
			const userMsgId = userMsgData.id;

			const asstMsgRes = await fetch(`${baseUrl}/messages/branch`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: {
						convId: conversationId,
						type: 'normal',
						role: 'assistant',
						content: '',
						timestamp: Date.now()
					},
					parentId: userMsgId
				})
			});
			if (!asstMsgRes.ok) throw new Error(`Failed asst msg: ${await asstMsgRes.text()}`);
			const asstMsg = await asstMsgRes.json();
			const assistantMessageId = asstMsg.id;

			const chatRes = await fetch(`${baseUrl}/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					conversationId,
					assistantMessageId,
					connectionOverride: {
						baseUrl: 'http://mock-llm',
						apiKey: 'test-key'
					},
					options: {
						user: 'mock:' + JSON.stringify(cfg)
					}
				})
			});
			if (!chatRes.ok) {
				const txt = await chatRes.text();
				throw new Error(`Failed to start chat: ${chatRes.status} ${txt}`);
			}
			const data = await chatRes.json();
			return { taskId: data.taskId, convId: conversationId, asstMsgId: assistantMessageId, config: cfg };
		}));

		const results = await Promise.all(activeStreams.map(async (streamInfo, idx) => {
			console.log(`Processing stream ${idx}...`);
			let content = '';
			const decoder = new TextDecoder();
			
			try {
				let isComplete = false;
				let loopStream = true;
				let currentEvent = 'message';
				let buffer = '';

				while (!isComplete) {
					console.log(`Stream ${idx} fetching SSE for taskId: ${streamInfo.taskId}...`);
					const sseRes = await fetch(`${baseUrl}/chat/${streamInfo.taskId}/stream`);
					console.log(`Stream ${idx} sseRes.status: ${sseRes.status}`);
					const reader = sseRes.body?.getReader();
					if (!reader) break;

					while (loopStream) {
						const { done, value } = await reader.read();
						
						if (value) {
							const decoded = decoder.decode(value, { stream: !done });
							console.log(`Stream ${idx} received chunk: ${JSON.stringify(decoded)}`);
							buffer += decoded;
							const lines = buffer.split('\n');
							buffer = lines.pop() || ''; // keep incomplete line for next chunk

							for (const line of lines) {
								if (line.startsWith('event: ')) {
									currentEvent = line.slice(7).trim();
									continue;
								}
								if (!line.startsWith('data: ')) continue;
								
								const dataStr = line.slice(6).trim();
								if (!dataStr || dataStr === '[DONE]') continue;

								try {
									const data = JSON.parse(dataStr);
									
									// Simulate user permission logic
									if (currentEvent === 'permission_request') {
										console.log(`Stream ${idx} got permission request for ${data.toolName}`);
										// Answer the permission request
										const resumeRes = await fetch(`${baseUrl}/chat/${streamInfo.convId}/resume-permission`, {
											method: 'POST',
											headers: { 'Content-Type': 'application/json' },
											body: JSON.stringify({
												messageId: streamInfo.asstMsgId,
												decision: 'once',
												allowedOnceToolName: `builtin:${data.toolName}`
											})
										});
										const resumeData = await resumeRes.json();
										if (resumeData.taskId) {
											console.log(`Stream ${idx} got new taskId ${resumeData.taskId}`);
											streamInfo.taskId = resumeData.taskId;
											loopStream = false; // break the current inner loop so we reconnect to new taskId
											break;
										}
									}

									if (currentEvent === 'message' || currentEvent === 'assistant_message') {
										content += (data.content || '');
									}

									if (currentEvent === 'done') {
										console.log(`Stream ${idx} got done!`);
										isComplete = true;
										loopStream = false;
										break;
									}
								} catch (e) {
									console.error(`Stream ${idx} parse error:`, e);
								}
							}
						}

						if (done) {
							console.log(`Stream ${idx} reader done!`);
							break;
						}
					}
					// If we broke out of loopStream but not complete, it might be due to a reconnect.
					// Reset loopStream for the next fetch.
					loopStream = !isComplete;
				}
			} catch (err) {
				console.error(`Stream ${idx} failed:`, err);
			}
			console.log(`Stream ${idx} finished!`);
			return { idx, content, streamInfo };
		}));

		// Validate database state
		for (const res of results) {
			const msgs = db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY timestamp ASC').all(res.streamInfo.convId) as any[];
			
			// We expect a root message, user message, assistant message, and possibly a tool result + second assistant message if tool was called
			console.log(`Stream ${res.idx} messages:`, msgs.map(m => ({ role: m.role, id: m.id })));
			expect(msgs.length).toBeGreaterThanOrEqual(3);
			
			const asstMsgs = msgs.filter(m => m.role === 'assistant');
			// content should have ' token' repeated approx 1000 times total across the turn(s)
			const totalContent = asstMsgs.map(m => m.content).join('');
			expect(totalContent).toContain('token');
			
			// check that parent-child relationships are intact and strictly within this convId
			for (const m of msgs) {
				if (m.parent) {
					const parent = msgs.find(p => p.id === m.parent);
					expect(parent).toBeDefined(); // No foreign parents!
				}
			}
		}
	}, 120000); // Allow 2 minutes for 160 TPS / 20 TPS to finish 1000 tokens
});
