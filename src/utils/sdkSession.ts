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
import { extractContentBeforeXmlContext } from './context';

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
  type: 'user' | 'assistant' | 'system' | 'result' | 'file-history-snapshot' | 'queue-operation';
  parentUuid?: string | null;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  /** Request ID groups assistant messages from the same API call. */
  requestId?: string;
  message?: {
    role?: string;
    content?: string | SDKNativeContentBlock[];
  };
  // Result message fields
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  /** Present on tool result user messages - contains the tool execution result. */
  toolUseResult?: unknown;
  /** UUID of the assistant message that initiated this tool call. */
  sourceToolAssistantUUID?: string;
  /** Tool use ID for injected content (e.g., skill prompt expansion). */
  sourceToolUseID?: string;
  /** Meta messages are system-injected, not actual user input. */
  isMeta?: boolean;
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
 * The SDK replaces ALL non-alphanumeric characters with `-`.
 * This handles Unicode characters (Chinese, Japanese, etc.) and special chars (brackets, etc.).
 */
export function encodeVaultPathForSDK(vaultPath: string): string {
  const absolutePath = path.resolve(vaultPath);
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
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
 */
export function sdkSessionExists(vaultPath: string, sessionId: string): boolean {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    return existsSync(sessionPath);
  } catch {
    return false;
  }
}

/**
 * Deletes an SDK session file.
 * Fails silently if the file doesn't exist or cannot be deleted.
 *
 * @param vaultPath - The vault's absolute path
 * @param sessionId - The session ID to delete
 */
export async function deleteSDKSession(vaultPath: string, sessionId: string): Promise<void> {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    if (!existsSync(sessionPath)) return;
    await fs.unlink(sessionPath);
  } catch {
    // Fail silently - file may have been deleted externally
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
 * Checks if user message content represents rebuilt context (history sent to SDK when session reset).
 * These start with a conversation role prefix and contain conversation history markers.
 * Handles both normal history (starting with User:) and truncated/malformed history (starting with Assistant:).
 */
function isRebuiltContextContent(textContent: string): boolean {
  // Must start with a conversation role prefix
  if (!/^(User|Assistant):\s/.test(textContent)) return false;
  // Must contain conversation continuation markers
  return textContent.includes('\n\nUser:') ||
         textContent.includes('\n\nAssistant:') ||
         textContent.includes('\n\nA:');
}

/**
 * Extracts display content from user messages by removing XML context wrappers.
 * Uses shared extraction logic from context utilities.
 *
 * Returns undefined if no XML context found (plain user message).
 */
function extractDisplayContent(textContent: string): string | undefined {
  return extractContentBeforeXmlContext(textContent);
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
        // Skip empty or whitespace-only text blocks to avoid extra gaps
        // Also trim the content to remove leading/trailing whitespace that causes visual gaps
        if (block.text && block.text.trim()) {
          blocks.push({ type: 'text', content: block.text.trim() });
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

  // For user messages, extract displayContent from <query> tags if present
  const displayContent = sdkMsg.type === 'user'
    ? extractDisplayContent(textContent)
    : undefined;

  // Detect interrupt messages from SDK (stored as user messages with specific content)
  const isInterrupt = sdkMsg.type === 'user' && (
    textContent === '[Request interrupted by user]' ||
    textContent === '[Request interrupted by user for tool use]'
  );

  // Detect rebuilt context messages (history sent to SDK when session reset)
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
    ...(isInterrupt && { isInterrupt: true }),
    ...(isRebuiltContext && { isRebuiltContext: true }),
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
 * Checks if a user message is system-injected (not actual user input).
 * These include:
 * - Tool result messages (`toolUseResult` field)
 * - Skill prompt injections (`sourceToolUseID` field)
 * - Meta messages (`isMeta` field)
 * Such messages should be skipped as they're internal SDK communication.
 */
function isSystemInjectedMessage(sdkMsg: SDKNativeMessage): boolean {
  if (sdkMsg.type !== 'user') return false;
  return 'toolUseResult' in sdkMsg ||
         'sourceToolUseID' in sdkMsg ||
         sdkMsg.isMeta === true;
}

/** Result of loading SDK session messages. */
export interface SDKSessionLoadResult {
  messages: ChatMessage[];
  skippedLines: number;
  error?: string;
}

/**
 * Merges content from a source assistant message into a target message.
 * Used to combine multiple SDK messages from the same API turn (same requestId).
 */
function mergeAssistantMessage(target: ChatMessage, source: ChatMessage): void {
  // Merge text content (with separator if both have content)
  if (source.content) {
    if (target.content) {
      target.content = target.content + '\n\n' + source.content;
    } else {
      target.content = source.content;
    }
  }

  // Merge tool calls
  if (source.toolCalls) {
    target.toolCalls = [...(target.toolCalls || []), ...source.toolCalls];
  }

  // Merge content blocks
  if (source.contentBlocks) {
    target.contentBlocks = [...(target.contentBlocks || []), ...source.contentBlocks];
  }
}

/**
 * Loads and converts all messages from an SDK native session.
 *
 * Uses two-pass approach:
 * 1. First pass: collect all tool_result from all messages
 * 2. Second pass: convert messages and attach results to tool calls
 *
 * Consecutive assistant messages with the same requestId are merged into one,
 * as the SDK stores multiple JSONL entries for a single API turn (text, then tool_use, etc).
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
  let pendingAssistant: ChatMessage | null = null;

  // Second pass: convert messages, merging consecutive assistant messages
  // Assistant messages are merged until an actual user message (not tool_result) appears
  for (const sdkMsg of result.messages) {
    // Skip system-injected messages (tool results, skill prompts, meta messages)
    if (isSystemInjectedMessage(sdkMsg)) continue;

    const chatMsg = parseSDKMessageToChat(sdkMsg, toolResults);
    if (!chatMsg) continue;

    if (chatMsg.role === 'assistant') {
      // Merge all consecutive assistant messages into one bubble
      if (pendingAssistant) {
        mergeAssistantMessage(pendingAssistant, chatMsg);
      } else {
        pendingAssistant = chatMsg;
      }
    } else {
      // Actual user message (not tool_result) - push any pending assistant first
      if (pendingAssistant) {
        chatMessages.push(pendingAssistant);
        pendingAssistant = null;
      }
      chatMessages.push(chatMsg);
    }
  }

  // Don't forget the last pending assistant message
  if (pendingAssistant) {
    chatMessages.push(pendingAssistant);
  }

  // Sort by timestamp ascending
  chatMessages.sort((a, b) => a.timestamp - b.timestamp);

  return { messages: chatMessages, skippedLines: result.skippedLines };
}
