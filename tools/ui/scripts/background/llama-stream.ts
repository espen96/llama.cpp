/**
 * llama-stream.ts — Background fetch + SQLite write + SSE broadcast
 *
 * Core responsibilities:
 * 1. Fetch the upstream OAI-compatible endpoint (streaming)
 * 2. Accumulate tokens in memory
 * 3. Throttle SQLite writes (every DB_FLUSH_INTERVAL_MS)
 * 4. Broadcast raw SSE events to connected browser clients via sse-hub
 * 5. On completion or error: do a final flush to SQLite and mark done
 *
 * The upstream endpoint URL and API key are read from the user_settings
 * table (same keys the frontend stores via StorageService).
 */

import { updateMessage } from '../sqlite/messages.js';
import { getAllSettings } from '../sqlite/settings.js';
import * as taskManager from './task-manager.js';
import * as sseHub from './sse-hub.js';

/** Throttle DB writes to this interval (ms). Keeps write rate low even at 400 tps. */
const DB_FLUSH_INTERVAL_MS = 500;

/** How long to keep a finished task before deleting it from memory (ms). */
const TASK_GC_DELAY_MS = 30_000;

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

    // Start the async fetch — we do NOT await it, it runs in the background.
    runStream(task, opts).catch((err) => {
        console.error(`[llama-stream] Unhandled error in task ${task.taskId}:`, err);
    });

    return task.taskId;
}

async function runStream(
    task: taskManager.Task,
    opts: StartStreamOptions
): Promise<void> {
    const { taskId } = task;
    console.log(`[llama-stream] runStream: starting task ${taskId} (conversation: ${opts.conversationId}, assistantMessageId: ${opts.assistantMessageId})`);

    // Start the periodic SQLite flush timer
    task.dbFlushTimer = setInterval(() => {
        flushToDB(task);
    }, DB_FLUSH_INTERVAL_MS);

    const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
    };
    if (opts.apiKey) {
        headers['Authorization'] = `Bearer ${opts.apiKey}`;
    }
    if (opts.xConversationId) {
        headers['X-Conversation-Id'] = opts.xConversationId;
    }

    try {
        console.log(`[llama-stream] runStream: fetching upstream completed url=${url}`);
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...opts.requestBody, stream: true }),
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

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log(`[llama-stream] runStream: reader done for task ${taskId}`);
                break;
            }

            sseBuffer += decoder.decode(value, { stream: true });

            // Process complete SSE lines
            const lines = sseBuffer.split('\n');
            // Keep the last (possibly incomplete) line in the buffer
            sseBuffer = lines.pop() ?? '';

            for (const line of lines) {
                processLine(task, line);
            }
        }

        // Process any remaining buffer
        if (sseBuffer.trim()) {
            processLine(task, sseBuffer);
        }

        // Final DB flush with generation_status = 'done'
        console.log(`[llama-stream] runStream: completing task ${taskId} successfully`);
        await finalFlush(task, 'done');
        taskManager.markTaskDone(taskId);
        sseHub.closeTask(taskId);

    } catch (err: unknown) {
        if (isAbortError(err)) {
            console.log(`[llama-stream] runStream: task ${taskId} aborted/stopped by controller signal`);
            // User requested stop — save whatever we have as 'done' (partial is fine)
            await finalFlush(task, 'done');
            taskManager.markTaskDone(taskId);
        } else {
            console.error(`[llama-stream] runStream: task ${taskId} failed:`, err);
            await finalFlush(task, 'error');
            taskManager.markTaskError(taskId);
            sseHub.send(taskId, 'error', { message: err instanceof Error ? err.message : String(err) });
        }
        sseHub.closeTask(taskId);
    } finally {
        console.log(`[llama-stream] runStream: finally block for task ${taskId}, scheduling delete in ${TASK_GC_DELAY_MS}ms`);
        // Schedule task GC
        setTimeout(() => taskManager.deleteTask(taskId), TASK_GC_DELAY_MS);
    }
}

function processLine(task: taskManager.Task, line: string): void {
    if (!line.startsWith('data:')) return;

    const data = line.slice(5).trim();
    if (data === '[DONE]') return;

    try {
        const parsed = JSON.parse(data);
        const choice = parsed?.choices?.[0];
        if (!choice) return;

        // Capture model name from first chunk if not already resolved/requested
        if (parsed.model && !task.resolvedModel) {
            task.resolvedModel = parsed.model;
        }
        // Capture completion id
        if (parsed.id && !task.completionId) {
            task.completionId = parsed.id;
        }

        const delta = choice.delta;
        if (!delta) return;

        // Sanitize the model property with the correct resolved name
        if (task.resolvedModel) {
            parsed.model = task.resolvedModel;
        }
        const sanitizedData = JSON.stringify(parsed);

        // Regular content token
        if (typeof delta.content === 'string' && delta.content) {
            task.accumulatedContent += delta.content;
            // Forward sanitized SSE line to browser clients
            sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
            return;
        }

        // Reasoning content (llama.cpp extension)
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            task.accumulatedReasoning += delta.reasoning_content;
            sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
            return;
        }

        // Tool calls delta — forward as-is, accumulate final form in onComplete
        if (delta.tool_calls) {
            sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
            return;
        }

        // finish_reason — capture tool_calls if present in this chunk
        if (choice.finish_reason) {
            // Forward to client so it knows the stream ended
            sseHub.broadcast(task.taskId, `data: ${sanitizedData}\n\n`);
        }

    } catch {
        // Malformed SSE chunk — skip
    }
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

/** Final write to SQLite on stream completion or error. */
async function finalFlush(
    task: taskManager.Task,
    status: 'done' | 'error'
): Promise<void> {
    // Stop the interval timer before the final write
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
        updateMessage(task.assistantMessageId, update);
    } catch (err) {
        console.error(`[llama-stream] Final flush failed for ${task.assistantMessageId}:`, err);
    }
}

/** Resolve the upstream connection URL and API key from user_settings. */
export function resolveUpstreamConnection(): { baseUrl: string; apiKey: string } {
    try {
        const settings = getAllSettings();
        // The connectionsStore serializes the connections list under 'LlamaUi.connections'
        // and active connection id under 'LlamaUi.activeConnectionId'
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

        // Fall back to the legacy apiKey and default localhost
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
    return (
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted'))
    );
}
