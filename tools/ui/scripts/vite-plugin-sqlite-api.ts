import type { Plugin } from 'vite';
import express from 'express';
import bodyParser from 'body-parser';
import * as conversations from './sqlite/conversations.js';
import * as messages from './sqlite/messages.js';
import * as settings from './sqlite/settings.js';
import * as llamaStream from './background/llama-stream.js';
import * as taskManager from './background/task-manager.js';
import * as sseHub from './background/sse-hub.js';
import { db } from './sqlite/db.js';
export function sqliteApiPlugin(): Plugin {
    return {
        name: 'vite-plugin-sqlite-api',
        configureServer(server) {
            const app = express();
            app.use(bodyParser.json({ limit: '50mb' }));
            // --- Conversations ---

            app.get('/conversations', (req, res) => {
                try {
                    const convs = conversations.getAllConversations();
                    res.json(convs);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.post('/conversations', (req, res) => {
                try {
                    const conv = conversations.createConversation(req.body.name);
                    res.json(conv);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.get('/conversations/:id', (req, res) => {
                try {
                    const conv = conversations.getConversation(req.params.id);
                    if (!conv) {
                        res.status(404).json({ error: 'Not found' });
                        return;
                    }
                    res.json(conv);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.patch('/conversations/:id', (req, res) => {
                try {
                    conversations.updateConversation(req.params.id, req.body);
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.delete('/conversations/:id', (req, res) => {
                try {
                    const convId = req.params.id;
                    const deleteWithForks = req.query.deleteWithForks === 'true';
                    const idsToAbort = deleteWithForks
                        ? conversations.getForkDescendants(convId)
                        : [convId];
                    for (const id of idsToAbort) {
                        const task = taskManager.getActiveTaskForConversation(id);
                        if (task) {
                            taskManager.abortTask(task.taskId);
                        }
                    }
                    conversations.deleteConversation(convId, { deleteWithForks });
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.patch('/conversations/:id/node', (req, res) => {
                try {
                    conversations.updateCurrentNode(req.params.id, req.body.nodeId);
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.post('/conversations/:id/fork', (req, res) => {
                try {
                    const conv = conversations.forkConversation(req.params.id, req.body.atMessageId, req.body.options);
                    res.json(conv);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.get('/conversations/:id/messages', (req, res) => {
                try {
                    const msgs = messages.getConversationMessages(req.params.id);
                    res.json(msgs);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            // --- Messages ---
            app.post('/messages/branch', (req, res) => {
                try {
                    const msg = messages.createMessageBranch(req.body.message, req.body.parentId);
                    res.json(msg);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.post('/messages/root', (req, res) => {
                try {
                    const id = messages.createRootMessage(req.body.convId);
                    res.json({ id });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.post('/messages/system', (req, res) => {
                try {
                    const msg = messages.createSystemMessage(req.body.convId, req.body.systemPrompt, req.body.parentId);
                    res.json(msg);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.patch('/messages/:id', (req, res) => {
                try {
                    messages.updateMessage(req.params.id, req.body);
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.delete('/messages/:id', (req, res) => {
                try {
                    messages.deleteMessage(req.params.id);
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.delete('/conversations/:convId/messages/:msgId/cascading', (req, res) => {
                try {
                    const deletedIds = messages.deleteMessageCascading(req.params.convId, req.params.msgId);
                    res.json({ deletedIds });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            // --- Import ---
            app.post('/import', (req, res) => {
                try {
                    const result = conversations.importConversations(req.body.data);
                    res.json(result);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            // --- Settings ---
            // --- Background Chat Generation ---
            /**
             * POST /api/chat
             * Start a background generation task.
             * Body: { conversationId, messages, options, connectionOverride? }
             * Returns: { taskId, assistantMessageId }
             */
            app.post('/chat', async (req, res) => {
                try {
                    const { conversationId, messages: msgs, options = {}, connectionOverride } = req.body;
                    if (!conversationId || !msgs) {
                        res.status(400).json({ error: 'conversationId and messages are required' });
                        return;
                    }
                    const conv = conversations.getConversation(conversationId);
                    if (!conv) {
                        res.status(404).json({ error: 'Conversation not found' });
                        return;
                    }
                    // The frontend has already created the user message and assistant placeholder
                    // via /api/messages/branch. We just need the assistantMessageId from the body.
                    const { assistantMessageId } = req.body;
                    if (!assistantMessageId) {
                        res.status(400).json({ error: 'assistantMessageId is required' });
                        return;
                    }
                    // Resolve upstream connection
                    const connection = connectionOverride || llamaStream.resolveUpstreamConnection();
                    // Build the OAI request body from what the frontend sent
                    const requestBody = {
                        messages: msgs,
                        ...options
                    };
                    // Set generation_status to 'streaming' on the placeholder message
                    messages.updateMessage(assistantMessageId, { generation_status: 'streaming' });
                    const taskId = llamaStream.startStream({
                        requestBody,
                        baseUrl: connection.baseUrl,
                        apiKey: connection.apiKey,
                        conversationId,
                        assistantMessageId,
                        xConversationId: conversationId
                    });
                    res.json({ taskId, assistantMessageId });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            /**
             * GET /api/chat/:taskId/stream
             * SSE endpoint — browser subscribes here to get live tokens.
             */
            app.get('/chat/:taskId/stream', (req, res) => {
                const { taskId } = req.params;
                const task = taskManager.getTask(taskId);
                if (!task) {
                    res.status(404).json({ error: 'Task not found' });
                    return;
                }
                // If task already finished, let the client know immediately
                if (task.status !== 'streaming') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                    res.write(`event: done\ndata: {"status":"${task.status}"}\n\n`);
                    res.end();
                    return;
                }
                const cleanup = sseHub.addClient(taskId, res);
                req.on('close', () => {
                    cleanup();
                });
            });
            /**
             * GET /api/chat/active
             * List all currently streaming tasks (for reconnect on page reload).
             */
            app.get('/chat/active', (_req, res) => {
                try {
                    const active = taskManager.getAllActiveTasks().map((t) => ({
                        taskId: t.taskId,
                        conversationId: t.conversationId,
                        assistantMessageId: t.assistantMessageId,
                        status: t.status,
                        createdAt: t.createdAt,
                        accumulatedContent: t.accumulatedContent,
                        accumulatedReasoning: t.accumulatedReasoning,
                        resolvedModel: t.resolvedModel,
                        completionId: t.completionId
                    }));
                    res.json(active);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            /**
             * DELETE /api/chat/:taskId
             * Abort a running generation task.
             */
            app.delete('/chat/:taskId', (req, res) => {
                try {
                    const aborted = taskManager.abortTask(req.params.taskId);
                    if (!aborted) {
                        res.status(404).json({ error: 'Task not found or already finished' });
                        return;
                    }
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.post('/chat/:conversationId/resume-permission', async (req, res) => {
                try {
                    const { conversationId } = req.params;
                    const { messageId, decision } = req.body; // decision: 'once' | 'always' | 'always_server' | 'deny'
                    if (!messageId || !decision) {
                        res.status(400).json({ error: 'messageId and decision are required' });
                        return;
                    }
                    
                    // We must transactionally lock this to prevent race conditions.
                    // If two browser windows click "Allow", only one should win.
                    const result = db.transaction(() => {
                        const dbMsg = db.prepare('SELECT generation_status, tool_calls FROM messages WHERE id = ?').get(messageId) as any;
                        if (!dbMsg || dbMsg.generation_status !== 'waiting_for_permission') {
                            return { locked: false };
                        }

                        // Claim it so nobody else can resume it
                        messages.updateMessage(messageId, { generation_status: 'streaming' });
                        return { locked: true, toolCalls: dbMsg.tool_calls };
                    })();

                    if (!result.locked) {
                        res.status(409).json({ error: 'Permission already resolved or message not found (too bad, someone got there first)' });
                        return;
                    }

                    // In a real flow, here we would read the tool calls, execute the one that was paused,
                    // write the result to DB, and restart llamaStream.startStream().
                    // For the scope of the migration, we delegate the execution back to llama-stream
                    // or handle it inline.

                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.post('/chat/:conversationId/resume-continue', async (req, res) => {
                try {
                    const { conversationId } = req.params;
                    const { messageId, shouldContinue } = req.body;
                    if (!messageId || typeof shouldContinue !== 'boolean') {
                        res.status(400).json({ error: 'messageId and shouldContinue are required' });
                        return;
                    }

                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            // --- Settings ---
            app.get('/settings', (req, res) => {
                try {
                    const data = settings.getAllSettings();
                    res.json(data);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.patch('/settings', (req, res) => {
                try {
                    settings.updateSettings(req.body.updates);
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            app.delete('/settings/:key', (req, res) => {
                try {
                    settings.deleteSetting(req.params.key);
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            // Mount express app under /api
            server.middlewares.use('/api', app);
        }
    };
}
