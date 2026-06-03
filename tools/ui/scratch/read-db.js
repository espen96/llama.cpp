import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), '.data/llama-ui.sqlite3');
const db = new Database(dbPath);

console.log('Querying settings...');
const rows = db.prepare('SELECT key, value FROM user_settings').all();
for (const row of rows) {
    if (row.key.includes('connection') || row.key.includes('alwaysAllowedTools') || row.key.includes('config')) {
        console.log(`Key: ${row.key}`);
        console.log(`Value: ${row.value}\n`);
    }
}
