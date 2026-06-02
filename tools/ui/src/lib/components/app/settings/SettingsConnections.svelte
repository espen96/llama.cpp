<script lang="ts">
	import { Plus, Trash2, Radio, Plug, Eye, EyeOff } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { connectionsStore, type ServerConnection } from '$lib/stores/connections.svelte';
	import { serverStore } from '$lib/stores/server.svelte';
	import { modelsStore } from '$lib/stores/models.svelte';
	import { toolsStore } from '$lib/stores/tools.svelte';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';

	// ── Local editing state ──────────────────────────────────────────

	let connections = $derived(connectionsStore.connections);
	let activeId = $derived(connectionsStore.activeConnectionId);

	let isAdding = $state(false);
	let editingId = $state<string | null>(null);

	// Form fields
	let formName = $state('');
	let formUrl = $state('');
	let formApiKey = $state('');
	let formUpstreamPath = $state('');
	let showApiKey = $state(false);

	function resetForm() {
		formName = '';
		formUrl = '';
		formApiKey = '';
		formUpstreamPath = '';
		showApiKey = false;
		isAdding = false;
		editingId = null;
	}

	function startAdd() {
		resetForm();
		isAdding = true;
	}

	function startEdit(conn: ServerConnection) {
		formName = conn.name;
		formUrl = conn.url;
		formApiKey = conn.apiKey;
		formUpstreamPath = conn.upstreamPath;
		showApiKey = false;
		editingId = conn.id;
		isAdding = false;
	}

	function saveConnection() {
		const trimmedUrl = formUrl.trim().replace(/\/+$/, '');
		const trimmedName = formName.trim();

		if (!trimmedName || !trimmedUrl) {
			toast.error('Name and URL are required');
			return;
		}

		if (editingId) {
			connectionsStore.updateConnection(editingId, {
				name: trimmedName,
				url: trimmedUrl,
				apiKey: formApiKey.trim(),
				upstreamPath: formUpstreamPath.trim()
			});
			toast.success(`Updated connection "${trimmedName}"`);
		} else {
			connectionsStore.addConnection({
				name: trimmedName,
				url: trimmedUrl,
				apiKey: formApiKey.trim(),
				upstreamPath: formUpstreamPath.trim(),
				enabled: true
			});
			toast.success(`Added connection "${trimmedName}"`);
		}

		resetForm();
	}

	function removeConnection(conn: ServerConnection) {
		connectionsStore.removeConnection(conn.id);
		if (editingId === conn.id) resetForm();
		toast.info(`Removed connection "${conn.name}"`);
	}

	async function activateConnection(id: string | null) {
		connectionsStore.setActiveConnection(id);

		// Immediate switch: clear and re-fetch everything
		serverStore.clear();
		modelsStore.clear();
		toolsStore.clear();

		try {
			await serverStore.fetch();
			await modelsStore.fetch(true);
			await toolsStore.fetchBuiltinTools();
		} catch (error) {
			console.warn('[Connections] Re-fetch after switch failed:', error);
		}

		if (id === null) {
			toast.info('Switched to local server');
		} else {
			const conn = connectionsStore.connections.find((c) => c.id === id);
			toast.success(`Connected to "${conn?.name}"`);
		}
	}
</script>

