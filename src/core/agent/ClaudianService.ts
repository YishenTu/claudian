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
  SlashCommand as SDKSlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import type ClaudianPlugin from '../../main';
import { stripCurrentNoteContext } from '../../utils/context';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../utils/env';
import { getPathAccessType, getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getLastUserMessage,
  isSessionExpiredError,
} from '../../utils/session';
import {
  createBlocklistHook,
  createVaultRestrictionHook,
} from '../hooks';
import type { McpServerManager } from '../mcp';
import { isSessionInitEvent, isStreamChunk, transformSDKMessage } from '../sdk';
import {
  buildPermissionUpdates,
  getActionDescription,
} from '../security';
import { TOOL_SKILL } from '../tools/toolNames';
import type {
  ApprovalDecision,
  ChatMessage,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../types';
import { resolveModelWithBetas, THINKING_BUDGETS } from '../types';
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

export type { ApprovalDecision };

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

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

export interface EnsureReadyOptions {
  /** Session ID to resume. Auto-resolved from sessionManager if not provided. */
  sessionId?: string;
  /** External context paths to include. */
  externalContextPaths?: string[];
  /** Force restart even if query is running (for session switch, crash recovery). */
  force?: boolean;
  /** Preserve response handlers across restart (for mid-turn crash recovery). */
  preserveHandlers?: boolean;
}

export class ClaudianService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private readyStateListeners = new Set<(ready: boolean) => void>();

  // Modular components
  private sessionManager = new SessionManager();
  private mcpManager: McpServerManager;

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
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try {
      listener(this.isReady());
    } catch {
      // Ignore listener errors
    }
    return () => {
      this.readyStateListeners.delete(listener);
    };
  }

  private notifyReadyStateChange(): void {
    if (this.readyStateListeners.size === 0) {
      return;
    }

    const isReady = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(isReady);
      } catch {
        // Ignore listener errors
      }
    }
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /**
   * Ensures the persistent query is running with current configuration.
   * Unified API that replaces preWarm() and restartPersistentQuery().
   *
   * Behavior:
   * - If not running → start (if paths available)
   * - If running and force=true → close and restart
   * - If running and config changed → close and restart
   * - If running and config unchanged → no-op
   *
   * Note: When restart is needed, the query is closed BEFORE checking if we can
   * start a new one. This ensures fallback to cold-start if CLI becomes unavailable.
   *
   * @returns true if the query was (re)started, false otherwise
   */
  async ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    const vaultPath = getVaultPath(this.plugin.app);

    // Track external context paths for dynamic updates (empty list clears)
    if (options && options.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = options.externalContextPaths;
    }

    // Auto-resolve session ID from sessionManager if not explicitly provided
    const effectiveSessionId = options?.sessionId ?? this.sessionManager.getSessionId() ?? undefined;
    const externalContextPaths = options?.externalContextPaths ?? this.currentExternalContextPaths;

    // Case 1: Not running → try to start
    if (!this.persistentQuery) {
      if (!vaultPath) return false;
      const cliPath = this.plugin.getResolvedClaudeCliPath();
      if (!cliPath) return false;
      await this.startPersistentQuery(vaultPath, cliPath, effectiveSessionId, externalContextPaths);
      return true;
    }

    // Case 2: Force restart (session switch, crash recovery)
    // Close FIRST, then try to start new one (allows fallback if CLI unavailable)
    if (options?.force) {
      this.closePersistentQuery('forced restart', { preserveHandlers: options.preserveHandlers });
      if (!vaultPath) return false;
      const cliPath = this.plugin.getResolvedClaudeCliPath();
      if (!cliPath) return false;
      await this.startPersistentQuery(vaultPath, cliPath, effectiveSessionId, externalContextPaths);
      return true;
    }

    // Case 3: Check if config changed → restart if needed
    // We need vaultPath and cliPath to build config for comparison
    if (!vaultPath) return false;
    const cliPath = this.plugin.getResolvedClaudeCliPath();
    if (!cliPath) return false;

    const newConfig = this.buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
    if (this.needsRestart(newConfig)) {
      // Close FIRST, then try to start new one (allows fallback if CLI unavailable)
      this.closePersistentQuery('config changed', { preserveHandlers: options?.preserveHandlers });
      // Re-check CLI path as it might have changed during close
      const cliPathAfterClose = this.plugin.getResolvedClaudeCliPath();
      if (cliPathAfterClose) {
        await this.startPersistentQuery(vaultPath, cliPathAfterClose, effectiveSessionId, externalContextPaths);
        return true;
      }
      // CLI unavailable after close - query is closed, will fallback to cold-start
      return false;
    }

    // Case 4: Running and config unchanged → no-op
    return false;
  }

  /**
   * Starts the persistent query for the active chat conversation.
   */
  private async startPersistentQuery(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string,
    externalContextPaths?: string[]
  ): Promise<void> {
    if (this.persistentQuery) {
      return;
    }

    this.shuttingDown = false;
    this.vaultPath = vaultPath;

    this.messageChannel = new MessageChannel();

    if (resumeSessionId) {
      this.messageChannel.setSessionId(resumeSessionId);
      this.sessionManager.setSessionId(resumeSessionId, this.plugin.settings.model);
    }

    this.queryAbortController = new AbortController();

    const config = this.buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
    this.currentConfig = config;

    const options = await this.buildPersistentQueryOptions(
      vaultPath,
      cliPath,
      resumeSessionId,
      externalContextPaths
    );

    this.persistentQuery = agentQuery({
      prompt: this.messageChannel,
      options,
    });
    this.attachPersistentQueryStdinErrorHandler(this.persistentQuery);

    this.startResponseConsumer();
    this.notifyReadyStateChange();
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
    if (!error || typeof error !== 'object') return false;
    const e = error as { code?: string; message?: string };
    return e.code === 'EPIPE' || (typeof e.message === 'string' && e.message.includes('EPIPE'));
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
    this.notifyReadyStateChange();
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
  private buildPersistentQueryConfig(
    vaultPath: string,
    cliPath: string,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    return QueryOptionsBuilder.buildPersistentQueryConfig(
      this.buildQueryOptionsContext(vaultPath, cliPath),
      externalContextPaths
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
    resumeSessionId?: string,
    externalContextPaths?: string[]
  ): Options {
    const baseContext = this.buildQueryOptionsContext(vaultPath, cliPath);
    const hooks = this.buildHooks();
    const permissionMode = this.plugin.settings.permissionMode;

    const ctx: PersistentQueryContext = {
      ...baseContext,
      abortController: this.queryAbortController ?? undefined,
      resumeSessionId,
      canUseTool: permissionMode !== 'yolo' ? this.createApprovalCallback() : undefined,
      hooks,
      externalContextPaths,
    };

    return QueryOptionsBuilder.buildPersistentQueryOptions(ctx);
  }

  /**
   * Builds the hooks for SDK options.
   * Hooks need access to `this` for dynamic settings, so they're built here.
   *
   * @param externalContextPaths - Optional external context paths for cold-start queries.
   *        If not provided, the closure reads this.currentExternalContextPaths at execution
   *        time (for persistent queries where the value may change dynamically).
   */
  private buildHooks(externalContextPaths?: string[]) {
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

    return {
      PreToolUse: [blocklistHook, vaultRestrictionHook],
    };
  }

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
        // Skip error handling if this consumer was replaced by a new one.
        // This prevents race conditions where the OLD consumer's error handler
        // interferes with the NEW handler after a restart (e.g., from applyDynamicUpdates).
        if (this.persistentQuery !== queryForThisConsumer && this.persistentQuery !== null) {
          return;
        }

        // Skip restart if cold-start is in progress (it will handle session capture)
        if (!this.shuttingDown && !this.coldStartInProgress) {
          const handler = this.responseHandlers[this.responseHandlers.length - 1];
          const errorInstance = error instanceof Error ? error : new Error(String(error));
          const messageToReplay = this.lastSentMessage;

          if (!this.crashRecoveryAttempted && messageToReplay && handler && !handler.sawAnyChunk) {
            this.crashRecoveryAttempted = true;
            try {
              await this.ensureReady({ force: true, preserveHandlers: true });
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
              await this.ensureReady({ force: true });
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
        // If ensureReady() restarted, it starts a new consumer which sets the flag true,
        // so we shouldn't clear it here.
        if (this.persistentQuery === queryForThisConsumer || this.persistentQuery === null) {
          this.responseConsumerRunning = false;
        }
      }
    })();
  }

  /** @param modelOverride - Optional model override for cold-start queries */
  private getTransformOptions(modelOverride?: string) {
    return {
      intendedModel: modelOverride ?? this.plugin.settings.model,
      is1MEnabled: this.plugin.settings.show1MModel ?? false,
      customContextLimits: this.plugin.settings.customContextLimits,
    };
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
    for (const event of transformSDKMessage(message, this.getTransformOptions())) {
      if (isSessionInitEvent(event)) {
        this.sessionManager.captureSession(event.sessionId);
        this.messageChannel?.setSessionId(event.sessionId);
        if (event.agents) {
          try { this.plugin.agentManager.setBuiltinAgentNames(event.agents); } catch { /* non-critical */ }
        }
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

  private registerResponseHandler(handler: ResponseHandler): void {
    this.responseHandlers.push(handler);
  }

  private unregisterResponseHandler(handlerId: string): void {
    const idx = this.responseHandlers.findIndex(h => h.id === handlerId);
    if (idx >= 0) {
      this.responseHandlers.splice(idx, 1);
    }
  }

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

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedClaudePath);
    const missingNodeError = getMissingNodeError(resolvedClaudePath, enhancedPath);
    if (missingNodeError) {
      yield { type: 'error', content: missingNodeError };
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
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
      this.sessionManager.clearHistoryRebuild();
    }

    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNoteContext(prompt);
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
    const shouldUsePersistent = !effectiveQueryOptions?.forceColdStart;

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
        try {
          yield* this.queryViaPersistent(promptToSend, images, vaultPath, resolvedClaudePath, effectiveQueryOptions);
          return;
        } catch (error) {
          if (isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
            this.sessionManager.invalidateSession();
            const retryRequest = this.buildHistoryRebuildRequest(prompt, conversationHistory);

            this.coldStartInProgress = true;
            this.abortController = new AbortController();

            try {
              yield* this.queryViaSDK(
                retryRequest.prompt,
                vaultPath,
                resolvedClaudePath,
                // Use current message's images, fallback to history images
                images ?? retryRequest.images,
                effectiveQueryOptions
              );
            } catch (retryError) {
              const msg = retryError instanceof Error ? retryError.message : 'Unknown error';
              yield { type: 'error', content: msg };
            } finally {
              this.coldStartInProgress = false;
              this.abortController = null;
            }
            return;
          }

          throw error;
        }
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
        const retryRequest = this.buildHistoryRebuildRequest(prompt, conversationHistory);

        try {
          yield* this.queryViaSDK(
            retryRequest.prompt,
            vaultPath,
            resolvedClaudePath,
            // Use current message's images, fallback to history images
            images ?? retryRequest.images,
            effectiveQueryOptions
          );
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

  private buildHistoryRebuildRequest(
    prompt: string,
    conversationHistory: ChatMessage[]
  ): { prompt: string; images?: ImageAttachment[] } {
    const historyContext = buildContextFromHistory(conversationHistory);
    const actualPrompt = stripCurrentNoteContext(prompt);
    const fullPrompt = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
    const lastUserMessage = getLastUserMessage(conversationHistory);

    return {
      prompt: fullPrompt,
      images: lastUserMessage?.images,
    };
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
        // Re-throw session expired errors for outer retry logic to handle
        if (isSessionExpiredError(state.error)) {
          throw state.error;
        }
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

    // Model can always be updated dynamically (show1MModel change triggers restart)
    const show1MModel = this.plugin.settings.show1MModel;
    if (this.currentConfig && selectedModel !== this.currentConfig.model) {
      const resolved = resolveModelWithBetas(selectedModel, show1MModel);
      try {
        await this.persistentQuery.setModel(resolved.model);
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
      const sdkMode = permissionMode === 'yolo' ? 'bypassPermissions' : 'acceptEdits';
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

    // Track external context paths (used by hooks and for restart detection)
    const newExternalContextPaths = queryOptions?.externalContextPaths || [];
    this.currentExternalContextPaths = newExternalContextPaths;

    // Check for config changes that require restart
    if (!allowRestart) {
      return;
    }

    // Check if restart is needed using the valid cliPath we already have
    const newConfig = this.buildPersistentQueryConfig(this.vaultPath, cliPath, newExternalContextPaths);
    if (!this.needsRestart(newConfig)) {
      return;
    }

    // Restart is needed - use force to ensure query is closed even if CLI becomes unavailable
    const restarted = await this.ensureReady({
      externalContextPaths: newExternalContextPaths,
      preserveHandlers: restartOptions?.preserveHandlers,
      force: true,
    });

    // After restart, apply dynamic updates to the new process
    if (restarted && this.persistentQuery) {
      await this.applyDynamicUpdates(queryOptions, restartOptions, false);
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

  private buildPromptWithImages(prompt: string, images?: ImageAttachment[]): string | AsyncGenerator<any> {
    if (!images || images.length === 0) {
      return prompt;
    }

    const content: SDKContentBlock[] = [];

    // Images before text (Claude recommendation for best quality)
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

    const queryPrompt = this.buildPromptWithImages(prompt, images);
    const baseContext = this.buildQueryOptionsContext(cwd, cliPath);
    const externalContextPaths = queryOptions?.externalContextPaths || [];
    const hooks = this.buildHooks(externalContextPaths);
    const hasEditorContext = prompt.includes('<editor_selection');

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
      externalContextPaths,
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

        for (const event of transformSDKMessage(message, this.getTransformOptions(selectedModel))) {
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
      // Re-throw session expired errors for outer retry logic to handle
      if (isSessionExpiredError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.sessionManager.clearPendingModel();
      this.currentAllowedTools = null; // Clear tool restriction after query
    }

    yield { type: 'done' };
  }

  cancel() {
    this.approvalDismisser?.();

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
  }

  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /** Consume session invalidation flag for persistence updates. */
  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  /**
   * Check if the service is ready (persistent query is active).
   * Used to determine if SDK skills are available.
   */
  isReady(): boolean {
    return this.isPersistentQueryActive();
  }

  /**
   * Get supported commands (SDK skills) from the persistent query.
   * Returns an empty array if the query is not ready.
   */
  async getSupportedCommands(): Promise<SlashCommand[]> {
    if (!this.persistentQuery) {
      return [];
    }

    try {
      const sdkCommands: SDKSlashCommand[] = await this.persistentQuery.supportedCommands();
      return sdkCommands.map((cmd) => ({
        id: `sdk:${cmd.name}`,
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        content: '', // SDK skills don't need content - they're handled by the SDK
        source: 'sdk' as const,
      }));
    } catch {
      // Silently return empty array on error
      return [];
    }
  }

  /**
   * Set the session ID (for restoring from saved conversation).
   * Closes persistent query synchronously if session is changing, then ensures query is ready.
   *
   * @param id - Session ID to restore, or null for new session
   * @param externalContextPaths - External context paths for the session (prevents stale contexts)
   */
  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    const currentId = this.sessionManager.getSessionId();
    const sessionChanged = currentId !== id;

    // Close synchronously when session changes (maintains backwards compatibility)
    if (sessionChanged) {
      this.closePersistentQuery('session switch');
      this.crashRecoveryAttempted = false;
    }

    this.sessionManager.setSessionId(id, this.plugin.settings.model);

    // Ensure query is ready with the new session ID and external contexts
    // Passing external contexts here prevents stale contexts from previous session
    this.ensureReady({
      sessionId: id ?? undefined,
      externalContextPaths,
    }).catch(() => {
      // Best-effort, ignore failures
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

  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null) {
    this.approvalDismisser = dismisser;
  }

  private createApprovalCallback(): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
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

      // No pre-check — SDK already checked permanent rules before calling canUseTool
      if (!this.approvalCallback) {
        return { behavior: 'deny', message: 'No approval handler available.' };
      }

      try {
        const { decisionReason, blockedPath, agentID } = options;
        const description = getActionDescription(toolName, input);
        const decision = await this.approvalCallback(
          toolName, input, description,
          { decisionReason, blockedPath, agentID }
        );

        if (decision === 'cancel') {
          return { behavior: 'deny', message: 'User interrupted.', interrupt: true };
        }

        if (decision === 'allow' || decision === 'allow-always') {
          const updatedPermissions = buildPermissionUpdates(
            toolName, input, decision, options.suggestions
          );
          return { behavior: 'allow', updatedInput: input, updatedPermissions };
        }

        return { behavior: 'deny', message: 'User denied this action.', interrupt: false };
      } catch (error) {
        // Don't interrupt session — the deny message is sufficient for Claude
        // to try an alternative approach or ask the user.
        return {
          behavior: 'deny',
          message: `Approval request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          interrupt: false,
        };
      }
    };
  }
}
