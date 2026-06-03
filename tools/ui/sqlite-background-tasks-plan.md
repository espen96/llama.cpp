# SQLite and Background Task Architecture Plan

## 1. Goal and Overview
The goal is to transition the `llama-ui` from a purely client-side state architecture (using IndexedDB/Dexie) to a client-server architecture with a persistent SQLite database. This will allow LLM generations to run in the background on the server, ensuring that if the client disconnects (e.g., closing the laptop or phone), the LLM task continues, and the client can resume exactly where it left off upon reconnecting. It also introduces the concept of a `User` to scope chat history.

## 2. Architectural Shift
Currently, the UI is a static SPA (`@sveltejs/adapter-static`) that stores state in IndexedDB and calls the `llama.cpp` `/v1/` endpoints directly. 

To achieve background execution and persistence, we need a **Node.js Middle Tier**. There are two paths to achieve this in this repository:
1. **SvelteKit Fullstack (`@sveltejs/adapter-node`)**: We switch from `adapter-static` to `adapter-node`. This converts the Svelte app into a Node.js server. Database logic and background tasks run in `src/routes/api/...`.
2. **Standalone Node Server**: We keep the Svelte app static, but build a separate Node/Express backend in a new folder (e.g., `server/`). We use Vite's proxy to route `/api` requests to this new backend during development.

**Recommendation:** If you plan to exclusively run this via Node (`npm run dev` or `npm start`), using `@sveltejs/adapter-node` is the most idiomatic and seamless for SvelteKit.

## 3. Phase 1: Database Setup (SQLite)
We will introduce `better-sqlite3` and optionally an ORM like `drizzle-orm` for type safety.

### Initial Schema
- **Users**: `id`, `username` (defaulting to "admin").
- **Conversations**: `id`, `userId`, `name`, `lastModified`, `currNode`, `forkedFromId`.
- **Messages**: `id`, `convId`, `type`, `role`, `content`, `parentId`, `children` (JSON array or parent-child relations), `toolCalls`.

## 4. Phase 2: Background Task Orchestration & Single Source of Truth
Instead of the browser talking directly to `llama.cpp` and managing state, the UI becomes a "dumb" client. The Node.js middle-tier becomes the **single source of truth** for all conversations, preventing any desyncs between the UI and backend (like ghost messages or lost attachments).

1. **Client Request**: User types a prompt. Client sends `POST /api/chat` with `{ convId, content, attachments }`.
2. **Server Initialization**: 
   - Server saves the user message to SQLite immediately.
   - Server creates a placeholder assistant message in SQLite.
   - Server starts an asynchronous fetch request to the `llama.cpp` backend (`localhost:8080/v1/chat/completions`).
3. **Background Execution & Throttled DB Writes**: 
   - The server reads the stream from `llama.cpp`. 
   - **Throttling writes:** Writing every token to SQLite instantly would cause hundreds of writes per second per user. Instead, the server keeps the accumulating text in memory and syncs to SQLite on an interval (e.g., once every 1 or 2 seconds) and once more when the generation completes.
   - **Crucially**, if the HTTP request from the client to the Node server drops, the Node server does *not* abort the `llama.cpp` fetch. It finishes the generation and saves the final state to SQLite.
4. **Client Updates (SSE / WebSockets)**:
   - The client subscribes to real-time updates via Server-Sent Events (SSE) at `GET /api/conversations/:id/stream`.
   - The server streams tokens instantly to the UI over SSE as they arrive from `llama.cpp` (unthrottled), so the UI feels perfectly responsive.
   - When the client connects, it gets the latest state of the message from the DB. If it's still generating, it instantly receives new tokens via the SSE stream.

## 5. Phase 3: Client-Side Refactoring
1. **Remove Dexie**: Rip out the Dexie implementation in `src/lib/services/database.service.ts`.
2. **API Service**: Replace it with a robust API client that fetches from `/api/conversations` and `/api/messages`.
3. **Streaming Logic**: Refactor the chat screen so that instead of managing the Llama stream reading itself, it delegates to the SSE stream from the Node middle-tier.
4. **State Hydration**: When the UI loads, it fetches the "admin" user's active conversations. If a conversation was left mid-generation, the UI immediately displays the text generated so far and attaches to the SSE stream to see the rest.

## 6. Action Items to Start
- [ ] Install SQLite dependencies (`better-sqlite3`).
- [ ] Determine backend strategy (`adapter-node` vs `Express` server).
- [ ] Create the SQLite schema and initialization scripts.
- [ ] Port the `DatabaseService` methods to backend API routes.
- [ ] Write the background orchestration logic for `llama.cpp` streaming.
