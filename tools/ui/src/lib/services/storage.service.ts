import { browser } from '$app/environment';
import { SettingsService } from './settings.service';

/**
 * StorageService acts as a synchronous, reactive in-memory cache for user settings,
 * backed by the SQLite database via SettingsService.
 * It replaces localStorage across the application.
 */
export class StorageService {
    static data: Record<string, string> = {};
    static isInitialized = false;

    static async initialize() {
        if (!browser) return;
        
        try {
            const serverSettings = await SettingsService.getAllSettings();
            
            // If the server has no settings at all, we migrate from localStorage
            if (Object.keys(serverSettings).length === 0) {
                // EXCEPTION: This is migration bootstrap code. Runs before StorageService is
                // initialized, so it must read raw localStorage to seed the backend database.
                // This is the ONLY place raw localStorage is used for app data at runtime.
                // All other app reads/writes go through StorageService → SQLite backend.
                const toMigrate: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    // Only migrate keys used by our app
                    if (key && (key.startsWith('LlamaUi.') || key.startsWith('LlamaCppWebui.') || key.startsWith('llama_ui_') || key === 'theme')) {
                        toMigrate[key] = localStorage.getItem(key) || '';
                    }
                }
                
                if (Object.keys(toMigrate).length > 0) {
                    await SettingsService.updateSettings(toMigrate);
                    StorageService.data = toMigrate;
                    console.log(`[StorageService] Migrated ${Object.keys(toMigrate).length} settings from localStorage`);
                }
            } else {
                StorageService.data = serverSettings;
            }
        } catch (e) {
            console.error('[StorageService] Failed to initialize:', e);
        }

        StorageService.isInitialized = true;
    }

    static getItem(key: string): string | null {
        return StorageService.data[key] || null;
    }

    static setItem(key: string, value: string) {
        StorageService.data[key] = value;
        if (browser && StorageService.isInitialized) {
            SettingsService.updateSettings({ [key]: value }).catch(e => 
                console.error(`[StorageService] Failed to persist ${key}:`, e)
            );
        }
    }

    static removeItem(key: string) {
        delete StorageService.data[key];
        if (browser && StorageService.isInitialized) {
            SettingsService.deleteSetting(key).catch(e => 
                console.error(`[StorageService] Failed to delete ${key}:`, e)
            );
        }
    }
}
