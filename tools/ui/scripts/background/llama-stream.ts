/**
 * llama-stream.ts — Background fetch + SQLite write + SSE broadcast
 *
 * Core responsibilities:
 * 1. Fetch the upstream OAI-compatible endpoint (streaming)
 * 2. Run the full agentic loop: detect tool_calls → execute → continue
 * 3. Accumulate tokens in memory
 * 4. Throttle SQLite writes (every DB_FLUSH_INTERVAL_MS)
 * 5. Broadcast raw SSE events to connected browser clients via sse-hub
 * 6. On completion or error: do a final flush to SQLite and mark done
 *
 * MCP connections are established at the start of the task and held for
 * the full agentic turn. Permissions are read from SQLite settings.
 */

import {
	updateMessage,
	createToolResultMessage,
	createAssistantMessagePlaceholder
} from '../sqlite/messages.js';
import { db } from '../sqlite/db.js';
import { getConversation } from '../sqlite/conversations.js';
import { getAllSettings } from '../sqlite/settings.js';
import * as taskManager from './task-manager.js';
import type { ToolCallAccumulator } from './task-manager.js';
import * as sseHub from './sse-hub.js';
import * as mcpSessionManager from './mcp-session-manager.js';
import type { McpConnectionMap } from './mcp-session-manager.js';
import { executeTool } from './tool-executor.js';
import type { ToolContext } from './tool-executor.js';
import crypto from 'crypto';
async function fetchTools(baseUrl: string): Promise<any[]> {
    try {
        const url = `${baseUrl.replace(/\/$/, '')}/tools`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const parsed = await res.json();
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const EXECUTE_JAVASCRIPT_TOOL = {
	type: 'function',
	function: {
		name: 'execute_javascript',
		description:
			'Executes Javascript code on the server side in a safe, restricted sandbox. Can be used for calculations, data transformations, or logic tests. Returns the result of the last evaluated expression or a string representation of the output.',
		parameters: {
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description:
						'The Javascript code to execute. Must not rely on any external APIs, network access, or file system access.'
				}
			},
			required: ['code']
		}
	}
};

async function buildBackendToolsList(
    baseUrl: string,
    mcpConnections: McpConnectionMap,
    disabledTools: Set<string>,
    settings: Record<string, string>
): Promise<any[] | undefined> {
    const tools: any[] = [];

    // 1. Fetch built-in tools from llama-server
    try {
        const serverTools = await fetchTools(baseUrl);
        for (const t of serverTools) {
            if (t?.definition?.function?.name && !disabledTools.has(t.definition.function.name)) {
                tools.push(t.definition);
            }
        }
    } catch (err) {
        console.warn('[llama-stream] Failed to fetch built-in tools:', err);
    }

    // 2. Append execute_javascript if not disabled
    if (!disabledTools.has('execute_javascript')) {
        tools.push(EXECUTE_JAVASCRIPT_TOOL);
    }

    // 3. Append MCP tools
    for (const conn of mcpConnections.values()) {
        for (const mcpTool of conn.tools || []) {
            if (!disabledTools.has(mcpTool.name)) {
                tools.push({
                    type: 'function',
                    function: {
                        name: mcpTool.name,
                        description: mcpTool.description,
                        parameters: mcpTool.inputSchema || { type: 'object', properties: {} }
                    }
                });
            }
        }
    }

    // 4. Append custom tools from settings
    try {
        const configRaw = settings['LlamaUi.config'];
        if (configRaw) {
            const cfg = JSON.parse(configRaw);
            const customJson = cfg.customJson;
            if (customJson) {
                const parsed = typeof customJson === 'string' ? JSON.parse(customJson) : customJson;
                if (Array.isArray(parsed)) {
                    for (const t of parsed) {
                        if (t?.type === 'function' && t.function?.name && !disabledTools.has(t.function.name)) {
                            tools.push(t);
                        }
                    }
                }
            }
        }
    } catch {}

    return tools.length > 0 ? tools : undefined;
}

/** Throttle DB writes to this interval (ms). Keeps write rate low even at 400 tps. */
const DB_FLUSH_INTERVAL_MS = 500;

/** How long to keep a finished task before deleting it from memory (ms). */
const TASK_GC_DELAY_MS = 30_000;

/** Default max agentic turns if not configured in settings */
const DEFAULT_MAX_AGENTIC_TURNS = 10;

