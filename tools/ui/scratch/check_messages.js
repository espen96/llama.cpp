import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), '.data/llama-ui.sqlite3');
const db = new Database(dbPath);

const conversationId = '5fe8e772-7ea2-4daa-a524-ba7373b1bb20';
const messages = db.prepare('SELECT id, role, content, tool_calls, reasoning_content FROM messages WHERE conv_id = ? ORDER BY timestamp ASC').all(conversationId);

console.log('Messages detail:');
for (const msg of messages) {
    console.log(`ID: ${msg.id} | Role: ${msg.role}`);
    if (msg.content) console.log(`  Content: ${msg.content.slice(0, 100)}`);
    if (msg.tool_calls) console.log(`  Tool Calls: ${msg.tool_calls}`);
    if (msg.reasoning_content) console.log(`  Reasoning: ${msg.reasoning_content.slice(0, 100)}`);
}
