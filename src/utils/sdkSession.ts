/**
 * SDK Session Parser - Parses Claude Agent SDK native session files.
 *
 * The SDK stores sessions in ~/.claude/projects/{vault-path-encoded}/{sessionId}.jsonl
 * Each line is a JSON object with message data.
 *
 * This utility converts SDK native messages to Claudian's ChatMessage format
 * for displaying conversation history from native sessions.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage, ContentBlock, ToolCallInfo } from '../core/types';

/**
 * SDK native message structure (stored in session JSONL files).
 * Based on Claude Agent SDK internal format.
 */
export interface SDKNativeMessage {
  type: 'user' | 'assistant' | 'system' | 'result' | 'file-history-snapshot';
  parentUuid?: string | null;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | SDKNativeContentBlock[];
  };
  // Result message fields
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
}

/**
 * SDK native content block structure.
 */
export interface SDKNativeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
}

/**
 * Encodes a vault path for the SDK project directory name.
 * The SDK uses URL-safe base64 encoding of the absolute path.
 */
export function encodeVaultPathForSDK(vaultPath: string): string {
  // SDK uses the absolute path, then encodes it
  const absolutePath = path.resolve(vaultPath);
  // Convert to base64 and make URL-safe
  const base64 = Buffer.from(absolutePath).toString('base64');
  // Replace + with -, / with _, and remove = padding
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Gets the SDK projects directory path.
 * Returns ~/.claude/projects/
 */
export function getSDKProjectsPath(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Gets the full path to an SDK session file.
 *
 * @param vaultPath - The vault's absolute path
 * @param sessionId - The session ID (same as conversation ID for native sessions)
 * @returns Full path to the session JSONL file, or null if not determinable
 */
export function getSDKSessionPath(vaultPath: string, sessionId: string): string {
  const projectsPath = getSDKProjectsPath();
  const encodedVault = encodeVaultPathForSDK(vaultPath);
  return path.join(projectsPath, encodedVault, `${sessionId}.jsonl`);
}

/**
 * Checks if an SDK session file exists.
 */
export function sdkSessionExists(vaultPath: string, sessionId: string): boolean {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    return fs.existsSync(sessionPath);
  } catch {
    return false;
  }
}

/**
 * Reads and parses an SDK session file.
 *
 * @param vaultPath - The vault's absolute path
 * @param sessionId - The session ID
 * @returns Array of SDK native messages, or empty array on error
 */
export function readSDKSession(vaultPath: string, sessionId: string): SDKNativeMessage[] {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return [];
    }

    const content = fs.readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SDKNativeMessage[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as SDKNativeMessage;
        messages.push(msg);
      } catch {
        // Skip invalid JSON lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Extracts text content from SDK content blocks.
 */
function extractTextContent(content: string | SDKNativeContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;

  return content
    .filter((block): block is SDKNativeContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string'
    )
    .map(block => block.text)
    .join('\n');
}

/**
 * Extracts tool calls from SDK content blocks.
 *
 * @param content - The content blocks from the assistant message
 * @param toolResults - Pre-collected tool results from all messages (for cross-message matching)
 */
function extractToolCalls(
  content: string | SDKNativeContentBlock[] | undefined,
  toolResults?: Map<string, { content: string; isError: boolean }>
): ToolCallInfo[] | undefined {
  if (!content || typeof content === 'string') return undefined;

  const toolUses = content.filter(
    (block): block is SDKNativeContentBlock & { type: 'tool_use'; id: string; name: string } =>
      block.type === 'tool_use' && !!block.id && !!block.name
  );

  if (toolUses.length === 0) return undefined;

  // Use provided results map, or build one from same-message results (fallback)
  const results = toolResults ?? new Map<string, { content: string; isError: boolean }>();
  if (!toolResults) {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        results.set(block.tool_use_id, {
          content: resultContent,
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
      status: result ? (result.isError ? 'error' : 'completed') : 'completed',
      result: result?.content,
      isExpanded: false,
    };
  });
}

/**
 * Maps SDK content blocks to Claudian's ContentBlock format.
 */
function mapContentBlocks(content: string | SDKNativeContentBlock[] | undefined): ContentBlock[] | undefined {
  if (!content || typeof content === 'string') return undefined;

  const blocks: ContentBlock[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) {
          blocks.push({ type: 'text', content: block.text });
        }
        break;

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

      // tool_result blocks are handled as part of tool calls, not content blocks
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Converts an SDK native message to a ChatMessage.
 *
 * Note: For full tool result matching across messages, use loadSDKSessionMessages()
 * which performs two-pass parsing. This function only matches tool_result in the
 * same message as tool_use.
 *
 * @param sdkMsg - The SDK native message
 * @returns ChatMessage or null if the message should be skipped
 */
export function parseSDKMessageToChat(sdkMsg: SDKNativeMessage): ChatMessage | null {
  // Skip non-conversation messages
  if (sdkMsg.type === 'file-history-snapshot') return null;
  if (sdkMsg.type === 'system') return null;
  if (sdkMsg.type === 'result') return null;

  // Only process user and assistant messages
  if (sdkMsg.type !== 'user' && sdkMsg.type !== 'assistant') return null;

  const content = sdkMsg.message?.content;
  const textContent = extractTextContent(content);

  // Skip empty messages (but allow assistant messages with tool_use)
  const hasToolUse = Array.isArray(content) && content.some(b => b.type === 'tool_use');
  if (!textContent && !hasToolUse && (!content || typeof content === 'string')) return null;

  const timestamp = sdkMsg.timestamp
    ? new Date(sdkMsg.timestamp).getTime()
    : Date.now();

  return {
    id: sdkMsg.uuid || `sdk-${timestamp}-${Math.random().toString(36).slice(2)}`,
    role: sdkMsg.type,
    content: textContent,
    timestamp,
    toolCalls: sdkMsg.type === 'assistant' ? extractToolCalls(content) : undefined,
    contentBlocks: sdkMsg.type === 'assistant' ? mapContentBlocks(content) : undefined,
  };
}

/**
 * Collects all tool_result blocks from SDK messages.
 * Used for cross-message tool result matching (tool_result often in user message
 * following assistant's tool_use).
 */
function collectToolResults(sdkMessages: SDKNativeMessage[]): Map<string, { content: string; isError: boolean }> {
  const results = new Map<string, { content: string; isError: boolean }>();

  for (const sdkMsg of sdkMessages) {
    const content = sdkMsg.message?.content;
    if (!content || typeof content === 'string') continue;

    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        results.set(block.tool_use_id, {
          content: resultContent,
          isError: block.is_error ?? false,
        });
      }
    }
  }

  return results;
}

/**
 * Checks if a user message contains only tool_result (no actual user content).
 * Such messages should be skipped as they're just result delivery.
 */
function isToolResultOnlyMessage(sdkMsg: SDKNativeMessage): boolean {
  if (sdkMsg.type !== 'user') return false;

  const content = sdkMsg.message?.content;
  if (!content || typeof content === 'string') return false;

  // Check if all blocks are tool_result
  const hasOnlyToolResults = content.every(block => block.type === 'tool_result');
  return hasOnlyToolResults && content.length > 0;
}

/**
 * Loads and converts all messages from an SDK native session.
 *
 * Uses two-pass approach:
 * 1. First pass: collect all tool_result from all messages
 * 2. Second pass: convert messages and attach results to tool calls
 *
 * @param vaultPath - The vault's absolute path
 * @param sessionId - The session ID
 * @returns Array of ChatMessage objects, sorted by timestamp
 */
export function loadSDKSessionMessages(vaultPath: string, sessionId: string): ChatMessage[] {
  const sdkMessages = readSDKSession(vaultPath, sessionId);

  // First pass: collect all tool results for cross-message matching
  const toolResults = collectToolResults(sdkMessages);

  const chatMessages: ChatMessage[] = [];

  // Second pass: convert messages
  for (const sdkMsg of sdkMessages) {
    // Skip user messages that only contain tool_result
    if (isToolResultOnlyMessage(sdkMsg)) continue;

    const chatMsg = parseSDKMessageToChatWithResults(sdkMsg, toolResults);
    if (chatMsg) {
      chatMessages.push(chatMsg);
    }
  }

  // Sort by timestamp ascending
  chatMessages.sort((a, b) => a.timestamp - b.timestamp);

  return chatMessages;
}

/**
 * Converts an SDK native message to a ChatMessage with cross-message tool results.
 */
function parseSDKMessageToChatWithResults(
  sdkMsg: SDKNativeMessage,
  toolResults: Map<string, { content: string; isError: boolean }>
): ChatMessage | null {
  // Skip non-conversation messages
  if (sdkMsg.type === 'file-history-snapshot') return null;
  if (sdkMsg.type === 'system') return null;
  if (sdkMsg.type === 'result') return null;

  // Only process user and assistant messages
  if (sdkMsg.type !== 'user' && sdkMsg.type !== 'assistant') return null;

  const content = sdkMsg.message?.content;
  const textContent = extractTextContent(content);

  // Skip empty messages (but allow assistant messages with tool_use)
  const hasToolUse = Array.isArray(content) && content.some(b => b.type === 'tool_use');
  if (!textContent && !hasToolUse && (!content || typeof content === 'string')) return null;

  const timestamp = sdkMsg.timestamp
    ? new Date(sdkMsg.timestamp).getTime()
    : Date.now();

  return {
    id: sdkMsg.uuid || `sdk-${timestamp}-${Math.random().toString(36).slice(2)}`,
    role: sdkMsg.type,
    content: textContent,
    timestamp,
    toolCalls: sdkMsg.type === 'assistant' ? extractToolCalls(content, toolResults) : undefined,
    contentBlocks: sdkMsg.type === 'assistant' ? mapContentBlocks(content) : undefined,
  };
}