<div in:fade={{ duration: 150 }}>
	<!-- Connection list -->
	<div class="space-y-3">
		<!-- Local server (always present) -->
		<button
			type="button"
			class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors
				{activeId === null ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-border/80'}"
			onclick={() => activateConnection(null)}
		>
			<div
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
					{activeId === null ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}"
			>
				<Radio class="h-4 w-4" />
			</div>
			<div class="min-w-0 flex-1">
				<div class="font-medium">Local Server</div>
				<div class="truncate text-sm text-muted-foreground">Built-in (served from same origin)</div>
			</div>
			{#if activeId === null}
				<span class="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
					Active
				</span>
			{/if}
		</button>

		<!-- Custom connections -->
		{#each connections as conn (conn.id)}
			<div
				class="rounded-lg border transition-colors
					{activeId === conn.id ? 'border-primary/50 bg-primary/5' : 'border-border'}"
			>
				<button
					type="button"
					class="flex w-full items-center gap-3 p-4 text-left"
					onclick={() => {
						if (activeId !== conn.id) {
							activateConnection(conn.id);
						}
					}}
				>
					<div
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
							{activeId === conn.id ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}"
					>
						<Plug class="h-4 w-4" />
					</div>
					<div class="min-w-0 flex-1">
						<div class="font-medium">{conn.name}</div>
						<div class="truncate text-sm text-muted-foreground">
							{conn.url}
							{#if conn.upstreamPath}
								<span class="opacity-60"> · upstream: {conn.upstreamPath}</span>
							{/if}
						</div>
					</div>
					{#if activeId === conn.id}
						<span class="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
							Active
						</span>
					{/if}
				</button>

				<div class="flex items-center gap-1 border-t border-border/50 px-4 py-2">
					<Button variant="ghost" size="sm" onclick={() => startEdit(conn)}>Edit</Button>
					<Button
						variant="ghost"
						size="sm"
						class="text-destructive hover:text-destructive"
						onclick={() => removeConnection(conn)}
					>
						<Trash2 class="mr-1 h-3 w-3" />
						Remove
					</Button>
				</div>
			</div>
		{/each}

		<!-- Empty state -->
		{#if connections.length === 0 && !isAdding}
			<div class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
				No custom connections configured yet. Add one to connect to remote servers.
			</div>
		{/if}
	</div>

	<!-- Add button -->
	<div class="mt-4">
		<Button variant="outline" size="sm" onclick={startAdd}>
			<Plus class="mr-1 h-4 w-4" />
			Add Connection
		</Button>
	</div>

	<!-- Add / Edit form -->
	{#if isAdding || editingId}
		<div
			class="mt-4 space-y-4 rounded-lg border border-border bg-card p-4"
			in:fade={{ duration: 100 }}
		>
			<h4 class="text-sm font-semibold">
				{editingId ? 'Edit Connection' : 'New Connection'}
			</h4>

			<div class="space-y-3">
				<div>
					<label for="conn-name" class="mb-1 block text-sm font-medium">Name</label>
					<input
						id="conn-name"
						type="text"
						bind:value={formName}
						placeholder="My Server"
						class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
					/>
				</div>

				<div>
					<label for="conn-url" class="mb-1 block text-sm font-medium">URL</label>
					<input
						id="conn-url"
						type="url"
						bind:value={formUrl}
						placeholder="http://192.168.1.50:8080"
						class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
					/>
					<p class="mt-1 text-xs text-muted-foreground">
						Base URL of the server. Don't include /v1 — it will be appended automatically.
					</p>
				</div>

				<div>
					<label for="conn-apikey" class="mb-1 block text-sm font-medium">API Key</label>
					<div class="relative">
						<input
							id="conn-apikey"
							type={showApiKey ? 'text' : 'password'}
							bind:value={formApiKey}
							placeholder="Optional"
							class="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm"
						/>
						<button
							type="button"
							class="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							onclick={() => (showApiKey = !showApiKey)}
						>
							{#if showApiKey}
								<EyeOff class="h-4 w-4" />
							{:else}
								<Eye class="h-4 w-4" />
							{/if}
						</button>
					</div>
				</div>

				<div>
					<label for="conn-upstream" class="mb-1 block text-sm font-medium">
						Upstream Path
						<span class="font-normal text-muted-foreground">(optional)</span>
					</label>
					<input
						id="conn-upstream"
						type="text"
						bind:value={formUpstreamPath}
						placeholder="/upstream/my-model"
						class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
					/>
					<p class="mt-1 text-xs text-muted-foreground">
						For llama-swap proxies. Gives access to props, slots, tools on the upstream llama.cpp
						backend.
					</p>
				</div>
			</div>

			<div class="flex gap-2">
				<Button size="sm" onclick={saveConnection}>
					{editingId ? 'Save' : 'Add'}
				</Button>
				<Button variant="ghost" size="sm" onclick={resetForm}>Cancel</Button>
			</div>
		</div>
	{/if}
</div>
