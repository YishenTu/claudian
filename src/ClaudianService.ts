import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { query, type Options, type CanUseTool, type PermissionResult, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type ClaudianPlugin from './main';
import {
  StreamChunk,
  ChatMessage,
  ToolCallInfo,
  SDKMessage,
  THINKING_BUDGETS,
  ApprovedAction,
  ImageAttachment,
  ToolDiffData,
} from './types';
import { buildSystemPrompt } from './systemPrompt';
import { getVaultPath, parseEnvironmentVariables } from './utils';
import { readCachedImageBase64 } from './imageCache';

const MAX_DIFF_SIZE = 100 * 1024; // 100KB limit for diff computation

// Content block types for SDK message format
interface TextContentBlock {
  type: 'text';
  text: string;
}

interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

type ContentBlock = TextContentBlock | ImageContentBlock;

// Callback type for requesting user approval
export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string
) => Promise<'allow' | 'allow-always' | 'deny'>;

export class ClaudianService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private resolvedClaudePath: string | null = null;

  // Approval callback for UI prompts (set by ClaudianView)
  private approvalCallback: ApprovalCallback | null = null;

  // Session-scoped approved actions (cleared on session reset)
  private sessionApprovedActions: ApprovedAction[] = [];

  // Vault path for restricting agent access
  private vaultPath: string | null = null;

  // Original file content for diff computation (keyed by tool_use_id)
  private originalContents: Map<string, { filePath: string; content: string | null }> = new Map();

  // Computed diff data waiting to be retrieved (keyed by tool_use_id)
  private pendingDiffData: Map<string, ToolDiffData> = new Map();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /**
   * Find the claude CLI binary by checking common installation locations
   */
  private findClaudeCLI(): string | null {
    // Common installation locations
    const homeDir = os.homedir();
    const commonPaths = [
      path.join(homeDir, '.claude', 'local', 'claude'),
      path.join(homeDir, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(homeDir, 'bin', 'claude'),
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Send a query to Claude and stream the response
   * @param prompt The user's message
   * @param images Optional images to include with the message
   * @param conversationHistory Optional message history for session expiration recovery
   */
  async *query(prompt: string, images?: ImageAttachment[], conversationHistory?: ChatMessage[]): AsyncGenerator<StreamChunk> {
    // Get vault path
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    // Find claude CLI - cache the result
    if (!this.resolvedClaudePath) {
      this.resolvedClaudePath = this.findClaudeCLI();
    }

    if (!this.resolvedClaudePath) {
      yield { type: 'error', content: 'Claude CLI not found. Please install Claude Code CLI.' };
      return;
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    const hydratedImages = await this.hydrateImagesData(images, vaultPath);

    try {
      yield* this.queryViaSDK(prompt, vaultPath, hydratedImages);
    } catch (error) {
      // Handle session expiration - rebuild context and retry
      if (this.isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
        this.sessionId = null;

        // Rebuild context from history
        const historyContext = this.buildContextFromHistory(conversationHistory);
        const lastUserMessage = this.getLastUserMessage(conversationHistory);
        // Strip context prefix before comparison to avoid false mismatch
        // (prompt may have "Context files: [...]\n\n" prefix, but stored content doesn't)
        const actualPrompt = prompt.replace(/^Context files: \[.*?\]\n\n/, '');
        const shouldAppendPrompt = !lastUserMessage || lastUserMessage.content.trim() !== actualPrompt.trim();
        const fullPrompt = historyContext
          ? shouldAppendPrompt
            ? `${historyContext}\n\nUser: ${prompt}`
            : historyContext
          : prompt;

        // Retry without resume (note: images not included in retry for simplicity)
        const retryImages = await this.hydrateImagesData(lastUserMessage?.images, vaultPath);

        try {
          yield* this.queryViaSDK(fullPrompt, vaultPath, retryImages);
        } catch (retryError) {
          const msg = retryError instanceof Error ? retryError.message : 'Unknown error';
          yield { type: 'error', content: msg };
        }
        return;
      }

      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Build conversation context from message history
   */
  private buildContextFromHistory(messages: ChatMessage[]): string {
    const parts: string[] = [];

    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }

      if (message.role === 'assistant') {
        const hasContent = message.content && message.content.trim().length > 0;
        const hasToolResult = message.toolCalls?.some(tc => tc.result && tc.result.trim().length > 0);
        if (!hasContent && !hasToolResult) {
          continue;
        }
      }

      const role = message.role === 'user' ? 'User' : 'Assistant';
      const lines: string[] = [];
      const content = message.content?.trim();
      const contextLine = this.formatContextLine(message);
      const userPayload = contextLine
        ? content
          ? `${contextLine}\n\n${content}`
          : contextLine
        : content;
      lines.push(userPayload ? `${role}: ${userPayload}` : `${role}:`);

      if (message.role === 'assistant' && message.toolCalls?.length) {
        const toolLines = message.toolCalls
          .map(tc => this.formatToolCallForContext(tc))
          .filter(Boolean) as string[];
        if (toolLines.length > 0) {
          lines.push(...toolLines);
        }
      }

      parts.push(lines.join('\n'));
    }

    return parts.join('\n\n');
  }

  /**
   * Check if an error is a session expiration error
   * Only matches session-specific errors, not general "not found" or "invalid" errors
   */
  private isSessionExpiredError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    return msg.includes('session expired') ||
           msg.includes('session not found') ||
           msg.includes('invalid session') ||
           msg.includes('session invalid') ||
           (msg.includes('session') && msg.includes('expired')) ||
           (msg.includes('resume') && (msg.includes('failed') || msg.includes('error')));
  }

  /**
   * Get the last user message in a conversation history
   */
  private getLastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i];
      }
    }
    return undefined;
  }

  /**
   * Format a tool call line for inclusion in recovery context
   */
  private formatToolCallForContext(toolCall: ToolCallInfo): string {
    const status = toolCall.status ?? 'completed';
    const base = `[Tool ${toolCall.name} status=${status}]`;
    const hasResult = typeof toolCall.result === 'string' && toolCall.result.trim().length > 0;

    if (!hasResult) {
      return base;
    }

    const result = this.truncateToolResultForContext(toolCall.result as string);
    return `${base} result: ${result}`;
  }

  /**
   * Truncate tool result to avoid overloading recovery prompt
   */
  private truncateToolResultForContext(result: string, maxLength = 800): string {
    if (result.length > maxLength) {
      return `${result.slice(0, maxLength)}... (truncated)`;
    }
    return result;
  }

  /**
   * Format a context line for user messages when rebuilding history
   */
  private formatContextLine(message: ChatMessage): string | null {
    if (!message.contextFiles) {
      return null;
    }
    const fileList = message.contextFiles.join(', ');
    return `Context files: [${fileList}]`;
  }

  /**
   * Ensure images have base64 data loaded from cache or file paths
   */
  private async hydrateImagesData(images?: ImageAttachment[], vaultPath?: string | null): Promise<ImageAttachment[] | undefined> {
    if (!images || images.length === 0) return undefined;

    const hydrated: ImageAttachment[] = [];

    for (const image of images) {
      if (image.data) {
        hydrated.push(image);
        continue;
      }

      const base64 = await this.loadImageBase64(image, vaultPath);
      if (base64) {
        hydrated.push({ ...image, data: base64 });
      }
    }

    return hydrated.length > 0 ? hydrated : undefined;
  }

  private async loadImageBase64(image: ImageAttachment, vaultPath?: string | null): Promise<string | null> {
    if (image.cachePath) {
      const base64 = readCachedImageBase64(this.plugin.app, image.cachePath);
      if (base64) return base64;
    }

    if (image.filePath) {
      const absPath = this.resolveImagePath(image.filePath, vaultPath);
      if (absPath && fs.existsSync(absPath)) {
        try {
          const buffer = fs.readFileSync(absPath);
          return buffer.toString('base64');
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  private resolveImagePath(filePath: string, vaultPath?: string | null): string | null {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    if (vaultPath) {
      return path.join(vaultPath, filePath);
    }
    return null;
  }

  /**
   * Build a prompt with images as content blocks
   * If no images, returns the string prompt directly
   * If images present, returns an async generator yielding the message
   */
  private buildPromptWithImages(prompt: string, images?: ImageAttachment[]): string | AsyncGenerator<any> {
    // If no images, return plain string prompt
    const validImages = (images || []).filter(img => !!img.data);
    if (validImages.length === 0) {
      return prompt;
    }

    // Build content blocks array - images first, then text
    const content: ContentBlock[] = [];

    // Add image blocks first (Claude recommends images before text)
    for (const image of validImages) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data!,
        },
      });
    }

    // Add text block with the prompt
    if (prompt.trim()) {
      content.push({
        type: 'text',
        text: prompt,
      });
    }

    // Return async generator for SDK
    async function* messageGenerator() {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content,
        },
      };
    }

    return messageGenerator();
  }

  private async *queryViaSDK(prompt: string, cwd: string, images?: ImageAttachment[]): AsyncGenerator<StreamChunk> {
    const selectedModel = this.plugin.settings.model;
    const permissionMode = this.plugin.settings.permissionMode;

    // Store vault path for restriction checks
    this.vaultPath = cwd;

    // Parse custom environment variables from settings
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());

    // Build the prompt - either a string or content blocks with images
    const queryPrompt = this.buildPromptWithImages(prompt, images);

    // Build system prompt with settings
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
    });

    const options: Options = {
      cwd,
      systemPrompt,
      model: selectedModel,
      abortController: this.abortController ?? undefined,
      pathToClaudeCodeExecutable: this.resolvedClaudePath!,
      env: {
        ...process.env,     // Inherit current environment
        ...customEnv,       // Override with user's custom variables
      },
    };

    // Create hooks for security enforcement
    const securityHooks: HookCallbackMatcher[] = [
      this.createBlocklistHook(),
      this.createVaultRestrictionHook(),
    ];

    // Create file hash tracking hooks
    const fileHashPreHook = this.createFileHashPreHook();
    const fileHashPostHook = this.createFileHashPostHook();

    // Apply permission mode
    if (permissionMode === 'yolo') {
      // Yolo mode: bypass permissions but use hooks to enforce blocklist and vault restriction
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
      options.hooks = {
        PreToolUse: [...securityHooks, fileHashPreHook],
        PostToolUse: [fileHashPostHook],
      };
    } else {
      // Safe mode: use hooks for security, canUseTool for approvals
      options.permissionMode = 'default';
      options.canUseTool = this.createSafeModeCallback();
      options.hooks = {
        PreToolUse: [...securityHooks, fileHashPreHook],
        PostToolUse: [fileHashPostHook],
      };
    }

    // Enable extended thinking based on thinking budget setting
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    // Resume previous session if we have a session ID
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    try {
      const response = query({ prompt: queryPrompt, options });

      for await (const message of response) {
        // Check for cancellation
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          break;
        }

        // transformSDKMessage now yields multiple chunks
        for (const chunk of this.transformSDKMessage(message)) {
          yield chunk;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    }

    yield { type: 'done' };
  }

  /**
   * Transform SDK message to our StreamChunk format
   * Returns an array since one SDK message can contain multiple chunks
   * (e.g., assistant message with both text and tool_use blocks)
   *
   * SDK Message Types:
   * - 'system' - init, status, etc.
   * - 'assistant' - assistant response with content blocks (text, tool_use)
   * - 'user' - user messages, includes tool_use_result for tool outputs
   * - 'stream_event' - streaming deltas
   * - 'result' - final result
   */
  private *transformSDKMessage(message: SDKMessage): Generator<StreamChunk> {
    // Capture parent_tool_use_id for subagent routing
    // null = main agent, non-null = subagent context
    const parentToolUseId = message.parent_tool_use_id ?? null;

    switch (message.type) {
      case 'system':
        // Capture session ID from init message
        if (message.subtype === 'init' && message.session_id) {
          this.sessionId = message.session_id;
        }
        // Don't yield system messages to the UI
        break;

      case 'assistant':
        // Extract ALL content blocks - text, tool_use, and thinking
        if (message.message?.content && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              yield { type: 'thinking', content: block.thinking, parentToolUseId };
            } else if (block.type === 'text' && block.text) {
              yield { type: 'text', content: block.text, parentToolUseId };
            } else if (block.type === 'tool_use') {
              yield {
                type: 'tool_use',
                id: block.id || `tool-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                name: block.name || 'unknown',
                input: block.input || {},
                parentToolUseId,
              };
            }
          }
        }
        break;

      case 'user':
        // Check for blocked tool calls (from hook denials)
        if ((message as any)._blocked && (message as any)._blockReason) {
          yield {
            type: 'blocked',
            content: (message as any)._blockReason,
          };
          break;
        }
        // User messages can contain tool results
        if (message.tool_use_result !== undefined && message.parent_tool_use_id) {
          yield {
            type: 'tool_result',
            id: message.parent_tool_use_id,
            content: typeof message.tool_use_result === 'string'
              ? message.tool_use_result
              : JSON.stringify(message.tool_use_result, null, 2),
            isError: false,
            parentToolUseId,
          };
        }
        // Also check message.message.content for tool_result blocks
        if (message.message?.content && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === 'tool_result') {
              yield {
                type: 'tool_result',
                id: block.tool_use_id || message.parent_tool_use_id || '',
                content: typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content, null, 2),
                isError: block.is_error || false,
                parentToolUseId,
              };
            }
          }
        }
        break;

      case 'stream_event':
        // Handle streaming events for real-time updates
        const event = message.event;
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          yield {
            type: 'tool_use',
            id: event.content_block.id || `tool-${Date.now()}`,
            name: event.content_block.name || 'unknown',
            input: event.content_block.input || {},
            parentToolUseId,
          };
        } else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          if (event.content_block.thinking) {
            yield { type: 'thinking', content: event.content_block.thinking, parentToolUseId };
          }
        } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
          if (event.content_block.text) {
            yield { type: 'text', content: event.content_block.text, parentToolUseId };
          }
        } else if (event?.type === 'content_block_delta') {
          if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            yield { type: 'thinking', content: event.delta.thinking, parentToolUseId };
          } else if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text', content: event.delta.text, parentToolUseId };
          }
        }
        break;

      case 'result':
        // Final result - no text to extract, result is a string summary
        break;

      case 'error':
        if (message.error) {
          yield { type: 'error', content: message.error };
        }
        break;
    }
  }

  /**
   * Check if a bash command should be blocked
   */
  private shouldBlockCommand(command: string): boolean {
    if (!this.plugin.settings.enableBlocklist) {
      return false;
    }

    return this.plugin.settings.blockedCommands.some(pattern => {
      try {
        return new RegExp(pattern, 'i').test(command);
      } catch {
        // Invalid regex, try simple includes
        return command.toLowerCase().includes(pattern.toLowerCase());
      }
    });
  }

  /**
   * Cancel the current query
   */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Reset the conversation session
   * Call this when clearing the chat to start fresh
   */
  resetSession() {
    this.sessionId = null;
    // Clear session-scoped approved actions
    this.sessionApprovedActions = [];
    // Clear diff-related state
    this.clearDiffState();
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the session ID (for restoring from saved conversation)
   */
  setSessionId(id: string | null): void {
    this.sessionId = id;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.cancel();
    this.resetSession();
  }

  // ============================================
  // Approval Memory Methods
  // ============================================

  /**
   * Set the approval callback for UI prompts
   */
  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  /**
   * Create PreToolUse hook to enforce blocklist
   * This runs before EVERY tool execution, even in bypassPermissions mode
   */
  private createBlocklistHook(): HookCallbackMatcher {
    return {
      matcher: 'Bash',  // Only match Bash tool
      hooks: [
        async (hookInput, toolUseID, options) => {
          // hookInput is PreToolUseHookInput with tool_name and tool_input
          const input = hookInput as {
            tool_name: string;
            tool_input: { command?: string };
          };
          const command = input.tool_input?.command || '';

          if (this.shouldBlockCommand(command)) {
            // Use hookSpecificOutput with permissionDecision: 'deny' to block
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Command blocked by blocklist: ${command}`,
              },
            };
          }

          return { continue: true };
        },
      ],
    };
  }

  /**
   * Create PreToolUse hook to restrict file access to vault only
   * Checks Read, Write, Edit, Glob, Grep, LS tools for path violations
   */
  private createVaultRestrictionHook(): HookCallbackMatcher {
    // Match all file-related tools
    const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'Bash'];
    const editTools = ['Write', 'Edit', 'NotebookEdit'];

    return {
      hooks: [
        async (hookInput, toolUseID, options) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };

          const toolName = input.tool_name;

          // Bash: inspect command for paths that escape the vault
          if (toolName === 'Bash') {
            const command = (input.tool_input?.command as string) || '';
            const outsidePath = this.findOutsideVaultPathInCommand(command);
            if (outsidePath) {
              return {
                continue: false,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: `Access denied: Command path "${outsidePath}" is outside the vault. Agent is restricted to vault directory only.`,
                },
              };
            }
            return { continue: true };
          }

          // Skip if not a file-related tool
          if (!fileTools.includes(toolName)) {
            return { continue: true };
          }

          // Get the path from tool input
          const filePath = this.getPathFromToolInput(toolName, input.tool_input);

          if (filePath && !this.isPathWithinVault(filePath)) {
            // BUG FIX #5: Clean up edit state when blocking Write/Edit/NotebookEdit
            if (editTools.includes(toolName)) {
              this.plugin.getView()?.fileContextManager?.cancelFileEdit(toolName, input.tool_input);
            }
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Access denied: Path "${filePath}" is outside the vault. Agent is restricted to vault directory only.`,
              },
            };
          }

          return { continue: true };
        },
      ],
    };
  }

  /**
   * Extract file path from tool input based on tool type
   */
  private getPathFromToolInput(toolName: string, toolInput: Record<string, unknown>): string | null {
    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        return (toolInput.file_path as string) || (toolInput.notebook_path as string) || null;
      case 'Glob':
      case 'Grep':
      case 'LS':
        return (toolInput.path as string) || null;
      default:
        return null;
    }
  }

  /**
   * Check if a path is within the vault directory
   */
  private isPathWithinVault(filePath: string): boolean {
    if (!this.vaultPath) return true; // No restriction if vault path not set

    const vaultReal = this.resolveRealPath(this.vaultPath);
    const expandedPath = filePath.startsWith('~/')
      ? path.join(os.homedir(), filePath.slice(2))
      : filePath;
    const candidate = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(this.vaultPath, expandedPath);
    const resolvedPath = this.resolveRealPath(candidate);

    // Check if the path starts with the vault path (or is exactly the vault)
    return resolvedPath === vaultReal ||
           resolvedPath.startsWith(vaultReal + path.sep);
  }

  /**
   * Best-effort realpath that falls back to path.resolve for non-existent targets
   */
  private resolveRealPath(p: string): string {
    try {
      return (fs.realpathSync.native ?? fs.realpathSync)(p);
    } catch {
      return path.resolve(p);
    }
  }

  /**
   * Find the first command path that escapes the vault, if any
   */
  private findOutsideVaultPathInCommand(command: string): string | null {
    if (!command || !this.vaultPath) return null;

    const candidates = this.extractPathCandidates(command);
    for (const candidate of candidates) {
      const normalized = candidate.startsWith('~/')
        ? path.join(os.homedir(), candidate.slice(2))
        : candidate;

      if (!this.isPathWithinVault(normalized)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Naive tokenizer to pull out path-like segments from a bash command
   */
  private extractPathCandidates(command: string): string[] {
    const candidates = new Set<string>();
    const tokenRegex = /(['"`])(.*?)\1|[^\s]+/g;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(command)) !== null) {
      const token = match[2] ?? match[0];
      const cleaned = token.trim();
      if (!cleaned) continue;
      if (cleaned === '.' || cleaned === '/') continue;

      // Consider tokens with path separators or explicit traversal as path-like
      if (cleaned.includes(path.sep) || cleaned.startsWith('..') || cleaned.startsWith('~/')) {
        candidates.add(cleaned);
      }
    }

    return Array.from(candidates);
  }

  /**
   * Create callback for Safe mode - check approved actions, then prompt user
   * Note: Blocklist is enforced by PreToolUse hook, not here
   */
  private createSafeModeCallback(): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      // Check if action is pre-approved
      if (this.isActionApproved(toolName, input)) {
        return { behavior: 'allow', updatedInput: input };
      }

      // If no approval callback is set, deny the action
      if (!this.approvalCallback) {
        // BUG FIX #5: Clean up edit state when denying permission
        this.plugin.getView()?.fileContextManager?.cancelFileEdit(toolName, input);
        return {
          behavior: 'deny',
          message: 'No approval handler available. Please enable Yolo mode or configure permissions.',
        };
      }

      // Generate description for the user
      const description = this.getActionDescription(toolName, input);

      // Request approval from the user
      try {
        const decision = await this.approvalCallback(toolName, input, description);

        if (decision === 'deny') {
          // BUG FIX #5: Clean up edit state when user denies permission
          this.plugin.getView()?.fileContextManager?.cancelFileEdit(toolName, input);
          return {
            behavior: 'deny',
            message: 'User denied this action.',
            interrupt: false,
          };
        }

        // Approve the action and potentially save to memory
        if (decision === 'allow-always') {
          await this.approveAction(toolName, input, 'always');
        } else if (decision === 'allow') {
          this.approveAction(toolName, input, 'session');
        }

        return { behavior: 'allow', updatedInput: input };
      } catch (error) {
        // BUG FIX #5: Clean up edit state when approval fails
        this.plugin.getView()?.fileContextManager?.cancelFileEdit(toolName, input);
        return {
          behavior: 'deny',
          message: 'Approval request failed.',
          interrupt: true,
        };
      }
    };
  }

  /**
   * Check if an action is pre-approved (either session or permanent)
   */
  private isActionApproved(toolName: string, input: Record<string, unknown>): boolean {
    const pattern = this.getActionPattern(toolName, input);

    // Check session-scoped approvals
    const sessionApproved = this.sessionApprovedActions.some(
      action => action.toolName === toolName && this.matchesPattern(toolName, pattern, action.pattern)
    );
    if (sessionApproved) return true;

    // Check permanent approvals
    const permanentApproved = this.plugin.settings.approvedActions.some(
      action => action.toolName === toolName && this.matchesPattern(toolName, pattern, action.pattern)
    );
    return permanentApproved;
  }

  /**
   * Add an action to the approved list
   */
  async approveAction(toolName: string, input: Record<string, unknown>, scope: 'session' | 'always'): Promise<void> {
    const pattern = this.getActionPattern(toolName, input);
    const action: ApprovedAction = {
      toolName,
      pattern,
      approvedAt: Date.now(),
      scope,
    };

    if (scope === 'session') {
      this.sessionApprovedActions.push(action);
    } else {
      this.plugin.settings.approvedActions.push(action);
      await this.plugin.saveSettings();
    }
  }

  /**
   * Generate a pattern from tool input for matching
   */
  private getActionPattern(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return typeof input.command === 'string' ? input.command.trim() : '';
      case 'Read':
      case 'Write':
      case 'Edit':
        return (input.file_path as string) || '*';
      case 'NotebookEdit':
        return (input.notebook_path as string) || (input.file_path as string) || '*';
      case 'Glob':
        return (input.pattern as string) || '*';
      case 'Grep':
        return (input.pattern as string) || '*';
      default:
        return JSON.stringify(input);
    }
  }

  /**
   * Check if a pattern matches an approved pattern
   * Currently uses exact match, can be enhanced with glob support
   */
  private matchesPattern(toolName: string, actionPattern: string, approvedPattern: string): boolean {
    if (toolName === 'Bash') {
      return actionPattern === approvedPattern;
    }

    // Wildcard matches everything
    if (approvedPattern === '*') return true;

    // Exact match
    if (actionPattern === approvedPattern) return true;

    // Check if approved pattern is a prefix (for file paths)
    if (actionPattern.startsWith(approvedPattern)) return true;

    return false;
  }

  /**
   * Generate a human-readable description of the action
   */
  private getActionDescription(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return `Run command: ${input.command}`;
      case 'Read':
        return `Read file: ${input.file_path}`;
      case 'Write':
        return `Write to file: ${input.file_path}`;
      case 'Edit':
        return `Edit file: ${input.file_path}`;
      case 'Glob':
        return `Search files matching: ${input.pattern}`;
      case 'Grep':
        return `Search content matching: ${input.pattern}`;
      default:
        return `${toolName}: ${JSON.stringify(input)}`;
    }
  }

  /**
   * Create PreToolUse hook to capture original file hash and content before editing
   */
  private createFileHashPreHook(): HookCallbackMatcher {
    return {
      matcher: 'Write|Edit|NotebookEdit',
      hooks: [
        async (hookInput, toolUseId) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };

          // Capture original content for diff (Write/Edit only, not NotebookEdit)
          if (input.tool_name === 'Write' || input.tool_name === 'Edit') {
            const rawPath = input.tool_input.file_path;
            const filePath = typeof rawPath === 'string' && rawPath ? rawPath : undefined;

            if (filePath && this.vaultPath) {
              const fullPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.vaultPath, filePath);
              try {
                // Read original content (null if file doesn't exist)
                if (fs.existsSync(fullPath)) {
                  const stats = fs.statSync(fullPath);
                  // Limit to 100KB to prevent memory issues
                  if (stats.size <= MAX_DIFF_SIZE) {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    this.originalContents.set(toolUseId, { filePath, content });
                  } else {
                    // File too large for diff
                    this.originalContents.set(toolUseId, { filePath, content: null });
                  }
                } else {
                  // New file
                  this.originalContents.set(toolUseId, { filePath, content: '' });
                }
              } catch {
                this.originalContents.set(toolUseId, { filePath, content: null });
              }
            }
          }

          await this.plugin.getView()?.fileContextManager?.markFileBeingEdited(
            input.tool_name,
            input.tool_input
          );
          return { continue: true };
        },
      ],
    };
  }

  /**
   * Create PostToolUse hook to store post-edit hash and compute diff after tool completion
   */
  private createFileHashPostHook(): HookCallbackMatcher {
    return {
      matcher: 'Write|Edit|NotebookEdit',
      hooks: [
        async (hookInput, toolUseId) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
            tool_result?: { is_error?: boolean };
          };
          const isError = input.tool_result?.is_error ?? false;

          // Compute diff for Write/Edit (if not error)
          if (input.tool_name === 'Write' || input.tool_name === 'Edit') {
            const originalEntry = this.originalContents.get(toolUseId);
            const rawPath = input.tool_input.file_path;
            const filePath = typeof rawPath === 'string' && rawPath ? rawPath : originalEntry?.filePath;

            if (!isError && filePath && this.vaultPath) {
              const fullPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.vaultPath, filePath);

              let diffData: ToolDiffData | undefined;

              // If original was too large/unavailable, propagate skip reason
              if (originalEntry?.content === null) {
                diffData = { filePath, skippedReason: 'too_large' };
              } else {
                try {
                  if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    if (stats.size <= MAX_DIFF_SIZE) {
                      const newContent = fs.readFileSync(fullPath, 'utf-8');
                      if (originalEntry && originalEntry.content !== undefined) {
                        diffData = { filePath, originalContent: originalEntry.content, newContent };
                      } else {
                        diffData = { filePath, skippedReason: 'unavailable' };
                      }
                    } else {
                      diffData = { filePath, skippedReason: 'too_large' };
                    }
                  } else {
                    diffData = { filePath, skippedReason: 'unavailable' };
                  }
                } catch {
                  diffData = { filePath, skippedReason: 'unavailable' };
                }
              }

              if (diffData) {
                this.pendingDiffData.set(toolUseId, diffData);
              }
            }

            // Clean up original content map regardless of success/error
            this.originalContents.delete(toolUseId);
          }

          await this.plugin.getView()?.fileContextManager?.trackEditedFile(
            input.tool_name,
            input.tool_input,
            isError
          );
          return { continue: true };
        },
      ],
    };
  }

  /**
   * Get pending diff data for a tool_use_id (and remove it from pending)
   */
  getDiffData(toolUseId: string): ToolDiffData | undefined {
    const data = this.pendingDiffData.get(toolUseId);
    if (data) {
      this.pendingDiffData.delete(toolUseId);
    }
    return data;
  }

  /**
   * Clear all diff-related state (call on session reset)
   */
  clearDiffState(): void {
    this.originalContents.clear();
    this.pendingDiffData.clear();
  }
}
