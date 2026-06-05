# Stateless Architecture Migration Plan: Achieving the "Zen" State

This document serves as a comprehensive breakdown and technical blueprint for migrating the current stateful `llama.cpp` UI backend to a fully stateless, turn-based architecture.

## 1. The Core Issue: The "Stateful" Hang

The project recently moved the agentic loop (tool calling, generation, permissions) from the frontend Svelte store to the Node/Bun backend. However, **the browser's execution pattern was copied over verbatim**. 

In a browser, it's normal to suspend an `async` function, show a modal, wait for the user to click "Allow", and then resolve the promise to resume execution. On the backend, doing this means:
- The `runAgenticLoop` (in `llama-stream.ts`) halts midway through execution (`await pendingPermissions.waitForPermission(...)`).
- The async thread stays alive, holding memory, MCP connections, and SSE streams open.
- When the user clicks **STOP**, the frontend sends an abort signal. The backend marks the task as aborted, **but the suspended Promise has no way of knowing this**. The thread remains hanging, leaking resources, and creating a "Zombie" execution that might randomly resume if the permission timeout fires.
- Reconnecting to a session requires complicated in-memory registries (`task-manager.ts`) and replaying events.

## 2. The "Zen" Stateless Principle

The backend should be a simple orchestrator where the **SQLite Database is the absolute single source of truth**. 

If the backend hits a point where it needs user input (e.g., tool permission or turn limit continuation):
1. It updates the database with the current state (e.g., `generation_status = 'waiting_for_permission'`).
2. It sends the frontend a notification.
3. **It immediately terminates the execution context.**

The backend becomes completely idle. There are no pending promises, no in-memory tasks, and no hanging sockets. 

When the user clicks "Allow" or "Stop", the frontend is simply triggering a new, short-lived backend invocation that reconstructs what to do next by reading the database.

---

## 3. Stateful vs. Stateless Comparison

| Feature | Current Stateful Model | Proposed Stateless Zen Model |
| :--- | :--- | :--- |
| **Active State** | High. Holds active task loops, promises, and SSE connections open during user prompts. | **None.** The backend is entirely idle when waiting for the user. |
| **Waiting for Permission** | Thread suspends at `await waitForPermission()`. | Thread saves `waiting_for_permission` to DB, closes SSE stream, and exits cleanly. |
| **Stopping / Aborting** | Fails to cancel suspended promises. Creates zombie executions. | Trivial. Update DB to `'aborted'`. (No thread exists to abort if it was waiting). |
| **Page Reload / Reconnect**| Highly complex. Client must fetch active tasks, reconnect, and server replays events. | Trivial. Frontend reads DB on load. If status is `waiting_for_permission`, render the prompt. |
| **Memory / CPU Leaks** | High risk due to orphaned promises and timeout fallbacks. | **Zero risk.** Every backend task has a definitive, immediate end. |

---

## 4. Execution Plan: How to Implement the Migration

When work resumes, these are the exact architectural steps to execute:

### Phase 1: Clean House (Delete In-Memory Registries)
The first step is removing the complex in-memory state tracking that is no longer needed.
- **Delete** `scripts/background/pending-permissions.ts`
- **Delete** `scripts/background/pending-continue-requests.ts`
- **Delete / Gut** `scripts/background/task-manager.ts` (We only need a very lightweight way to abort an *actively streaming* LLM fetch, not long-lived task states).

### Phase 2: Define SQLite State Transitions
Utilize the `generation_status` field in the `messages` SQLite table as the definitive state engine.
- `'streaming'`: LLM is generating.
- `'waiting_for_permission'`: Generation paused; user must approve a tool call.
- `'waiting_for_continue'`: Turn limit reached; user must approve continuation.
- `'done'` / `'error'` / `'aborted'`: Terminal states.

When writing tool calls to the database during a stream, ensure the JSON stringified arguments are complete so they can be picked up safely in the next phase.

### Phase 3: Segment `llama-stream.ts`
Refactor the giant `runAgenticLoop` into a function that handles **exactly one execution turn** and then exits.
- **Run Completion**: Fetch `/v1/chat/completions`. Stream tokens.
- **Evaluate Tool Calls**: 
  - If tools are pre-authorized, execute them, write the results, and automatically invoke the next LLM turn.
  - If any tool requires permission, update the SQLite message to `'waiting_for_permission'`, send the SSE notification, **and `return` (exit the function completely).**

### Phase 4: Create Stateless Resume APIs
In `scripts/vite-plugin-sqlite-api.ts`, add endpoints that handle the user's decision and spawn a new, short-lived task.

**Example `POST /api/chat/resume-permission`**:
1. Frontend sends `{ conversationId, decision: 'once' }`.
2. Backend queries the latest message for that conversation. Verifies `generation_status === 'waiting_for_permission'`.
3. Reads the pending tool call arguments directly from the SQLite message.
4. If approved, executes the tool, writes the tool result to the DB, and launches a fresh `llamaStream` invocation to get the LLM's next response.
5. If denied, writes "Tool execution denied" as the tool result, and launches the next LLM response.

### Phase 5: Simplify Frontend Stores (`chat.svelte.ts`)
Remove the complex `onPermissionRequest` callbacks that hold open network requests.
- The UI simply watches the database state. If the active message is `'waiting_for_permission'`, it shows the modal.
- When the user clicks "Allow", it sends a standard POST request to the new resume API, and attaches to the new SSE stream.

---

## Conclusion
By adopting this Stateless Zen architecture, the backend becomes a robust, fault-tolerant state machine. Hanging promises are eliminated, page reloads are natively supported without complex sync logic, and the "Stop" button becomes 100% reliable.
