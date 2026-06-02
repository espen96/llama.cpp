class ArtifactsStore {
	private _code = $state('');
	private _language = $state('');
	private _title = $state('Artifact');
	private _isOpen = $state(false);
	private _isFullscreen = $state(false);
	private _mode = $state<'preview' | 'code'>('preview');

	get code() {
		return this._code;
	}

	get language() {
		return this._language;
	}

	get title() {
		return this._title;
	}

	get isOpen() {
		return this._isOpen;
	}

	get isFullscreen() {
		return this._isFullscreen;
	}

	get mode() {
		return this._mode;
	}

	open(code: string, language: string, title: string = 'Artifact') {
		this._code = code;
		this._language = language;
		this._title = title;
		this._isOpen = true;
		this._isFullscreen = false;

		const lang = language?.toLowerCase() || '';
		if (lang === 'html' || lang === 'xml' || lang === 'svg') {
			this._mode = 'preview';
		} else {
			this._mode = 'code';
		}
	}

	close() {
		this._isOpen = false;
		this._isFullscreen = false;
	}

	toggleFullscreen() {
		this._isFullscreen = !this._isFullscreen;
	}

	setFullscreen(isFullscreen: boolean) {
		this._isFullscreen = isFullscreen;
	}

	setMode(mode: 'preview' | 'code') {
		this._mode = mode;
	}

	setOpen(isOpen: boolean) {
		this._isOpen = isOpen;
	}
}

export const artifactsStore = new ArtifactsStore();
