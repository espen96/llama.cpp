import { connectionsStore } from '$lib/stores/connections.svelte';
import { ServerRole } from '$lib/enums';

/**
 * Connection Fetch Shim
 *
 * Monkey-patches window.fetch to intercept API calls when a custom connection
 * is active. Rewrites URLs, patches auth headers, injects chat_id in SSE
 * streams, and returns mock responses for unsupported endpoints.
 *
 * When no custom connection is active, fetch passes through unchanged.
 */

// Paths the shim intercepts (relative or absolute, with or without leading dot)
const INTERCEPTED_PATHS = [
	'/v1/models',
	'/v1/chat/completions',
	'/v1/chat/completions/control',
	'/props',
	'/slots',
	'/tools',
	'/models/load',
	'/models/unload',
	'/cors-proxy'
];

/**
 * Normalise a request URL to a path we can match against.
 * Handles: "./v1/chat/completions", "/v1/models", "http://localhost:8080/v1/models"
 */
function extractPath(input: string | URL | Request): string | null {
	let url: string;
	if (input instanceof Request) {
		url = input.url;
	} else if (input instanceof URL) {
		url = input.href;
	} else {
		url = input;
	}

	// Strip leading dot ("./v1/..." -> "/v1/...")
	if (url.startsWith('./')) {
		url = url.slice(1);
	}

	// If it's an absolute URL to the same origin, extract the pathname
	try {
		if (url.startsWith('http://') || url.startsWith('https://')) {
			const parsed = new URL(url);
			// Only intercept same-origin URLs (not already-redirected custom URLs)
			if (parsed.origin === window.location.origin) {
				return parsed.pathname + parsed.search;
			}
			return null;
		}
	} catch {
		// Not a valid URL, treat as path
	}

	return url;
}

/**
 * Find which intercepted path pattern this request matches.
 * Returns the matched pattern, or null.
 */
