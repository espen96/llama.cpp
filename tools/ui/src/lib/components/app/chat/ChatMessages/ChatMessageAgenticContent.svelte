<script lang="ts">
	import { Wrench, Loader2, Brain } from '@lucide/svelte';
	import {
		ChatMessageStatistics,
		CollapsibleContentBlock,
		MarkdownContent,
		SyntaxHighlightedCode,
		ChatMessageActionCardPermissionRequest,
		ChatMessageActionCardContinueRequest
	} from '$lib/components/app';

	import {
		AgenticSectionType,
		ChatMessageStatsView,
		FileTypeText,
		ToolPermissionDecision,
		MessageRole
	} from '$lib/enums';
	import type {
		ChatMessageAgenticTimings,
		ChatMessageAgenticTurnStats,
		DatabaseMessage
	} from '$lib/types';
	import {
		deriveAgenticSections,
		formatJsonPretty,
		parseToolResultWithImages,
		type AgenticSection,
		type ToolResultLine
	} from '$lib/utils';
	import {
		agenticResolvePermission,
		agenticPendingContinueRequest,
		agenticResolveContinue,
		agenticLastError
	} from '$lib/stores/agentic.svelte';
	import { config } from '$lib/stores/settings.svelte';

	type TextEntry = {
		kind: 'text';
		section: (typeof sectionsParsed)[number];
		flatIndex: number;
	};

	type ChainEntry = {
		kind: 'chain';
		sections: (typeof sectionsParsed)[number][];
		flatIndices: number[];
		summary: string;
	};

	type DisplayEntry = TextEntry | ChainEntry;

	/** Stable key for a display entry — survives index shifts when new sections appear */
	function getEntryKey(entry: DisplayEntry): string {
		return entry.kind === 'chain' ? `c${entry.flatIndices[0]}` : `t${entry.flatIndex}`;
	}

	interface Props {
		message: DatabaseMessage;
		toolMessages?: DatabaseMessage[];
		isStreaming?: boolean;
		isLastAssistantMessage?: boolean;
		highlightTurns?: boolean;
	}

	let {
		message,
		toolMessages = [],
		isStreaming = false,
		isLastAssistantMessage = false,
		highlightTurns = false
	}: Props = $props();

	let expandedStates: Record<number, boolean> = $state({});

	const showToolCallInProgress = $derived(config().showToolCallInProgress as boolean);

	const hasReasoningError = $derived(
		isLastAssistantMessage ? !!agenticLastError(message.convId) : false
	);

	import { toolsStore } from '$lib/stores/tools.svelte';

	let permissionDismissed = $state(false);

	const sections = $derived(deriveAgenticSections(message, toolMessages, [], isStreaming));

	const activeAssistantMessage = $derived.by(() => {
		if (toolMessages && toolMessages.length > 0) {
			for (let i = toolMessages.length - 1; i >= 0; i--) {
				if (toolMessages[i].role === MessageRole.ASSISTANT) {
					return toolMessages[i];
				}
			}
		}
		return message;
	});

	const pendingPermission = $derived.by(() => {
		if (activeAssistantMessage.generation_status !== 'waiting_for_permission') return null;
		if (!isLastAssistantMessage) return null;
		const pendingSection = sections.find(s => s.type === AgenticSectionType.TOOL_CALL_PENDING);
		if (!pendingSection?.toolName) return null;
		return {
			toolName: pendingSection.toolName,
			serverLabel: toolsStore.getToolServerLabel(pendingSection.toolName),
			messageId: activeAssistantMessage.id
		};
	});

	// Reset dismissed when pendingPermission changes (new request or cleared)
	// NOTE: Known minor issue — the permission dialog can briefly flash after the user
	// clicks Allow/Deny. reconnectToTask updates the message store (new object reference),
	// causing pendingPermission to briefly flip true→false→true, which resets
	// permissionDismissed. Resolves itself. TODO: fix with debounced dismiss or stable derived.
	let prevPendingRef: typeof pendingPermission = null;
	$effect(() => {
		if (pendingPermission !== prevPendingRef) {
			prevPendingRef = pendingPermission;
			if (pendingPermission) {
				permissionDismissed = false;
			}
		}
	});

	function handlePermission(decision: ToolPermissionDecision) {
		if (!pendingPermission) return;
		permissionDismissed = true;
		agenticResolvePermission(message.convId, pendingPermission.messageId, pendingPermission.toolName, pendingPermission.serverLabel, decision);
	}

	let continueDismissed = $state(false);

	const pendingContinue = $derived(
		isLastAssistantMessage && activeAssistantMessage.generation_status === 'waiting_for_continue'
	);

	let prevContinueRef = false;
	$effect(() => {
		if (pendingContinue !== prevContinueRef) {
			prevContinueRef = pendingContinue;
			if (pendingContinue) {
				continueDismissed = false;
			}
		}
	});

	function handleContinue(shouldContinue: boolean) {
		continueDismissed = true;
		agenticResolveContinue(message.convId, activeAssistantMessage.id, shouldContinue);
	}

	// Parse tool results with images
	const sectionsParsed = $derived(
		sections.map((section) => ({
			...section,
			parsedLines: section.toolResult
				? parseToolResultWithImages(section.toolResult, section.toolResultExtras || message?.extra)
				: ([] as ToolResultLine[])
		}))
	);

	// Chain grouping: consecutive non-text sections become a single collapsible group
	function isNonTextSection(
		section: (typeof sectionsParsed)[number]
	): section is (typeof sectionsParsed)[number] & {
		type:
			| AgenticSectionType.REASONING
			| AgenticSectionType.REASONING_PENDING
			| AgenticSectionType.TOOL_CALL
			| AgenticSectionType.TOOL_CALL_PENDING
			| AgenticSectionType.TOOL_CALL_STREAMING;
	} {
		return (
			section.type === AgenticSectionType.REASONING ||
			section.type === AgenticSectionType.REASONING_PENDING ||
			section.type === AgenticSectionType.TOOL_CALL ||
			section.type === AgenticSectionType.TOOL_CALL_PENDING ||
			section.type === AgenticSectionType.TOOL_CALL_STREAMING
		);
	}

	function generateChainSummary(chainSections: (typeof sectionsParsed)[number][]): string {
		const toolNames: string[] = [];
		let reasoningCount = 0;

		for (const s of chainSections) {
			if (
				s.type === AgenticSectionType.REASONING ||
				s.type === AgenticSectionType.REASONING_PENDING
			) {
				reasoningCount++;
			} else if (s.toolName) {
				if (!toolNames.includes(s.toolName)) {
					toolNames.push(s.toolName);
				}
			}
		}

		const parts: string[] = [];

		if (reasoningCount > 0) {
			parts.push(reasoningCount === 1 ? 'Reasoning' : `Reasoning (${reasoningCount})`);
		}

		if (toolNames.length > 0) {
			if (toolNames.length <= 3) {
				parts.push(toolNames.join(', '));
			} else {
				parts.push(`${toolNames[0]}, ${toolNames[1]} + ${toolNames.length - 2} more`);
			}
		}

		return parts.join(' — ') || 'Agent step';
	}

	function chainHasPending(
		chainSections: (typeof sectionsParsed)[number][]
	): boolean {
		return chainSections.some(
			(s) =>
				s.type === AgenticSectionType.TOOL_CALL_PENDING ||
				s.type === AgenticSectionType.TOOL_CALL_STREAMING ||
				s.type === AgenticSectionType.REASONING_PENDING
		);
	}

	const displayEntries = $derived.by((): DisplayEntry[] => {
		const entries: DisplayEntry[] = [];
		let currentChain: (typeof sectionsParsed)[number][] = [];
		let currentIndices: number[] = [];

		function flushChain() {
			if (currentChain.length === 0) return;
			if (currentChain.length === 1) {
				entries.push({
					kind: 'text',
					section: currentChain[0],
					flatIndex: currentIndices[0]
				});
			} else {
				entries.push({
					kind: 'chain',
					sections: currentChain,
					flatIndices: [...currentIndices],
					summary: generateChainSummary(currentChain)
				});
			}
			currentChain = [];
			currentIndices = [];
		}

		for (let i = 0; i < sectionsParsed.length; i++) {
			const section = sectionsParsed[i];

			if (isNonTextSection(section)) {
				currentChain.push(section);
				currentIndices.push(i);
			} else {
				flushChain();
				entries.push({ kind: 'text', section, flatIndex: i });
			}
		}

		flushChain();
		return entries;
	});

	let chainExpandedStates: Record<string, boolean> = $state({});

	function isChainExpanded(_entry: ChainEntry, entryKey: string): boolean {
		if (chainExpandedStates[entryKey] !== undefined) {
			return chainExpandedStates[entryKey];
		}
		return false;
	}

	function toggleChainExpanded(entryKey: string) {
		const current = chainExpandedStates[entryKey];
		chainExpandedStates[entryKey] = current === undefined ? true : !current;
	}

	function lastReasoningContent(chainSections: (typeof sectionsParsed)[number][]): string | undefined {
		for (let i = chainSections.length - 1; i >= 0; i--) {
			const s = chainSections[i];
			if (
				(s.type === AgenticSectionType.REASONING ||
					s.type === AgenticSectionType.REASONING_PENDING) &&
				s.content
			) {
				return s.content;
			}
		}
		return undefined;
	}

	// Group flat sections into agentic turns
	// A new turn starts when a non-tool section follows a tool section
	const turnGroups = $derived.by(() => {
		const turns: { sections: (typeof sectionsParsed)[number][]; flatIndices: number[] }[] = [];
		let currentTurn: (typeof sectionsParsed)[number][] = [];
		let currentIndices: number[] = [];
		let prevWasTool = false;

		for (let i = 0; i < sectionsParsed.length; i++) {
			const section = sectionsParsed[i];
			const isTool =
				section.type === AgenticSectionType.TOOL_CALL ||
				section.type === AgenticSectionType.TOOL_CALL_PENDING ||
				section.type === AgenticSectionType.TOOL_CALL_STREAMING;

			if (!isTool && prevWasTool && currentTurn.length > 0) {
				turns.push({ sections: currentTurn, flatIndices: currentIndices });
				currentTurn = [];
				currentIndices = [];
			}

			currentTurn.push(section);
			currentIndices.push(i);
			prevWasTool = isTool;
		}

		if (currentTurn.length > 0) {
			turns.push({ sections: currentTurn, flatIndices: currentIndices });
		}

		return turns;
	});

	function getDefaultExpanded(section: AgenticSection): boolean {
		if (
			section.type === AgenticSectionType.TOOL_CALL_PENDING ||
			section.type === AgenticSectionType.TOOL_CALL_STREAMING
		) {
			return showToolCallInProgress;
		}

		return false;
	}

	function isExpanded(index: number, section: AgenticSection): boolean {
		if (expandedStates[index] !== undefined) {
			return expandedStates[index];
		}

		return getDefaultExpanded(section);
	}

	function toggleExpanded(index: number, section: AgenticSection) {
		const currentState = isExpanded(index, section);

		expandedStates[index] = !currentState;
	}

	function buildTurnAgenticTimings(stats: ChatMessageAgenticTurnStats): ChatMessageAgenticTimings {
		return {
			turns: 1,
			toolCallsCount: stats.toolCalls.length,
			toolsMs: stats.toolsMs,
			toolCalls: stats.toolCalls,
			llm: stats.llm
		};
	}
