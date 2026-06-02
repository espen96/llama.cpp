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
									const context = vm.createContext({});
									const result = vm.runInContext(code, context, { timeout: 1000 });
									
									res.statusCode = 200;
									res.setHeader('Content-Type', 'application/json');
									res.end(JSON.stringify({ plain_text: String(result) }));
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
