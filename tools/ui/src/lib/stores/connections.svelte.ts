import { browser } from '$app/environment';
import { uuid } from '$lib/utils/uuid';
import { STORAGE_APP_NAME } from '$lib/constants';
import { StorageService } from '$lib/services/storage.service';

/**
 * A remote server connection definition.
 *
 * Connections are shared across all users — they describe available backends,
 * not per-user preferences.
 */
export interface ServerConnection {
	/** Unique identifier */
	id: string;
	/** Human-readable label (e.g. "Home Server", "Cloud GPU") */
	name: string;
	/** Base URL including scheme (e.g. "http://192.168.1.50:8080") */
	url: string;
	/** Optional API key for this connection */
	apiKey: string;
	/**
	 * Whether this connection is a llama-swap proxy.
	 * When true, requests to /props, /slots, and /tools are dynamically
	 * prefixed with `/upstream/{model_id}`.
	 */
	llamaSwap: boolean;
	/** Whether this connection is available for selection */
	enabled: boolean;
}

const CONNECTIONS_STORAGE_KEY = `${STORAGE_APP_NAME}.connections`;
const ACTIVE_CONNECTION_STORAGE_KEY = `${STORAGE_APP_NAME}.activeConnectionId`;

/**
 * connectionsStore — manages the list of server connections and the active selection.
 *
 * Persistence is abstracted behind load/save methods so we can swap
 * localStorage for SQLite / an API later without touching consumers.
 */
class ConnectionsStore {
	connections = $state<ServerConnection[]>([]);
	activeConnectionId = $state<string | null>(null);

	get activeConnection(): ServerConnection | null {
		if (!this.activeConnectionId) return null;
		return this.connections.find((c) => c.id === this.activeConnectionId) ?? null;
	}

	get isCustomConnectionActive(): boolean {
		return this.activeConnection !== null;
	}

	constructor() {
		this.rehydrate();
	}

	// ── CRUD ──────────────────────────────────────────────────────────

	addConnection(partial: Omit<ServerConnection, 'id'>): ServerConnection {
		const connection: ServerConnection = { id: uuid(), ...partial };
		this.connections = [...this.connections, connection];
		this.save();
		return connection;
	}

	updateConnection(id: string, updates: Partial<Omit<ServerConnection, 'id'>>): void {
		this.connections = this.connections.map((c) => (c.id === id ? { ...c, ...updates } : c));
		this.save();
	}

	removeConnection(id: string): void {
		this.connections = this.connections.filter((c) => c.id !== id);
		if (this.activeConnectionId === id) {
			this.activeConnectionId = null;
		}
		this.save();
	}

	setActiveConnection(id: string | null): void {
		if (id !== null) {
			const exists = this.connections.find((c) => c.id === id);
			if (!exists || !exists.enabled) return;
		}
		this.activeConnectionId = id;
		this.save();
	}

	// ── Persistence (swap these for SQLite later) ────────────────────

	rehydrate(): void {
		if (!browser) return;
		try {
			const raw = StorageService.getItem(CONNECTIONS_STORAGE_KEY);
			this.connections = raw
				? (JSON.parse(raw) as any[]).map((c) => ({
						id: c.id,
						name: c.name,
						url: c.url,
						apiKey: c.apiKey,
						llamaSwap: c.llamaSwap ?? !!c.upstreamPath,
						enabled: c.enabled
					}))
				: [];

			const activeId = StorageService.getItem(ACTIVE_CONNECTION_STORAGE_KEY);
			this.activeConnectionId = activeId || null;

			// Validate: active id must reference an existing enabled connection
			if (this.activeConnectionId) {
				const exists = this.connections.find((c) => c.id === this.activeConnectionId && c.enabled);
				if (!exists) {
					this.activeConnectionId = null;
				}
			}
		} catch (error) {
			console.warn('Failed to load connections from storage:', error);
			this.connections = [];
			this.activeConnectionId = null;
		}
	}

	private save(): void {
		if (!browser) return;
		try {
			StorageService.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(this.connections));
			if (this.activeConnectionId) {
				StorageService.setItem(ACTIVE_CONNECTION_STORAGE_KEY, this.activeConnectionId);
			} else {
				StorageService.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
			}
		} catch (error) {
			console.error('Failed to save connections to storage:', error);
		}
	}
}

export const connectionsStore = new ConnectionsStore();