function matchPath(path: string): string | null {
	// Strip query string for matching
	const pathOnly = path.split('?')[0];

	// Also handle base path prefix (SvelteKit may prepend it)
	for (const pattern of INTERCEPTED_PATHS) {
		if (pathOnly === pattern || pathOnly.endsWith(pattern)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Build a mock /props response for servers that don't have this endpoint.
 */
function buildMockPropsResponse(): Response {
	const mockProps = {
		default_generation_settings: {
			id: 0,
			id_task: 0,
			n_ctx: 8192,
			speculative: false,
			is_processing: false,
			params: {
				n_predict: -1,
				seed: 4294967295,
				temperature: 0.6,
				dynatemp_range: 0,
				dynatemp_exponent: 1,
				top_k: 40,
				top_p: 0.95,
				min_p: 0.05,
				top_n_sigma: -1,
				xtc_probability: 0,
				xtc_threshold: 0.1,
				typ_p: 1,
				repeat_last_n: 64,
				repeat_penalty: 1,
				presence_penalty: 0,
				frequency_penalty: 0,
				dry_multiplier: 0,
				dry_base: 1.75,
				dry_allowed_length: 2,
				dry_penalty_last_n: -1,
				dry_sequence_breakers: ['\n', ':', '"', '*'],
				mirostat: 0,
				mirostat_tau: 5,
				mirostat_eta: 0.1,
				stop: [],
				max_tokens: -1,
				n_keep: 0,
				n_discard: 0,
				ignore_eos: false,
				stream: true,
				logit_bias: [],
				n_probs: 0,
				min_keep: 0,
				grammar: '',
				grammar_lazy: false,
				grammar_triggers: [],
				preserved_tokens: [],
				chat_format: 'content_only',
				reasoning_format: 'auto',
				reasoning_in_content: false,
				generation_prompt: '',
				samplers: ['top_k', 'typ_p', 'top_p', 'min_p', 'temperature'],
				backend_sampling: false,
				'speculative.n_max': 16,
				'speculative.n_min': 5,
				'speculative.p_min': 0.9,
				timings_per_token: false,
				post_sampling_probs: false,
				lora: []
			},
			prompt: '',
			next_token: {
				has_next_token: false,
				has_new_line: false,
				n_remain: -1,
				n_decoded: 0,
				stopping_word: ''
			}
		},
		total_slots: 1,
		model_path: '',
		role: ServerRole.ROUTER,
		modalities: { vision: false, audio: false, video: false },
		chat_template: '{{ enable_thinking }} <think></think>',
		bos_token: '',
		eos_token: '',
		build_info: 'custom-connection'
	};

	return new Response(JSON.stringify(mockProps), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Build a mock response for endpoints that don't exist on the remote.
 */
function buildMockResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Try fetching a URL, returning null on network error or non-2xx status.
 */
async function tryFetch(url: string, init?: RequestInit): Promise<Response | null> {
	try {
		const res = await originalFetch(url, init);
		if (res.ok) {
			// Some proxies (like Open WebUI) are SPAs that return index.html (200 OK)
			// for unknown endpoints instead of a 404 JSON response.
			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('text/html')) {
				return null;
			}
			return res;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Patch an SSE stream to inject chat_id into each data chunk if missing.
 * This fixes compatibility with Open WebUI proxy.
 */
function patchSSEStream(response: Response, requestedModel?: string): Response {
	const body = response.body;
	if (!body) return response;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}

			const text = decoder.decode(value, { stream: true });
			const lines = text.split('\n');
			const patched: string[] = [];

			for (const line of lines) {
				if (line.startsWith('data: ') && line !== 'data: [DONE]') {
					try {
						const data = JSON.parse(line.slice(6));
						if (!data.chat_id) {
							data.chat_id = 'dummy';
						}
						if (requestedModel) {
							data.model = requestedModel;
						}
						patched.push('data: ' + JSON.stringify(data));
					} catch {
						// Not valid JSON, pass through
						patched.push(line);
					}
				} else {
					patched.push(line);
				}
			}

			controller.enqueue(encoder.encode(patched.join('\n')));
		}
	});

	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

/**
 * Build the auth headers for the custom connection.
 */
function buildConnectionHeaders(
	connectionApiKey: string,
	existingHeaders?: HeadersInit
): Record<string, string> {
	const headers: Record<string, string> = {};

	// Copy existing headers
	if (existingHeaders) {
		if (existingHeaders instanceof Headers) {
			existingHeaders.forEach((value, key) => {
				headers[key] = value;
			});
		} else if (Array.isArray(existingHeaders)) {
			existingHeaders.forEach(([key, value]) => {
				headers[key] = value;
			});
		} else {
			Object.assign(headers, existingHeaders);
		}
	}

	// Override auth with connection-specific key
	if (connectionApiKey) {
		headers['Authorization'] = `Bearer ${connectionApiKey}`;
	} else {
		delete headers['Authorization'];
		delete headers['authorization'];
	}

	return headers;
}

// Keep a reference to the real fetch
let originalFetch: typeof window.fetch;
let shimInstalled = false;

/**
 * Install the global fetch shim. Call once on app startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function installConnectionFetchShim(): void {
	if (!globalThis.window || shimInstalled) return;

	originalFetch = window.fetch.bind(window);
	shimInstalled = true;

	const shimFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const connection = connectionsStore.activeConnection;

		// Extract URL string for debugging
		let debugUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		console.debug(`[Shim] Fetch called: ${debugUrl}`, { hasConnection: !!connection });

		if (!connection) {
			// No custom connection — pass through unchanged
			return originalFetch(input, init);
		}

		const path = extractPath(input);
		if (!path) {
			// Not a same-origin request or unrecognised — pass through
			return originalFetch(input, init);
		}

		const matched = matchPath(path);
		if (!matched) {
			// Not an intercepted path — pass through
			return originalFetch(input, init);
		}

		console.debug(`[Shim] Intercepting ${matched} -> ${connection.url}`);

		const baseUrl = connection.url.replace(/\/+$/, '');
		const upstream = connection.upstreamPath?.replace(/\/+$/, '') || '';
		const connectionHeaders = buildConnectionHeaders(
			connection.apiKey,
			init?.headers
		);

		// Preserve query string from original path
		const queryString = path.includes('?') ? path.slice(path.indexOf('?')) : '';

		switch (matched) {
			case '/v1/models': {
				const targetUrl = `${baseUrl}/v1/models${queryString}`;
				console.debug(`[Shim] Fetching models from: ${targetUrl}`);
				try {
					const response = await originalFetch(targetUrl, { ...init, headers: connectionHeaders });
					
					// Sanitize the response to avoid Open WebUI specific fields confusing the UI
					if (response.ok) {
						const contentType = response.headers.get('content-type') || '';
						if (contentType.includes('application/json')) {
							const data = await response.json();
							
							if (data && Array.isArray(data.data)) {
								data.data = data.data.filter((m: any) => {
									// Filter out models that Open WebUI explicitly marks as hidden
									if (m?.info?.meta?.hidden === true) return false;
									return true;
								}).map((m: any) => {
									// Map to standard OpenAI format to drop Open WebUI extras
									return {
										id: m.id,
										name: m.name || m.id,
										object: 'model',
										created: m.created || Date.now(),
										owned_by: m.owned_by || 'openai'
									};
								});
								
								return new Response(JSON.stringify(data), {
									status: response.status,
									statusText: response.statusText,
									headers: response.headers
								});
							}
						}
					}
					
					console.debug(`[Shim] Models response status: ${response.status}`);
					return response;
				} catch (err) {
					console.error(`[Shim] Models fetch failed:`, err);
					throw err;
				}
			}

			case '/v1/chat/completions': {
				const targetUrl = `${baseUrl}/v1/chat/completions`;
				let modifiedInit = { ...init };
				let requestedModel = '';

				if (init?.body && typeof init.body === 'string') {
					try {
						const bodyObj = JSON.parse(init.body);
						requestedModel = bodyObj.model || '';
						if (!bodyObj.chat_id) {
							bodyObj.chat_id = 'dummy';
							modifiedInit.body = JSON.stringify(bodyObj);
						}
					} catch (e) {
						console.warn('[Shim] Failed to parse and patch chat completions request body:', e);
					}
				}

				const response = await originalFetch(targetUrl, {
					...modifiedInit,
					headers: connectionHeaders
				});
				// Patch SSE stream to inject chat_id if it's a streaming response
				const contentType = response.headers.get('content-type') || '';
				if (contentType.includes('text/event-stream')) {
					return patchSSEStream(response, requestedModel);
				} else if (contentType.includes('application/json') && requestedModel) {
					try {
						const data = await response.json();
						data.model = requestedModel;
						return new Response(JSON.stringify(data), {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers
						});
					} catch (e) {
						// Fallback to returning the response as is
					}
				}
				return response;
			}

			case '/v1/chat/completions/control': {
				// Try forwarding; if it fails, mock success
				const targetUrl = `${baseUrl}/v1/chat/completions/control`;
				const res = await tryFetch(targetUrl, { ...init, headers: connectionHeaders });
				return res ?? buildMockResponse({ success: true });
			}

			case '/props': {
				// Try upstream path first (llama-swap), then direct, then mock
				if (upstream) {
					const upstreamRes = await tryFetch(
						`${baseUrl}${upstream}/props${queryString}`,
						{ ...init, headers: connectionHeaders }
					);
					if (upstreamRes) return upstreamRes;
				}

				const directRes = await tryFetch(
					`${baseUrl}/props${queryString}`,
					{ ...init, headers: connectionHeaders }
				);
				if (directRes) return directRes;

				return buildMockPropsResponse();
			}

			case '/slots': {
				// Try upstream, then direct, then mock
				if (upstream) {
					const upstreamRes = await tryFetch(
						`${baseUrl}${upstream}/slots${queryString}`,
						{ ...init, headers: connectionHeaders }
					);
					if (upstreamRes) return upstreamRes;
				}

				const directRes = await tryFetch(
					`${baseUrl}/slots${queryString}`,
					{ ...init, headers: connectionHeaders }
				);
				if (directRes) return directRes;

				return buildMockResponse([]);
			}

			case '/tools': {
				// Try upstream, then direct, then mock
				if (upstream) {
					const upstreamRes = await tryFetch(
						`${baseUrl}${upstream}/tools${queryString}`,
						{ ...init, headers: connectionHeaders }
					);
					if (upstreamRes) return upstreamRes;
				}

				const directRes = await tryFetch(
					`${baseUrl}/tools${queryString}`,
					{ ...init, headers: connectionHeaders }
				);
				if (directRes) return directRes;

				return buildMockResponse([]);
			}

			case '/models/load':
			case '/models/unload': {
				// Try forwarding; if it fails, mock success
				const targetUrl = `${baseUrl}${matched}`;
				const res = await tryFetch(targetUrl, { ...init, headers: connectionHeaders });
				return res ?? buildMockResponse({ success: true });
			}

			case '/cors-proxy': {
				// Pass through to local server (cors-proxy is a local feature)
				return originalFetch(input, init);
			}

			default:
				return originalFetch(input, init);
		}
	};

	window.fetch = shimFetch;
	globalThis.fetch = shimFetch;

	console.info('[connection-shim] Fetch shim installed');
}

/**
 * Uninstall the shim (for testing / cleanup).
 */
export function uninstallConnectionFetchShim(): void {
	if (shimInstalled && originalFetch) {
		window.fetch = originalFetch;
		globalThis.fetch = originalFetch;
		shimInstalled = false;
		console.info('[connection-shim] Fetch shim uninstalled');
	}
}
