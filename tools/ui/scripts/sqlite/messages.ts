import { db } from './db.js';
import crypto from 'crypto';
import { updateConversation } from './conversations.js';

export function createMessageBranch(message: any, parentId: string | null): any {
    const newMessage = {
        ...message,
        id: crypto.randomUUID(),
        parent: parentId,
        toolCalls: message.toolCalls ?? '',
        children: []
    };

    const insertMsg = db.prepare(`
        INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children, tool_calls, tool_call_id, completion_id, reasoning_content, extra, timings, model, generation_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        if (parentId !== null) {
            const parent = db.prepare('SELECT children FROM messages WHERE id = ?').get(parentId) as any;
            if (!parent) throw new Error(`Parent message ${parentId} not found`);
            const children = JSON.parse(parent.children);
            children.push(newMessage.id);
            db.prepare('UPDATE messages SET children = ? WHERE id = ?').run(JSON.stringify(children), parentId);
        }

        insertMsg.run(
            newMessage.id,
            newMessage.convId,
            newMessage.type,
            newMessage.timestamp,
            newMessage.role,
            newMessage.content || '',
            newMessage.parent || null,
            JSON.stringify(newMessage.children),
            typeof newMessage.toolCalls === 'string' ? newMessage.toolCalls : (newMessage.toolCalls ? JSON.stringify(newMessage.toolCalls) : null),
            newMessage.toolCallId || null,
            newMessage.completionId || null,
            newMessage.reasoningContent || null,
            newMessage.extra ? JSON.stringify(newMessage.extra) : null,
            newMessage.timings ? JSON.stringify(newMessage.timings) : null,
            newMessage.model || null,
            newMessage.generation_status || 'done'
        );

        updateConversation(newMessage.convId, { currNode: newMessage.id });
    });

    transaction();

    return newMessage;
}

export function createRootMessage(convId: string): string {
    const id = crypto.randomUUID();
    const timestamp = Date.now();

    db.prepare(`
        INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, convId, 'root', timestamp, 'system', '', null, '[]');

    return id;
}

export function createSystemMessage(convId: string, systemPrompt: string, parentId: string): any {
    const trimmedPrompt = systemPrompt.trim();
    if (!trimmedPrompt) {
        throw new Error('Cannot create system message with empty content');
    }

    const id = crypto.randomUUID();
    const timestamp = Date.now();

    const transaction = db.transaction(() => {
        db.prepare(`
            INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, convId, 'system', timestamp, 'system', trimmedPrompt, parentId, '[]');

        const parent = db.prepare('SELECT children FROM messages WHERE id = ?').get(parentId) as any;
        if (parent) {
            const children = JSON.parse(parent.children);
            children.push(id);
            db.prepare('UPDATE messages SET children = ? WHERE id = ?').run(JSON.stringify(children), parentId);
        }
    });

    transaction();

    return {
        id,
        convId,
        type: 'system',
        timestamp,
        role: 'system',
        content: trimmedPrompt,
        parent: parentId,
        children: []
    };
}

/**
 * Create a tool result message (role: "tool") in the database.
 * Called by the backend agentic loop after executing a tool call.
 *
 * @param convId - Conversation ID
 * @param toolCallId - The tool_call_id that this result answers
 * @param content - Text content of the result
 * @param parentId - ID of the assistant message that made the tool call
 * @returns The new message object
 */
export function createToolResultMessage(
    convId: string,
    toolCallId: string,
    content: string,
    parentId: string
): any {
    const id = crypto.randomUUID();
    const timestamp = Date.now();

    const transaction = db.transaction(() => {
        db.prepare(`
            INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children, tool_call_id, generation_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, convId, 'tool', timestamp, 'tool', content, parentId, '[]', toolCallId, 'done');

        // Add this message as a child of the parent (assistant) message
        const parent = db.prepare('SELECT children FROM messages WHERE id = ?').get(parentId) as any;
        if (parent) {
            const children = JSON.parse(parent.children || '[]');
            children.push(id);
            db.prepare('UPDATE messages SET children = ? WHERE id = ?').run(JSON.stringify(children), parentId);
        }

        updateConversation(convId, { currNode: id });
    });

    transaction();

    return { id, convId, type: 'tool', timestamp, role: 'tool', content, parent: parentId, children: [], toolCallId };
}

/**
 * Create an assistant message placeholder for a subsequent agentic turn.
 * Used by the backend agentic loop when starting a new LLM turn.
 *
 * @param convId - Conversation ID
 * @param parentId - ID of the last tool result message (parent in the tree)
 * @param id - Pre-generated UUID to use for this message
 * @returns The new message row id
 */