interface StartStreamOptions {
	/** Full OAI chat completion request body (already serialized by the frontend) */
	requestBody: Record<string, unknown>;
	/** Connection URL override (e.g. from connectionsStore) */
	baseUrl: string;
	apiKey: string;
	conversationId: string;
	assistantMessageId: string;
	/** Pass-through for upstream llama.cpp ring-buffer (PR #23226) */
	xConversationId?: string;
}

/**
 * Start a background stream. Returns the taskId immediately.
 * The caller (POST /api/chat handler) returns this taskId to the browser.
 */
export function startStream(opts: StartStreamOptions): string {
	const task = taskManager.createTask(opts.conversationId, opts.assistantMessageId);

	if (typeof opts.requestBody.model === 'string' && opts.requestBody.model) {
		task.resolvedModel = opts.requestBody.model;
	}

	// Read max turns from settings
	try {
		const settings = getAllSettings();
		const configRaw = settings['LlamaUi.config'];
		if (configRaw) {
			const cfg = JSON.parse(configRaw);
			const turns = Number(cfg.agenticMaxTurns);
			if (turns > 0) task.maxAgenticTurns = turns;
		}
	} catch {
		// Use default
	}

	// Start the async fetch — we do NOT await it, it runs in the background.
	runAgenticLoop(task, opts).catch((err) => {
		console.error(`[llama-stream] Unhandled error in task ${task.taskId}:`, err);
	});

	return task.taskId;
}

export interface ResumeState {
	pendingToolCalls?: any[];
	allowedOnceKey?: string;
	denied?: boolean;
	/** Turn count from before the pause — preserves agenticTurn across resume cycles */
	previousTurnCount?: number;
}

export function resumeStream(opts: StartStreamOptions, resumeState?: ResumeState): string {
	const task = taskManager.createTask(opts.conversationId, opts.assistantMessageId);

	if (typeof opts.requestBody.model === 'string' && opts.requestBody.model) {
		task.resolvedModel = opts.requestBody.model;
	}

	try {
		const settings = getAllSettings();
		const configRaw = settings['LlamaUi.config'];
		if (configRaw) {
			const cfg = JSON.parse(configRaw);
			const turns = Number(cfg.agenticMaxTurns);
			if (turns > 0) task.maxAgenticTurns = turns;
		}
	} catch {
		// Use default
	}

	// Preserve turn count across resume cycles so maxAgenticTurns is per-conversation, not per-resume
	if (resumeState?.previousTurnCount !== undefined) {
		task.agenticTurn = resumeState.previousTurnCount;
	}

	runAgenticLoop(task, opts, resumeState).catch((err) => {
		console.error(`[llama-stream] Unhandled error in task ${task.taskId}:`, err);
	});

	return task.taskId;
}

/**
 * Main agentic loop. Runs until:
 * - finish_reason = 'stop' (no tool calls)
 * - max turns reached
 * - task aborted
 * - error
 */
