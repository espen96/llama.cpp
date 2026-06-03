import { browser } from '$app/environment';
import { StorageService } from '$lib/services/storage.service';

type PersistedValue<T> = {
	get value(): T;
	set value(newValue: T);
};

export const _persistedInstances: Array<() => void> = [];

export function persisted<T>(key: string, initialValue: T): PersistedValue<T> {
	let value = initialValue;

	const load = () => {
		if (browser) {
			try {
				const stored = StorageService.getItem(key);

				if (stored !== null) {
					value = JSON.parse(stored) as T;
				}
			} catch (error) {
				console.warn(`Failed to load ${key}:`, error);
			}
		}
	};

	load();
	_persistedInstances.push(load);

	const persist = (next: T) => {
		if (!browser) {
			return;
		}

		try {
			if (next === null || next === undefined) {
				StorageService.removeItem(key);
				return;
			}

			StorageService.setItem(key, JSON.stringify(next));
		} catch (error) {
			console.warn(`Failed to persist ${key}:`, error);
		}
	};

	return {
		get value() {
			return value;
		},

		set value(newValue: T) {
			value = newValue;
			persist(newValue);
		}
	};
}
