/**
 * chat-api.service.ts — Frontend bridge to the background generation API.
 *
 * This service handles the two-leg communication for background generation:
 * 1. POST /api/chat → starts the task, gets taskId back immediately
 * 2. GET /api/chat/:taskId/stream → SSE stream, receives tokens as they come
 *
 * The frontend still owns the SSE parsing and reactive state updates
 * (that stays in chatStore). This service just handles the transport.
 */

import type { ChatMessageTimings } from '$lib/types/chat';

export interface BackgroundChatRequest {
    conversationId: string;
    assistantMessageId: string;
    /** Already-normalized OAI messages array */
    messages: unknown[];
    /** All other OAI completion params (model, temperature, tools, etc.) */
    options: Record<string, unknown>;
    /** Optional connection override (baseUrl + apiKey) */
    connectionOverride?: { baseUrl: string; apiKey: string };
}

export interface BackgroundChatResponse {
    taskId: string;
    assistantMessageId: string;
}

export interface ChatStreamCallbacksBackground {
    onTaskId?: (taskId: string) => void;
    onChunk?: (chunk: string) => void;
    onReasoningChunk?: (chunk: string) => void;
    /** Called with the raw tool_calls delta array from each SSE chunk */
    onToolCallChunk?: (delta: unknown) => void;
    onModel?: (model: string) => void;
    onCompletionId?: (id: string) => void;
    onTimings?: (timings: ChatMessageTimings) => void;
    onComplete?: (content: string, reasoningContent?: string) => Promise<void>;
    onError?: (error: Error) => void;
}

/**
 * Start a background generation task and subscribe to its SSE stream.
 * Returns an object with an `abort()` method.
 */
export function startBackgroundChat(
    request: BackgroundChatRequest,
    callbacks: ChatStreamCallbacksBackground,
    signal?: AbortSignal
): { abort: () => void } {
    let taskId: string | null = null;
    let eventSource: EventSource | null = null;

    // We track accumulated content here so onComplete gets the full text.
    let accumulatedContent = '';
    let accumulatedReasoning = '';

    // Track ongoing tool calls across deltas (mirrors chat.service.ts logic)
    const pendingToolCalls: Record<number, {
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }> = {};

    const abortController = new AbortController();
    const combinedSignal = signal ? mergeSignals(signal, abortController.signal) : abortController.signal;

    async function start() {
        try {
            // Step 1: Start the background task
            const resp = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: combinedSignal
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
                throw new Error(err.error || `HTTP ${resp.status}`);
            }

            const data: BackgroundChatResponse = await resp.json();
            taskId = data.taskId;

            callbacks.onTaskId?.(taskId);

            if (combinedSignal.aborted) return;

            // Step 2: Subscribe to SSE stream
            subscribeToStream(taskId);
        } catch (err: unknown) {
            if (!isAbortError(err)) {
                callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    function subscribeToStream(id: string) {
        // Use EventSource for SSE — it auto-reconnects which is fine here,
        // the task stays alive on the server regardless.
        const url = `/api/chat/${encodeURIComponent(id)}/stream`;
        eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
            processChunk(event.data);
        };

        eventSource.addEventListener('done', () => {
            eventSource?.close();
            finalize();
        });

        eventSource.addEventListener('error', (event) => {
            const msg = (event as MessageEvent).data;
            eventSource?.close();
            let errorObj: unknown;
            try { errorObj = JSON.parse(msg); } catch { errorObj = { message: msg }; }
            callbacks.onError?.(
                new Error((errorObj as { message?: string })?.message || 'Stream error')
            );
        });

        // Fallback: if connection closes without done event
        eventSource.onerror = () => {
            // EventSource will auto-retry; we only care if the task is done
            if (combinedSignal.aborted) {
                eventSource?.close();
            }
        };

        // When the outer abort fires, close the stream
        combinedSignal.addEventListener('abort', () => {
            eventSource?.close();
            // Note: We intentionally do NOT send DELETE /api/chat/:taskId here.
            // The backend owns the upstream connection and continues streaming.
        });
    }

    function processChunk(data: string): void {
        if (data === '[DONE]') {
            finalize();
            return;
        }
        try {
            const parsed = JSON.parse(data);
            const choice = parsed?.choices?.[0];
            if (!choice) return;

            if (parsed.model) callbacks.onModel?.(parsed.model);
            if (parsed.id) callbacks.onCompletionId?.(parsed.id);

            const delta = choice.delta;
            if (!delta) return;

            if (typeof delta.content === 'string' && delta.content) {
                accumulatedContent += delta.content;
                callbacks.onChunk?.(delta.content);
            }

            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                accumulatedReasoning += delta.reasoning_content;
                callbacks.onReasoningChunk?.(delta.reasoning_content);
            }

            if (delta.tool_calls) {
                // Accumulate tool call deltas
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!pendingToolCalls[idx]) {
                        pendingToolCalls[idx] = {
                            id: tc.id || '',
                            type: tc.type || 'function',
                            function: { name: tc.function?.name || '', arguments: '' }
                        };
                    }
                    if (tc.function?.arguments) {
                        pendingToolCalls[idx].function.arguments += tc.function.arguments;
                    }
                    if (tc.function?.name) {
                        pendingToolCalls[idx].function.name = tc.function.name;
                    }
                }
                callbacks.onToolCallChunk?.(delta.tool_calls);
            }

            // Parse timings from usage field if present
            if (parsed.usage) {
                const u = parsed.usage;
                const timings: ChatMessageTimings = {
                    prompt_n: u.prompt_tokens ?? 0,
                    predicted_n: u.completion_tokens ?? 0
                };
                callbacks.onTimings?.(timings);
            }

        } catch {
            // Malformed SSE chunk, skip
        }
    }

    function finalize(): void {
        callbacks.onComplete?.(accumulatedContent, accumulatedReasoning || undefined).catch(
            (err) => callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
        );
    }

    start();

    return {
        abort() {
            abortController.abort();
        }
    };
}