async function runAgenticLoop(task: taskManager.Task, opts: StartStreamOptions, resumeState?: ResumeState): Promise<void> {
	const { taskId } = task;
	console.log(
		`[llama-stream] Starting task ${taskId} (conv: ${opts.conversationId}, msg: ${opts.assistantMessageId})`
	);

	// --- Read settings ---
	const settings = getAllSettings();
	const { allowedTools, disabledTools, mcpServers } = readToolSettings(settings);

	// --- Read per-chat MCP overrides ---
	const conv = getConversation(opts.conversationId);
	const mcpOverrides: Array<{ serverId: string; enabled: boolean }> =
		conv?.mcpServerOverrides ?? [];

	// --- Build list of enabled MCP servers for this conversation ---
	const enabledMcpServers = buildEnabledMcpServers(mcpServers, mcpOverrides);

	// --- Connect to MCP servers (held for entire task) ---
	let mcpConnections: McpConnectionMap = new Map();
	if (enabledMcpServers.length > 0) {
		console.log(
			`[llama-stream] Connecting to ${enabledMcpServers.length} MCP server(s) for task ${taskId}`
		);
		mcpConnections = await mcpSessionManager.connectAll(enabledMcpServers);
		console.log(`[llama-stream] ${mcpConnections.size} MCP server(s) connected for task ${taskId}`);
	}

	const toolCtx: ToolContext = {
		baseUrl: opts.baseUrl,
		mcpConnections,
		allowedTools,
		disabledTools
	};

	// Start the periodic SQLite flush timer
	task.dbFlushTimer = setInterval(() => {
		flushToDB(task);
	}, DB_FLUSH_INTERVAL_MS);

	// Initialize task accumulated content from DB if it already has some (e.g. on resume continue)
	try {
		const existingMsg = db.prepare('SELECT content, reasoning_content FROM messages WHERE id = ?').get(opts.assistantMessageId) as any;
		if (existingMsg) {
			task.accumulatedContent = existingMsg.content || '';
			task.accumulatedReasoning = existingMsg.reasoning_content || '';
		}
	} catch (err) {
		console.warn(`[llama-stream] Failed to read initial content for message ${opts.assistantMessageId}:`, err);
	}

	// Build running messages array — starts with what was sent from the frontend
	const runningMessages: unknown[] = Array.isArray(opts.requestBody.messages)
		? [...(opts.requestBody.messages as unknown[])]
		: [];

	// Gather and build tools list entirely backend-side
	const tools = await buildBackendToolsList(opts.baseUrl, mcpConnections, disabledTools, settings);
	// Track the current "parent" message ID for tool result messages
	let currentAssistantMessageId = opts.assistantMessageId;
	// Track the last tool result message ID so the next assistant turn can be parented correctly
	let lastToolResultMessageId: string | null = null;

	try {
		let shouldContinueLoop = true;
		let initialPendingToolCalls = resumeState?.pendingToolCalls || null;
		const allowedOnceKey = resumeState?.allowedOnceKey;

		while (shouldContinueLoop) {
			while (task.agenticTurn < task.maxAgenticTurns) {
				if (task.controller.signal.aborted) break;

			const isFirstTurn = task.agenticTurn === 0;
			console.log(
				`[llama-stream] Task ${taskId}: starting turn ${task.agenticTurn + 1}/${task.maxAgenticTurns}`
			);

			let toolCalls: ToolCallAccumulator[] = [];

			if (initialPendingToolCalls && initialPendingToolCalls.length > 0) {
				if (resumeState?.denied) {
					// User denied the tool calls — write error results to DB and proceed
					for (const toolCall of initialPendingToolCalls) {
						const resultMsg = createToolResultMessage(
							opts.conversationId,
							toolCall.id,
							'Error: Tool execution denied by user',
							currentAssistantMessageId
						);
						lastToolResultMessageId = resultMsg.id;

						sseHub.send(taskId, 'tool_result', {
							id: toolCall.id,
							toolName: toolCall.function.name,
							content: 'Error: Tool execution denied by user',
							isError: true,
							messageId: resultMsg.id,
							parentId: currentAssistantMessageId
						});

						runningMessages.push({
							role: 'tool',
							tool_call_id: toolCall.id,
							content: 'Error: Tool execution denied by user'
						});
					}
					// Update parent assistant message status to 'done'
					updateMessage(currentAssistantMessageId, { generation_status: 'done' });
				} else {
					// Resuming from permission request: execute them
					toolCalls = initialPendingToolCalls;
				}
				initialPendingToolCalls = null; // Consume so we don't loop infinitely
				task.agenticTurn++;
			} else {
				// --- Normal Generation Flow ---
				// For subsequent turns, create a new assistant message placeholder in DB
				if (!isFirstTurn) {
					const newMsgId = crypto.randomUUID();
					const parentId = lastToolResultMessageId || currentAssistantMessageId;
					createAssistantMessagePlaceholder(opts.conversationId, parentId, newMsgId);
					currentAssistantMessageId = newMsgId;
					task.assistantMessageId = newMsgId;

					// Broadcast assistant_message event to SSE clients
					sseHub.send(taskId, 'assistant_message', {
						messageId: newMsgId,
						parentId
					});
				}

				// Start/Restart the periodic SQLite flush timer if it was cleared
				if (!task.dbFlushTimer) {
					task.dbFlushTimer = setInterval(() => {
						flushToDB(task);
					}, DB_FLUSH_INTERVAL_MS);
				}

				// Reset per-turn accumulators
				task.accumulatedContent = '';
				task.accumulatedReasoning = '';
				task.accumulatedToolCalls = '';
				task.pendingToolCalls = {};

				const requestBody = {
					...opts.requestBody,
					messages: runningMessages,
					tools,
					stream: true
				};

				const finishReason = await runSingleCompletion(
					task,
					opts,
					requestBody,
					currentAssistantMessageId,
					isFirstTurn
				);

				task.agenticTurn++;

				if (task.controller.signal.aborted) break;

				// --- No tool calls: we're done ---
				if (finishReason !== 'tool_calls') {
					await finalFlush(task, currentAssistantMessageId, 'done');
					taskManager.markTaskDone(taskId);
					sseHub.closeTask(taskId);
					return;
				}

				// --- Tool calls: extract them ---
				toolCalls = Object.values(task.pendingToolCalls) as ToolCallAccumulator[];
				if (toolCalls.length === 0) {
					// finish_reason said tool_calls but nothing accumulated — treat as done
					await finalFlush(task, currentAssistantMessageId, 'done');
					taskManager.markTaskDone(taskId);
					sseHub.closeTask(taskId);
					return;
				}

				// Save the assistant message with tool_calls to DB
				await flushAssistantWithToolCalls(task, currentAssistantMessageId, toolCalls);

				// Append assistant message to running context
				runningMessages.push({
					role: 'assistant',
					content: task.accumulatedContent || null,
					reasoning_content: task.accumulatedReasoning || undefined,
					tool_calls: toolCalls.map((tc) => {
						let cleanArgs = tc.function.arguments;
						try {
							JSON.parse(cleanArgs || '{}');
						} catch {
							console.warn(`[llama-stream] Sanitizing malformed tool call arguments: "${cleanArgs}"`);
							cleanArgs = '{}';
						}
						return {
							id: tc.id,
							type: tc.type,
							function: { name: tc.function.name, arguments: cleanArgs }
						};
					})
				});
			}

			// Execute each tool call
			for (const toolCall of toolCalls) {
				if (task.controller.signal.aborted) break;

				const toolName = (toolCall.function.name || '').trim();
				let parsedArgs: Record<string, unknown> = {};
				try {
					parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
				} catch {
					parsedArgs = {};
				}

				console.log(`[llama-stream] Task ${taskId}: executing tool "${toolName}"`);

				if (!toolName) {
					const result = { content: 'Error: Unknown tool: ', isError: true };
					console.log(
						`[llama-stream] Task ${taskId}: tool name is empty, skipping permission check and returning error`
					);
					const toolResultMsg = createToolResultMessage(
						opts.conversationId,
						toolCall.id,
						result.content,
						currentAssistantMessageId
					);
					lastToolResultMessageId = toolResultMsg.id;

					sseHub.send(taskId, 'tool_result', {
						id: toolCall.id,
						toolName: '',
						content: result.content,
						isError: result.isError
					});

					runningMessages.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: result.content
					});
					continue;
				}

				// Broadcast tool_call event to SSE clients
				sseHub.send(taskId, 'tool_call', {
					id: toolCall.id,
					name: toolName,
					arguments: toolCall.function.arguments
				});

				// Determine source: builtin vs MCP
				const mcpConn = mcpSessionManager.findConnectionForTool(toolCtx.mcpConnections, toolName);
				const isMcp = mcpConn !== undefined;

				// Build permission key
				const permissionKey = isMcp
					? `mcp-${mcpConn!.serverId}:${toolName}`
					: `builtin:${toolName}`;
				const serverLabel = isMcp ? mcpConn!.serverName : 'Built-in Tools';

				// Check permission
				let isAllowed = toolCtx.allowedTools.has(permissionKey) || allowedOnceKey === permissionKey;

				if (!isAllowed) {
					// Tool not in always-allowed list — request permission from the browser
					console.log(
						`[llama-stream] Task ${taskId}: tool "${toolName}" needs permission, saving state to DB and exiting.`
					);

					// 1. Sync Point: Flush all accumulated text and the complete tool calls JSON to DB
					await flushAssistantWithToolCalls(task, currentAssistantMessageId, toolCalls);
					
					// 2. Override status to waiting
					updateMessage(currentAssistantMessageId, { generation_status: 'waiting_for_permission' });

					// 3. Notify frontend
					sseHub.send(taskId, 'permission_request', {
						toolName,
						serverLabel
					});

					// 4. Clean exit
					taskManager.markTaskDone(taskId);
					sseHub.closeTask(taskId);
					return;
				}

				const result = await executeTool(toolName, parsedArgs, toolCtx);

				console.log(
					`[llama-stream] Task ${taskId}: tool "${toolName}" result (isError=${result.isError})`
				);

				// Save tool result to DB as a child of the assistant message
				const toolResultMsg = createToolResultMessage(
					opts.conversationId,
					toolCall.id,
					result.content,
					currentAssistantMessageId
				);
				lastToolResultMessageId = toolResultMsg.id;

				// Broadcast tool_result event to SSE clients
				sseHub.send(taskId, 'tool_result', {
					id: toolCall.id,
					toolName,
					content: result.content,
					isError: result.isError,
					messageId: toolResultMsg.id,
					parentId: currentAssistantMessageId
				});

				// Append tool result to running context
				runningMessages.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: result.content
				});
			}

			// Continue the loop for the next LLM turn
		}

		// Max turns reached — ask the user whether to continue
		if (task.agenticTurn >= task.maxAgenticTurns) {
			console.warn(
				`[llama-stream] Task ${taskId}: max agentic turns (${task.maxAgenticTurns}) reached, requesting continue and exiting.`
			);

			// 1. Flush current state
			await finalFlush(task, currentAssistantMessageId, 'waiting_for_continue');

			// 2. Notify frontend
			sseHub.send(taskId, 'continue_request', {
				turn: task.agenticTurn,
				maxTurns: task.maxAgenticTurns
			});

			// 3. Clean exit
			taskManager.markTaskDone(taskId);
			sseHub.closeTask(taskId);
			return;
		}
		} // end outer while loop

		await finalFlush(task, currentAssistantMessageId, 'done');
		taskManager.markTaskDone(taskId);
		sseHub.closeTask(taskId);
	} catch (err: unknown) {
		if (isAbortError(err)) {
			console.log(`[llama-stream] Task ${taskId} aborted`);
			await finalFlush(task, currentAssistantMessageId, 'done');
			taskManager.markTaskDone(taskId);
		} else {
			console.error(`[llama-stream] Task ${taskId} failed:`, err);
			await finalFlush(task, currentAssistantMessageId, 'error');
			taskManager.markTaskError(taskId);
			sseHub.send(taskId, 'error', {
				message: err instanceof Error ? err.message : String(err)
			});
		}
		sseHub.closeTask(taskId);
	} finally {
		setTimeout(() => taskManager.deleteTask(taskId), TASK_GC_DELAY_MS);
	}
}

