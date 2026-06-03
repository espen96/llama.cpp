import { db, getDefaultUserId } from './db.js';

export function getAllSettings(): Record<string, string> {
    const userId = getDefaultUserId();
    const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId) as {key: string, value: string}[];
    
    const settings: Record<string, string> = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

export function updateSettings(updates: Record<string, string>): void {
    const userId = getDefaultUserId();
    const timestamp = Date.now();
    
    const stmt = db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `);

    const transaction = db.transaction(() => {
        for (const [key, value] of Object.entries(updates)) {
            stmt.run(userId, key, value, timestamp);
        }
    });

    transaction();
}

export function deleteSetting(key: string): void {
    const userId = getDefaultUserId();
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
}
