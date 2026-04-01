import { extractResolvedAnswers, extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import { TOOL_ASK_USER_QUESTION } from '../../../core/tools/toolNames';
import type {
  ChatMessage,
  ContentBlock,
  ImageAttachment,
  ImageMediaType,
  ToolCallInfo,
} from '../../../core/types';
import { extractContentBeforeXmlContext } from '../../../utils/context';
import { extractDiffData } from '../../../utils/diff';
import { isCompactionCanceledStderr, isInterruptSignalText } from '../../../utils/interrupt';
import { extractToolResultContent } from '../sdk/toolResultContent';
import type {
  AsyncSubagentResult,
  SDKNativeContentBlock,
  SDKNativeMessage,
} from './sdkHistoryTypes';

function extractTextContent(content: string | SDKNativeContentBlock[] | undefined): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is SDKNativeContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '(no content)')
    .map(block => block.text)
    .join('\n');
}

function isRebuiltContextContent(textContent: string): boolean {
  if (!/^(User|Assistant):\s/.test(textContent)) {
    return false;
  }

  return textContent.includes('\n\nUser:')
    || textContent.includes('\n\nAssistant:')
    || textContent.includes('\n\nA:');
}

function extractDisplayContent(textContent: string): string | undefined {
  return extractContentBeforeXmlContext(textContent);
}

function extractImages(content: string | SDKNativeContentBlock[] | undefined): ImageAttachment[] | undefined {
  if (!content || typeof content === 'string') {
    return undefined;
  }

  const imageBlocks = content.filter(
    (block): block is SDKNativeContentBlock & {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    } => block.type === 'image' && !!block.source?.data,
  );

  if (imageBlocks.length === 0) {
    return undefined;
  }

  return imageBlocks.map((block, index) => ({
    id: `sdk-img-${Date.now()}-${index}`,
    name: `image-${index + 1}`,
    mediaType: block.source.media_type as ImageMediaType,
    data: block.source.data,
    size: Math.ceil(block.source.data.length * 0.75),
    source: 'paste' as const,
  }));
}

function extractToolCalls(
  content: string | SDKNativeContentBlock[] | undefined,
  toolResults?: Map<string, { content: string; isError: boolean }>,
): ToolCallInfo[] | undefined {
  if (!content || typeof content === 'string') {
    return undefined;
  }

  const toolUses = content.filter(
    (block): block is SDKNativeContentBlock & { type: 'tool_use'; id: string; name: string } =>
      block.type === 'tool_use' && !!block.id && !!block.name,
  );

  if (toolUses.length === 0) {
    return undefined;
  }

  const results = toolResults ?? new Map<string, { content: string; isError: boolean }>();
  if (!toolResults) {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, {
          content: extractToolResultContent(block.content),
          isError: block.is_error ?? false,
        });
      }
    }
  }

  return toolUses.map(block => {
    const result = results.get(block.id);
    return {
      id: block.id,
      name: block.name,
      input: block.input ?? {},
      status: result ? (result.isError ? 'error' : 'completed') : 'running',
      result: result?.content,
      isExpanded: false,
    };
  });
}

function mapContentBlocks(content: string | SDKNativeContentBlock[] | undefined): ContentBlock[] | undefined {
  if (!content || typeof content === 'string') {
    return undefined;
  }

  const blocks: ContentBlock[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = block.text;
        const trimmed = text?.trim();
        if (text && trimmed && trimmed !== '(no content)') {
          blocks.push({ type: 'text', content: text });
        }
        break;
      }
      case 'thinking':
        if (block.thinking) {
          blocks.push({ type: 'thinking', content: block.thinking });
        }
        break;
      case 'tool_use':
        if (block.id) {
          blocks.push({ type: 'tool_use', toolId: block.id });
        }
        break;
      default:
        break;
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

export function parseSDKMessageToChat(
  sdkMsg: SDKNativeMessage,
  toolResults?: Map<string, { content: string; isError: boolean }>,
): ChatMessage | null {
  if (sdkMsg.type === 'file-history-snapshot') {
    return null;
  }

  if (sdkMsg.type === 'system') {
    if (sdkMsg.subtype === 'compact_boundary') {
      const timestamp = sdkMsg.timestamp ? new Date(sdkMsg.timestamp).getTime() : Date.now();
      return {
        id: sdkMsg.uuid || `compact-${timestamp}-${Math.random().toString(36).slice(2)}`,
        role: 'assistant',
        content: '',
        timestamp,
        contentBlocks: [{ type: 'context_compacted' }],
      };
    }
    return null;
  }

  if (sdkMsg.type === 'result') {
    return null;
  }

  if (sdkMsg.type !== 'user' && sdkMsg.type !== 'assistant') {
    return null;
  }

  const content = sdkMsg.message?.content;
  const textContent = extractTextContent(content);
  const images = sdkMsg.type === 'user' ? extractImages(content) : undefined;

  const hasToolUse = Array.isArray(content) && content.some(block => block.type === 'tool_use');
  const hasImages = !!images && images.length > 0;
  if (!textContent && !hasToolUse && !hasImages && (!content || typeof content === 'string')) {
    return null;
  }

  const timestamp = sdkMsg.timestamp ? new Date(sdkMsg.timestamp).getTime() : Date.now();
  const commandNameMatch = sdkMsg.type === 'user'
    ? textContent.match(/<command-name>(\/[^<]+)<\/command-name>/)
    : null;

  let displayContent: string | undefined;
  if (sdkMsg.type === 'user') {
    displayContent = commandNameMatch ? commandNameMatch[1] : extractDisplayContent(textContent);
  }

  const isInterrupt = sdkMsg.type === 'user' && isInterruptSignalText(textContent);
  const isRebuiltContext = sdkMsg.type === 'user' && isRebuiltContextContent(textContent);

  return {
    id: sdkMsg.uuid || `sdk-${timestamp}-${Math.random().toString(36).slice(2)}`,
    role: sdkMsg.type,
    content: textContent,
    displayContent,
    timestamp,
    toolCalls: sdkMsg.type === 'assistant' ? extractToolCalls(content, toolResults) : undefined,
    contentBlocks: sdkMsg.type === 'assistant' ? mapContentBlocks(content) : undefined,
    images,
    ...(sdkMsg.type === 'user' && sdkMsg.uuid && { userMessageId: sdkMsg.uuid }),
    ...(sdkMsg.type === 'assistant' && sdkMsg.uuid && { assistantMessageId: sdkMsg.uuid }),
    ...(isInterrupt && { isInterrupt: true }),
    ...(isRebuiltContext && { isRebuiltContext: true }),
  };
}

export function collectToolResults(
  sdkMessages: SDKNativeMessage[],
): Map<string, { content: string; isError: boolean }> {
  const results = new Map<string, { content: string; isError: boolean }>();

  for (const sdkMsg of sdkMessages) {
    const content = sdkMsg.message?.content;
    if (!content || typeof content === 'string') {
      continue;
    }

    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, {
          content: extractToolResultContent(block.content),
          isError: block.is_error ?? false,
        });
      }
    }
  }

  return results;
}

