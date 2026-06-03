

async function test() {
    const baseUrl = 'http://localhost:8081';
    console.log('Fetching models from', `${baseUrl}/v1/models`);
    const modelsResp = await fetch(`${baseUrl}/v1/models`);
    const modelsData = await modelsResp.json();
    console.log('Models:', JSON.stringify(modelsData));
    
    const model = modelsData.data?.[0]?.id || 'default';
    console.log('Using model:', model);

    const url = `${baseUrl}/v1/chat/completions`;
    const body = {
        model,
        messages: [{ role: 'user', content: 'write a simple hello world in javascript using execute_javascript' }],
        tools: [{
            type: 'function',
            function: {
                name: 'execute_javascript',
                description: 'Executes Javascript code on the server side in a safe, restricted sandbox.',
                parameters: {
                    type: 'object',
                    properties: {
                        code: { type: 'string' }
                    },
                    required: ['code']
                }
            }
        }],
        stream: true
    };

    console.log('Sending request to', url);
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        console.error('Request failed:', resp.status, await resp.text());
        return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log('--- CHUNK ---');
        console.log(decoder.decode(value));
    }
    console.log('Stream ended');
}

test().catch(console.error);
