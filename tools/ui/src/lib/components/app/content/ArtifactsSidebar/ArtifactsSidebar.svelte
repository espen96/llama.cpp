<script lang="ts">
	import { X, Eye, Code, Maximize2, Minimize2 } from '@lucide/svelte';
	import { ActionIcon, ActionIconCopyToClipboard } from '$lib/components/app';
	import { artifactsStore } from '$lib/stores/artifacts.svelte';
	import SyntaxHighlightedCode from '../SyntaxHighlightedCode.svelte';
	import { fade } from 'svelte/transition';

	let isFullscreen = $derived(artifactsStore.isFullscreen);
	let mode = $derived(artifactsStore.mode);
	let code = $derived(artifactsStore.code);
	let language = $derived(artifactsStore.language);
	let title = $derived(artifactsStore.title);

	function toggleMode(targetMode: 'preview' | 'code') {
		artifactsStore.setMode(targetMode);
	}

	function handleClose() {
		artifactsStore.close();
	}

	function handleToggleFullscreen() {
		artifactsStore.toggleFullscreen();
	}

	let iframeRef = $state<HTMLIFrameElement | null>(null);

	$effect(() => {
		if (iframeRef && mode === 'preview') {
			iframeRef.srcdoc = code;
		}
	});
</script>

<div
	class="artifacts-sidebar flex flex-col h-full bg-sidebar/50 backdrop-blur-lg border-l border-border overflow-hidden select-none transition-all duration-300"
	transition:fade={{ duration: 200 }}
>
	<!-- Top Bar -->
	<div class="flex items-center justify-between p-3 border-b border-border bg-sidebar/80 backdrop-blur-md">
		<div class="flex items-center gap-2 overflow-hidden mr-2">
			<span class="font-semibold text-sm truncate text-foreground">{title || 'Artifact'}</span>
			{#if language}
				<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wider">
					{language}
				</span>
			{/if}
		</div>

		<!-- Toggles & Actions -->
		<div class="flex items-center gap-2 shrink-0">
			<!-- Mode Selector -->
			{#if language?.toLowerCase() === 'html' || language?.toLowerCase() === 'xml' || language?.toLowerCase() === 'svg'}
				<div class="flex items-center bg-muted/60 p-0.5 rounded-lg border border-border/50 mr-1">
					<button
						class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-all {mode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
						onclick={() => toggleMode('preview')}
						type="button"
					>
						<Eye class="h-3.5 w-3.5" />
						<span>Preview</span>
					</button>
					<button
						class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-all {mode === 'code' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
						onclick={() => toggleMode('code')}
						type="button"
					>
						<Code class="h-3.5 w-3.5" />
						<span>Code</span>
					</button>
				</div>
			{/if}

			<!-- Copy Action -->
			<ActionIconCopyToClipboard
				text={code}
				canCopy={!!code}
				ariaLabel="Copy code"
			/>

			<!-- Fullscreen Toggle -->
			<ActionIcon
				icon={isFullscreen ? Minimize2 : Maximize2}
				tooltip={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
				iconSize="h-4 w-4"
				onclick={handleToggleFullscreen}
			/>

			<div class="h-4 w-[1px] bg-border/60 mx-1"></div>

			<!-- Close Action -->
			<ActionIcon
				icon={X}
				tooltip="Close Sidebar"
				iconSize="h-4 w-4"
				onclick={handleClose}
			/>
		</div>
	</div>

	<!-- Content Area -->
	<div class="flex-1 min-h-0 bg-background overflow-hidden relative">
		{#if mode === 'preview'}
			<iframe
				bind:this={iframeRef}
				title="Artifact Preview"
				sandbox="allow-scripts"
				class="w-full h-full border-0 bg-white"
			></iframe>
		{:else}
			<div class="w-full h-full overflow-auto bg-muted/30">
				<SyntaxHighlightedCode
					{code}
					{language}
					maxHeight="100%"
					class="min-h-full w-full border-0 rounded-none bg-transparent"
				/>
			</div>
		{/if}
	</div>
</div>

<style>
	/* Make the preview screen crisp and responsive */
	iframe {
		color-scheme: light;
	}
</style>