export function collectStructuredPatchResults(sdkMessages: SDKNativeMessage[]): Map<string, unknown> {
  const results = new Map<string, unknown>();

  for (const sdkMsg of sdkMessages) {
    if (sdkMsg.type !== 'user' || !sdkMsg.toolUseResult) {
      continue;
    }

    const content = sdkMsg.message?.content;
    if (!content || typeof content === 'string') {
      continue;
    }

    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, sdkMsg.toolUseResult);
      }
    }
  }

  return results;
}

export function collectAsyncSubagentResults(
  sdkMessages: SDKNativeMessage[],
): Map<string, AsyncSubagentResult> {
  const results = new Map<string, AsyncSubagentResult>();

  for (const sdkMsg of sdkMessages) {
    if (sdkMsg.type !== 'queue-operation') {
      continue;
    }
    if (sdkMsg.operation !== 'enqueue') {
      continue;
    }
    if (typeof sdkMsg.content !== 'string') {
      continue;
    }
    if (!sdkMsg.content.includes('<task-notification>')) {
      continue;
    }

    const taskId = extractXmlTag(sdkMsg.content, 'task-id');
    const status = extractXmlTag(sdkMsg.content, 'status');
    const result = extractXmlTag(sdkMsg.content, 'result');
    if (!taskId || !result) {
      continue;
    }

    results.set(taskId, {
      result,
      status: status ?? 'completed',
    });
  }

  return results;
}

export function extractXmlTag(content: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = content.match(regex);
  if (!match || !match[1]) {
    return null;
  }

  const trimmed = match[1].trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isSystemInjectedMessage(sdkMsg: SDKNativeMessage): boolean {
  if (sdkMsg.type !== 'user') {
    return false;
  }
  if ('toolUseResult' in sdkMsg || 'sourceToolUseID' in sdkMsg || !!sdkMsg.isMeta) {
    return true;
  }

  const text = extractTextContent(sdkMsg.message?.content);
  if (!text) {
    return false;
  }

  if (text.includes('<command-name>') && text.includes('<command-message>')) {
    return false;
  }
  if (isCompactionCanceledStderr(text)) {
    return false;
  }

  if (text.startsWith('This session is being continued from a previous conversation')) {
    return true;
  }
  if (text.includes('<command-name>')) {
    return true;
  }
  if (text.includes('<local-command-stdout>') || text.includes('<local-command-stderr>')) {
    return true;
  }
  if (text.includes('<task-notification>')) {
    return true;
  }

  return false;
}

export function mergeAssistantMessage(target: ChatMessage, source: ChatMessage): void {
  if (source.content) {
    target.content = target.content ? `${target.content}\n\n${source.content}` : source.content;
  }

  if (source.toolCalls) {
    target.toolCalls = [...(target.toolCalls || []), ...source.toolCalls];
  }

  if (source.contentBlocks) {
    target.contentBlocks = [...(target.contentBlocks || []), ...source.contentBlocks];
  }

  if (source.assistantMessageId) {
    target.assistantMessageId = source.assistantMessageId;
  }
}

export function hydrateStructuredToolResults(messages: ChatMessage[], toolUseResults: Map<string, unknown>): void {
  if (toolUseResults.size === 0) {
    return;
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) {
      continue;
    }

    for (const toolCall of msg.toolCalls) {
      const toolUseResult = toolUseResults.get(toolCall.id);
      if (!toolUseResult) {
        continue;
      }

      if (!toolCall.diffData) {
        toolCall.diffData = extractDiffData(toolUseResult, toolCall);
      }

      if (toolCall.name === TOOL_ASK_USER_QUESTION) {
        const answers =
          extractResolvedAnswers(toolUseResult) ??
          extractResolvedAnswersFromResultText(toolCall.result);
        if (answers) {
          toolCall.resolvedAnswers = answers;
        }
      }
    }
  }
}

export function hydrateFallbackAskUserAnswers(messages: ChatMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) {
      continue;
    }

    for (const toolCall of msg.toolCalls) {
      if (toolCall.name !== TOOL_ASK_USER_QUESTION || toolCall.resolvedAnswers) {
        continue;
      }

      const answers = extractResolvedAnswersFromResultText(toolCall.result);
      if (answers) {
        toolCall.resolvedAnswers = answers;
      }
    }
  }
}
