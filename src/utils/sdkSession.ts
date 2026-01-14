/**
 * SDK Session Parser - Parses Claude Agent SDK native session files.
 *
 * The SDK stores sessions in ~/.claude/projects/{vault-path-encoded}/{sessionId}.jsonl
 * Each line is a JSON object with message data.
 *
 * This utility converts SDK native messages to Claudian's ChatMessage format
 * for displaying conversation history from native sessions.
 */

import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage, ContentBlock, ImageAttachment, ImageMediaType, ToolCallInfo } from '../core/types';

/** Result of reading an SDK session file. */
export interface SDKSessionReadResult {
  messages: SDKNativeMessage[];
  skippedLines: number;
  error?: string;
}

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
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
  // Image block fields
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Encodes a vault path for the SDK project directory name.
 * The SDK uses simple character replacement (NOT base64):
 * - `/` → `-`
 * - spaces → `-`
 * - `~` → `-`
 * - `'` → `-`
 */
export function encodeVaultPathForSDK(vaultPath: string): string {
  const absolutePath = path.resolve(vaultPath);
  // Replace special characters with dashes
  // The leading `/` becomes the first `-`
  return absolutePath
    .replace(/\//g, '-')
    .replace(/ /g, '-')
    .replace(/~/g, '-')
    .replace(/'/g, '-');
}

/**
 * Gets the SDK projects directory path.
 * Returns ~/.claude/projects/
 */
export function getSDKProjectsPath(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Validates a session ID to prevent path traversal attacks.
 * Accepts alphanumeric strings with hyphens and underscores (max 128 chars).
 * Common formats: SDK UUIDs, Claudian IDs (conv-TIMESTAMP-RANDOM).
 */
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length === 0 || sessionId.length > 128) {
    return false;
  }
  // Reject path traversal attempts and path separators
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return false;
  }
  // Allow only alphanumeric characters, hyphens, and underscores
  return /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

/**
 * Gets the full path to an SDK session file.
 *
 * @param vaultPath - The vault's absolute path
 * @param sessionId - The SDK session ID (may equal conversation ID for new native sessions)
 * @returns Full path to the session JSONL file
 * @throws Error if sessionId is invalid (path traversal protection)
 */
export function getSDKSessionPath(vaultPath: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  const projectsPath = getSDKProjectsPath();
  const encodedVault = encodeVaultPathForSDK(vaultPath);
  return path.join(projectsPath, encodedVault, `${sessionId}.jsonl`);
}

/**
 * Checks if an SDK session file exists.
 * Uses synchronous check for simple existence test.
 */
export function sdkSessionExists(vaultPath: string, sessionId: string): boolean {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    return existsSync(sessionPath);
  } catch {
    // Invalid session ID or path construction error
    return false;
  }
}

/**
 * Reads and parses an SDK session file asynchronously.
 *
 * @param vaultPath - The vault's absolute path
 * @param sessionId - The session ID
 * @returns Result object with messages, skipped line count, and any error
 */
export async function readSDKSession(vaultPath: string, sessionId: string): Promise<SDKSessionReadResult> {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    if (!existsSync(sessionPath)) {
      return { messages: [], skippedLines: 0 };
    }

    const content = await fs.readFile(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SDKNativeMessage[] = [];
    let skippedLines = 0;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as SDKNativeMessage;
        messages.push(msg);
      } catch {
        skippedLines++;
      }
    }

    return { messages, skippedLines };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { messages: [], skippedLines: 0, error: errorMsg };
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
 * Extracts images from SDK content blocks.
 */
function extractImages(content: string | SDKNativeContentBlock[] | undefined): ImageAttachment[] | undefined {
  if (!content || typeof content === 'string') return undefined;

  const imageBlocks = content.filter(
    (block): block is SDKNativeContentBlock & {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    } => block.type === 'image' && !!block.source?.data
  );

  if (imageBlocks.length === 0) return undefined;

  return imageBlocks.map((block, index) => ({
    id: `sdk-img-${Date.now()}-${index}`,
    name: `image-${index + 1}`,
    mediaType: block.source.media_type as ImageMediaType,
    data: block.source.data,
    size: Math.ceil(block.source.data.length * 0.75), // Approximate original size from base64
    source: 'paste' as const,
  }));
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
 * @param sdkMsg - The SDK native message
 * @param toolResults - Optional pre-collected tool results for cross-message matching.
 *   If not provided, only matches tool_result in the same message as tool_use.
 *   For full cross-message matching, use loadSDKSessionMessages() which performs two-pass parsing.
 * @returns ChatMessage or null if the message should be skipped
 */
export function parseSDKMessageToChat(
  sdkMsg: SDKNativeMessage,
  toolResults?: Map<string, { content: string; isError: boolean }>
): ChatMessage | null {
  // Skip non-conversation messages
  if (sdkMsg.type === 'file-history-snapshot') return null;
  if (sdkMsg.type === 'system') return null;
  if (sdkMsg.type === 'result') return null;

  // Only process user and assistant messages
  if (sdkMsg.type !== 'user' && sdkMsg.type !== 'assistant') return null;

  const content = sdkMsg.message?.content;
  const textContent = extractTextContent(content);
  const images = sdkMsg.type === 'user' ? extractImages(content) : undefined;

  // Skip empty messages (but allow messages with tool_use or images)
  const hasToolUse = Array.isArray(content) && content.some(b => b.type === 'tool_use');
  const hasImages = images && images.length > 0;
  if (!textContent && !hasToolUse && !hasImages && (!content || typeof content === 'string')) return null;

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
    images,
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

/** Result of loading SDK session messages. */
export interface SDKSessionLoadResult {
  messages: ChatMessage[];
  skippedLines: number;
  error?: string;
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
 * @returns Result object with messages, skipped line count, and any error
 */
export async function loadSDKSessionMessages(vaultPath: string, sessionId: string): Promise<SDKSessionLoadResult> {
  const result = await readSDKSession(vaultPath, sessionId);

  if (result.error) {
    return { messages: [], skippedLines: result.skippedLines, error: result.error };
  }

  // First pass: collect all tool results for cross-message matching
  const toolResults = collectToolResults(result.messages);

  const chatMessages: ChatMessage[] = [];

  // Second pass: convert messages
  for (const sdkMsg of result.messages) {
    // Skip user messages that only contain tool_result
    if (isToolResultOnlyMessage(sdkMsg)) continue;

    const chatMsg = parseSDKMessageToChat(sdkMsg, toolResults);
    if (chatMsg) {
      chatMessages.push(chatMsg);
    }
  }

  // Sort by timestamp ascending
  chatMessages.sort((a, b) => a.timestamp - b.timestamp);

  return { messages: chatMessages, skippedLines: result.skippedLines };
}
