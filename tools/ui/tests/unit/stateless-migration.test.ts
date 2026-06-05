import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as llamaStream from '../../scripts/background/llama-stream.js';
import * as taskManager from '../../scripts/background/task-manager.js';
import { db } from '../../scripts/sqlite/db.js';
import { createConversation } from '../../scripts/sqlite/conversations.js';
import { createRootMessage, createMessageBranch, updateMessage } from '../../scripts/sqlite/messages.js';

// We want to test that the backend does not hang when it needs permission,
// but instead saves the state to SQLite and gracefully exits.

describe('Stateless Architecture Migration', () => {
    let originalFetch: typeof globalThis.fetch;
    let convId: string;
    let rootMsgId: string;
    let userMsg: any;
    let assistantMsg: any;

    beforeEach(() => {
        // Setup SQLite test data
        db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM user_settings; DELETE FROM projects;');
        
        const conv = createConversation('Test Conversation');
        convId = conv.id;
        rootMsgId = createRootMessage(convId);
        
        // Setup initial user message and assistant placeholder
        userMsg = createMessageBranch(
            { role: 'user', content: 'Use the test_tool please', convId, type: 'normal', timestamp: Date.now() },
            rootMsgId
        );
        assistantMsg = createMessageBranch(
            { role: 'assistant', content: '', convId, type: 'normal', timestamp: Date.now() },
            userMsg.id
        );
        
        updateMessage(assistantMsg.id, { generation_status: 'streaming' });

        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        // Clear tasks
        const active = taskManager.getAllActiveTasks();
        for (const t of active) {
            taskManager.deleteTask(t.taskId);
        }
    });

    it('should exit gracefully and update DB when waiting for permission', async () => {
        // Mock fetch to simulate an OpenAI stream that requests a tool
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            const streamContent = [
                'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"}}]}\n\n',
                'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"test_tool","arguments":"{\\"foo\\":\\"bar\\"}"}}]}}]}\n\n',
                'data: {"id":"chatcmpl-1","choices":[{"finish_reason":"tool_calls"}]}\n\n',
                'data: [DONE]\n\n'
            ];

            let index = 0;
            const stream = new ReadableStream({
                start(controller) {
                    function push() {
                        if (index < streamContent.length) {
                            controller.enqueue(new TextEncoder().encode(streamContent[index]));
                            index++;
                            setTimeout(push, 10);
                        } else {
                            controller.close();
                        }
                    }
                    push();
                }
            });

            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        });

        // Start stream using the public API
        const taskId = llamaStream.startStream({
            requestBody: {
                messages: [{ role: 'user', content: 'Use the test_tool please' }],
                tools: [{ type: 'function', function: { name: 'test_tool' } }],
                model: 'mock-model'
            },
            baseUrl: 'http://mock',
            apiKey: 'mock',
            conversationId: convId,
            assistantMessageId: assistantMsg.id
        });

        const task = taskManager.getTask(taskId);
        expect(task).toBeDefined();

        // Wait for the async loop to process the stream
        // Because we are testing "Zen" mode, the loop should completely resolve and exit
        // instead of hanging indefinitely on a pending promise.
        
        // We'll poll until the task is no longer in "streaming" status
        let attempts = 0;
        while (attempts < 50) {
            const dbMsg = db.prepare('SELECT generation_status, tool_calls FROM messages WHERE id = ?').get(assistantMsg.id) as any;
            if (dbMsg && dbMsg.generation_status === 'waiting_for_permission') {
                break;
            }
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        const finalDbMsg = db.prepare('SELECT generation_status, tool_calls FROM messages WHERE id = ?').get(assistantMsg.id) as any;
        
        // Under the NEW stateless architecture:
        // 1. Database status must be updated to waiting_for_permission
        expect(finalDbMsg.generation_status).toBe('waiting_for_permission');
        
        // 2. The tool calls must be safely stored in the database
        const parsedTools = JSON.parse(finalDbMsg.tool_calls || '[]');
        expect(parsedTools.length).toBe(1);
        expect(parsedTools[0].function.name).toBe('test_tool');
        
        // 3. The task in memory should be marked done or aborted because the thread exited
        // Or removed entirely. The thread must NOT be hanging.
        const finalTask = taskManager.getTask(taskId);
        // Depending on implementation, we might just mark the task as done or delete it.
        // Let's assume it should be gracefully finished and removed from active tracking.
        expect(finalTask?.status !== 'streaming').toBe(true);
    });

    it('should prevent race conditions when multiple clients resume permission', async () => {
        // Setup initial message in waiting_for_permission state
        updateMessage(assistantMsg.id, { generation_status: 'waiting_for_permission', tool_calls: '[{"function":{"name":"test_tool"}}]' });

        // Simulate the express endpoint logic concurrently
        const resumeLogic = (decision: string) => {
            return db.transaction(() => {
                const dbMsg = db.prepare('SELECT generation_status FROM messages WHERE id = ?').get(assistantMsg.id) as any;
                if (!dbMsg || dbMsg.generation_status !== 'waiting_for_permission') {
                    return { success: false, reason: 'locked' };
                }

                // Claim it
                updateMessage(assistantMsg.id, { generation_status: 'streaming' });
                return { success: true, decision };
            })();
        };

        // Fire two promises at exactly the same time
        const results = await Promise.all([
            Promise.resolve().then(() => resumeLogic('allow')),
            Promise.resolve().then(() => resumeLogic('deny'))
        ]);

        // Only one should succeed
        const successes = results.filter(r => r.success);
        const failures = results.filter(r => !r.success);

        expect(successes.length).toBe(1);
        expect(failures.length).toBe(1);
        expect(failures[0].reason).toBe('locked');
        
        // Final state in DB must be streaming
        const finalMsg = db.prepare('SELECT generation_status FROM messages WHERE id = ?').get(assistantMsg.id) as any;
        expect(finalMsg.generation_status).toBe('streaming');
    });

    it('should correctly resume and handle denial', async () => {
        // Mock fetch to simulate next completion after tool denial
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            const streamContent = [
                'data: {"id":"chatcmpl-2","choices":[{"delta":{"content":"Okay, tool denied."}}]}\n\n',
                'data: [DONE]\n\n'
            ];
            let index = 0;
            const stream = new ReadableStream({
                start(controller) {
                    function push() {
                        if (index < streamContent.length) {
                            controller.enqueue(new TextEncoder().encode(streamContent[index]));
                            index++;
                            setTimeout(push, 10);
                        } else {
                            controller.close();
                        }
                    }
                    push();
                }
            });
            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        });

        // Set state to waiting_for_permission with a pending tool call
        updateMessage(assistantMsg.id, {
            generation_status: 'waiting_for_permission',
            tool_calls: JSON.stringify([{
                id: 'call_abc',
                type: 'function',
                function: { name: 'test_tool', arguments: '{"arg": 1}' }
            }])
        });

        // Resume stream with denied decision
        const taskId = llamaStream.resumeStream(
            {
                conversationId: convId,
                assistantMessageId: assistantMsg.id,
                requestBody: { messages: [] },
                baseUrl: 'http://mock',
                apiKey: 'mock'
            },
            {
                pendingToolCalls: [{
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'test_tool', arguments: '{"arg": 1}' }
                }],
                denied: true
            }
        );

        // Poll until the next assistant message placeholder is created and generation finishes
        let attempts = 0;
        let nextAssistantMsg: any = null;
        while (attempts < 50) {
            const allMsgs = db.prepare('SELECT * FROM messages WHERE conv_id = ?').all(convId) as any[];
            nextAssistantMsg = allMsgs.find(m => m.parent !== null && m.role === 'assistant' && m.id !== assistantMsg.id);
            if (nextAssistantMsg && nextAssistantMsg.generation_status === 'done') {
                break;
            }
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        expect(nextAssistantMsg).toBeDefined();
        expect(nextAssistantMsg.generation_status).toBe('done');
        expect(nextAssistantMsg.content).toBe('Okay, tool denied.');

        // Verify that the tool result was created and parented correctly
        const toolResultMsg = db.prepare("SELECT * FROM messages WHERE parent = ? AND role = 'tool'").get(assistantMsg.id) as any;
        expect(toolResultMsg).toBeDefined();
        expect(toolResultMsg.content).toContain('Tool execution denied by user');
        
        // Parent of the new assistant message should be the tool result message
        expect(nextAssistantMsg.parent).toBe(toolResultMsg.id);
    });
});

