/**
 * Claudian - Session Utilities
 *
 * Session recovery and history reconstruction.
 */

import type { ChatMessage, ToolCallInfo } from '../core/types';
import { extractUserQuery, formatCurrentNote } from './context';

// ============================================
// Session Recovery
// ============================================

/**
 * Error patterns that indicate session needs recovery.
 */
const SESSION_ERROR_PATTERNS = [
  'session expired',
  'session not found',
  'invalid session',
  'session invalid',
  'process exited with code',
] as const;

const SESSION_ERROR_COMPOUND_PATTERNS = [
  { includes: ['session', 'expired'] },
  { includes: ['resume', 'failed'] },
  { includes: ['resume', 'error'] },
] as const;

/** Checks if an error indicates session needs recovery. */
export function isSessionExpiredError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : '';

  for (const pattern of SESSION_ERROR_PATTERNS) {
    if (msg.includes(pattern)) {
      return true;
    }
  }

  for (const { includes } of SESSION_ERROR_COMPOUND_PATTERNS) {
    if (includes.every(part => msg.includes(part))) {
      return true;
    }
  }

  return false;
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
      } else {
        valueStr = String(value);
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
 * - Only include results for failed tools (errors are important to remember)
 * - Successful tools can be re-executed if needed
 */
export function formatToolCallForContext(toolCall: ToolCallInfo, maxErrorLength = 500): string {
  const status = toolCall.status ?? 'completed';
  const isFailed = status === 'error' || status === 'blocked';
  const inputStr = formatToolInput(toolCall.input);
  const inputPart = inputStr ? ` input: ${inputStr}` : '';

  // For successful tools, show what was done (Claude can re-execute if needed)
  if (!isFailed) {
    return `[Tool ${toolCall.name}${inputPart} status=${status}]`;
  }

  // For failed tools, include the error message so Claude knows what went wrong
  const hasResult = typeof toolCall.result === 'string' && toolCall.result.trim().length > 0;
  if (!hasResult) {
    return `[Tool ${toolCall.name}${inputPart} status=${status}]`;
  }

  const errorMsg = truncateToolResult(toolCall.result as string, maxErrorLength);
  return `[Tool ${toolCall.name}${inputPart} status=${status}] error: ${errorMsg}`;
}

/** Truncates tool result to avoid overloading recovery prompt. */
export function truncateToolResult(result: string, maxLength = 500): string {
  if (result.length > maxLength) {
    return `${result.slice(0, maxLength)}... (truncated)`;
  }
  return result;
}

/** Formats a context line for user messages when rebuilding history. */
export function formatContextLine(message: ChatMessage): string | null {
  if (!message.currentNote) {
    return null;
  }
  return formatCurrentNote(message.currentNote);
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

  // Summarize thinking: show count and total duration if available
  const totalDuration = thinkingBlocks.reduce(
    (sum, block) => sum + (block.durationSeconds ?? 0),
    0
  );

  const durationPart = totalDuration > 0 ? `, ${totalDuration.toFixed(1)}s total` : '';
  return [`[Thinking: ${thinkingBlocks.length} block(s)${durationPart}]`];
}

/**
 * Builds conversation context from message history for session recovery.
 */
export function buildContextFromHistory(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    // Skip interrupt messages - they're UI indicators, not actual conversation content
    if (message.isInterrupt) {
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
    const content = message.content?.trim();
    const contextLine = formatContextLine(message);

    const userPayload = contextLine
      ? content
        ? `${contextLine}\n\n${content}`
        : contextLine
      : content;

    lines.push(userPayload ? `${role}: ${userPayload}` : `${role}:`);

    // Add thinking block summary for assistant messages
    if (message.role === 'assistant') {
      const thinkingLines = formatThinkingBlocks(message);
      if (thinkingLines.length > 0) {
        lines.push(...thinkingLines);
      }
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const toolLines = message.toolCalls
        .map(tc => formatToolCallForContext(tc))
        .filter(Boolean) as string[];
      if (toolLines.length > 0) {
        lines.push(...toolLines);
      }
    }

    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

/** Gets the last user message from conversation history. */
export function getLastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i];
    }
  }
  return undefined;
}

/**
 * Builds a prompt with history context for session recovery.
 * Avoids duplicating the current prompt if it's already the last user message.
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
  // Use displayContent if available (already extracted), otherwise extract from content
  const lastUserQuery = lastUserMessage?.displayContent
    ?? extractUserQuery(lastUserMessage?.content ?? '');
  const currentUserQuery = extractUserQuery(actualPrompt);

  const shouldAppendPrompt = !lastUserMessage ||
    lastUserQuery.trim() !== currentUserQuery.trim();

  return shouldAppendPrompt
    ? `${historyContext}\n\nUser: ${prompt}`
    : historyContext;
}
