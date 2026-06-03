import type { Plugin } from 'vite';
import express from 'express';
import bodyParser from 'body-parser';
import * as conversations from './sqlite/conversations.js';
import * as messages from './sqlite/messages.js';
import * as settings from './sqlite/settings.js';

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
                    conversations.deleteConversation(req.params.id, { deleteWithForks: req.query.deleteWithForks === 'true' });
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
