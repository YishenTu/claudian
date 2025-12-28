/**
 * Claudian - Session Utilities
 *
 * Session recovery and history reconstruction.
 */

import type { ChatMessage, ToolCallInfo } from '../core/types';
import { formatContextFilesLine } from './context';

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

/** Formats a tool call for inclusion in rebuilt context. */
export function formatToolCallForContext(toolCall: ToolCallInfo, maxResultLength = 800): string {
  const status = toolCall.status ?? 'completed';
  const base = `[Tool ${toolCall.name} status=${status}]`;
  const hasResult = typeof toolCall.result === 'string' && toolCall.result.trim().length > 0;

  if (!hasResult) {
    return base;
  }

  const result = truncateToolResult(toolCall.result as string, maxResultLength);
  return `${base} result: ${result}`;
}

/** Truncates tool result to avoid overloading recovery prompt. */
export function truncateToolResult(result: string, maxLength = 800): string {
  if (result.length > maxLength) {
    return `${result.slice(0, maxLength)}... (truncated)`;
  }
  return result;
}

/** Formats a context line for user messages when rebuilding history. */
export function formatContextLine(message: ChatMessage): string | null {
  if (!message.contextFiles || message.contextFiles.length === 0) {
    return null;
  }
  return formatContextFilesLine(message.contextFiles);
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

    if (message.role === 'assistant') {
      const hasContent = message.content && message.content.trim().length > 0;
      const hasToolResult = message.toolCalls?.some(
        tc => tc.result && tc.result.trim().length > 0
      );
      if (!hasContent && !hasToolResult) {
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
