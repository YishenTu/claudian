/**
 * Claudian - Session Utilities
 *
 * Session recovery and history reconstruction.
 */

import type { ChatMessage, ImageAttachment, ToolCallInfo } from '../core/types';
import { appendBrowserContext } from './browser';
import { appendCanvasContext } from './canvas';
import { appendLinkedContent, appendLinkedContentBody, extractUserQuery, formatLinkedContent } from './context';
import { appendEditorContext } from './editor';

export function getMissingSessionId(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(/no conversation found with session id:\s*([a-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

export function isSessionMissingError(error: unknown, expectedSessionId?: string): boolean {
  const missingSessionId = getMissingSessionId(error);
  return !!missingSessionId
    && (!expectedSessionId || missingSessionId.toLowerCase() === expectedSessionId.toLowerCase());
}

// ============================================
// History Reconstruction
// ============================================

/**
 * Formats tool input for inclusion in rebuilt context.
 * Includes all non-null parameters, truncates long string values.
 */
function formatToolInput(input: Record<string, unknown>, maxLength = 200): string {
  if (!input || Object.keys(input).length === 0) return '';

  try {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;

      let valueStr: string;
      if (typeof value === 'string') {
        valueStr = value.length > 100 ? `${value.slice(0, 100)}...` : value;
      } else if (typeof value === 'object') {
        valueStr = '[object]';
      } else if (typeof value === 'function') {
        valueStr = '[function]';
      } else if (typeof value === 'symbol') {
        valueStr = value.description ? `[symbol:${value.description}]` : '[symbol]';
      } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        valueStr = `${value}`;
      } else {
        valueStr = '[unknown]';
      }
      parts.push(`${key}=${valueStr}`);
    }

    const result = parts.join(', ');
    return result.length > maxLength ? `${result.slice(0, maxLength)}...` : result;
  } catch {
    return '[input formatting error]';
  }
}

/**
 * Formats a tool call for inclusion in rebuilt context.
 *
 * Strategy:
 * - Always include tool name and input (so Claude knows what was attempted)
 * - By default, only include results for failed tools during compact recovery
 * - Ephemeral context retains complete results that cannot be read again
 */
export function formatToolCallForContext(
  toolCall: ToolCallInfo,
  preserveToolContext = false,
): string {
  const status = toolCall.status ?? 'completed';
  const isFailed = status === 'error' || status === 'blocked';
  const inputStr = preserveToolContext ? JSON.stringify(toolCall.input) : formatToolInput(toolCall.input);
  const inputPart = inputStr ? ` input: ${inputStr}` : '';

  if (!isFailed) {
    const result = preserveToolContext && typeof toolCall.result === 'string' && toolCall.result.trim()
      ? `\n${toolCall.result}`
      : '';
    return `[Tool ${toolCall.name}${inputPart} status=${status}]${result}`;
  }

  const hasResult = typeof toolCall.result === 'string' && toolCall.result.trim().length > 0;
  if (!hasResult) {
    return `[Tool ${toolCall.name}${inputPart} status=${status}]`;
  }

  const errorMsg = preserveToolContext
    ? toolCall.result as string
    : truncateToolResult(toolCall.result as string);
  return `[Tool ${toolCall.name}${inputPart} status=${status}] error: ${errorMsg}`;
}

function truncateToolResult(result: string): string {
  const maxLength = 500;
  if (result.length > maxLength) {
    return `${result.slice(0, maxLength)}... (truncated)`;
  }
  return result;
}

function formatContextLine(message: ChatMessage): string | null {
  const linkedContentPath = message.linkedContentPath ?? message.currentNote;
  if (!linkedContentPath) {
    return null;
  }
  return formatLinkedContent(linkedContentPath);
}

/**
 * Formats thinking blocks for inclusion in rebuilt context.
 * Just indicates that thinking occurred (content not included - Claude will think anew).
 */
function formatThinkingBlocks(message: ChatMessage): string[] {
  if (!message.contentBlocks) return [];

  const thinkingBlocks = message.contentBlocks.filter(
    (block): block is { type: 'thinking'; content: string; durationSeconds?: number } =>
      block.type === 'thinking'
  );

  if (thinkingBlocks.length === 0) return [];

  const totalDuration = thinkingBlocks.reduce(
    (sum, block) => sum + (block.durationSeconds ?? 0),
    0
  );

  const durationPart = totalDuration > 0 ? `, ${totalDuration.toFixed(1)}s total` : '';
  return [`[Thinking: ${thinkingBlocks.length} block(s)${durationPart}]`];
}

/** Available captured images, in the same order as the textual history. */
export function getHistoryImages(messages: readonly ChatMessage[]): ImageAttachment[] {
  return messages.flatMap(message => message.role === 'user' && !message.isInterrupt
    ? (message.images ?? []).filter(image => Boolean(image.data))
    : []);
}

function formatCapturedUserContent(message: ChatMessage): string {
  const snapshot = message.executionInput;
  if (!snapshot) return message.content?.trim() ?? '';
  let content = snapshot.canonicalText;
  const context = snapshot.context;
  if (context?.linkedContent) {
    content = context.linkedContent.content === undefined
      ? appendLinkedContent(content, context.linkedContent.path)
      : appendLinkedContentBody(content, context.linkedContent.path, context.linkedContent.content);
  }
  if (context?.editorSelection) content = appendEditorContext(content, context.editorSelection);
  if (context?.browserSelection) content = appendBrowserContext(content, context.browserSelection);
  if (context?.canvasSelection) content = appendCanvasContext(content, context.canvasSelection);
  return content;
}

export function buildContextFromHistory(
  messages: ChatMessage[],
  options: { preserveCapturedContext?: boolean } = {},
): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    if (message.isInterrupt && message.role === 'user') {
      continue;
    }

    if (message.role === 'assistant') {
      const hasContent = message.content && message.content.trim().length > 0;
      const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
      const hasThinking = message.contentBlocks?.some(b => b.type === 'thinking');
      if (!hasContent && !hasToolCalls && !hasThinking) {
        continue;
      }
    }

    const role = message.role === 'user' ? 'User' : 'Assistant';
    const lines: string[] = [];
    const capturedUser = options.preserveCapturedContext && message.role === 'user';
    const content = capturedUser ? formatCapturedUserContent(message) : message.content?.trim();
    const contextLine = capturedUser && message.executionInput?.context?.linkedContent
      ? null : formatContextLine(message);

    const userPayload = contextLine
      ? content
        ? `${contextLine}\n\n${content}`
        : contextLine
      : content;

    lines.push(userPayload ? `${role}: ${userPayload}` : `${role}:`);
    if (capturedUser) {
      const images = getHistoryImages([message]);
      if (images.length > 0) lines.push(`[Images attached in history order: ${images.map(image => image.name).join(', ')}]`);
    }

    if (message.role === 'assistant') {
      const thinkingLines = formatThinkingBlocks(message);
      if (thinkingLines.length > 0) {
        lines.push(...thinkingLines);
      }
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const toolLines = message.toolCalls
        .map(tc => formatToolCallForContext(tc, options.preserveCapturedContext))
        .filter(Boolean);
      if (toolLines.length > 0) {
        lines.push(...toolLines);
      }
    }

    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

function getLastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i];
    }
  }
  return undefined;
}

/**
 * Builds a prompt with history context for session recovery.
 * Avoids duplicating an unanswered current prompt already present in history.
 */
export function buildPromptWithHistoryContext(
  historyContext: string | null,
  prompt: string,
  actualPrompt: string,
  conversationHistory: ChatMessage[]
): string {
  if (!historyContext) return prompt;

  const lastUserMessage = getLastUserMessage(conversationHistory);

  // Compare actual user queries, not XML-wrapped versions
  const lastUserQuery = lastUserMessage?.displayContent
    ?? extractUserQuery(lastUserMessage?.content ?? '');
  const currentUserQuery = extractUserQuery(actualPrompt);

  const laterContext = lastUserMessage
    ? buildContextFromHistory(conversationHistory.slice(conversationHistory.lastIndexOf(lastUserMessage) + 1))
    : '';
  const shouldAppendPrompt = !lastUserMessage || laterContext.length > 0 ||
    lastUserQuery.trim() !== currentUserQuery.trim();

  return shouldAppendPrompt
    ? `${historyContext}\n\nUser: ${prompt}`
    : historyContext;
}
