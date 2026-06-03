import { uuid } from '$lib/utils';
import { MessageRole } from '$lib/enums';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types/database';

export class DatabaseService {
    /**
     *
     *
     * Conversations
     *
     *
     */

    static async createConversation(name: string): Promise<DatabaseConversation> {
        const res = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    /**
     *
     *
     * Messages
     *
     *
     */

    static async createMessageBranch(
        message: Omit<DatabaseMessage, 'id' | 'parent'>,
        parentId: string | null
    ): Promise<DatabaseMessage> {
        const res = await fetch('/api/messages/branch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, parentId })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    static async createRootMessage(convId: string): Promise<string> {
        const res = await fetch('/api/messages/root', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ convId })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.id;
    }

    static async createSystemMessage(
        convId: string,
        systemPrompt: string,
        parentId: string
    ): Promise<DatabaseMessage> {
        const res = await fetch('/api/messages/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ convId, systemPrompt, parentId })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    static async deleteConversation(
        id: string,
        options?: { deleteWithForks?: boolean }
    ): Promise<void> {
        const query = options?.deleteWithForks ? '?deleteWithForks=true' : '';
        const res = await fetch(`/api/conversations/${id}${query}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error(await res.text());
    }

    static async deleteMessage(messageId: string): Promise<void> {
        const res = await fetch(`/api/messages/${messageId}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error(await res.text());
    }

    static async deleteMessageCascading(
        conversationId: string,
        messageId: string
    ): Promise<string[]> {
        const res = await fetch(`/api/conversations/${conversationId}/messages/${messageId}/cascading`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.deletedIds;
    }

    static async getAllConversations(): Promise<DatabaseConversation[]> {
        const res = await fetch('/api/conversations');
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    static async getConversation(id: string): Promise<DatabaseConversation | undefined> {
        const res = await fetch(`/api/conversations/${id}`);
        if (res.status === 404) return undefined;
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    static async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
        const res = await fetch(`/api/conversations/${convId}/messages`);
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    static async updateConversation(
        id: string,
        updates: Partial<Omit<DatabaseConversation, 'id'>>
    ): Promise<void> {
        const res = await fetch(`/api/conversations/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        if (!res.ok) throw new Error(await res.text());
    }

    /**
     *
     *
     * Navigation
     *
     *
     */

    static async updateCurrentNode(convId: string, nodeId: string): Promise<void> {
        const res = await fetch(`/api/conversations/${convId}/node`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId })
        });
        if (!res.ok) throw new Error(await res.text());
    }

    static async updateMessage(
        id: string,
        updates: Partial<Omit<DatabaseMessage, 'id'>>
    ): Promise<void> {
        const res = await fetch(`/api/messages/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        if (!res.ok) throw new Error(await res.text());
    }

    static async forkConversation(
        sourceConvId: string,
        atMessageId: string,
        options: { name: string; includeAttachments: boolean }
    ): Promise<DatabaseConversation> {
        const res = await fetch(`/api/conversations/${sourceConvId}/fork`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ atMessageId, options })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    /**
     *
     *
     * Import
     *
     *
     */

    static async importConversations(
        data: { conv: DatabaseConversation; messages: DatabaseMessage[] }[]
    ): Promise<{ imported: number; skipped: number }> {
        const res = await fetch('/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data })
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }
}