/**
 * Run a single LLM completion turn, streaming tokens to SSE clients.
 * Returns the finish_reason of the completion.
 */
async function runSingleCompletion(
	task: taskManager.Task,
	opts: StartStreamOptions,
	requestBody: Record<string, unknown>,
	assistantMessageId: string,
	isFirstTurn: boolean
): Promise<string> {
	const { taskId } = task;
	const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'text/event-stream'
	};
	if (opts.apiKey) {
		headers['Authorization'] = `Bearer ${opts.apiKey}`;
	}
	if (opts.xConversationId) {
		headers['X-Conversation-Id'] = opts.xConversationId;
	}

	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...requestBody, stream: true }),
		signal: task.controller.signal
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => `HTTP ${response.status}`);
		throw new Error(`Upstream error ${response.status}: ${errText}`);
	}

	if (!response.body) {
		throw new Error('No response body from upstream');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let sseBuffer = '';
	let finishReason = 'stop';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		sseBuffer += decoder.decode(value, { stream: true });

		const lines = sseBuffer.split('\n');
		sseBuffer = lines.pop() ?? '';

		for (const line of lines) {
			const reason = processLine(task, line, assistantMessageId, true);
			if (reason) finishReason = reason;
		}
	}

	if (sseBuffer.trim()) {
		const reason = processLine(task, sseBuffer, assistantMessageId, true);
		if (reason) finishReason = reason;
	}

	return finishReason;
}

