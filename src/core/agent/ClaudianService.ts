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
import { Notice } from 'obsidian';

import type ClaudianPlugin from '../../main';
import { stripCurrentNotePrefix } from '../../utils/context';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getPathAccessType, getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getLastUserMessage,
  isSessionExpiredError,
} from '../../utils/session';
import {
  createBlocklistHook,
  createFileHashPostHook,
  createFileHashPreHook,
  createVaultRestrictionHook,
  type FileEditPostCallback,
} from '../hooks';
import type { McpServerManager } from '../mcp';
import { isSessionInitEvent, isStreamChunk, transformSDKMessage } from '../sdk';
import {
  ApprovalManager,
  getActionDescription,
} from '../security';
import { TOOL_SKILL } from '../tools/toolNames';
import type {
  CCPermissions,
  ChatMessage,
  ImageAttachment,
  StreamChunk,
} from '../types';
import { THINKING_BUDGETS } from '../types';
import { MessageChannel } from './MessageChannel';
import {
  type ColdStartQueryContext,
  type PersistentQueryContext,
  QueryOptionsBuilder,
  type QueryOptionsContext,
} from './QueryOptionsBuilder';
import { SessionManager } from './SessionManager';
import {
  type ClosePersistentQueryOptions,
  createResponseHandler,
  isTurnCompleteMessage,
  type PersistentQueryConfig,
  type ResponseHandler,
  type SDKContentBlock,
} from './types';

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
  private coldStartInProgress = false;  // Prevent consumer error restarts during cold-start

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
      } catch {
        // Rule is still in session permissions via ApprovalManager, so action continues.
        new Notice('Failed to save permission rule');
      }
    });

    this.approvalManager.setAddDenyRuleCallback(async (rule) => {
      try {
        await this.plugin.storage.addDenyRule(rule);
        await this.loadCCPermissions();
      } catch {
        // Rule is still in session permissions via ApprovalManager, so action continues.
        new Notice('Failed to save permission rule');
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
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return;
    }

    const resolvedClaudePath = this.plugin.getResolvedClaudeCliPath();
    if (!resolvedClaudePath) {
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
      return;
    }

    this.shuttingDown = false;
    this.vaultPath = vaultPath;

    // Create message channel
    this.messageChannel = new MessageChannel();

    // Pre-set session ID on channel if resuming
    if (resumeSessionId) {
      this.messageChannel.setSessionId(resumeSessionId);
    }

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
    this.attachPersistentQueryStdinErrorHandler(this.persistentQuery);

    // Start the response consumer loop
    this.startResponseConsumer();
  }

  private attachPersistentQueryStdinErrorHandler(query: Query): void {
    const stdin = (query as { transport?: { processStdin?: NodeJS.WritableStream } }).transport?.processStdin;
    if (!stdin || typeof stdin.on !== 'function' || typeof stdin.once !== 'function') {
      return;
    }

    const handler = (error: NodeJS.ErrnoException) => {
      if (this.shuttingDown || this.isPipeError(error)) {
        return;
      }
      this.closePersistentQuery('stdin error');
    };

    stdin.on('error', handler);
    stdin.once('close', () => {
      stdin.removeListener('error', handler);
    });
  }

  private isPipeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const maybeError = error as { code?: string; message?: string };
    if (maybeError.code === 'EPIPE') {
      return true;
    }
    return typeof maybeError.message === 'string' && maybeError.message.includes('EPIPE');
  }

  /**
   * Closes the persistent query and cleans up resources.
   */
  closePersistentQuery(_reason?: string, options?: ClosePersistentQueryOptions): void {
    if (!this.persistentQuery) {
      return;
    }

    const preserveHandlers = options?.preserveHandlers ?? false;

    this.shuttingDown = true;

    // Close the message channel (ends the async iterable)
    this.messageChannel?.close();

    // Interrupt the query
    void this.persistentQuery.interrupt().catch(() => {
      // Silence abort/interrupt errors during shutdown
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

    // NOTE: Do NOT reset crashRecoveryAttempted here.
    // It's reset in queryViaPersistent after a successful message send,
    // or in resetSession/setSessionId when switching sessions.
    // Resetting it here would cause infinite restart loops on persistent errors.

    // Reset shuttingDown flag so next query can start a new persistent query.
    // This must be done after all cleanup to prevent race conditions with the consumer loop.
    this.shuttingDown = false;
  }

  /**
   * Restarts the persistent query (e.g., after configuration change or crash recovery).
   * Does NOT try to resume session - just spins up a fresh process.
   * Resume happens when user sends a message via queryViaPersistent.
   */
  async restartPersistentQuery(reason?: string, options?: ClosePersistentQueryOptions): Promise<void> {
    this.closePersistentQuery(reason, options);

    const vaultPath = getVaultPath(this.plugin.app);
    const cliPath = this.plugin.getResolvedClaudeCliPath();

    if (vaultPath && cliPath) {
      // Don't pass session ID - just spin up the process
      await this.startPersistentQuery(vaultPath, cliPath);
    }
  }

  /**
   * Checks if the persistent query needs to be restarted based on configuration changes.
   */
  private needsRestart(newConfig: PersistentQueryConfig): boolean {
    return QueryOptionsBuilder.needsRestart(this.currentConfig, newConfig);
  }

  /**
   * Builds configuration object for tracking changes.
   */
  private buildPersistentQueryConfig(vaultPath: string, cliPath: string): PersistentQueryConfig {
    return QueryOptionsBuilder.buildPersistentQueryConfig(
      this.buildQueryOptionsContext(vaultPath, cliPath)
    );
  }

  /**
   * Builds the base query options context from current state.
   */
  private buildQueryOptionsContext(vaultPath: string, cliPath: string): QueryOptionsContext {
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);

    return {
      vaultPath,
      cliPath,
      settings: this.plugin.settings,
      customEnv,
      enhancedPath,
      mcpManager: this.mcpManager,
      pluginManager: this.plugin.pluginManager,
    };
  }

  /**
   * Builds SDK options for the persistent query.
   */
  private buildPersistentQueryOptions(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string
  ): Options {
    const baseContext = this.buildQueryOptionsContext(vaultPath, cliPath);
    const hooks = this.buildHooks(vaultPath);
    const permissionMode = this.plugin.settings.permissionMode;

    const ctx: PersistentQueryContext = {
      ...baseContext,
      abortController: this.queryAbortController ?? undefined,
      resumeSessionId,
      canUseTool: permissionMode !== 'yolo' ? this.createApprovalCallback() : undefined,
      hooks,
    };

    return QueryOptionsBuilder.buildPersistentQueryOptions(ctx);
  }

  /**
   * Builds the hooks for SDK options.
   * Hooks need access to `this` for dynamic settings, so they're built here.
   *
   * @param vaultPath - The vault path for file operations.
   * @param externalContextPaths - Optional external context paths for cold-start queries.
   *        If not provided, the closure reads this.currentExternalContextPaths at execution
   *        time (for persistent queries where the value may change dynamically).
   */
  private buildHooks(vaultPath: string, externalContextPaths?: string[]) {
    const blocklistHook = createBlocklistHook(() => ({
      blockedCommands: this.plugin.settings.blockedCommands,
      enableBlocklist: this.plugin.settings.enableBlocklist,
    }));

    const vaultRestrictionHook = createVaultRestrictionHook({
      getPathAccessType: (p) => {
        if (!this.vaultPath) return 'vault';
        // For cold-start queries, use the passed externalContextPaths.
        // For persistent queries, read this.currentExternalContextPaths at execution time
        // so dynamic updates are reflected.
        const paths = externalContextPaths ?? this.currentExternalContextPaths;
        return getPathAccessType(
          p,
          paths,
          this.plugin.settings.allowedExportPaths,
          this.vaultPath
        );
      },
    });

    const postCallback: FileEditPostCallback = {
      trackEditedFile: async () => {
        // File tracking is delegated to PreToolUse/PostToolUse hooks
      },
    };

    const fileHashPreHook = createFileHashPreHook(vaultPath);
    const fileHashPostHook = createFileHashPostHook(vaultPath, postCallback);

    return {
      PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
      PostToolUse: [fileHashPostHook],
    };
  }

  // ============================================
  // Response Consumer Loop (Phase 1.4)
  // ============================================

  /**
   * Starts the background consumer loop that routes chunks to handlers.
   */
  private startResponseConsumer(): void {
    if (this.responseConsumerRunning) {
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
        // Skip restart if cold-start is in progress (it will handle session capture)
        if (!this.shuttingDown && !this.coldStartInProgress) {
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
              // If restart failed due to session expiration, invalidate session
              // so next query triggers noSessionButHasHistory → history rebuild
              if (isSessionExpiredError(restartError)) {
                this.sessionManager.invalidateSession();
              }
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
              // If restart failed due to session expiration, invalidate session
              // so next query triggers noSessionButHasHistory → history rebuild
              if (isSessionExpiredError(restartError)) {
                this.sessionManager.invalidateSession();
              }
              // Restart failed - next query will start fresh.
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
    // Note: Session expiration errors are handled in catch blocks (queryViaSDK, handleAbort)
    // The SDK throws errors as exceptions, not as message types

    // Safe to use last handler - design guarantees single handler at a time
    const handler = this.responseHandlers[this.responseHandlers.length - 1];
    if (handler && this.isStreamTextEvent(message)) {
      handler.markStreamTextSeen();
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
        }
      }
    }

    // Check for turn completion
    if (isTurnCompleteMessage(message)) {
      // Signal turn complete to message channel
      this.messageChannel?.onTurnComplete();

      // Notify handler
      if (handler) {
        handler.resetStreamText();
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

    // Clear interrupted flag - persistent query handles interruption gracefully,
    // no need to force cold-start just because user cancelled previous response
    if (this.sessionManager.wasInterrupted()) {
      this.sessionManager.clearInterrupted();
    }

    // Session mismatch recovery: SDK returned a different session ID (context lost)
    // Inject history to restore context without forcing cold-start
    if (this.sessionManager.needsHistoryRebuild() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNotePrefix(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
      this.sessionManager.clearHistoryRebuild();
    }

    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNotePrefix(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory!);

      // Note: Do NOT call invalidateSession() here. The cold-start will capture
      // a new session ID anyway, and invalidating would break any persistent query
      // restart that happens during the cold-start (causing SESSION MISMATCH).
      forceColdStart = true;
    }

    const effectiveQueryOptions = forceColdStart
      ? { ...queryOptions, forceColdStart: true }
      : queryOptions;

    if (forceColdStart) {
      // Set flag BEFORE closing to prevent consumer error from triggering restart
      this.coldStartInProgress = true;
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
    // Set flag to prevent consumer error restarts from interfering
    this.coldStartInProgress = true;
    this.abortController = new AbortController();

    try {
      yield* this.queryViaSDK(promptToSend, vaultPath, resolvedClaudePath, images, effectiveQueryOptions);
    } catch (error) {
      if (isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
        this.sessionManager.invalidateSession();

        const historyContext = buildContextFromHistory(conversationHistory);
        const actualPrompt = stripCurrentNotePrefix(prompt);
        const fullPrompt = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);

        const lastUserMessage = getLastUserMessage(conversationHistory);

        try {
          yield* this.queryViaSDK(fullPrompt, vaultPath, resolvedClaudePath, lastUserMessage?.images, effectiveQueryOptions);
        } catch (retryError) {
          const msg = retryError instanceof Error ? retryError.message : 'Unknown error';
          yield { type: 'error', content: msg };
        }
        return;
      }

      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.coldStartInProgress = false;
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
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions);
      return;
    }

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
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions);
      return;
    }
    if (!this.responseConsumerRunning) {
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions);
      return;
    }

    // Build SDKUserMessage
    const message = this.buildSDKUserMessage(prompt, images);

    // Create a promise-based handler to yield chunks
    // Use a mutable state object to work around TypeScript's control flow analysis
    const state = {
      chunks: [] as StreamChunk[],
      resolveChunk: null as ((chunk: StreamChunk | null) => void) | null,
      done: false,
      error: null as Error | null,
    };

    const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handler = createResponseHandler({
      id: handlerId,
      onChunk: (chunk) => {
        handler.markChunkSeen();
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
    });

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
          yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions);
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
    const sessionId = this.sessionManager.getSessionId() || '';

    if (!images || images.length === 0) {
      return {
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    }

    // Build content blocks with images
    const content: SDKContentBlock[] = [];

    for (const image of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data,
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
      session_id: sessionId,
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
      return;
    }
    const cliPath = this.plugin.getResolvedClaudeCliPath();
    if (!cliPath) {
      return;
    }

    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    const permissionMode = this.plugin.settings.permissionMode;
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    const thinkingTokens = budgetConfig?.tokens ?? null;

    // Update model if changed
    if (this.currentConfig && selectedModel !== this.currentConfig.model) {
      try {
        await this.persistentQuery.setModel(selectedModel);
        this.currentConfig.model = selectedModel;
      } catch {
        // Silently ignore model update errors
      }
    }

    // Update thinking tokens if changed
    const currentThinking = this.currentConfig?.thinkingTokens ?? null;
    if (thinkingTokens !== currentThinking) {
      try {
        await this.persistentQuery.setMaxThinkingTokens(thinkingTokens);
        if (this.currentConfig) {
          this.currentConfig.thinkingTokens = thinkingTokens;
        }
      } catch {
        // Silently ignore thinking tokens update errors
      }
    }

    // Update permission mode if changed
    // Since we always start with allowDangerouslySkipPermissions: true,
    // we can dynamically switch between modes without restarting
    if (this.currentConfig && permissionMode !== this.currentConfig.permissionMode) {
      const sdkMode = permissionMode === 'yolo' ? 'bypassPermissions' : 'default';
      try {
        await this.persistentQuery.setPermissionMode(sdkMode);
        this.currentConfig.permissionMode = permissionMode;
      } catch {
        // Silently ignore permission mode update errors
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
      // Convert to McpServerConfig format
      const serverConfigs: Record<string, McpServerConfig> = {};
      for (const [name, config] of Object.entries(mcpServers)) {
        serverConfigs[name] = config as McpServerConfig;
      }
      try {
        await this.persistentQuery.setMcpServers(serverConfigs);
        this.currentConfig.mcpServersKey = mcpServersKey;
      } catch {
        // Silently ignore MCP servers update errors
      }
    }

    // External context paths are injected per message; track but do not restart.
    if (this.currentConfig) {
      this.currentConfig.externalContextPaths = queryOptions?.externalContextPaths || [];
    }
    this.currentExternalContextPaths = queryOptions?.externalContextPaths || [];

    // Check for other changes that require restart
    const newConfig = this.buildPersistentQueryConfig(this.vaultPath, cliPath);
    if (this.needsRestart(newConfig)) {
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
    if (!images || images.length === 0) {
      return prompt;
    }

    const content: SDKContentBlock[] = [];

    // Add image blocks first (Claude recommends images before text)
    for (const image of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data,
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

    // Build the prompt - either a string or content blocks with images
    const queryPrompt = this.buildPromptWithImages(prompt, images);

    // Build cold-start context
    const baseContext = this.buildQueryOptionsContext(cwd, cliPath);
    const externalContextPaths = queryOptions?.externalContextPaths || [];
    const hooks = this.buildHooks(cwd, externalContextPaths);
    const hasEditorContext = prompt.includes('<editor_selection');

    // Prepare allowed tools with Skill tool included
    let allowedTools: string[] | undefined;
    if (queryOptions?.allowedTools !== undefined && queryOptions.allowedTools.length > 0) {
      const toolSet = new Set([...queryOptions.allowedTools, TOOL_SKILL]);
      allowedTools = [...toolSet];
    }

    const ctx: ColdStartQueryContext = {
      ...baseContext,
      abortController: this.abortController ?? undefined,
      sessionId: this.sessionManager.getSessionId() ?? undefined,
      modelOverride: queryOptions?.model,
      canUseTool: permissionMode !== 'yolo' ? this.createApprovalCallback() : undefined,
      hooks,
      mcpMentions: queryOptions?.mcpMentions,
      enabledMcpServers: queryOptions?.enabledMcpServers,
      allowedTools,
      hasEditorContext,
    };

    const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

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
      void this.persistentQuery.interrupt().catch(() => {
        // Silence abort/interrupt errors
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

    // Reset crash recovery for fresh start
    this.crashRecoveryAttempted = false;

    this.sessionManager.reset();
    this.approvalManager.clearSessionPermissions();
  }

  /** Get the current session ID. */
  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /** Consume session invalidation flag for persistence updates. */
  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  /**
   * Set the session ID (for restoring from saved conversation).
   * Closes the persistent query since session is switching, then pre-warms the new session.
   */
  setSessionId(id: string | null): void {
    // Close persistent query when switching sessions
    const currentId = this.sessionManager.getSessionId();
    if (currentId !== id) {
      this.closePersistentQuery('session switch');
      // Reset crash recovery for new session context
      this.crashRecoveryAttempted = false;
    }

    this.sessionManager.setSessionId(id, this.plugin.settings.model);

    // Pre-warm the SDK process (no session ID - just spin up the process)
    // Resume happens when user sends a message via queryViaPersistent
    this.preWarm().catch(() => {
      // Pre-warm is best-effort, ignore failures
    });
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
      return {
        behavior: 'deny',
        message: `Approval request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        interrupt: true,
      };
    }
  }
}
