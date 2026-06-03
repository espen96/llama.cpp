/**
 * pending-permissions.ts — Pause/resume permission requests for the backend agentic loop.
 *
 * When a tool requires user approval, llama-stream sends a `permission_request`
 * SSE event to the browser. The browser shows the existing permission dialog,
 * then POSTs the decision to /api/chat/:taskId/permission.
 * That endpoint calls resolvePermission() here to unblock the waiting task.
 */

import crypto from 'crypto';

export type PermissionDecision = 'once' | 'always' | 'always_server' | 'deny';

interface PendingRequest {
    resolve: (decision: PermissionDecision) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** requestId → pending resolver */
const pending = new Map<string, PendingRequest>();

/** Timeout before auto-denying an unanswered permission request */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a new permission request and wait for a browser response.
 * Resolves with the user's decision, or 'deny' on timeout.
 */
export function waitForPermission(requestId: string): Promise<PermissionDecision> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (pending.has(requestId)) {
                pending.delete(requestId);
                console.warn(`[pending-permissions] Request ${requestId} timed out, denying`);
                resolve('deny');
            }
        }, REQUEST_TIMEOUT_MS);

        pending.set(requestId, { resolve, timer });
    });
}

/**
 * Resolve a pending permission request from the browser's POST.
 * Returns false if the requestId is unknown or already resolved.
 */
export function resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const req = pending.get(requestId);
    if (!req) return false;

    clearTimeout(req.timer);
    pending.delete(requestId);
    req.resolve(decision);
    return true;
}

/** Generate a unique ID for a permission request. */
export function newRequestId(): string {
    return crypto.randomUUID();
}
