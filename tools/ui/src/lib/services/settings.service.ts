export class SettingsService {
    static async getAllSettings(): Promise<Record<string, string>> {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    static async updateSettings(updates: Record<string, string>): Promise<void> {
        const res = await fetch('/api/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates })
        });
        if (!res.ok) throw new Error(await res.text());
    }

    static async deleteSetting(key: string): Promise<void> {
        const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error(await res.text());
    }
}
