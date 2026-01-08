/**
 * Claudian - Claude Agent SDK wrapper
 *
 * Handles communication with Claude via the Agent SDK. Manages streaming,
 * session persistence, permission modes, and security hooks.
 *
 * Architecture:
 * - Persistent query for active chat conversation (eliminates cold-start latency)
 * - Cold-start queries for inline edit, title generation
 * - MessageChannel for message queueing and turn management
 * - Dynamic updates (model, thinking tokens, permission mode, MCP servers)
 */

import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import type ClaudianPlugin from '../../main';
import { stripCurrentNotePrefix } from '../../utils/context';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getPathAccessType, getVaultPath } from '../../utils/path';
import { buildContextFromHistory, getLastUserMessage, isSessionExpiredError } from '../../utils/session';
import {
  createBlocklistHook,
  createFileHashPostHook,
  createFileHashPreHook,
  createVaultRestrictionHook,
  type DiffContentEntry,
  type FileEditPostCallback,
} from '../hooks';
import { hydrateImagesData } from '../images/imageLoader';
import type { McpServerManager } from '../mcp';
import { buildSystemPrompt, type SystemPromptSettings } from '../prompts/mainAgent';
import { isSessionInitEvent, isStreamChunk, transformSDKMessage } from '../sdk';
import {
  ApprovalManager,
  getActionDescription,
} from '../security';
import { TOOL_SKILL } from '../tools/toolNames';
import type {
  CCPermissions,
  ChatMessage,
  ClaudeModel,
  ImageAttachment,
  PermissionMode,
  StreamChunk,
  ToolDiffData,
} from '../types';
import { THINKING_BUDGETS } from '../types';

/** SDK tools that require canUseTool interception (not supported in bypassPermissions mode). */
const UNSUPPORTED_SDK_TOOLS = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

/**
 * Check if an SDK message signals turn completion.
 * - 'result' is the normal completion signal
 * - 'error' may also complete the turn when SDK emits an error without result
 *
 * Note: We cast to string because TypeScript's SDK types may not include 'error'
 * but it can occur at runtime.
 */
function isTurnCompleteMessage(message: SDKMessage): boolean {
  const messageType = message.type as string;
  return messageType === 'result' || messageType === 'error';
}

// ============================================
// Session Management (inlined)
// ============================================

interface SessionState {
  sessionId: string | null;
  sessionModel: ClaudeModel | null;
  pendingSessionModel: ClaudeModel | null;
  wasInterrupted: boolean;
}

class SessionManager {
  private state: SessionState = {
    sessionId: null,
    sessionModel: null,
    pendingSessionModel: null,
    wasInterrupted: false,
  };

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  setSessionId(id: string | null, defaultModel?: ClaudeModel): void {
    this.state.sessionId = id;
    this.state.sessionModel = id ? (defaultModel ?? null) : null;
  }

  wasInterrupted(): boolean {
    return this.state.wasInterrupted;
  }

  markInterrupted(): void {
    this.state.wasInterrupted = true;
  }

  clearInterrupted(): void {
    this.state.wasInterrupted = false;
  }

  setPendingModel(model: ClaudeModel): void {
    this.state.pendingSessionModel = model;
  }

  clearPendingModel(): void {
    this.state.pendingSessionModel = null;
  }

  captureSession(sessionId: string): void {
    this.state.sessionId = sessionId;
    this.state.sessionModel = this.state.pendingSessionModel;
    this.state.pendingSessionModel = null;
  }

  invalidateSession(): void {
    this.state.sessionId = null;
    this.state.sessionModel = null;
  }

  reset(): void {
    this.state = {
      sessionId: null,
      sessionModel: null,
      pendingSessionModel: null,
      wasInterrupted: false,
    };
  }
}

// ============================================
// Diff Storage (inlined)
// ============================================

class DiffStore {
  private originalContents = new Map<string, DiffContentEntry>();
  private pendingDiffData = new Map<string, ToolDiffData>();

  getOriginalContents(): Map<string, DiffContentEntry> {
    return this.originalContents;
  }

  getPendingDiffData(): Map<string, ToolDiffData> {
    return this.pendingDiffData;
  }

  getDiffData(toolUseId: string): ToolDiffData | undefined {
    const data = this.pendingDiffData.get(toolUseId);
    if (data) {
      this.pendingDiffData.delete(toolUseId);
    }
    return data;
  }

  clear(): void {
    this.originalContents.clear();
    this.pendingDiffData.clear();
  }
}

// ============================================
// MessageChannel - Queue-based AsyncIterable
// ============================================

/**
 * Message queue configuration for the persistent query channel.
 *
 * MAX_QUEUED_MESSAGES: Maximum pending messages before dropping.
 * This prevents memory buildup from rapid user input. 8 allows
 * reasonable queuing while protecting against runaway scenarios.
 *
 * MAX_MERGED_CHARS: Maximum merged text content size.
 * Text messages are merged to reduce API calls. 12000 chars allows
 * substantial batching while staying well under token limits.
 */
const MESSAGE_CHANNEL_CONFIG = {
  MAX_QUEUED_MESSAGES: 8,
  MAX_MERGED_CHARS: 12000,
};

/** Pending message in the queue (text-only for merging). */
interface PendingTextMessage {
  type: 'text';
  content: string;
}

/** Pending message with attachments (cannot be merged). */
interface PendingAttachmentMessage {
  type: 'attachment';
  message: SDKUserMessage;
}

type PendingMessage = PendingTextMessage | PendingAttachmentMessage;

/**
 * MessageChannel - Queue-based async iterable for persistent queries.
 *
 * Rules:
 * - Single in-flight turn at a time
 * - Text-only messages merge with \n\n while a turn is active
 * - Attachment messages (with images) queue one at a time; newer replaces older while turn is active
 * - Overflow policy: drop newest and warn
 */
