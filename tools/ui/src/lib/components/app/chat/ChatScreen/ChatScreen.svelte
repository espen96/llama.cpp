<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		ChatScreenForm,
		ChatMessages,
		ChatScreenDragOverlay,
		ChatScreenProcessingInfo,
		ChatScreenActionScrollDown,
		DialogEmptyFileAlert,
		DialogFileUploadError,
		DialogChatError,
		ServerLoadingSplash,
		DialogConfirmation,
		ChatScreenServerError,
		ArtifactsSidebar
	} from '$lib/components/app';
	import { artifactsStore } from '$lib/stores/artifacts.svelte';
	import { setProcessingInfoContext } from '$lib/contexts';
	import { ErrorDialogType } from '$lib/enums';
	import { createAutoScrollController } from '$lib/hooks/use-auto-scroll.svelte';
	import { useKeyboardShortcuts } from '$lib/hooks/use-keyboard-shortcuts.svelte';
	import {
		chatStore,
		errorDialog,
		isLoading,
		isChatStreaming,
		isEditing,
		getAddFilesHandler,
		activeProcessingState
	} from '$lib/stores/chat.svelte';
	import {
		conversationsStore,
		activeMessages,
		activeConversation
	} from '$lib/stores/conversations.svelte';
	import { config } from '$lib/stores/settings.svelte';
	import { serverLoading, serverError, isRouterMode } from '$lib/stores/server.svelte';
	import { modelsStore, modelOptions, selectedModelId } from '$lib/stores/models.svelte';
	import { isFileTypeSupported, filterFilesByModalities } from '$lib/utils';
	import { parseFilesToMessageExtras, processFilesToChatUploaded } from '$lib/utils/browser-only';
	import { onMount } from 'svelte';
	import ChatScreenGreeting from './ChatScreenGreeting.svelte';

	let { showCenteredEmpty = false } = $props();

	const autoScroll = createAutoScrollController();

	let disableAutoScroll = $derived(Boolean(config().disableAutoScroll));
	let chatScrollContainer: HTMLDivElement | undefined = $state();
	let dragCounter = $state(0);
	let isDragOver = $state(false);
	let showFileErrorDialog = $state(false);
	let uploadedFiles = $state<ChatUploadedFile[]>([]);

	let fileErrorData = $state<{
		generallyUnsupported: File[];
		modalityUnsupported: File[];
		modalityReasons: Record<string, string>;
		supportedTypes: string[];
	}>({
		generallyUnsupported: [],
		modalityUnsupported: [],
		modalityReasons: {},
		supportedTypes: []
	});

	let showDeleteDialog = $state(false);

	let showEmptyFileDialog = $state(false);

	let processingInfoVisible = $state(false);

	let emptyFileNames = $state<string[]>([]);

	let initialMessage = $state('');

	// Resizable splitter state
	let containerRefForSplit = $state<HTMLDivElement>();
	let sidebarWidthPercent = $state(50);
	let isResizing = $state(false);

	function startResizing(event: PointerEvent) {
		event.preventDefault();
		isResizing = true;

		const handlePointerMove = (e: PointerEvent) => {
			if (!isResizing || !containerRefForSplit) return;
			const rect = containerRefForSplit.getBoundingClientRect();
			const offsetX = e.clientX - rect.left;
			const percent = (offsetX / rect.width) * 100;
			// Sidebar is on the right side, so sidebar width is 100 - percent
			sidebarWidthPercent = Math.max(20, Math.min(80, 100 - percent));
		};

		const handlePointerUp = () => {
			isResizing = false;
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('pointerup', handlePointerUp);
		};

		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
	}

	let isEmpty = $derived(
		showCenteredEmpty && !activeConversation() && activeMessages().length === 0 && !isLoading()
	);

	let activeErrorDialog = $derived(errorDialog());
	let isServerLoading = $derived(serverLoading());
	let hasPropsError = $derived(!!serverError());

	let isCurrentConversationLoading = $derived(isLoading() || isChatStreaming());

	let showProcessingInfo = $derived(
		isCurrentConversationLoading ||
			(config().keepStatsVisible && !!page.params.id) ||
			activeProcessingState() !== null
	);

	let isRouter = $derived(isRouterMode());

	let conversationModel = $derived(
		chatStore.getConversationModel(activeMessages() as DatabaseMessage[])
	);

	let activeModelId = $derived.by(() => {
		const options = modelOptions();

		if (!isRouter) {
			return options.length > 0 ? options[0].model : null;
		}

		const selectedId = selectedModelId();
		if (selectedId) {
			const model = options.find((m) => m.id === selectedId);
			if (model) return model.model;
		}

		if (conversationModel) {
			const model = options.find((m) => m.model === conversationModel);
			if (model) return model.model;
		}

		return null;
	});

	let modelPropsVersion = $state(0);

	setProcessingInfoContext({
		get showProcessingInfo() {
			return showProcessingInfo;
		}
	});

	$effect(() => {
		if (activeModelId) {
			const cached = modelsStore.getModelProps(activeModelId);

			if (!cached) {
				modelsStore.fetchModelProps(activeModelId).then(() => {
					modelPropsVersion++;
				});
			}
		}
	});

	let hasAudioModality = $derived.by(() => {
		if (activeModelId) {
			void modelPropsVersion;

			return modelsStore.modelSupportsAudio(activeModelId);
		}

		return false;
	});

	let hasVideoModality = $derived.by(() => {
		if (activeModelId) {
			void modelPropsVersion;

			return modelsStore.modelSupportsVideo(activeModelId);
		}

		return false;
	});

	let hasVisionModality = $derived.by(() => {
		if (activeModelId) {
			void modelPropsVersion;

			return modelsStore.modelSupportsVision(activeModelId);
		}

		return false;
	});

	async function handleDeleteConfirm() {
		const conversation = activeConversation();

		if (conversation) {
			await conversationsStore.deleteConversation(conversation.id);
		}

		showDeleteDialog = false;
	}

	function handleProcessingInfoVisibility(visible: boolean) {
		processingInfoVisible = visible;
	}

	function handleDragEnter(event: DragEvent) {
		event.preventDefault();

		dragCounter++;

		if (event.dataTransfer?.types.includes('Files')) {
			isDragOver = true;
		}
	}

	function handleDragLeave(event: DragEvent) {
		event.preventDefault();

		dragCounter--;

		if (dragCounter === 0) {
			isDragOver = false;
		}
	}

	function handleErrorDialogOpenChange(open: boolean) {
		if (!open) {
			chatStore.dismissErrorDialog();
		}
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();

		isDragOver = false;
		dragCounter = 0;

		if (event.dataTransfer?.files) {
			const files = Array.from(event.dataTransfer.files);

			if (isEditing()) {
				const handler = getAddFilesHandler();

				if (handler) {
					handler(files);
					return;
				}
			}

			processFiles(files);
		}
	}

	function handleFileRemove(fileId: string) {
		uploadedFiles = uploadedFiles.filter((f) => f.id !== fileId);
	}

	function handleFileUpload(files: File[]) {
		processFiles(files);
	}

	const { handleKeydown } = useKeyboardShortcuts({
		deleteActiveConversation: () => {
			if (activeConversation()) {
				showDeleteDialog = true;
			}
		}
	});

	async function handleSystemPromptAdd(draft: { message: string; files: ChatUploadedFile[] }) {
		if (draft.message || draft.files.length > 0) {
			chatStore.savePendingDraft(draft.message, draft.files);
		}

		await chatStore.addSystemPrompt();
	}

	function handleScroll() {
		autoScroll.handleScroll();
	}

	async function handleSendMessage(message: string, files?: ChatUploadedFile[]): Promise<boolean> {
		const plainFiles = files ? $state.snapshot(files) : undefined;
		const result = plainFiles
			? await parseFilesToMessageExtras(plainFiles, activeModelId ?? undefined)
			: undefined;

		if (result?.emptyFiles && result.emptyFiles.length > 0) {
			emptyFileNames = result.emptyFiles;
			showEmptyFileDialog = true;

			if (files) {
				const emptyFileNamesSet = new Set(result.emptyFiles);
				uploadedFiles = uploadedFiles.filter((file) => !emptyFileNamesSet.has(file.name));
			}
			return false;
		}

		const extras = result?.extras;

		// Enable autoscroll for user-initiated message sending
		autoScroll.enable();
		await chatStore.sendMessage(message, extras);
		autoScroll.scrollToBottom();

		return true;
	}

	async function processFiles(files: File[]) {
		const generallySupported: File[] = [];
		const generallyUnsupported: File[] = [];

		for (const file of files) {
			if (isFileTypeSupported(file.name, file.type)) {
				generallySupported.push(file);
			} else {
				generallyUnsupported.push(file);
			}
		}

		// Use model-specific capabilities for file validation
		const capabilities = {
			hasVision: hasVisionModality,
			hasAudio: hasAudioModality,
			hasVideo: hasVideoModality
		};
		const { supportedFiles, unsupportedFiles, modalityReasons } = filterFilesByModalities(
			generallySupported,
			capabilities
		);

		const allUnsupportedFiles = [...generallyUnsupported, ...unsupportedFiles];

		if (allUnsupportedFiles.length > 0) {
			const supportedTypes: string[] = ['text files', 'PDFs'];

			if (hasVisionModality) supportedTypes.push('images');
			if (hasAudioModality) supportedTypes.push('audio files');
			if (hasVideoModality) supportedTypes.push('video files');

			fileErrorData = {
				generallyUnsupported,
				modalityUnsupported: unsupportedFiles,
				modalityReasons,
				supportedTypes
			};
			showFileErrorDialog = true;
		}

		if (supportedFiles.length > 0) {
			const processed = await processFilesToChatUploaded(
				supportedFiles,
				activeModelId ?? undefined
			);
			uploadedFiles = [...uploadedFiles, ...processed];
		}
	}

	afterNavigate(() => {
		if (!disableAutoScroll) {
			autoScroll.enable();
		}
	});

	function handleMessagesReady() {
		if (disableAutoScroll) return;

		if (!autoScroll.userScrolledUp) {
			requestAnimationFrame(() => {
				autoScroll.scrollToBottom('instant');
			});
		}
	}

	onMount(() => {
		autoScroll.startObserving();

		if (!disableAutoScroll) {
			autoScroll.enable();
		}

		const pendingDraft = chatStore.consumePendingDraft();
		if (pendingDraft) {
			initialMessage = pendingDraft.message;
			uploadedFiles = pendingDraft.files;
		}
	});

	$effect(() => {
		autoScroll.setContainer(chatScrollContainer);
	});

	$effect(() => {
		autoScroll.setDisabled(disableAutoScroll);
	});
