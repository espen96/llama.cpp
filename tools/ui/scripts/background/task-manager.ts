/**
 * task-manager.ts — Background task registry
 *
 * Tracks every active generation task: its AbortController (so we can cancel
 * the upstream fetch), its current accumulated content (for reconnect), and
 * its status.
 *
 * Tasks are identified by a uuid taskId, created by llama-stream.ts when
 * POST /api/chat is received and cleaned up when the stream ends.
 */

import crypto from 'crypto';

export type TaskStatus = 'streaming' | 'done' | 'error' | 'aborted';

export interface ToolCallAccumulator {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

export interface Task {
    taskId: string;
    conversationId: string;
    /** The SQLite row id of the assistant placeholder message */
    assistantMessageId: string;
    controller: AbortController;
    status: TaskStatus;
    /** Accumulated content so far (throttle buffer) */
    accumulatedContent: string;
    accumulatedReasoning: string;
    /** Accumulated tool call json string */
    accumulatedToolCalls: string;
    resolvedModel: string | null;
    completionId: string | null;
    createdAt: number;
    /** Timer handle for periodic DB writes */
    dbFlushTimer: ReturnType<typeof setInterval> | null;
    /** In-flight tool call deltas during streaming, keyed by index */
    pendingToolCalls: Record<number, ToolCallAccumulator>;
    /** Current agentic turn number (0 = first LLM call) */
    agenticTurn: number;
    /** Maximum number of agentic turns before stopping */
    maxAgenticTurns: number;
    /** If set, the task is waiting for a continue decision from the browser */
    pendingContinueRequestId: string | null;
}

const tasks = new Map<string, Task>();

export function createTask(
    conversationId: string,
    assistantMessageId: string
): Task {
    const taskId = crypto.randomUUID();
    const task: Task = {
        taskId,
        conversationId,
        assistantMessageId,
        controller: new AbortController(),
        status: 'streaming',
        accumulatedContent: '',
        accumulatedReasoning: '',
        accumulatedToolCalls: '',
        resolvedModel: null,
        completionId: null,
        createdAt: Date.now(),
        dbFlushTimer: null,
        pendingToolCalls: {},
        agenticTurn: 0,
        maxAgenticTurns: 10,
        pendingContinueRequestId: null
    };
    tasks.set(taskId, task);
    return task;
}

export function getTask(taskId: string): Task | undefined {
    return tasks.get(taskId);
}

/** Find any streaming task for a conversation (used on reconnect). */
export function getActiveTaskForConversation(conversationId: string): Task | undefined {
    for (const task of tasks.values()) {
        if (task.conversationId === conversationId && task.status === 'streaming') {
            return task;
        }
    }
    return undefined;
}

export function getAllActiveTasks(): Task[] {
    return Array.from(tasks.values()).filter((t) => t.status === 'streaming');
}

export function markTaskDone(taskId: string): void {
    const task = tasks.get(taskId);
    if (task) {
        task.status = 'done';
        if (task.dbFlushTimer) {
            clearInterval(task.dbFlushTimer);
            task.dbFlushTimer = null;
        }
    }
}

export function markTaskError(taskId: string): void {
    const task = tasks.get(taskId);
    if (task) {
        task.status = 'error';
        if (task.dbFlushTimer) {
            clearInterval(task.dbFlushTimer);
            task.dbFlushTimer = null;
        }
    }
}

export function abortTask(taskId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) {
        console.log(`[task-manager] abortTask: task ${taskId} not found`);
        return false;
    }
    console.log(`[task-manager] abortTask called for task ${taskId}, current status: ${task.status}`);
    if (task.status === 'streaming') {
        task.controller.abort();
        task.status = 'aborted';
        if (task.dbFlushTimer) {
            clearInterval(task.dbFlushTimer);
            task.dbFlushTimer = null;
        }
    }
    return true;
}

/** Remove a task from memory (call after SSE is closed + DB write is done). */
export function deleteTask(taskId: string): void {
    const task = tasks.get(taskId);
    if (task?.dbFlushTimer) {
        clearInterval(task.dbFlushTimer);
    }
    tasks.delete(taskId);
}
