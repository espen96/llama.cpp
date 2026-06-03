import { db, getDefaultUserId } from './db.js';
import crypto from 'crypto';

// Use any to match the types in the frontend until we share types
export function createConversation(name: string): any {
    const id = crypto.randomUUID();
    const lastModified = Date.now();
    const userId = getDefaultUserId();
    const currNode = '';

    const stmt = db.prepare(`
        INSERT INTO conversations (id, name, last_modified, curr_node, user_id)
        VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, name, lastModified, currNode, userId);
    
    return {
        id,
        name,
        lastModified,
        currNode,
    };
}

export function getAllConversations(): any[] {
    const rows = db.prepare('SELECT * FROM conversations ORDER BY last_modified DESC').all();
    return rows.map(mapConversationRow);
}

export function getConversation(id: string): any {
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) return undefined;
    return mapConversationRow(row);
}

export function updateConversation(id: string, updates: any): void {
    const fields: string[] = [];
    const values: any[] = [];

    const allowedFields: Record<string, string> = {
        name: 'name',
        currNode: 'curr_node',
        forkedFromConversationId: 'forked_from_conversation_id',
        thinkingEnabled: 'thinking_enabled',
        reasoningEffort: 'reasoning_effort',
    };

    for (const [key, dbColumn] of Object.entries(allowedFields)) {
        if (updates[key] !== undefined) {
            fields.push(`${dbColumn} = ?`);
            let val = updates[key];
            if (typeof val === 'boolean') {
                val = val ? 1 : 0;
            }
            values.push(val);
        }
    }

    if (updates.mcpServerOverrides !== undefined) {
        fields.push('mcp_server_overrides = ?');
        values.push(JSON.stringify(updates.mcpServerOverrides));
    }

    // Always update lastModified
    fields.push('last_modified = ?');
    values.push(Date.now());

    if (fields.length === 0) return;

    values.push(id);

    const stmt = db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
}

export function deleteConversation(id: string, options?: { deleteWithForks?: boolean }): void {
    if (options?.deleteWithForks) {
        // Collect all descendant forks to delete
        const idsToDelete: string[] = [];
        const queue = [id];

        while (queue.length > 0) {
            const parentId = queue.shift()!;
            idsToDelete.push(parentId);
            
            const children = db.prepare('SELECT id FROM conversations WHERE forked_from_conversation_id = ?').all(parentId) as {id: string}[];
            for (const child of children) {
                queue.push(child.id);
            }
        }

        const deleteConvStmt = db.prepare('DELETE FROM conversations WHERE id = ?');
        const deleteMsgsStmt = db.prepare('DELETE FROM messages WHERE conv_id = ?');

        const transaction = db.transaction(() => {
            for (const forkId of idsToDelete) {
                deleteMsgsStmt.run(forkId);
                deleteConvStmt.run(forkId);
            }
        });
        transaction();
    } else {
        // Reparent direct children to deleted conv's parent
        const conv = db.prepare('SELECT forked_from_conversation_id FROM conversations WHERE id = ?').get(id) as any;
        const newParent = conv?.forked_from_conversation_id || null;

        const transaction = db.transaction(() => {
            db.prepare('UPDATE conversations SET forked_from_conversation_id = ? WHERE forked_from_conversation_id = ?').run(newParent, id);
            db.prepare('DELETE FROM messages WHERE conv_id = ?').run(id);
            db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        });
        transaction();
    }
}

export function updateCurrentNode(convId: string, nodeId: string): void {
    updateConversation(convId, { currNode: nodeId });
}

export function importConversations(data: { conv: any; messages: any[] }[]): { imported: number; skipped: number } {
    let importedCount = 0;
    let skippedCount = 0;

    const checkConv = db.prepare('SELECT id FROM conversations WHERE id = ?');
    const insertConv = db.prepare(`
        INSERT INTO conversations (id, name, last_modified, curr_node, forked_from_conversation_id, mcp_server_overrides, thinking_enabled, reasoning_effort, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // We will do messages in another module or here. It's easier to just use standard SQL for messages.
    // For now, I'll export a general function that takes message insert dependencies if needed, or handle it here.
    const insertMsg = db.prepare(`
        INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children, tool_calls, tool_call_id, completion_id, reasoning_content, extra, timings, model, generation_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        for (const item of data) {
            const { conv, messages } = item;
            const existing = checkConv.get(conv.id);
            if (existing) {
                skippedCount++;
                continue;
            }

            insertConv.run(
                conv.id,
                conv.name,
                conv.lastModified || Date.now(),
                conv.currNode || '',
                conv.forkedFromConversationId || null,
                conv.mcpServerOverrides ? JSON.stringify(conv.mcpServerOverrides) : null,
                conv.thinkingEnabled ? 1 : 0,
                conv.reasoningEffort || null,
                getDefaultUserId()
            );

            for (const msg of messages) {
                insertMsg.run(
                    msg.id,
                    msg.convId,
                    msg.type,
                    msg.timestamp,
                    msg.role,
                    msg.content || '',
                    msg.parent || null,
                    JSON.stringify(msg.children || []),
                    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
                    msg.toolCallId || null,
                    msg.completionId || null,
                    msg.reasoningContent || null,
                    msg.extra ? JSON.stringify(msg.extra) : null,
                    msg.timings ? JSON.stringify(msg.timings) : null,
                    msg.model || null,
                    msg.generation_status || 'done'
                );
            }
            importedCount++;
        }
    });

    transaction();

    return { imported: importedCount, skipped: skippedCount };
}

export function forkConversation(sourceConvId: string, atMessageId: string, options: { name: string; includeAttachments: boolean }): any {
    const sourceConv = getConversation(sourceConvId);
    if (!sourceConv) throw new Error(`Source conversation ${sourceConvId} not found`);

    const allMessages = db.prepare('SELECT * FROM messages WHERE conv_id = ?').all(sourceConvId) as any[];
    
    // Find path to root
    const pathMessages: any[] = [];
    let currentId: string | null = atMessageId;
    
    while (currentId) {
        const msg = allMessages.find(m => m.id === currentId);
        if (!msg) break;
        pathMessages.push(msg);
        currentId = msg.parent || null;
    }
    
    // Reverse to get root -> leaf order
    pathMessages.reverse();

    if (pathMessages.length === 0 || pathMessages[pathMessages.length - 1].id !== atMessageId) {
        throw new Error(`Could not resolve message path to ${atMessageId}`);
    }

    const idMap = new Map<string, string>();
    for (const msg of pathMessages) {
        idMap.set(msg.id, crypto.randomUUID());
    }

    const newConvId = crypto.randomUUID();
    const clonedMessages = pathMessages.map(row => {
        const newId = idMap.get(row.id)!;
        const newParent = row.parent ? (idMap.get(row.parent) ?? null) : null;
        
        const oldChildren = JSON.parse(row.children || '[]');
        const newChildren = oldChildren
            .filter((childId: string) => idMap.has(childId))
            .map((childId: string) => idMap.get(childId)!);

        return {
            ...row,
            id: newId,
            conv_id: newConvId,
            parent: newParent,
            children: JSON.stringify(newChildren),
            extra: options.includeAttachments ? row.extra : null
        };
    });

    const lastClonedMessage = clonedMessages[clonedMessages.length - 1];
    
    const transaction = db.transaction(() => {
        db.prepare(`
            INSERT INTO conversations (id, name, last_modified, curr_node, forked_from_conversation_id, mcp_server_overrides, thinking_enabled, reasoning_effort, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            newConvId,
            options.name,
            Date.now(),
            lastClonedMessage.id,
            sourceConvId,
            sourceConv.mcpServerOverrides ? JSON.stringify(sourceConv.mcpServerOverrides) : null,
            sourceConv.thinkingEnabled ? 1 : 0,
            sourceConv.reasoningEffort || null,
            getDefaultUserId()
        );

        const insertMsg = db.prepare(`
            INSERT INTO messages (id, conv_id, type, timestamp, role, content, parent, children, tool_calls, tool_call_id, completion_id, reasoning_content, extra, timings, model, generation_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const msg of clonedMessages) {
            insertMsg.run(
                msg.id,
                msg.conv_id,
                msg.type,
                msg.timestamp,
                msg.role,
                msg.content,
                msg.parent,
                msg.children,
                msg.tool_calls,
                msg.tool_call_id,
                msg.completion_id,
                msg.reasoning_content,
                msg.extra,
                msg.timings,
                msg.model,
                msg.generation_status
            );
        }
    });

    transaction();

    return getConversation(newConvId);
}

// Helpers
function mapConversationRow(row: any): any {
    const result: any = {
        id: row.id,
        name: row.name,
        lastModified: row.last_modified,
        currNode: row.curr_node,
    };

    if (row.forked_from_conversation_id) result.forkedFromConversationId = row.forked_from_conversation_id;
    if (row.mcp_server_overrides) result.mcpServerOverrides = JSON.parse(row.mcp_server_overrides);
    if (row.thinking_enabled !== null) result.thinkingEnabled = row.thinking_enabled === 1;
    if (row.reasoning_effort) result.reasoningEffort = row.reasoning_effort;

    return result;
}
