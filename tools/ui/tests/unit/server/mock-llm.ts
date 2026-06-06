export interface MockLlmOptions {
	tps: number;
	totalTokens: number;
	includeToolCall?: boolean;
	toolName?: string;
	toolArgs?: string;
	toolCallDelayTokens?: number;
	includeReasoning?: boolean;
}

export function createMockStream(options: MockLlmOptions): ReadableStream {
	const { 
		tps, 
		totalTokens, 
		includeToolCall, 
		toolName = 'scratchpad',
		toolArgs = '{"content":"test scratchpad"}',
		toolCallDelayTokens = 100, 
		includeReasoning 
	} = options;
	
	let tokensSent = 0;
	let isToolCallSent = false;
	
	const msPerToken = 1000 / tps;

	return new ReadableStream({
		async start(controller) {
			const sendChunk = (data: any) => {
				const chunkStr = `data: ${JSON.stringify(data)}\n\n`;
				controller.enqueue(new TextEncoder().encode(chunkStr));
			};

			try {
				while (tokensSent < totalTokens) {
					// We wait for the msPerToken to simulate TPS
					await new Promise((resolve) => setTimeout(resolve, msPerToken));

					if (includeToolCall && !isToolCallSent && tokensSent >= toolCallDelayTokens) {
						// Send a tool call chunk
						sendChunk({
							choices: [
								{
									delta: {
										tool_calls: [
											{
												id: `call_mock_${toolName}`,
												type: 'function',
												function: {
													name: toolName,
													arguments: toolArgs
												}
											}
										]
									}
								}
							]
						});
						isToolCallSent = true;
						break; // LLM stops generating after a complete tool call is emitted
					}

					// Send reasoning for the first half, text for the second half
					if (includeReasoning && tokensSent < totalTokens / 2) {
						sendChunk({
							choices: [
								{
									delta: {
										reasoning_content: ' reasoning '
									}
								}
							]
						});
					} else {
						sendChunk({
							choices: [
								{
									delta: {
										content: ' token '
									}
								}
							]
						});
					}

					tokensSent++;
				}

				sendChunk({
					choices: [
						{
							finish_reason: isToolCallSent ? 'tool_calls' : 'stop'
						}
					]
				});
				controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
				controller.close();
			} catch (e) {
				controller.error(e);
			}
		}
	});
}
