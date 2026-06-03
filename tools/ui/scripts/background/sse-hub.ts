/**
 * sse-hub.ts — Per-task SSE client registry
 *
 * Each active generation task has a set of connected SSE response objects.
 * When the llama-stream module produces a chunk, it calls `broadcast()`.
 * Clients connect via GET /api/chat/:taskId/stream and are registered here.
 */

import type { Response } from 'express';

interface SseClient {
    res: Response;
    id: string;
}

// taskId → set of connected SSE clients
const clients = new Map<string, Set<SseClient>>();

/**
 * Register a new SSE client for a given task.
 * Sends standard SSE headers and returns a cleanup function.
 */
export function addClient(taskId: string, res: Response): () => void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // disable nginx buffering if present
    });
    res.flushHeaders();

    const clientId = Math.random().toString(36).slice(2);
    const client: SseClient = { res, id: clientId };

    if (!clients.has(taskId)) {
        clients.set(taskId, new Set());
    }
    clients.get(taskId)!.add(client);

    // Heartbeat to keep the connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch {
            clearInterval(heartbeat);
        }
    }, 15_000);

    const cleanup = () => {
        clearInterval(heartbeat);
        removeClient(taskId, client);
    };

    // Catch unhandled stream errors which could crash the Node server
    res.on('error', cleanup);
    res.on('close', cleanup);

    return cleanup;
}

function removeClient(taskId: string, client: SseClient): void {
    const taskClients = clients.get(taskId);
    if (taskClients) {
        taskClients.delete(client);
        if (taskClients.size === 0) {
            clients.delete(taskId);
        }
    }
}

/**
 * Broadcast a raw SSE event string to all clients of a task.
 * Callers are responsible for formatting (data:...\n\n).
 */
export function broadcast(taskId: string, data: string): void {
    const taskClients = clients.get(taskId);
    if (!taskClients || taskClients.size === 0) return;

    const dead: SseClient[] = [];
    for (const client of taskClients) {
        try {
            client.res.write(data);
        } catch {
            dead.push(client);
        }
    }
    for (const d of dead) {
        removeClient(taskId, d);
    }
}

/**
 * Send a typed event to all clients of a task.
 */
export function send(taskId: string, event: string, payload: unknown): void {
    broadcast(taskId, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Close all SSE connections for a task (called on task completion/error).
 */
export function closeTask(taskId: string): void {
    const taskClients = clients.get(taskId);
    if (!taskClients) return;
    for (const client of taskClients) {
        try {
            // Send a final done event so the client knows to close
            client.res.write('event: done\ndata: {}\n\n');
            client.res.end();
        } catch {
            // Connection already dead
        }
    }
    clients.delete(taskId);
}

/** Count connected clients for a task (debug/monitoring). */
export function clientCount(taskId: string): number {
    return clients.get(taskId)?.size ?? 0;
}