export function createAssistantMessagePlaceholder(
    convId: string,
    parentId: string,
    id: string
): string {
    const timestamp = Date.now();

    const transaction = db.transaction(() => {
        db.prepare(`
            INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children, generation_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, convId, 'normal', timestamp, 'assistant', '', parentId, '[]', 'streaming');

        const parent = db.prepare('SELECT children FROM messages WHERE id = ?').get(parentId) as any;
        if (parent) {
            const children = JSON.parse(parent.children || '[]');
            children.push(id);
            db.prepare('UPDATE messages SET children = ? WHERE id = ?').run(JSON.stringify(children), parentId);
        }

        updateConversation(convId, { currNode: id });
    });

    transaction();
    return id;
}

export function deleteMessage(messageId: string): void {
    const transaction = db.transaction(() => {
        const message = db.prepare('SELECT parent FROM messages WHERE id = ?').get(messageId) as any;
        if (!message) return;

        if (message.parent) {
            const parent = db.prepare('SELECT children FROM messages WHERE id = ?').get(message.parent) as any;
            if (parent) {
                const children = JSON.parse(parent.children).filter((childId: string) => childId !== messageId);
                db.prepare('UPDATE messages SET children = ? WHERE id = ?').run(JSON.stringify(children), message.parent);
            }
        }

        db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    });

    transaction();
}

function getDescendants(allMessages: any[], messageId: string): string[] {
    const descendants: string[] = [];
    const queue = [messageId];
    
    // Quick lookup map for children
    const childMap = new Map<string, string[]>();
    for (const msg of allMessages) {
        if (msg.parent) {
            const arr = childMap.get(msg.parent) || [];
            arr.push(msg.id);
            childMap.set(msg.parent, arr);
        }
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        const children = childMap.get(current) || [];
        for (const child of children) {
            descendants.push(child);
            queue.push(child);
        }
    }
    
    return descendants;
}

export function deleteMessageCascading(conversationId: string, messageId: string): string[] {
    let allToDelete: string[] = [];
    
    const transaction = db.transaction(() => {
        const allMessages = db.prepare('SELECT id, parent FROM messages WHERE conv_id = ?').all(conversationId) as any[];
        
        const descendants = getDescendants(allMessages, messageId);
        allToDelete = [messageId, ...descendants];

        const message = db.prepare('SELECT parent FROM messages WHERE id = ?').get(messageId) as any;
        if (message && message.parent) {
            const parent = db.prepare('SELECT children FROM messages WHERE id = ?').get(message.parent) as any;
            if (parent) {
                const children = JSON.parse(parent.children).filter((childId: string) => childId !== messageId);
                db.prepare('UPDATE messages SET children = ? WHERE id = ?').run(JSON.stringify(children), message.parent);
            }
        }

        const deleteStmt = db.prepare('DELETE FROM messages WHERE id = ?');
        for (const id of allToDelete) {
            deleteStmt.run(id);
        }
    });

    transaction();
    return allToDelete;
}

export function getConversationMessages(convId: string): any[] {
    const rows = db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY timestamp ASC').all(convId);
    return rows.map(mapMessageRow);
}

export function updateMessage(id: string, updates: any): void {
    const fields: string[] = [];
    const values: any[] = [];

    const simpleFields: Record<string, string> = {
        type: 'type',
        timestamp: 'timestamp',
        role: 'role',
        content: 'content',
        parent: 'parent',
        toolCallId: 'tool_call_id',
        completionId: 'completion_id',
        reasoningContent: 'reasoning_content',
        model: 'model',
        generation_status: 'generation_status',
    };

    for (const [key, dbColumn] of Object.entries(simpleFields)) {
        if (updates[key] !== undefined) {
            fields.push(`${dbColumn} = ?`);
            values.push(updates[key]);
        }
    }

    const jsonFields: Record<string, string> = {
        children: 'children',
        extra: 'extra',
        timings: 'timings',
    };

    for (const [key, dbColumn] of Object.entries(jsonFields)) {
        if (updates[key] !== undefined) {
            fields.push(`${dbColumn} = ?`);
            values.push(JSON.stringify(updates[key]));
        }
    }

    // toolCalls can be string or object
    if (updates.toolCalls !== undefined) {
        fields.push('tool_calls = ?');
        values.push(typeof updates.toolCalls === 'string' ? updates.toolCalls : JSON.stringify(updates.toolCalls));
    }

    if (fields.length === 0) return;

    values.push(id);

    const stmt = db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
}

// Helpers
function mapMessageRow(row: any): any {
    const result: any = {
        id: row.id,
        convId: row.conv_id,
        type: row.type,
        timestamp: row.timestamp,
        role: row.role,
        content: row.content,
        parent: row.parent,
        children: JSON.parse(row.children || '[]'),
    };

    if (row.tool_calls) {
        try {
            result.toolCalls = JSON.parse(row.tool_calls);
        } catch {
            result.toolCalls = row.tool_calls;
        }
    } else if (row.tool_calls === '') {
        result.toolCalls = '';
    }
    
    if (row.tool_call_id) result.toolCallId = row.tool_call_id;
    if (row.completion_id) result.completionId = row.completion_id;
    if (row.reasoning_content) result.reasoningContent = row.reasoning_content;
    if (row.extra) result.extra = JSON.parse(row.extra);
    if (row.timings) result.timings = JSON.parse(row.timings);
    if (row.model) result.model = row.model;
    if (row.generation_status) result.generation_status = row.generation_status;

    return result;
}

export function getActiveMessagePath(convId: string, leafNodeId: string): any[] {
    const messages = getConversationMessages(convId);
    const nodeMap = new Map<string, any>();
    for (const msg of messages) {
        nodeMap.set(msg.id, msg);
    }

    let startNode = nodeMap.get(leafNodeId);
    if (!startNode) {
        let latestTime = -1;
        for (const msg of messages) {
            if (msg.timestamp > latestTime) {
                startNode = msg;
                latestTime = msg.timestamp;
            }
        }
    }

    const result: any[] = [];
    let currentNode = startNode;
    while (currentNode) {
        if (currentNode.type !== 'root') {
            result.push(currentNode);
        }
        if (currentNode.parent === null) {
            break;
        }
        currentNode = nodeMap.get(currentNode.parent);
    }

    result.sort((a, b) => {
        if (a.role === 'system' && b.role !== 'system') return -1;
        if (a.role !== 'system' && b.role === 'system') return 1;
        return a.timestamp - b.timestamp;
    });

    return result;
}