/**
 * Reattach to an existing background generation task.
 * Subscribes to the SSE stream using the existing taskId.
 */
export function reconnectBackgroundChat(
    taskId: string,
    initialContent: string,
    initialReasoning: string,
    callbacks: ChatStreamCallbacksBackground,
    signal?: AbortSignal
): { abort: () => void } {
    let eventSource: EventSource | null = null;
    let accumulatedContent = initialContent;
    let accumulatedReasoning = initialReasoning;

    const pendingToolCalls: Record<number, {
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }> = {};

    const abortController = new AbortController();
    const combinedSignal = signal ? mergeSignals(signal, abortController.signal) : abortController.signal;

    function subscribeToStream(id: string) {
        const url = `/api/chat/${encodeURIComponent(id)}/stream`;
        eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
            processChunk(event.data);
        };

        eventSource.addEventListener('done', () => {
            eventSource?.close();
            finalize();
        });

        eventSource.addEventListener('error', (event) => {
            const msg = (event as MessageEvent).data;
            eventSource?.close();
            let errorObj: unknown;
            try { errorObj = JSON.parse(msg); } catch { errorObj = { message: msg }; }
            callbacks.onError?.(
                new Error((errorObj as { message?: string })?.message || 'Stream error')
            );
        });

        eventSource.onerror = () => {
            if (combinedSignal.aborted) {
                eventSource?.close();
            }
        };

        combinedSignal.addEventListener('abort', () => {
            eventSource?.close();
            // Reconnect flow doesn't abort the backend task
        });
    }

    function processChunk(data: string): void {
        if (data === '[DONE]') {
            finalize();
            return;
        }
        try {
            const parsed = JSON.parse(data);
            const choice = parsed?.choices?.[0];
            if (!choice) return;

            if (parsed.model) callbacks.onModel?.(parsed.model);
            if (parsed.id) callbacks.onCompletionId?.(parsed.id);

            const delta = choice.delta;
            if (!delta) return;

            if (typeof delta.content === 'string' && delta.content) {
                accumulatedContent += delta.content;
                callbacks.onChunk?.(delta.content);
            }

            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                accumulatedReasoning += delta.reasoning_content;
                callbacks.onReasoningChunk?.(delta.reasoning_content);
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!pendingToolCalls[idx]) {
                        pendingToolCalls[idx] = {
                            id: tc.id || '',
                            type: tc.type || 'function',
                            function: { name: tc.function?.name || '', arguments: '' }
                        };
                    }
                    if (tc.function?.arguments) {
                        pendingToolCalls[idx].function.arguments += tc.function.arguments;
                    }
                    if (tc.function?.name) {
                        pendingToolCalls[idx].function.name = tc.function.name;
                    }
                }
                callbacks.onToolCallChunk?.(delta.tool_calls);
            }

            if (parsed.usage) {
                const u = parsed.usage;
                const timings: ChatMessageTimings = {
                    prompt_n: u.prompt_tokens ?? 0,
                    predicted_n: u.completion_tokens ?? 0
                };
                callbacks.onTimings?.(timings);
            }

        } catch {
            // Malformed chunk
        }
    }

    function finalize(): void {
        callbacks.onComplete?.(accumulatedContent, accumulatedReasoning || undefined).catch(
            (err) => callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
        );
    }

    subscribeToStream(taskId);

    return {
        abort() {
            abortController.abort();
        }
    };
}

/** Fetch current active tasks (for reconnect on page reload). */
export async function getActiveTasks(): Promise<Array<{
    taskId: string;
    conversationId: string;
    assistantMessageId: string;
    status: string;
    createdAt: number;
    accumulatedContent?: string;
    accumulatedReasoning?: string;
    resolvedModel?: string | null;
    completionId?: string | null;
}>> {
    const resp = await fetch('/api/chat/active');
    if (!resp.ok) return [];
    return resp.json();
}

/** Abort a specific task on the server. */
export async function abortTask(taskId: string): Promise<boolean> {
    const resp = await fetch(`/api/chat/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    return resp.ok;
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
}

/** Merge two AbortSignals so either can cancel the operation. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (a.aborted || b.aborted) {
        controller.abort();
    } else {
        a.addEventListener('abort', abort, { once: true });
        b.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}
