/**
 * pending-continue-requests.ts — Pause/resume continue requests for the backend agentic loop.
 *
 * When the agentic turn limit is reached, llama-stream sends a `continue_request`
 * SSE event to the browser. The browser shows the continue dialog,
 * then POSTs the decision to /api/chat/:taskId/continue.
 * That endpoint calls resolveContinue() here to unblock the waiting task.
 */

import crypto from 'crypto';

interface PendingRequest {
	resolve: (shouldContinue: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** requestId → pending resolver */
const pending = new Map<string, PendingRequest>();

/** Timeout before auto-denyign an unanswered continue request */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a new continue request and wait for a browser response.
 * Resolves with the user's decision, or false on timeout.
 */
export function waitForContinue(requestId: string): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (pending.has(requestId)) {
				pending.delete(requestId);
				console.warn(`[pending-continue] Request ${requestId} timed out, denying`);
				resolve(false);
			}
		}, REQUEST_TIMEOUT_MS);

		pending.set(requestId, { resolve, timer });
	});
}

/**
 * Resolve a pending continue request from the browser's POST.
 * Returns false if the requestId is unknown or already resolved.
 */
export function resolveContinue(requestId: string, shouldContinue: boolean): boolean {
	const req = pending.get(requestId);
	if (!req) return false;

	clearTimeout(req.timer);
	pending.delete(requestId);
	req.resolve(shouldContinue);
	return true;
}

/** Generate a unique ID for a continue request. */
export function newRequestId(): string {
	return crypto.randomUUID();
}