</script>

{#if isDragOver}
	<ChatScreenDragOverlay />
{/if}

<svelte:window onkeydown={handleKeydown} />

{#if isServerLoading}
	<ServerLoadingSplash />
{:else}
	<div bind:this={containerRefForSplit} class="relative flex h-full w-full overflow-hidden bg-background">
		<div
			bind:this={chatScrollContainer}
			aria-label="Chat interface with file drop zone"
			class="flex h-full flex-col overflow-y-auto px-4 md:px-6 {!isResizing ? 'transition-all duration-300' : ''}"
			style={artifactsStore.isOpen && !artifactsStore.isFullscreen ? `width: ${100 - sidebarWidthPercent}%; border-right: 1px solid var(--border);` : 'width: 100%'}
			ondragenter={handleDragEnter}
			ondragleave={handleDragLeave}
			ondragover={handleDragOver}
			ondrop={handleDrop}
			onscroll={handleScroll}
			role="main"
		>
			<div class="flex grow flex-col pt-14">
				{#if !isEmpty}
					<ChatMessages
						messages={activeMessages()}
						onMessagesReady={handleMessagesReady}
						onUserAction={() => {
							autoScroll.enable();
							if (!autoScroll.userScrolledUp) {
								autoScroll.scrollToBottom();
							}
						}}
					/>
				{/if}

				<div
					class={[
						'pointer-events-none sticky right-4 left-4 mt-auto transition-all duration-200',
						isEmpty ? 'bottom-[calc(50dvh-7rem)]' : 'bottom-4 pt-24 md:pt-32'
					]}
				>
					<ChatScreenGreeting {isEmpty} />

					<ChatScreenActionScrollDown
						container={chatScrollContainer}
						hasProcessingInfoVisible={processingInfoVisible}
					/>

					<ChatScreenProcessingInfo onVisibilityChange={handleProcessingInfoVisibility} />

					<ChatScreenServerError />

					<div class="conversation-chat-form pointer-events-auto rounded-t-3xl">
						<ChatScreenForm
							disabled={hasPropsError || isEditing()}
							{initialMessage}
							isLoading={isCurrentConversationLoading}
							onFileRemove={handleFileRemove}
							onFileUpload={handleFileUpload}
							onSend={handleSendMessage}
							onStop={() => chatStore.stopGeneration()}
							onSystemPromptAdd={handleSystemPromptAdd}
							bind:uploadedFiles
						/>
					</div>
				</div>
			</div>
		</div>

		{#if artifactsStore.isOpen && !artifactsStore.isFullscreen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="w-1.5 h-full relative cursor-col-resize flex-shrink-0 bg-border/20 hover:bg-primary/50 transition-colors duration-200 group"
				onpointerdown={startResizing}
			>
				<div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] bg-border group-hover:bg-primary/80 transition-colors"></div>
			</div>
		{/if}

		{#if artifactsStore.isOpen}
			<div
				class="{!isResizing ? 'transition-all duration-300' : ''} {artifactsStore.isFullscreen ? 'absolute inset-0 z-[1000] w-full h-full' : 'h-full'}"
				style={artifactsStore.isFullscreen ? '' : `width: ${sidebarWidthPercent}%`}
			>
				<ArtifactsSidebar />
			</div>
		{/if}

		{#if isResizing}
			<div class="absolute inset-0 z-[9999] cursor-col-resize select-none pointer-events-auto bg-transparent"></div>
		{/if}
	</div>
{/if}

<DialogFileUploadError bind:open={showFileErrorDialog} {fileErrorData} />

<DialogConfirmation
	bind:open={showDeleteDialog}
	title="Delete Conversation"
	description="Are you sure you want to delete this conversation? This action cannot be undone and will permanently remove all messages in this conversation."
	confirmText="Delete"
	cancelText="Cancel"
	variant="destructive"
	icon={Trash2}
	onConfirm={handleDeleteConfirm}
	onCancel={() => (showDeleteDialog = false)}
/>

<DialogEmptyFileAlert
	bind:open={showEmptyFileDialog}
	emptyFiles={emptyFileNames}
	onOpenChange={(open) => {
		if (!open) {
			emptyFileNames = [];
		}
	}}
/>

<DialogChatError
	message={activeErrorDialog?.message ?? ''}
	contextInfo={activeErrorDialog?.contextInfo}
	onOpenChange={handleErrorDialogOpenChange}
	open={Boolean(activeErrorDialog)}
	type={activeErrorDialog?.type ?? ErrorDialogType.SERVER}
/>
