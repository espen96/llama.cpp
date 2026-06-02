import type { Plugin } from 'vite';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export function corsProxyPlugin(): Plugin {
	return {
		name: 'vite-plugin-cors-proxy',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const urlObj = new URL(req.url || '', 'http://localhost');
				if (urlObj.pathname === '/cors-proxy') {
					if (req.method === 'OPTIONS') {
						res.statusCode = 200;
						res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
						res.setHeader('Access-Control-Allow-Credentials', 'true');
						res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
						res.setHeader(
							'Access-Control-Allow-Headers',
							req.headers['access-control-request-headers'] || '*'
						);
						res.end();
						return;
					}

					const targetUrlStr = urlObj.searchParams.get('url');
					if (!targetUrlStr) {
						res.statusCode = 400;
						res.setHeader('Content-Type', 'application/json');
						res.end(JSON.stringify({ error: 'Missing url parameter' }));
						return;
					}

					try {
						const targetUrl = new URL(targetUrlStr);
						if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
							res.statusCode = 400;
							res.setHeader('Content-Type', 'application/json');
							res.end(JSON.stringify({ error: 'Unsupported URL scheme' }));
							return;
						}

						// Prepare headers to forward
						const headers: Record<string, string> = {};
						for (const [key, value] of Object.entries(req.headers)) {
							if (value === undefined) continue;
							let newKey = key;
							if (newKey.startsWith('x-proxy-header-')) {
								newKey = newKey.replace('x-proxy-header-', '');
							}

							// If header is multiple values, join them
							headers[newKey] = Array.isArray(value) ? value.join(', ') : value;
						}

						// Ensure Host header matches target host
						headers['host'] = targetUrl.host;

						// Read body from request
						const bodyChunks: Buffer[] = [];
						req.on('data', (chunk) => {
							bodyChunks.push(chunk);
						});

						req.on('end', () => {
							const body = Buffer.concat(bodyChunks);

							const requestModule = targetUrl.protocol === 'https:' ? https : http;
							const clientReq = requestModule.request(
								targetUrl.toString(),
								{
									method: req.method,
									headers: headers
								},
								(clientRes) => {
									// Copy status and headers from target response
									res.statusCode = clientRes.statusCode || 200;

									// Forward headers, but make sure to set CORS headers properly!
									for (const [key, value] of Object.entries(clientRes.headers)) {
										if (value === undefined) continue;
										// We want to skip some headers that might conflict or let the browser override
										if (
											[
												'access-control-allow-origin',
												'access-control-allow-credentials',
												'access-control-allow-methods',
												'access-control-allow-headers'
											].includes(key.toLowerCase())
										) {
											continue;
										}
										res.setHeader(key, value);
									}

									// Add CORS headers so localhost can read it
									res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
									res.setHeader('Access-Control-Allow-Credentials', 'true');
									res.setHeader(
										'Access-Control-Allow-Methods',
										'GET, POST, PUT, DELETE, OPTIONS, PATCH'
									);
									res.setHeader(
										'Access-Control-Allow-Headers',
										req.headers['access-control-request-headers'] || '*'
									);

									// Pipe response
									clientRes.pipe(res);
								}
							);

							clientReq.on('error', (err) => {
								console.error('[CORS Proxy Error]', err);
								res.statusCode = 502;
								res.setHeader('Content-Type', 'application/json');
								res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
							});

							if (body.length > 0) {
								clientReq.write(body);
							}
							clientReq.end();
						});
					} catch (err: any) {
						res.statusCode = 400;
						res.setHeader('Content-Type', 'application/json');
						res.end(JSON.stringify({ error: 'Invalid URL', message: err.message }));
					}
					return;
				}

				next();
			});
		}
	};
}