</script>

{#snippet renderSection(section: (typeof sectionsParsed)[number], index: number)}
	{#if section.type === AgenticSectionType.TEXT}
		<div class="agentic-text">
			<MarkdownContent content={section.content} attachments={message?.extra} />
		</div>
	{:else if section.type === AgenticSectionType.TOOL_CALL_STREAMING}
		{@const streamingIcon = isStreaming ? Loader2 : Loader2}
		{@const streamingIconClass = isStreaming ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}

		<CollapsibleContentBlock
			open={isExpanded(index, section)}
			class="my-2"
			icon={streamingIcon}
			iconClass={streamingIconClass}
			title={section.toolName || 'Tool call'}
			subtitle={isStreaming ? '' : 'incomplete'}
			{isStreaming}
			onToggle={() => toggleExpanded(index, section)}
		>
			<div class="pt-3">
				<div class="my-3 flex items-center gap-2 text-xs text-muted-foreground">
					<span>Arguments:</span>

					{#if isStreaming}
						<Loader2 class="h-3 w-3 animate-spin" />
					{/if}
				</div>
				{#if section.toolArgs}
					<SyntaxHighlightedCode
						code={formatJsonPretty(section.toolArgs)}
						language={FileTypeText.JSON}
						maxHeight="20rem"
						class="text-xs"
					/>
				{:else if isStreaming}
					<div class="rounded bg-muted/30 p-2 text-xs text-muted-foreground italic">
						Receiving arguments...
					</div>
				{:else}
					<div
						class="rounded bg-yellow-500/10 p-2 text-xs text-yellow-600 italic dark:text-yellow-400"
					>
						Response was truncated
					</div>
				{/if}
			</div>
		</CollapsibleContentBlock>
	{:else if section.type === AgenticSectionType.TOOL_CALL || section.type === AgenticSectionType.TOOL_CALL_PENDING}
		{@const isPending = section.type === AgenticSectionType.TOOL_CALL_PENDING}
		{@const toolIcon = isPending ? Loader2 : Wrench}
		{@const toolIconClass = isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}

		<CollapsibleContentBlock
			open={isExpanded(index, section)}
			class="my-2"
			icon={toolIcon}
			iconClass={toolIconClass}
			title={section.toolName || ''}
			subtitle={isPending ? 'executing...' : undefined}
			isStreaming={isPending}
			onToggle={() => toggleExpanded(index, section)}
		>
			{#if section.toolArgs && section.toolArgs !== '{}'}
				<div class="pt-3">
					<div class="my-3 text-xs text-muted-foreground">Arguments:</div>

					<SyntaxHighlightedCode
						code={formatJsonPretty(section.toolArgs)}
						language={FileTypeText.JSON}
						maxHeight="20rem"
						class="text-xs"
					/>
				</div>
			{/if}

			<div class="pt-3">
				<div class="my-3 flex items-center gap-2 text-xs text-muted-foreground">
					<span>Result:</span>

					{#if isPending}
						<Loader2 class="h-3 w-3 animate-spin" />
					{/if}
				</div>
				{#if isPending}
					<div class="rounded bg-muted/30 p-2 text-xs text-muted-foreground italic">
						Waiting for result...
					</div>
				{:else if section.toolResult}
					<div class="overflow-auto rounded-lg border border-border bg-muted p-4">
						{#each section.parsedLines as line, i (i)}
							<div class="font-mono text-xs leading-relaxed whitespace-pre-wrap">
								{line.text}
							</div>
							{#if line.image}
								<img
									src={line.image.base64Url}
									alt={line.image.name}
									class="mt-2 mb-2 h-auto max-w-full rounded-lg"
									loading="lazy"
								/>
							{/if}
						{/each}
					</div>
				{:else}
					<div class="rounded bg-muted/30 p-2 text-xs text-muted-foreground italic">No output</div>
				{/if}
			</div>
		</CollapsibleContentBlock>
	{:else if section.type === AgenticSectionType.REASONING}
		{@const reasoningSubtitle = section.wasInterrupted
			? hasReasoningError
				? 'Error'
				: 'Cancelled'
			: isStreaming
				? ''
				: undefined}

		<CollapsibleContentBlock
			open={isExpanded(index, section)}
			class="my-2"
			icon={Brain}
			title="Reasoning"
			subtitle={reasoningSubtitle}
			rawContent={section.content}
			onToggle={() => toggleExpanded(index, section)}
		>
			<div class="pt-3">
				<div class="text-xs leading-relaxed break-words whitespace-pre-wrap">
					{section.content}
				</div>
			</div>
		</CollapsibleContentBlock>
	{:else if section.type === AgenticSectionType.REASONING_PENDING}
		{@const reasoningTitle = isStreaming ? 'Reasoning...' : 'Reasoning'}
		{@const reasoningSubtitle = isStreaming ? '' : hasReasoningError ? 'Error' : 'Cancelled'}

		<CollapsibleContentBlock
			open={isExpanded(index, section)}
			class="my-2"
			icon={Brain}
			title={reasoningTitle}
			subtitle={reasoningSubtitle}
			rawContent={section.content}
			{isStreaming}
			onToggle={() => toggleExpanded(index, section)}
		>
			<div class="pt-3">
				<div class="text-xs leading-relaxed break-words whitespace-pre-wrap">
					{section.content}
				</div>
			</div>
		</CollapsibleContentBlock>
	{/if}
{/snippet}

<div class="agentic-content">
	{#if highlightTurns && turnGroups.length > 1}
		{#each turnGroups as turn, turnIndex (turnIndex)}
			{@const turnStats = message?.timings?.agentic?.perTurn?.[turnIndex]}
			<div class="agentic-turn my-2 hover:bg-muted/80 dark:hover:bg-muted/30">
				<span class="agentic-turn-label">Turn {turnIndex + 1}</span>
				{#each turn.sections as section, sIdx (turn.flatIndices[sIdx])}
					{@render renderSection(section, turn.flatIndices[sIdx])}
				{/each}
				{#if turnStats}
					<div class="turn-stats">
						<ChatMessageStatistics
							promptTokens={turnStats.llm.prompt_n}
							promptMs={turnStats.llm.prompt_ms}
							predictedTokens={turnStats.llm.predicted_n}
							predictedMs={turnStats.llm.predicted_ms}
							agenticTimings={turnStats.toolCalls.length > 0
								? buildTurnAgenticTimings(turnStats)
								: undefined}
							initialView={ChatMessageStatsView.GENERATION}
							hideSummary
						/>
					</div>
				{/if}
			</div>
		{/each}
	{:else}
		{#each displayEntries as entry, entryIndex (getEntryKey(entry))}
			{#if entry.kind === 'chain'}
				{@const entryKey = getEntryKey(entry)}
				{@const chainOpen = isChainExpanded(entry, entryKey)}
				<CollapsibleContentBlock
					open={chainOpen}
					class="my-2"
					icon={Brain}
					title={entry.summary}
					rawContent={lastReasoningContent(entry.sections)}
					isStreaming={isStreaming && chainHasPending(entry.sections)}
					onToggle={() => toggleChainExpanded(entryKey)}
				>
					{#if chainOpen}
						{#each entry.sections as section, sIdx (entry.flatIndices[sIdx])}
							{@render renderSection(section, entry.flatIndices[sIdx])}
						{/each}
					{/if}
				</CollapsibleContentBlock>
			{:else}
				{@render renderSection(entry.section, entry.flatIndex)}
			{/if}
		{/each}
	{/if}

	{#if pendingPermission && !permissionDismissed}
		<ChatMessageActionCardPermissionRequest
			toolName={pendingPermission.toolName}
			serverLabel={pendingPermission.serverLabel}
			onDecision={handlePermission}
		/>
	{/if}

	{#if pendingContinue && !continueDismissed}
		<ChatMessageActionCardContinueRequest onDecision={handleContinue} />
	{/if}
</div>

<style>
	.agentic-content {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
		max-width: 48rem;
	}

	.agentic-text {
		width: 100%;
	}

	.agentic-turn {
		position: relative;
		border: 1.5px dashed var(--muted-foreground);
		border-radius: 0.75rem;
		padding: 1rem;
		transition: background 0.1s;
	}

	.agentic-turn-label {
		position: absolute;
		top: -1rem;
		left: 0.75rem;
		padding: 0 0.375rem;
		background: var(--background);
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.turn-stats {
		margin-top: 0.75rem;
		padding-top: 0.5rem;
		border-top: 1px solid hsl(var(--muted) / 0.5);
	}
</style>
