import type { Plugin } from 'vite';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import vm from 'vm';

const SERVER_ORIGIN = process.env.VITE_PUBLIC_SERVER_ORIGIN || 'http://localhost:8080';

// Define the schema for our local javascript tool
const EXECUTE_JAVASCRIPT_TOOL = {
	type: 'function',
	function: {
		name: 'execute_javascript',
		description: 'Executes Javascript code on the server side in a safe, restricted sandbox. Can be used for calculations, data transformations, or logic tests. Returns the result of the last evaluated expression or a string representation of the output.',
		parameters: {
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description: 'The Javascript code to execute. Must not rely on any external APIs, network access, or file system access.'
				}
			},
			required: ['code']
		}
	}
};

const EXECUTE_JAVASCRIPT_TOOL_INFO = {
	display_name: 'Execute JavaScript',
	tool: 'execute_javascript',
	type: 'builtin',
	permissions: { write: false },
	definition: EXECUTE_JAVASCRIPT_TOOL
};

export function localToolsPlugin(): Plugin {
	return {
		name: 'vite-plugin-local-tools',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const urlObj = new URL(req.url || '', 'http://localhost');
				
				if (urlObj.pathname === '/tools') {
					if (req.method === 'GET') {
						res.statusCode = 200;
						res.setHeader('Content-Type', 'application/json');
						res.end(JSON.stringify([EXECUTE_JAVASCRIPT_TOOL_INFO]));
						return;
					}
					
					if (req.method === 'POST') {
						const bodyChunks: Buffer[] = [];
						req.on('data', (chunk) => bodyChunks.push(chunk));
						
						req.on('end', () => {
							const bodyBuffer = Buffer.concat(bodyChunks);
							let bodyData;
							try {
								bodyData = JSON.parse(bodyBuffer.toString());
							} catch (e) {
								res.statusCode = 400;
								res.setHeader('Content-Type', 'application/json');
								res.end(JSON.stringify({ error: 'Invalid JSON body' }));
								return;
							}
							
							if (bodyData && bodyData.tool === 'execute_javascript') {
								try {
									const code = bodyData.params?.code || '';
									
									// Capture console output
									const logs: string[] = [];
									const safeStringify = (val: any) => {
										if (val === undefined) return 'undefined';
										if (val === null) return 'null';
										if (typeof val === 'object') {
											try { return JSON.stringify(val); } catch (e) { return String(val); }
										}
										return String(val);
									};
									
									const sandboxConsole = {
										log: (...args: any[]) => logs.push(args.map(safeStringify).join(' ')),
										error: (...args: any[]) => logs.push('[ERROR] ' + args.map(safeStringify).join(' ')),
										warn: (...args: any[]) => logs.push('[WARN] ' + args.map(safeStringify).join(' ')),
										info: (...args: any[]) => logs.push(args.map(safeStringify).join(' ')),
									};
									
									const context = vm.createContext({ console: sandboxConsole });
									const result = vm.runInContext(code, context, { timeout: 1000 });
									
									let finalOutput = logs.join('\n');
									if (result !== undefined) {
										if (finalOutput) finalOutput += '\n';
										finalOutput += safeStringify(result);
									}
									
									if (!finalOutput) {
										finalOutput = 'undefined';
									}
									
									res.statusCode = 200;
									res.setHeader('Content-Type', 'application/json');
									res.end(JSON.stringify({ plain_text: finalOutput }));
								} catch (error: any) {
									res.statusCode = 200;
									res.setHeader('Content-Type', 'application/json');
									res.end(JSON.stringify({ error: error.message || String(error) }));
								}
								return;
							}
							
							res.statusCode = 404;
							res.setHeader('Content-Type', 'application/json');
							res.end(JSON.stringify({ error: 'Local tool not found' }));
						});
						return;
					}
				}
				
				next();
			});
		}
	};
}
