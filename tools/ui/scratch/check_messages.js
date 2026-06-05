import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), '.data/llama-ui.sqlite3');
const db = new Database(dbPath);

const conversationId = '5fe8e772-7ea2-4daa-a524-ba7373b1bb20';
const messages = db.prepare('SELECT id, role, parent, children FROM messages WHERE conv_id = ?').all(conversationId);

const msgMap = new Map(messages.map(m => [m.id, m]));

function printTree(nodeId, indent = '') {
    const node = msgMap.get(nodeId);
    if (!node) return;
    console.log(`${indent}ID: ${node.id} | Role: ${node.role} | Children Count: ${JSON.parse(node.children || '[]').length}`);
    const children = JSON.parse(node.children || '[]');
    for (const childId of children) {
        printTree(childId, indent + '  ');
    }
}

// Find root node (parent is null)
const root = messages.find(m => m.parent === null);
if (root) {
    printTree(root.id);
} else {
    console.log('No root found!');
}
