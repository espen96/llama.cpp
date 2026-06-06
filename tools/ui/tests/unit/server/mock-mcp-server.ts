import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
	{
		name: 'mock-mcp',
		version: '1.0.0'
	},
	{
		capabilities: {
			tools: {}
		}
	}
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: [
			{
				name: 'scratchpad',
				description: 'A mock scratchpad tool for testing.',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to write'
						}
					},
					required: ['content']
				}
			}
		]
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === 'scratchpad') {
		const content = String(request.params.arguments?.content || '');
		if (content === 'BROKEN') {
			throw new Error('Simulated tool crash');
		}
		return {
			content: [
				{
					type: 'text',
					text: `Scratchpad wrote: ${content}`
				}
			]
		};
	}
	throw new Error('Tool not found');
});

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error('MCP Server error', err);
	process.exit(1);
});
