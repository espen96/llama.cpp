import { getAllSettings } from '../sqlite/settings.js';
import { getConversation } from '../sqlite/conversations.js';

export function formatAttachmentText(label: string, name: string, content: string, extra?: string): string {
    const header = extra ? `${name} (${extra})` : name;
    return `\n\n--- ${label}: ${header} ---\n${content}`;
}

export function convertDbMessageToApiChatMessageData(message: any): any {
    if (message.role === 'tool' && message.toolCallId) {
        return {
            role: 'tool',
            content: message.content,
            tool_call_id: message.toolCallId
        };
    }

    let toolCalls: any[] | undefined;
    if (message.toolCalls) {
        try {
            toolCalls = typeof message.toolCalls === 'string' ? JSON.parse(message.toolCalls) : message.toolCalls;
        } catch {}
    }

    if (!message.extra || message.extra.length === 0) {
        const result: any = {
            role: message.role,
            content: message.content || null
        };
        if (message.reasoningContent) {
            result.reasoning_content = message.reasoningContent;
        }
        if (toolCalls && toolCalls.length > 0) {
            result.tool_calls = toolCalls;
        }
        return result;
    }

    const contentParts: any[] = [];
    const extras = typeof message.extra === 'string' ? JSON.parse(message.extra) : message.extra;

    for (const extra of extras) {
        if (extra.type === 'text' || extra.type === 'legacy_context') {
            contentParts.push({
                type: 'text',
                text: formatAttachmentText('File', extra.name, extra.content)
            });
        } else if (extra.type === 'image') {
            contentParts.push({
                type: 'image_url',
                image_url: { url: extra.base64Url }
            });
        } else if (extra.type === 'audio') {
            contentParts.push({
                type: 'input_audio',
                input_audio: { data: extra.base64Data, format: extra.mimeType ? (extra.mimeType.split('/')[1] || 'wav') : 'wav' }
            });
        } else if (extra.type === 'video') {
            contentParts.push({
                type: 'input_video',
                input_video: { data: extra.base64Data, format: extra.mimeType ? (extra.mimeType.includes('mp4') ? 'mp4' : 'auto') : 'auto' }
            });
        } else if (extra.type === 'pdf') {
            if (extra.processedAsImages && extra.images) {
                for (const img of extra.images) {
                    contentParts.push({ type: 'image_url', image_url: { url: img } });
                }
            } else {
                contentParts.push({
                    type: 'text',
                    text: formatAttachmentText('PDF File', extra.name, extra.content)
                });
            }
        } else if (extra.type === 'mcp_prompt') {
            contentParts.push({
                type: 'text',
                text: formatAttachmentText('MCP Prompt', extra.name, extra.content, extra.serverName)
            });
        } else if (extra.type === 'mcp_resource') {
            contentParts.push({
                type: 'text',
                text: formatAttachmentText('MCP Resource', extra.name, extra.content, extra.serverName)
            });
        }
    }

    if (message.content) {
        contentParts.push({
            type: 'text',
            text: message.content
        });
    }

    const result: any = {
        role: message.role,
        content: contentParts.length > 0 ? contentParts : (message.content || null)
    };
    if (message.reasoningContent) {
        result.reasoning_content = message.reasoningContent;
    }
    if (toolCalls && toolCalls.length > 0) {
        result.tool_calls = toolCalls;
    }
    return result;
}

export function buildOaiRequestBody(messages: any[], settings: Record<string, string>, convId: string): any {
    const configRaw = settings['LlamaUi.config'];
    const cfg = configRaw ? JSON.parse(configRaw) : {};
    const conv = getConversation(convId);

    // Filter out empty trailing assistant placeholders — these leak the chat template
    // prefix ("assistant\n<think>") into the model output because the model sees an
    // assistant turn it needs to continue from.
    const normalizedMessages = messages
        .map(convertDbMessageToApiChatMessageData)
        .filter((msg: any, i: number, arr: any[]) => {
            if (i === arr.length - 1 && msg.role === 'assistant' && !msg.content && !msg.tool_calls?.length) {
                return false;
            }
            return true;
        });

    const requestBody: any = {
        messages: normalizedMessages,
        stream: true,
        return_progress: true,
        reasoning_format: cfg.disableReasoningParsing ? 'none' : 'auto',
        chat_template_kwargs: { enable_thinking: conv?.thinkingEnabled ?? cfg.enableThinking },
        reasoning_control: true
    };

    const model = messages.find(m => m.model)?.model || cfg.model;
    if (model) requestBody.model = model;

    const temperature = cfg.temperature;
    if (temperature !== undefined) requestBody.temperature = temperature;
    
    // thinking budget tokens
    const enableThinking = conv?.thinkingEnabled ?? cfg.enableThinking;
    const reasoningEffort = conv?.reasoningEffort ?? cfg.reasoningEffort;
    const REASONING_EFFORT_TOKENS: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };
    if (enableThinking && reasoningEffort) {
        const tokens = REASONING_EFFORT_TOKENS[reasoningEffort];
        if (tokens) requestBody.thinking_budget_tokens = tokens;
    }

    // Load other parameters (presence_penalty, dynatemp, top_p, top_k, min_p, typ_p etc.)
    const simpleParams = [
        'dynatemp_range', 'dynatemp_exponent', 'top_k', 'top_p', 'min_p',
        'xtc_probability', 'xtc_threshold', 'typ_p', 'repeat_last_n',
        'repeat_penalty', 'presence_penalty', 'frequency_penalty',
        'dry_multiplier', 'dry_base', 'dry_allowed_length', 'dry_penalty_last_n',
        'samplers', 'backend_sampling', 'custom', 'timings_per_token'
    ];
    for (const key of simpleParams) {
        const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (cfg[camel] !== undefined) {
            requestBody[key] = cfg[camel];
        }
    }

    return requestBody;
}