function processLine(
	task: taskManager.Task,
	line: string,
	_assistantMessageId: string,
	broadcastToSse: boolean
): string | null {
	if (!line.startsWith('data:')) return null;

	const data = line.slice(5).trim();
	if (data === '[DONE]') return null;

	try {
		const parsed = JSON.parse(data);
		const choice = parsed?.choices?.[0];
		if (!choice) return null;

		if (parsed.model && !task.resolvedModel) {
			task.resolvedModel = parsed.model;
		}
		if (parsed.id && !task.completionId) {
			task.completionId = parsed.id;
		}
		if (parsed.timings) {
			task.accumulatedTimings = parsed.timings;
		}

		// Sanitize model name in broadcast
		if (task.resolvedModel) {
			parsed.model = task.resolvedModel;
		}
		const sanitizedData = JSON.stringify(parsed);

		const delta = choice.delta;
		const finishReason = choice.finish_reason as string | null;

		if (delta) {
			// Regular content
			if (typeof delta.content === 'string' && delta.content) {
				task.accumulatedContent += delta.content;
				if (broadcastToSse) {
					sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
				}
			}

			// Reasoning content
			if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
				task.accumulatedReasoning += delta.reasoning_content;
				if (broadcastToSse) {
					sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
				}
			}

			// Tool call deltas — accumulate
			if (delta.tool_calls) {
				for (const tc of delta.tool_calls as Array<{
					index?: number;
					id?: string;
					type?: string;
					function?: { name?: string; arguments?: string };
				}>) {
					const idx = tc.index ?? 0;
					if (!task.pendingToolCalls[idx]) {
						task.pendingToolCalls[idx] = {
							id: tc.id || '',
							type: tc.type || 'function',
							function: { name: tc.function?.name || '', arguments: '' }
						};
					} else {
						if (tc.id) task.pendingToolCalls[idx].id = tc.id;
						if (tc.function?.name) task.pendingToolCalls[idx].function.name = tc.function.name;
					}
					if (tc.function?.arguments) {
						task.pendingToolCalls[idx].function.arguments += tc.function.arguments;
					}
				}
				// Forward tool_calls delta to browser so it can show streaming tool name
				if (broadcastToSse) {
					sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
				}
			}
		}

		// Capture finish_reason
		if (finishReason) {
			if (broadcastToSse) {
				sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
			}
			return finishReason;
		}
	} catch (err: any) {
		console.error(`[llama-stream] Error parsing SSE line: "${line}"`, err.message);
	}

	return null;
}

