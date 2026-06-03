import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const dbPath = path.resolve(process.cwd(), '.data/llama-ui.sqlite3');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');
// Enforce foreign key constraints
db.pragma('foreign_keys = ON');

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id         TEXT PRIMARY KEY,
            username   TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id),
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id                          TEXT PRIMARY KEY,
            name                        TEXT NOT NULL,
            last_modified               INTEGER NOT NULL,
            curr_node                   TEXT,
            forked_from_conversation_id TEXT,
            mcp_server_overrides        TEXT,
            thinking_enabled            INTEGER,
            reasoning_effort            TEXT,
            user_id                     TEXT REFERENCES users(id),
            project_id                  TEXT REFERENCES projects(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id                TEXT PRIMARY KEY,
            conv_id           TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            type              TEXT NOT NULL,
            timestamp         INTEGER NOT NULL,
            role              TEXT NOT NULL,
            content           TEXT NOT NULL DEFAULT '',
            parent            TEXT,
            children          TEXT NOT NULL DEFAULT '[]',
            tool_calls        TEXT,
            tool_call_id      TEXT,
            completion_id     TEXT,
            reasoning_content TEXT,
            extra             TEXT,
            timings           TEXT,
            model             TEXT,
            generation_status TEXT DEFAULT 'done'
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conv_id         ON messages(conv_id);
        CREATE INDEX IF NOT EXISTS idx_conv_user               ON conversations(user_id);
        CREATE INDEX IF NOT EXISTS idx_conv_project            ON conversations(project_id);
        CREATE INDEX IF NOT EXISTS idx_conv_last_modified      ON conversations(last_modified DESC);
    `);

    // Ensure default user exists
    const defaultUser = db.prepare('SELECT id FROM users WHERE username = ?').get('default') as { id: string } | undefined;
    if (!defaultUser) {
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run(id, 'default', Date.now());
    }
}

initDb();

export function getDefaultUserId(): string {
    const defaultUser = db.prepare('SELECT id FROM users WHERE username = ?').get('default') as { id: string };
    return defaultUser.id;
}