class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: PendingMessage[] = [];
  private turnActive = false;
  private closed = false;
  private resolveNext: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private currentSessionId: string | null = null;
  private onWarning: (message: string) => void;

  constructor(onWarning: (message: string) => void = console.warn) {
    this.onWarning = onWarning;
  }

  /** Set the session ID for outgoing messages. */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /** Check if a turn is currently active. */
  isTurnActive(): boolean {
    return this.turnActive;
  }

  /** Check if the channel is closed. */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueue a message. If a turn is active:
   * - Text-only: merge with queued text (up to MAX_MERGED_CHARS)
   * - With attachments: replace any existing queued attachment (one at a time)
   */
  enqueue(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error('MessageChannel is closed');
    }

    const hasAttachments = this.messageHasAttachments(message);

    if (!this.turnActive) {
      if (this.resolveNext) {
        // Consumer is waiting - deliver immediately and mark turn active
        this.turnActive = true;
        const resolve = this.resolveNext;
        this.resolveNext = null;
        resolve({ value: message, done: false });
      } else {
        // No consumer waiting yet - queue for later pickup by next()
        // Don't set turnActive here; next() will set it when it dequeues
        if (this.queue.length >= MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES) {
          this.onWarning(`[MessageChannel] Queue full (${MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES}), dropping newest`);
          return;
        }
        if (hasAttachments) {
          this.queue.push({ type: 'attachment', message });
        } else {
          this.queue.push({ type: 'text', content: this.extractTextContent(message) });
        }
      }
      return;
    }

    // Turn is active - queue the message
    if (hasAttachments) {
      // Non-text messages are deferred as-is (one at a time)
      // Find existing attachment message or add new one
      const existingIdx = this.queue.findIndex(m => m.type === 'attachment');
      if (existingIdx >= 0) {
        // Replace existing (newer takes precedence for attachments)
        this.queue[existingIdx] = { type: 'attachment', message };
        this.onWarning('[MessageChannel] Attachment message replaced (only one can be queued)');
      } else {
        this.queue.push({ type: 'attachment', message });
      }
      return;
    }

    // Text-only - merge with existing text in queue
    const textContent = this.extractTextContent(message);
    const existingTextIdx = this.queue.findIndex(m => m.type === 'text');

    if (existingTextIdx >= 0) {
      const existing = this.queue[existingTextIdx] as PendingTextMessage;
      const mergedContent = existing.content + '\n\n' + textContent;

      // Check merged size
      if (mergedContent.length > MESSAGE_CHANNEL_CONFIG.MAX_MERGED_CHARS) {
        this.onWarning(`[MessageChannel] Merged content exceeds ${MESSAGE_CHANNEL_CONFIG.MAX_MERGED_CHARS} chars, dropping newest`);
        return;
      }

      existing.content = mergedContent;
    } else {
      // No existing text - add new
      if (this.queue.length >= MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES) {
        this.onWarning(`[MessageChannel] Queue full (${MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES}), dropping newest`);
        return;
      }
      this.queue.push({ type: 'text', content: textContent });
    }
  }

  /** Signal that the current turn has completed. */
  onTurnComplete(): void {
    this.turnActive = false;

    // Check if there's a queued message to send
    if (this.queue.length > 0 && this.resolveNext) {
      const pending = this.queue.shift()!;
      this.turnActive = true;
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: this.pendingToMessage(pending), done: false });
    }
  }

  /** Close the channel. */
  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
    }
  }

  /** Reset the channel for reuse. */
  reset(): void {
    this.queue = [];
    this.turnActive = false;
    this.closed = false;
    this.resolveNext = null;
  }

  /** Get the number of queued messages. */
  getQueueLength(): number {
    return this.queue.length;
  }

  /** AsyncIterable implementation. */
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
        }

        // If there's a queued message and no active turn, return it
        if (this.queue.length > 0 && !this.turnActive) {
          const pending = this.queue.shift()!;
          this.turnActive = true;
          return Promise.resolve({ value: this.pendingToMessage(pending), done: false });
        }

        // Wait for next message
        return new Promise((resolve) => {
          this.resolveNext = resolve;
        });
      },
    };
  }

  private messageHasAttachments(message: SDKUserMessage): boolean {
    if (!message.message?.content) return false;
    if (typeof message.message.content === 'string') return false;
    return message.message.content.some((block: { type: string }) => block.type === 'image');
  }

  private extractTextContent(message: SDKUserMessage): string {
    if (!message.message?.content) return '';
    if (typeof message.message.content === 'string') return message.message.content;
    return message.message.content
      .filter((block: { type: string }): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block: { type: 'text'; text: string }) => block.text)
      .join('\n\n');
  }

  private pendingToMessage(pending: PendingMessage): SDKUserMessage {
    if (pending.type === 'attachment') {
      return pending.message;
    }

    // Text-only - create a new SDKUserMessage
    return {
      type: 'user',
      message: {
        role: 'user',
        content: pending.content,
      },
      parent_tool_use_id: null,
      session_id: this.currentSessionId || '',
    };
  }
}

// ============================================
// Response Handler for Routing
// ============================================

interface ClosePersistentQueryOptions {
  preserveHandlers?: boolean;
}

/**
 * Handler for routing stream chunks to the appropriate query caller.
 *
 * Lifecycle:
 * 1. Created: Handler is registered via registerResponseHandler() when a query starts
 * 2. Receiving: Chunks arrive via onChunk(), sawAnyChunk and sawStreamText track state
 * 3. Terminated: Exactly one of onDone() or onError() is called when the turn ends
 *
 * Invariants:
 * - Only one handler is active at a time (MessageChannel enforces single-turn)
 * - After onDone()/onError(), the handler is unregistered and should not receive more chunks
 * - sawAnyChunk is used for crash recovery (restart if no chunks seen before error)
 * - sawStreamText prevents duplicate text from non-streamed assistant messages
 */
interface ResponseHandler {
  id: string;
  onChunk: (chunk: StreamChunk) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  sawStreamText: boolean;
  sawAnyChunk: boolean;
}

// ============================================
// Persistent Query Configuration State
// ============================================

/** Tracked configuration for detecting changes that require restart. */
interface PersistentQueryConfig {
  model: string | null;
  thinkingTokens: number | null;
  permissionMode: PermissionMode | null;
  allowDangerouslySkip: boolean;
  systemPromptKey: string;
  disallowedToolsKey: string;
  mcpServersKey: string;
  externalContextPaths: string[];
  allowedExportPaths: string[];
  settingSources: string;
  claudeCliPath: string;
}

/** Compute a stable key for system prompt inputs. */
function computeSystemPromptKey(settings: SystemPromptSettings): string {
  const parts = [
    settings.mediaFolder || '',
    settings.customPrompt || '',
    (settings.allowedExportPaths || []).sort().join('|'),
    settings.vaultPath || '',
    // Note: hasEditorContext is per-message, not tracked here
  ];
  return parts.join('::');
}

// ============================================
// SDK Content Types
// ============================================

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

type SDKContentBlock = TextContentBlock | ImageContentBlock;

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string
) => Promise<'allow' | 'allow-always' | 'deny' | 'deny-always' | 'cancel'>;

/** Options for query execution with optional overrides. */
export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  /** MCP servers @-mentioned in the prompt. */
  mcpMentions?: Set<string>;
  /** MCP servers enabled via UI selector (in addition to @-mentioned servers). */
  enabledMcpServers?: Set<string>;
  /** Force cold-start query (bypass persistent query). */
  forceColdStart?: boolean;
  /** Session-specific external context paths (directories with full access). */
  externalContextPaths?: string[];
}