/** Write current accumulated content to SQLite (periodic throttle). */
function flushToDB(task: taskManager.Task): void {
	if (!task.accumulatedContent && !task.accumulatedReasoning) return;
	try {
		updateMessage(task.assistantMessageId, {
			content: task.accumulatedContent,
			reasoningContent: task.accumulatedReasoning || undefined,
			generation_status: 'streaming'
		});
	} catch (err: unknown) {
		console.error(`[llama-stream] Throttle flush failed for ${task.assistantMessageId}:`, err);
	}
}

/** Save assistant message with tool_calls to SQLite. */
async function flushAssistantWithToolCalls(
	task: taskManager.Task,
	assistantMessageId: string,
	toolCalls: ToolCallAccumulator[]
): Promise<void> {
	if (task.dbFlushTimer) {
		clearInterval(task.dbFlushTimer);
		task.dbFlushTimer = null;
	}
	try {
		updateMessage(assistantMessageId, {
			content: task.accumulatedContent,
			reasoningContent: task.accumulatedReasoning || undefined,
			toolCalls: JSON.stringify(
				toolCalls.map((tc) => {
					let cleanArgs = tc.function.arguments;
					try {
						JSON.parse(cleanArgs || '{}');
					} catch {
						cleanArgs = '{}';
					}
					return {
						id: tc.id,
						type: tc.type,
						function: { name: tc.function.name, arguments: cleanArgs }
					};
				})
			),
			model: task.resolvedModel || undefined,
			completionId: task.completionId || undefined,
			generation_status: 'streaming'
		});
	} catch (err) {
		console.error(`[llama-stream] Tool calls flush failed for ${assistantMessageId}:`, err);
	}
}

/** Final write to SQLite on stream completion or error. */
async function finalFlush(
	task: taskManager.Task,
	assistantMessageId: string,
	status: 'done' | 'error' | 'waiting_for_continue' | 'waiting_for_permission'
): Promise<void> {
	if (task.dbFlushTimer) {
		clearInterval(task.dbFlushTimer);
		task.dbFlushTimer = null;
	}
	try {
		const update: Record<string, unknown> = {
			content: task.accumulatedContent,
			generation_status: status
		};
		if (task.accumulatedReasoning) {
			update.reasoningContent = task.accumulatedReasoning;
		}
		if (task.resolvedModel) {
			update.model = task.resolvedModel;
		}
		if (task.completionId) {
			update.completionId = task.completionId;
		}
		if (task.accumulatedToolCalls) {
			update.toolCalls = task.accumulatedToolCalls;
		}
		if (task.accumulatedTimings) {
			update.timings = task.accumulatedTimings;
		}
		updateMessage(assistantMessageId, update);
	} catch (err) {
		console.error(`[llama-stream] Final flush failed for ${assistantMessageId}:`, err);
	}
}

