# AGENTS.md — llama.cpp UI (Backend-Architecture)

## What This Is

This is the llama.cpp web UI, **repurposed** with a new server-side backend. The original code was written to run entirely in the browser — the frontend talked directly to llama.cpp's HTTP API, and all state (settings, chat history, tool permissions) lived in browser localStorage/IndexedDB.

We are changing that. The backend now owns everything.

## Core Principle: Backend Is In Charge

The backend (Node/Bun server, SQLite database) is the single source of truth. The frontend is a rendering layer — it mirrors what the backend says, and sends user interactions back.

- **Settings**: Stored in SQLite. Frontend reads from and writes to the backend API. Never assume localStorage is authoritative.
- **Chat history**: Stored in SQLite. Frontend receives messages via the database API, not from local storage.
- **Tool execution**: Owned by the backend agentic loop (`llama-stream.ts`). The frontend does not call llama.cpp directly.
- **Tool permissions**: Managed server-side via `pending-permissions.ts`. Frontend shows the dialog; backend decides whether to proceed.
- **Agentic loop**: Runs entirely in the backend. The frontend frontend loop code in `agentic.svelte.ts` is **dead code** — kept for reference but never executed.

## What to Expect When Reading Frontend Code

The frontend was not written for this architecture. You will encounter:

- Code that assumes the browser talks directly to llama.cpp's `/v1/chat/completions`
- localStorage/IndexedDB reads that bypass the backend entirely
- Frontend agentic loop logic that duplicates what the backend now does
- References to "the frontend owns the connection" or "the backend is just a proxy"

**Do not trust these assumptions.** When you see code that talks directly to llama.cpp or reads from localStorage, check whether it should instead be going through the backend API.

## Upstream Policy

We try to leverage upstream llama.cpp additions when possible. They generally know best.

- Do not rewrite things just because you can. If upstream did something, assume it was deliberate.
- Avoid forking or diverging from upstream unless there is a clear reason.
- When merging upstream changes, prefer adapting our code over overriding theirs.

## Deprecation Strategy

When moving logic from frontend to backend:

1. **Comment out the dead code** with `/** @deprecated Now handled by backend: <file> */` markers.
2. **Do not delete it.** The comments make it easier to stay in sync with upstream — fewer merge conflicts, and the old code serves as reference for what the frontend once did.
3. **Leave the imports in place** (with the deprecation comment) so upstream changes to those modules don't break our imports silently.
4. **The code should be unreachable**, not removed. If it's unreachable, it costs nothing and keeps the diff against upstream small.

## File Layout

```
scripts/
  background/           # Backend (Node/Bun)
    llama-stream.ts     # Main agentic loop — owns the upstream connection
    task-manager.ts     # In-memory task registry
    tool-executor.ts    # Builtin + MCP tool execution
    pending-permissions.ts  # Permission request/resume (in-memory)
    pending-continue-requests.ts  # Continue request/resume (in-memory)
    mcp-session-manager.ts
    sse-hub.ts          # SSE broadcast to browser clients
  vite-plugin-sqlite-api.ts  # Express API routes

src/lib/
  stores/               # Svelte stores (frontend state)
    agentic.svelte.ts   # Agentic state — frontend loop is DEAD CODE
    chat.svelte.ts      # Chat state — feeds backend events to UI
  services/
    chat-api.service.ts # SSE client + API calls
  components/           # UI components
```

## Key Files to Understand

| File | Role |
|------|------|
| `scripts/background/llama-stream.ts` | **The agentic loop.** Fetches upstream, detects tool calls, executes them, manages turns. |
| `scripts/background/task-manager.ts` | Task registry. Tasks are in-memory; lost on server restart. |
| `scripts/background/pending-permissions.ts` | Pauses the agentic loop when a tool needs user approval. |
| `scripts/background/pending-continue-requests.ts` | Pauses the agentic loop when turn limit is reached. |
| `src/lib/stores/agentic.svelte.ts` | Frontend agentic state. The `executeAgenticLoop` method is dead code. |
| `src/lib/stores/chat.svelte.ts` | Bridges backend SSE events to the UI. |
| `src/lib/services/chat-api.service.ts` | SSE client, `startBackgroundChat`, `reconnectBackgroundChat`. |