/** Service for interacting with Claude via the Agent SDK. */
export class ClaudianService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];

  // Modular components
  private sessionManager = new SessionManager();
  private approvalManager: ApprovalManager;
  private diffStore = new DiffStore();
  private mcpManager: McpServerManager;
  private ccPermissions: CCPermissions = { allow: [], deny: [], ask: [] };

  // ============================================
  // Persistent Query State (Phase 1)
  // ============================================

  private persistentQuery: Query | null = null;
  private messageChannel: MessageChannel | null = null;
  private queryAbortController: AbortController | null = null;
  private responseHandlers: ResponseHandler[] = [];
  private responseConsumerRunning = false;
  private shuttingDown = false;

  // Tracked configuration for detecting changes that require restart
  private currentConfig: PersistentQueryConfig | null = null;

  // Current allowed tools for canUseTool enforcement (null = no restriction)
  private currentAllowedTools: string[] | null = null;

  // Last sent message for crash recovery (Phase 1.3)
  private lastSentMessage: SDKUserMessage | null = null;
  private lastSentQueryOptions: QueryOptions | null = null;
  private crashRecoveryAttempted = false;

  constructor(plugin: ClaudianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;

    // Initialize approval manager with access to CC permissions
    this.approvalManager = new ApprovalManager(
      () => this.ccPermissions
    );

    // Set up callbacks for persisting permissions to CC settings
    this.approvalManager.setAddAllowRuleCallback(async (rule) => {
      try {
        await this.plugin.storage.addAllowRule(rule);
        await this.loadCCPermissions();
      } catch (error) {
        console.error('[ClaudianService] Failed to persist allow rule:', rule, error);
        // Rule is still in session permissions via ApprovalManager, so action continues
      }
    });

    this.approvalManager.setAddDenyRuleCallback(async (rule) => {
      try {
        await this.plugin.storage.addDenyRule(rule);
        await this.loadCCPermissions();
      } catch (error) {
        console.error('[ClaudianService] Failed to persist deny rule:', rule, error);
        // Rule is still in session permissions via ApprovalManager, so action continues
      }
    });
  }

  /**
   * Load CC permissions from storage.
   * Called during initialization and after permission changes.
   */
  async loadCCPermissions(): Promise<void> {
    this.ccPermissions = await this.plugin.storage.getPermissions();
  }

  /** Load MCP server configurations from storage. */
  async loadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /** Reload MCP server configurations (call after settings change). */
  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  // ============================================
  // Persistent Query Lifecycle (Phase 1.3)
  // ============================================

  /**
   * Pre-warm the persistent query for faster follow-up messages.
   * Call this on plugin load with the active conversation session ID.
   */
  async preWarm(resumeSessionId?: string): Promise<void> {
    if (this.persistentQuery) {
      console.log('[ClaudianService] Persistent query already running');
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      console.warn('[ClaudianService] Cannot pre-warm: vault path not available');
      return;
    }

    const resolvedClaudePath = this.plugin.getResolvedClaudeCliPath();
    if (!resolvedClaudePath) {
      console.warn('[ClaudianService] Cannot pre-warm: Claude CLI not found');
      return;
    }

    await this.startPersistentQuery(vaultPath, resolvedClaudePath, resumeSessionId);
  }

  /**
   * Starts the persistent query for the active chat conversation.
   */
  private async startPersistentQuery(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string
  ): Promise<void> {
    if (this.persistentQuery) {
      console.warn('[ClaudianService] Persistent query already started');
      return;
    }

    this.shuttingDown = false;
    this.vaultPath = vaultPath;

    // Create message channel
    this.messageChannel = new MessageChannel((msg) => {
      console.warn(msg);
      // TODO: Could surface this warning to UI
    });

    // Create abort controller for the persistent query
    this.queryAbortController = new AbortController();

    // Build initial configuration
    const config = this.buildPersistentQueryConfig(vaultPath, cliPath);
    this.currentConfig = config;

    // Build SDK options
    const options = await this.buildPersistentQueryOptions(vaultPath, cliPath, resumeSessionId);

    // Create the persistent query with the message channel
    this.persistentQuery = agentQuery({
      prompt: this.messageChannel,
      options,
    });

    // Start the response consumer loop
    this.startResponseConsumer();

    console.log('[ClaudianService] Persistent query started', {
      resumeSessionId: resumeSessionId ?? 'new',
    });
  }

  /**
   * Closes the persistent query and cleans up resources.
   */
  closePersistentQuery(reason?: string, options?: ClosePersistentQueryOptions): void {
    if (!this.persistentQuery) {
      return;
    }

    const preserveHandlers = options?.preserveHandlers ?? false;

    console.log('[ClaudianService] Closing persistent query', { reason });

    this.shuttingDown = true;

    // Close the message channel (ends the async iterable)
    this.messageChannel?.close();

    // Interrupt the query
    void this.persistentQuery.interrupt().catch((error) => {
      // Only silence expected abort/interrupt errors during shutdown
      if (error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort') || error.message.includes('interrupt'))) {
        return;
      }
      console.warn('[ClaudianService] Unexpected error during shutdown interrupt:', error);
    });

    // Abort as backup
    this.queryAbortController?.abort();

    if (!preserveHandlers) {
      // Notify all handlers before clearing so generators don't hang forever.
      // This ensures queryViaPersistent() exits its while(!state.done) loop.
      for (const handler of this.responseHandlers) {
        handler.onDone();
      }
    }

    // Clear state
    this.persistentQuery = null;
    this.messageChannel = null;
    this.queryAbortController = null;
    this.responseConsumerRunning = false;
    this.currentConfig = null;
    if (!preserveHandlers) {
      this.responseHandlers = [];
      this.currentAllowedTools = null;
    }

    // Reset crash recovery flag for next session
    this.crashRecoveryAttempted = false;

    // Reset shuttingDown flag so next query can start a new persistent query.
    // This must be done after all cleanup to prevent race conditions with the consumer loop.
    this.shuttingDown = false;
  }

  /**
   * Restarts the persistent query (e.g., after configuration change).
   */
  async restartPersistentQuery(reason?: string, options?: ClosePersistentQueryOptions): Promise<void> {
    console.log('[ClaudianService] Restarting persistent query', { reason });

    const sessionId = this.sessionManager.getSessionId();
    this.closePersistentQuery(reason, options);

    const vaultPath = getVaultPath(this.plugin.app);
    const cliPath = this.plugin.getResolvedClaudeCliPath();

    if (vaultPath && cliPath) {
      await this.startPersistentQuery(vaultPath, cliPath, sessionId ?? undefined);
    } else {
      console.warn('[ClaudianService] Cannot restart persistent query:', {
        hasVaultPath: !!vaultPath,
        hasCliPath: !!cliPath,
        reason,
      });
    }
  }

  /**
   * Checks if the persistent query needs to be restarted based on configuration changes.
   */
  private needsRestart(newConfig: PersistentQueryConfig): boolean {
    if (!this.currentConfig) return true;

    // These require restart (cannot be updated dynamically)
    if (this.currentConfig.systemPromptKey !== newConfig.systemPromptKey) return true;
    if (this.currentConfig.disallowedToolsKey !== newConfig.disallowedToolsKey) return true;
    if (this.currentConfig.settingSources !== newConfig.settingSources) return true;
    if (this.currentConfig.claudeCliPath !== newConfig.claudeCliPath) return true;

    // Note: allowDangerouslySkip (YOLO mode) is handled in ensurePersistentQuery's
    // permission mode section via restart (normal→YOLO) or setPermissionMode (YOLO→normal)

    // Export paths affect system prompt
    const oldExport = [...(this.currentConfig.allowedExportPaths || [])].sort().join('|');
    const newExport = [...(newConfig.allowedExportPaths || [])].sort().join('|');
    if (oldExport !== newExport) return true;

    return false;
  }

  /**
   * Builds configuration object for tracking changes.
   */
  private buildPersistentQueryConfig(vaultPath: string, cliPath: string): PersistentQueryConfig {
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      vaultPath,
    };

    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    const thinkingTokens = budgetConfig?.tokens ?? null;

    // Compute disallowedToolsKey from all disabled MCP tools (pre-registered upfront)
    const allDisallowedTools = this.mcpManager.getAllDisallowedMcpTools();
    const disallowedToolsKey = allDisallowedTools.join('|');

    return {
      model: this.plugin.settings.model,
      thinkingTokens: thinkingTokens && thinkingTokens > 0 ? thinkingTokens : null,
      permissionMode: this.plugin.settings.permissionMode,
      allowDangerouslySkip: this.plugin.settings.permissionMode === 'yolo',
      systemPromptKey: computeSystemPromptKey(systemPromptSettings),
      disallowedToolsKey,
      mcpServersKey: '', // Dynamic via setMcpServers, not tracked for restart
      externalContextPaths: [],
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      settingSources: this.plugin.settings.loadUserClaudeSettings ? 'user,project' : 'project',
      claudeCliPath: cliPath,
    };
  }

  /**
   * Builds SDK options for the persistent query.
   */
  private async buildPersistentQueryOptions(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string
  ): Promise<Options> {
    const selectedModel = this.plugin.settings.model;
    const permissionMode = this.plugin.settings.permissionMode;

    // Parse custom environment variables
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      vaultPath,
      hasEditorContext: true, // Always include editor selection instructions
    });

    const options: Options = {
      cwd: vaultPath,
      systemPrompt,
      model: selectedModel,
      abortController: this.queryAbortController ?? undefined,
      pathToClaudeCodeExecutable: cliPath,
      settingSources: this.plugin.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...customEnv,
        PATH: enhancedPath,
      },
      includePartialMessages: true, // Enable streaming (Phase 4)
    };

    // Pre-register all disabled MCP tools and hide unsupported SDK tools
    const allDisallowedTools = [
      ...this.mcpManager.getAllDisallowedMcpTools(),
      ...UNSUPPORTED_SDK_TOOLS,
    ];
    options.disallowedTools = allDisallowedTools;

    // Set permission mode
    if (permissionMode === 'yolo') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.permissionMode = 'default';
    }

    // Add thinking budget
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    // Add canUseTool for normal mode approval flow (YOLO mode bypasses this entirely)
    if (permissionMode !== 'yolo') {
      options.canUseTool = this.createApprovalCallback();
    }

    // Add hooks
    const blocklistHook = createBlocklistHook(() => ({
      blockedCommands: this.plugin.settings.blockedCommands,
      enableBlocklist: this.plugin.settings.enableBlocklist,
    }));

    const vaultRestrictionHook = createVaultRestrictionHook({
      getPathAccessType: (p) => {
        if (!this.vaultPath) return 'vault';
        return getPathAccessType(
          p,
          this.currentExternalContextPaths,
          this.plugin.settings.allowedExportPaths,
          this.vaultPath
        );
      },
    });

    const postCallback: FileEditPostCallback = {
      trackEditedFile: async (_name, _input, isError) => {
        // File tracking is delegated to PreToolUse/PostToolUse hooks
        if (isError) {
          console.warn('[ClaudianService] trackEditedFile received error for tool:', _name);
        }
      },
    };

    const fileHashPreHook = createFileHashPreHook(
      vaultPath,
      this.diffStore.getOriginalContents()
    );
    const fileHashPostHook = createFileHashPostHook(
      vaultPath,
      this.diffStore.getOriginalContents(),
      this.diffStore.getPendingDiffData(),
      postCallback
    );

    options.hooks = {
      PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
      PostToolUse: [fileHashPostHook],
    };

    // Resume session if provided
    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    return options;
  }

  // ============================================
  // Response Consumer Loop (Phase 1.4)
  // ============================================

  /**
   * Starts the background consumer loop that routes chunks to handlers.
   */
  private startResponseConsumer(): void {
    if (this.responseConsumerRunning) {
      console.warn('[ClaudianService] Response consumer already running');
      return;
    }

    this.responseConsumerRunning = true;

    // Track which query this consumer is for, to detect if we were replaced
    const queryForThisConsumer = this.persistentQuery;

    void (async () => {
      if (!this.persistentQuery) return;

      try {
        for await (const message of this.persistentQuery) {
          if (this.shuttingDown) break;

          await this.routeMessage(message);
        }
      } catch (error) {
        if (!this.shuttingDown) {
          console.error('[ClaudianService] Response consumer error:', error);
          const handler = this.responseHandlers[this.responseHandlers.length - 1];
          const errorInstance = error instanceof Error ? error : new Error(String(error));
          const messageToReplay = this.lastSentMessage;

          if (!this.crashRecoveryAttempted && messageToReplay && handler && !handler.sawAnyChunk) {
            this.crashRecoveryAttempted = true;
            try {
              await this.restartPersistentQuery('consumer error', { preserveHandlers: true });
              if (!this.messageChannel) {
                throw new Error('Persistent query restart did not create message channel');
              }
              await this.applyDynamicUpdates(this.lastSentQueryOptions ?? undefined, { preserveHandlers: true });
              this.messageChannel.enqueue(messageToReplay);
              return;
            } catch (restartError) {
              console.error('[ClaudianService] Failed to restart after consumer error:', restartError);
              handler.onError(errorInstance);
              return;
            }
          }

          // Notify active handler of error
          if (handler) {
            handler.onError(errorInstance);
          }

          // Crash recovery: restart persistent query to prepare for next user message.
          if (!this.crashRecoveryAttempted) {
            this.crashRecoveryAttempted = true;
            try {
              await this.restartPersistentQuery('consumer error');
            } catch (restartError) {
              console.error('[ClaudianService] Failed to restart after consumer error:', restartError);
            }
          }
        }
      } finally {
        // Only clear the flag if this consumer wasn't replaced by a new one (e.g., after restart)
        // If restartPersistentQuery() was called, it starts a new consumer which sets the flag true,
        // so we shouldn't clear it here.
        if (this.persistentQuery === queryForThisConsumer || this.persistentQuery === null) {
          this.responseConsumerRunning = false;
        }
      }
    })();
  }

  /**
   * Routes an SDK message to the active response handler.
   *
   * Design: Only one handler exists at a time because MessageChannel enforces
   * single-turn processing. When a turn is active, new messages are queued/merged.
   * The next message only dequeues after onTurnComplete(), which calls onDone()
   * on the current handler. A new handler is registered only when the next query starts.
   */
  private async routeMessage(message: SDKMessage): Promise<void> {
    // Safe to use last handler - design guarantees single handler at a time
    const handler = this.responseHandlers[this.responseHandlers.length - 1];
    if (handler && this.isStreamTextEvent(message)) {
      handler.sawStreamText = true;
    }

    // Transform SDK message to StreamChunks
    const selectedModel = this.plugin.settings.model;
    for (const event of transformSDKMessage(message, { intendedModel: selectedModel })) {
      if (isSessionInitEvent(event)) {
        this.sessionManager.captureSession(event.sessionId);
        this.messageChannel?.setSessionId(event.sessionId);
      } else if (isStreamChunk(event)) {
        if (message.type === 'assistant' && handler?.sawStreamText && event.type === 'text') {
          continue;
        }
        if (handler) {
          // Add sessionId to usage chunks (consistent with cold-start path)
          if (event.type === 'usage') {
            handler.onChunk({ ...event, sessionId: this.sessionManager.getSessionId() });
          } else {
            handler.onChunk(event);
          }
        } else {
          // This indicates a timing issue - chunks arriving without a registered handler
          console.error('[ClaudianService] Chunk discarded - no handler registered:', {
            type: event.type,
            handlerCount: this.responseHandlers.length,
            channelClosed: this.messageChannel?.isClosed() ?? 'no channel',
            turnActive: this.messageChannel?.isTurnActive() ?? 'no channel',
            shuttingDown: this.shuttingDown,
            sessionId: this.sessionManager.getSessionId(),
          });
        }
      }
    }

    // Check for turn completion
    if (isTurnCompleteMessage(message)) {
      // Signal turn complete to message channel
      this.messageChannel?.onTurnComplete();

      // Notify handler
      if (handler) {
        handler.sawStreamText = false;
        handler.onDone();
      }
    }
  }

  /**
   * Registers a response handler for an active query.
   */
  private registerResponseHandler(handler: ResponseHandler): void {
    this.responseHandlers.push(handler);
  }

  /**
   * Unregisters a response handler.
   */
  private unregisterResponseHandler(handlerId: string): void {
    const idx = this.responseHandlers.findIndex(h => h.id === handlerId);
    if (idx >= 0) {
      this.responseHandlers.splice(idx, 1);
    }
  }

  /** Check if persistent query is active. */
  isPersistentQueryActive(): boolean {
    return this.persistentQuery !== null && !this.shuttingDown;
  }

  /**
   * Sends a query to Claude and streams the response.
   *
   * Query selection:
   * - Persistent query: default chat conversation
   * - Cold-start query: only when forceColdStart is set
   */
  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const resolvedClaudePath = this.plugin.getResolvedClaudeCliPath();
    if (!resolvedClaudePath) {
      yield { type: 'error', content: 'Claude CLI not found. Please install Claude Code CLI.' };
      return;
    }

    // Rebuild history if needed before choosing persistent vs cold-start
    let promptToSend = prompt;
    let forceColdStart = false;

    if (this.sessionManager.wasInterrupted() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      if (historyContext) {
        promptToSend = `${historyContext}\n\nUser: ${prompt}`;
      }
      this.sessionManager.invalidateSession();
      this.sessionManager.clearInterrupted();
      forceColdStart = true;
    }

    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      if (conversationHistory && conversationHistory.length > 0) {
        const historyContext = buildContextFromHistory(conversationHistory);
        const lastUserMessage = getLastUserMessage(conversationHistory);
        const actualPrompt = stripCurrentNotePrefix(prompt);
        const shouldAppendPrompt = !lastUserMessage || lastUserMessage.content.trim() !== actualPrompt.trim();
        promptToSend = historyContext
          ? shouldAppendPrompt
            ? `${historyContext}\n\nUser: ${prompt}`
            : historyContext
          : prompt;
      }

      this.sessionManager.invalidateSession();
      forceColdStart = true;
    }

    const effectiveQueryOptions = forceColdStart
      ? { ...queryOptions, forceColdStart: true }
      : queryOptions;

    if (forceColdStart) {
      this.closePersistentQuery('session invalidated');
    }

    // Determine query path: persistent vs cold-start
    const shouldUsePersistent = this.shouldUsePersistentQuery(effectiveQueryOptions);

    if (shouldUsePersistent) {
      // Start persistent query if not running
      if (!this.persistentQuery && !this.shuttingDown) {
        await this.startPersistentQuery(
          vaultPath,
          resolvedClaudePath,
          this.sessionManager.getSessionId() ?? undefined
        );
      }

      if (this.persistentQuery && !this.shuttingDown) {
        // Use persistent query path
        yield* this.queryViaPersistent(promptToSend, images, vaultPath, resolvedClaudePath, effectiveQueryOptions);
        return;
      }
    }

    // Cold-start path (existing logic)
    this.abortController = new AbortController();

    const hydratedImages = await hydrateImagesData(this.plugin.app, images, vaultPath);

    try {
      yield* this.queryViaSDK(promptToSend, vaultPath, resolvedClaudePath, hydratedImages, effectiveQueryOptions);
    } catch (error) {
      if (isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
        this.sessionManager.invalidateSession();

        const historyContext = buildContextFromHistory(conversationHistory);
        const lastUserMessage = getLastUserMessage(conversationHistory);
        const actualPrompt = stripCurrentNotePrefix(prompt);
        const shouldAppendPrompt = !lastUserMessage || lastUserMessage.content.trim() !== actualPrompt.trim();
        const fullPrompt = historyContext
          ? shouldAppendPrompt
            ? `${historyContext}\n\nUser: ${prompt}`
            : historyContext
          : prompt;

        const retryImages = await hydrateImagesData(this.plugin.app, lastUserMessage?.images, vaultPath);

        try {
          yield* this.queryViaSDK(fullPrompt, vaultPath, resolvedClaudePath, retryImages, effectiveQueryOptions);
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
   * Determines if the persistent query should be used.
   * Cold-start is only used when forceColdStart is set.
   */
  private shouldUsePersistentQuery(queryOptions?: QueryOptions): boolean {
    if (queryOptions?.forceColdStart) return false;
    return true;
  }

  /**
   * Query via persistent query (Phase 1.5).
   * Uses the message channel to send messages without cold-start latency.
   */
  private async *queryViaPersistent(
    prompt: string,
    images: ImageAttachment[] | undefined,
    vaultPath: string,
    cliPath: string,
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    if (!this.persistentQuery || !this.messageChannel) {
      // Fallback to cold-start if persistent query not available
      console.warn('[ClaudianService] Persistent query not available, falling back to cold-start');
      const hydratedImages = await hydrateImagesData(this.plugin.app, images, vaultPath);
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, hydratedImages, queryOptions);
      return;
    }

    // Hydrate images
    const hydratedImages = await hydrateImagesData(this.plugin.app, images, vaultPath);

    // Set allowed tools for canUseTool enforcement
    // undefined = no restriction, [] = no tools, [...] = restricted
    if (queryOptions?.allowedTools !== undefined) {
      this.currentAllowedTools = queryOptions.allowedTools.length > 0
        ? [...queryOptions.allowedTools, TOOL_SKILL]
        : [];
    } else {
      this.currentAllowedTools = null;
    }

    // Save allowedTools before applyDynamicUpdates - restart would clear it
    const savedAllowedTools = this.currentAllowedTools;

    // Apply dynamic updates before sending (Phase 1.6)
    await this.applyDynamicUpdates(queryOptions);

    // Restore allowedTools in case restart cleared it
    this.currentAllowedTools = savedAllowedTools;

    // Check if applyDynamicUpdates triggered a restart that failed
    // (e.g., CLI path not found, vault path missing)
    if (!this.persistentQuery || !this.messageChannel) {
      console.warn('[ClaudianService] Persistent query lost after applyDynamicUpdates, falling back to cold-start');
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, hydratedImages, queryOptions);
      return;
    }
    if (!this.responseConsumerRunning) {
      console.warn('[ClaudianService] Response consumer not running, falling back to cold-start');
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, hydratedImages, queryOptions);
      return;
    }

    // Build SDKUserMessage
    const message = this.buildSDKUserMessage(prompt, hydratedImages);

    // Create a promise-based handler to yield chunks
    // Use a mutable state object to work around TypeScript's control flow analysis
    const state = {
      chunks: [] as StreamChunk[],
      resolveChunk: null as ((chunk: StreamChunk | null) => void) | null,
      done: false,
      error: null as Error | null,
    };

    const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handler: ResponseHandler = {
      id: handlerId,
      onChunk: (chunk) => {
        handler.sawAnyChunk = true;
        if (state.resolveChunk) {
          state.resolveChunk(chunk);
          state.resolveChunk = null;
        } else {
          state.chunks.push(chunk);
        }
      },
      onDone: () => {
        state.done = true;
        if (state.resolveChunk) {
          state.resolveChunk(null);
          state.resolveChunk = null;
        }
      },
      onError: (err) => {
        state.error = err;
        state.done = true;
        if (state.resolveChunk) {
          state.resolveChunk(null);
          state.resolveChunk = null;
        }
      },
      sawStreamText: false,
      sawAnyChunk: false,
    };

    this.registerResponseHandler(handler);

    try {
      // Track message for crash recovery (Phase 1.3)
      this.lastSentMessage = message;
      this.lastSentQueryOptions = queryOptions ?? null;
      this.crashRecoveryAttempted = false;

      // Enqueue the message with race condition protection
      // The channel could close between our null check above and this call
      try {
        this.messageChannel.enqueue(message);
      } catch (error) {
        if (error instanceof Error && error.message.includes('closed')) {
          console.warn('[ClaudianService] MessageChannel closed during enqueue, falling back to cold-start');
          yield* this.queryViaSDK(prompt, vaultPath, cliPath, hydratedImages, queryOptions);
          return;
        }
        throw error;
      }

      // Yield chunks as they arrive
      while (!state.done) {
        if (state.chunks.length > 0) {
          yield state.chunks.shift()!;
        } else {
          const chunk = await new Promise<StreamChunk | null>((resolve) => {
            state.resolveChunk = resolve;
          });
          if (chunk) {
            yield chunk;
          }
        }
      }

      // Yield any remaining chunks
      while (state.chunks.length > 0) {
        yield state.chunks.shift()!;
      }

      // Check if an error occurred (assigned in onError callback)
      if (state.error) {
        yield { type: 'error', content: state.error.message };
      }

      // Clear message tracking after completion
      this.lastSentMessage = null;
      this.lastSentQueryOptions = null;

      yield { type: 'done' };
    } finally {
      this.unregisterResponseHandler(handlerId);
      this.currentAllowedTools = null;
    }
  }

  /**
   * Builds an SDKUserMessage from prompt and images.
   */
  private buildSDKUserMessage(prompt: string, images?: ImageAttachment[]): SDKUserMessage {
    const validImages = (images || []).filter(img => !!img.data);

    if (validImages.length === 0) {
      return {
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
        parent_tool_use_id: null,
        session_id: this.sessionManager.getSessionId() || '',
      };
    }

    // Build content blocks with images
    const content: SDKContentBlock[] = [];

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

    if (prompt.trim()) {
      content.push({
        type: 'text',
        text: prompt,
      });
    }

    return {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: this.sessionManager.getSessionId() || '',
    };
  }

  /**
   * Apply dynamic updates to the persistent query before sending a message (Phase 1.6).
   */
  private async applyDynamicUpdates(
    queryOptions?: QueryOptions,
    restartOptions?: ClosePersistentQueryOptions,
    allowRestart = true
  ): Promise<void> {
    if (!this.persistentQuery) return;

    // Guard against null vaultPath/cliPath (shouldn't happen if persistentQuery exists, but be safe)
    if (!this.vaultPath) {
      console.warn('[ClaudianService] applyDynamicUpdates called without vaultPath');
      return;
    }
    const cliPath = this.plugin.getResolvedClaudeCliPath();
    if (!cliPath) {
      console.warn('[ClaudianService] applyDynamicUpdates called without CLI path');
      return;
    }

    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    const permissionMode = this.plugin.settings.permissionMode;
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    const thinkingTokens = budgetConfig?.tokens ?? null;

    // Update model if changed
    if (this.currentConfig && selectedModel !== this.currentConfig.model) {
      console.log('[ClaudianService] Updating model:', selectedModel);
      await this.persistentQuery.setModel(selectedModel);
      this.currentConfig.model = selectedModel;
    }

    // Update thinking tokens if changed
    const currentThinking = this.currentConfig?.thinkingTokens ?? null;
    if (thinkingTokens !== currentThinking) {
      console.log('[ClaudianService] Updating thinking tokens:', thinkingTokens);
      await this.persistentQuery.setMaxThinkingTokens(thinkingTokens);
      if (this.currentConfig) {
        this.currentConfig.thinkingTokens = thinkingTokens;
      }
    }

    // Update permission mode if changed (except YOLO toggle which requires restart)
    // Note: Switching from normal to YOLO requires restart (allowDangerouslySkipPermissions)
    // Switching from YOLO to normal can use setPermissionMode
    if (this.currentConfig && permissionMode !== this.currentConfig.permissionMode) {
      if (permissionMode === 'yolo' && this.currentConfig.permissionMode !== 'yolo') {
        // Switching TO YOLO requires restart
        console.log('[ClaudianService] Permission mode change to YOLO requires restart');
        if (!allowRestart) {
          return;
        }
        await this.restartPersistentQuery('permission mode change to YOLO', restartOptions);
        if (allowRestart && this.persistentQuery) {
          await this.applyDynamicUpdates(queryOptions, restartOptions, false);
        }
        return;
      } else if (permissionMode !== 'yolo') {
        // Can update via setPermissionMode (normal mode uses 'default')
        console.log('[ClaudianService] Updating permission mode: default');
        await this.persistentQuery.setPermissionMode('default');
        this.currentConfig.permissionMode = permissionMode;
        this.currentConfig.allowDangerouslySkip = false;
      }
    }

    // Update MCP servers if changed
    const mcpMentions = queryOptions?.mcpMentions || new Set<string>();
    const uiEnabledServers = queryOptions?.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    const mcpServers = this.mcpManager.getActiveServers(combinedMentions);
    // Include full config in key so config changes (not just name changes) trigger update
    const mcpServersKey = JSON.stringify(mcpServers);

    if (this.currentConfig && mcpServersKey !== this.currentConfig.mcpServersKey) {
      console.log('[ClaudianService] Updating MCP servers');
      // Convert to McpServerConfig format
      const serverConfigs: Record<string, McpServerConfig> = {};
      for (const [name, config] of Object.entries(mcpServers)) {
        serverConfigs[name] = config as McpServerConfig;
      }
      await this.persistentQuery.setMcpServers(serverConfigs);
      this.currentConfig.mcpServersKey = mcpServersKey;
    }

    // External context paths are injected per message; track but do not restart.
    if (this.currentConfig) {
      this.currentConfig.externalContextPaths = queryOptions?.externalContextPaths || [];
    }
    this.currentExternalContextPaths = queryOptions?.externalContextPaths || [];

    // Check for other changes that require restart
    const newConfig = this.buildPersistentQueryConfig(this.vaultPath, cliPath);
    if (this.needsRestart(newConfig)) {
      console.log('[ClaudianService] Configuration change requires restart');
      if (!allowRestart) {
        return;
      }
      await this.restartPersistentQuery('configuration change', restartOptions);
      if (allowRestart && this.persistentQuery) {
        await this.applyDynamicUpdates(queryOptions, restartOptions, false);
      }
    }
  }

  private isStreamTextEvent(message: SDKMessage): boolean {
    if (message.type !== 'stream_event') return false;
    const event = message.event;
    if (!event) return false;
    if (event.type === 'content_block_start') {
      return event.content_block?.type === 'text';
    }
    if (event.type === 'content_block_delta') {
      return event.delta?.type === 'text_delta';
    }
    return false;
  }

  /**
   * Build a prompt with images as content blocks
   */
  private buildPromptWithImages(prompt: string, images?: ImageAttachment[]): string | AsyncGenerator<any> {
    const validImages = (images || []).filter(img => !!img.data);
    if (validImages.length === 0) {
      return prompt;
    }

    const content: SDKContentBlock[] = [];

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

  private async *queryViaSDK(
    prompt: string,
    cwd: string,
    cliPath: string,
    images?: ImageAttachment[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    const permissionMode = this.plugin.settings.permissionMode;

    this.sessionManager.setPendingModel(selectedModel);
    this.vaultPath = cwd;

    // Parse custom environment variables from settings
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());

    // Enhance PATH for GUI apps (Obsidian has minimal PATH)
    // User-specified PATH from settings takes priority
    // Pass CLI path so we can auto-detect Node.js if using .js file
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);

    // Build the prompt - either a string or content blocks with images
    const queryPrompt = this.buildPromptWithImages(prompt, images);

    // Build system prompt with settings
    const hasEditorContext = prompt.includes('<editor_selection');
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      vaultPath: cwd,
      hasEditorContext,
    });


    const options: Options = {
      cwd,
      systemPrompt,
      model: selectedModel,
      abortController: this.abortController ?? undefined,
      pathToClaudeCodeExecutable: cliPath,
      // Load project settings. Optionally load user settings if enabled.
      // Note: User settings (~/.claude/settings.json) may contain permission rules
      // that bypass Claudian's permission system. Skills from ~/.claude/skills/
      // are still discovered regardless (not in settings.json).
      settingSources: this.plugin.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...customEnv,
        PATH: enhancedPath,
      },
      includePartialMessages: true, // Enable streaming (Phase 4)
    };

    // Add MCP servers to options
    // Combine @-mentioned servers (from caller) with UI-enabled servers
    const mcpMentions = queryOptions?.mcpMentions || new Set<string>();
    const uiEnabledServers = queryOptions?.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    const mcpServers = this.mcpManager.getActiveServers(combinedMentions);

    if (Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    // Disallow MCP tools from inactive servers and unsupported SDK tools
    const disallowedMcpTools = this.mcpManager.getDisallowedMcpTools(combinedMentions);
    options.disallowedTools = [
      ...disallowedMcpTools,
      ...UNSUPPORTED_SDK_TOOLS,
    ];

    // Create hooks for security enforcement
    const blocklistHook = createBlocklistHook(() => ({
      blockedCommands: this.plugin.settings.blockedCommands,
      enableBlocklist: this.plugin.settings.enableBlocklist,
    }));

    // External context paths (added via folder icon in UI)
    const externalContextPaths = queryOptions?.externalContextPaths || [];

    const vaultRestrictionHook = createVaultRestrictionHook({
      getPathAccessType: (p) => {
        if (!this.vaultPath) return 'vault';
        return getPathAccessType(
          p,
          externalContextPaths,
          this.plugin.settings.allowedExportPaths,
          this.vaultPath
        );
      },
    });

    // Create file tracking callbacks
    const postCallback: FileEditPostCallback = {
      trackEditedFile: async (_name, _input, isError) => {
        // File tracking is delegated to PreToolUse/PostToolUse hooks
        if (isError) {
          console.warn('[ClaudianService] trackEditedFile received error for tool:', _name);
        }
      },
    };

    // Create file hash tracking hooks
    const fileHashPreHook = createFileHashPreHook(
      this.vaultPath,
      this.diffStore.getOriginalContents()
    );
    const fileHashPostHook = createFileHashPostHook(
      this.vaultPath,
      this.diffStore.getOriginalContents(),
      this.diffStore.getPendingDiffData(),
      postCallback
    );

    // Set permission mode
    if (permissionMode === 'yolo') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.permissionMode = 'default';
      // Add canUseTool for normal mode approval flow
      options.canUseTool = this.createApprovalCallback();
    }

    options.hooks = {
      PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
      PostToolUse: [fileHashPostHook],
    };

    // Enable extended thinking based on thinking budget setting
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    // Apply tool restriction for cold-start queries
    // Cold-start uses options.tools for hard restriction (not canUseTool)
    if (queryOptions?.allowedTools !== undefined && queryOptions.allowedTools.length > 0) {
      // Include Skill tool for consistency
      const toolSet = new Set([...queryOptions.allowedTools, TOOL_SKILL]);
      options.tools = [...toolSet];
    }
    // If undefined or empty: no restriction (use default tools)

    // Resume previous session if we have a session ID
    const sessionId = this.sessionManager.getSessionId();
    if (sessionId) {
      options.resume = sessionId;
    }

    let sawStreamText = false;
    try {
      const response = agentQuery({ prompt: queryPrompt, options });
      let streamSessionId: string | null = this.sessionManager.getSessionId();

      for await (const message of response) {
        if (this.isStreamTextEvent(message)) {
          sawStreamText = true;
        }
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          break;
        }

        for (const event of transformSDKMessage(message, { intendedModel: selectedModel })) {
          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
            streamSessionId = event.sessionId;
          } else if (isStreamChunk(event)) {
            if (message.type === 'assistant' && sawStreamText && event.type === 'text') {
              continue;
            }
            if (event.type === 'usage') {
              yield { ...event, sessionId: streamSessionId };
            } else {
              yield event;
            }
          }
        }

        if (message.type === 'result') {
          sawStreamText = false;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.sessionManager.clearPendingModel();
      this.currentAllowedTools = null; // Clear tool restriction after query
    }

    yield { type: 'done' };
  }

  /** Cancel the current query. */
  cancel() {
    // Cancel cold-start query
    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }

    // Interrupt persistent query (Phase 1.9)
    if (this.persistentQuery && !this.shuttingDown) {
      void this.persistentQuery.interrupt().catch((error) => {
        // Only silence expected abort/interrupt errors
        if (error instanceof Error &&
          (error.name === 'AbortError' || error.message.includes('abort') || error.message.includes('interrupt'))) {
          return;
        }
        console.warn('[ClaudianService] Unexpected error during cancel interrupt:', error);
      });
    }
  }

  /**
   * Reset the conversation session.
   * Closes the persistent query since session is changing.
   */
  resetSession() {
    // Close persistent query (new session will use cold-start resume)
    this.closePersistentQuery('session reset');

    this.sessionManager.reset();
    this.approvalManager.clearSessionPermissions();
    this.diffStore.clear();
  }

  /** Get the current session ID. */
  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /**
   * Set the session ID (for restoring from saved conversation).
   * Closes the persistent query since session is switching.
   */
  setSessionId(id: string | null): void {
    // Close persistent query when switching sessions
    const currentId = this.sessionManager.getSessionId();
    if (currentId !== id) {
      this.closePersistentQuery('session switch');
    }

    this.sessionManager.setSessionId(id, this.plugin.settings.model);
  }

  /**
   * Cleanup resources (Phase 5).
   * Called on plugin unload to close persistent query and abort any cold-start query.
   */
  cleanup() {
    // Close persistent query
    this.closePersistentQuery('plugin cleanup');

    // Cancel any in-flight cold-start query
    this.cancel();
    this.resetSession();
  }

  /** Sets the approval callback for UI prompts. */
  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  /** Get pending diff data for a tool_use_id (and remove it from pending). */
  getDiffData(toolUseId: string): ToolDiffData | undefined {
    return this.diffStore.getDiffData(toolUseId);
  }

  /** Clear all diff-related state. */
  clearDiffState(): void {
    this.diffStore.clear();
  }

  /**
   * Create approval callback for normal mode.
   * Enforces tool restrictions and handles approval flow.
   */
  private createApprovalCallback(): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      // Enforce allowedTools restriction
      if (this.currentAllowedTools !== null) {
        if (!this.currentAllowedTools.includes(toolName) && toolName !== TOOL_SKILL) {
          const allowedList = this.currentAllowedTools.length > 0
            ? ` Allowed tools: ${this.currentAllowedTools.join(', ')}.`
            : ' No tools are allowed for this query type.';
          return {
            behavior: 'deny',
            message: `Tool "${toolName}" is not allowed for this query.${allowedList}`,
          };
        }
      }

      // Use approval flow for normal mode
      return this.handleNormalModeApproval(toolName, input);
    };
  }

  /**
   * Handle normal mode approval - check approved actions, then prompt user.
   */
  private async handleNormalModeApproval(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> {
    // Check if action is pre-approved
    if (this.approvalManager.isActionApproved(toolName, input)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // If no approval callback is set, deny the action
    if (!this.approvalCallback) {
      return {
        behavior: 'deny',
        message: 'No approval handler available. Please enable YOLO mode or configure permissions.',
      };
    }

    // Generate description for the user
    const description = getActionDescription(toolName, input);

    // Request approval from the user
    try {
      const decision = await this.approvalCallback(toolName, input, description);

      if (decision === 'cancel') {
        // User pressed Escape - interrupt the stream like in Claude Code
        return {
          behavior: 'deny',
          message: 'User interrupted.',
          interrupt: true,
        };
      }

      if (decision === 'deny') {
        // User explicitly clicked Deny button - continue with denial (session only)
        await this.approvalManager.denyAction(toolName, input, 'session');
        return {
          behavior: 'deny',
          message: 'User denied this action.',
          interrupt: false,
        };
      }

      if (decision === 'deny-always') {
        // User clicked Always Deny - persist the denial
        await this.approvalManager.denyAction(toolName, input, 'always');
        return {
          behavior: 'deny',
          message: 'User denied this action.',
          interrupt: false,
        };
      }

      // Approve the action and potentially save to memory
      if (decision === 'allow-always') {
        await this.approvalManager.approveAction(toolName, input, 'always');
      } else if (decision === 'allow') {
        await this.approvalManager.approveAction(toolName, input, 'session');
      }

      return { behavior: 'allow', updatedInput: input };
    } catch (error) {
      console.error('[ClaudianService] Approval callback failed:', error);
      return {
        behavior: 'deny',
        message: `Approval request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        interrupt: true,
      };
    }
  }
}