// --- Settings helpers ---

interface ToolSettings {
	allowedTools: Set<string>;
	disabledTools: Set<string>;
	mcpServers: McpServerRaw[];
}

interface McpServerRaw {
	id: string;
	url: string;
	enabled: boolean;
	name?: string;
	headers?: string;
	requestTimeoutSeconds?: number;
	useProxy?: boolean;
}

function readToolSettings(settings: Record<string, string>): ToolSettings {
	let allowedTools = new Set<string>();
	let disabledTools = new Set<string>();
	let mcpServers: McpServerRaw[] = [];

	try {
		const raw = settings['LlamaUi.alwaysAllowedTools'];
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) allowedTools = new Set(parsed);
		}
	} catch {}

	try {
		const raw = settings['LlamaUi.disabledTools'];
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) disabledTools = new Set(parsed);
		}
	} catch {}

	try {
		const configRaw = settings['LlamaUi.config'];
		if (configRaw) {
			const cfg = JSON.parse(configRaw);
			if (cfg.mcpServers) {
				let parsedMcpServers = cfg.mcpServers;
				if (typeof parsedMcpServers === 'string') {
					try {
						parsedMcpServers = JSON.parse(parsedMcpServers);
					} catch {}
				}
				if (Array.isArray(parsedMcpServers)) {
					mcpServers = parsedMcpServers as McpServerRaw[];
				}
			}
		}
	} catch {}

	return { allowedTools, disabledTools, mcpServers };
}

function buildEnabledMcpServers(
	rawServers: McpServerRaw[],
	overrides: Array<{ serverId: string; enabled: boolean }>
): mcpSessionManager.McpServerEntry[] {
	const overrideMap = new Map(overrides.map((o) => [o.serverId, o.enabled]));
	const result: mcpSessionManager.McpServerEntry[] = [];

	for (let idx = 0; idx < rawServers.length; idx++) {
		const s = rawServers[idx];
		const id =
			s.id && typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `mcp-server-${idx + 1}`;
		// Per-chat override controls enablement; fall back to global enabled status
		const enabled = overrideMap.has(id) ? overrideMap.get(id)! : s.enabled;
		if (!enabled || !s.url?.trim()) continue;

		let headers: Record<string, string> | undefined;
		if (s.headers) {
			try {
				const parsed = JSON.parse(s.headers);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					headers = parsed as Record<string, string>;
				}
			} catch {}
		}

		const entry: mcpSessionManager.McpServerEntry = {
			id,
			name: s.name && s.name.trim() ? s.name.trim() : s.url.trim() || id,
			url: s.url.trim(),
			requestTimeoutMs: s.requestTimeoutSeconds ? s.requestTimeoutSeconds * 1000 : 30_000
		};
		if (headers) entry.headers = headers;
		result.push(entry);
	}

	return result;
}

/** Resolve the upstream connection URL and API key from user_settings. */
export function resolveUpstreamConnection(): { baseUrl: string; apiKey: string } {
	try {
		const settings = getAllSettings();
		const connectionsRaw = settings['LlamaUi.connections'];
		const activeId = settings['LlamaUi.activeConnectionId'];

		if (connectionsRaw && activeId) {
			const connections = JSON.parse(connectionsRaw) as Array<{
				id: string;
				url: string;
				apiKey: string;
				enabled: boolean;
			}>;
			const active = connections.find((c) => c.id === activeId && c.enabled);
			if (active) {
				return { baseUrl: active.url, apiKey: active.apiKey || '' };
			}
		}

		const configRaw = settings['LlamaUi.config'];
		if (configRaw) {
			const cfg = JSON.parse(configRaw);
			if (cfg.apiKey) return { baseUrl: 'http://localhost:8080', apiKey: cfg.apiKey };
		}
	} catch {
		// Fall through to default
	}
	return { baseUrl: 'http://localhost:8080', apiKey: '' };
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
}
