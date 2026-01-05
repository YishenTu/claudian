/**
 * Claudian - Claude Agent SDK wrapper
 *
 * Handles communication with Claude via the Agent SDK. Manages streaming,
 * session persistence, permission modes, and security hooks.
 */

import type { CanUseTool, Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import * as os from 'os';
import * as path from 'path';

import type ClaudianPlugin from '../../main';
import { stripCurrentNotePrefix } from '../../utils/context';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import {
  getPathAccessType,
  getVaultPath,
  normalizePathForFilesystem,
  type PathAccessType,
} from '../../utils/path';
import { buildContextFromHistory, getLastUserMessage } from '../../utils/session';
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
import { buildSystemPrompt } from '../prompts/mainAgent';
import { isSessionInitEvent, isStreamChunk, transformSDKMessage } from '../sdk';
import {
  ApprovalManager,
  getActionDescription,
} from '../security';
import { TOOL_ASK_USER_QUESTION, TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE } from '../tools/toolNames';
import type {
  AskUserQuestionCallback,
  AskUserQuestionInput,
  ChatMessage,
  ClaudeModel,
  ImageAttachment,
  Permission,
  PermissionMode,
  StreamChunk,
  ToolDiffData,
} from '../types';
import { THINKING_BUDGETS } from '../types';

// ============================================
// Message Channel (for persistent streaming)
// ============================================

interface MessageChannel<T> {
  send: (message: T) => void;
  receive: () => AsyncIterable<T>;
  close: () => void;
}

function createMessageChannel<T>(): MessageChannel<T> {
  const queue: T[] = [];
  let resolver: ((value: IteratorResult<T>) => void) | null = null;
  let closed = false;

  return {
    send(message: T) {
      if (closed) return;
      if (resolver) {
        resolver({ value: message, done: false });
        resolver = null;
      } else {
        queue.push(message);
      }
    },
    receive() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<T>> {
              if (queue.length > 0) {
                return { value: queue.shift()!, done: false };
              }
              if (closed) {
                return { value: undefined as T, done: true };
              }
              return new Promise(resolve => {
                resolver = resolve;
              });
            }
          };
        }
      };
    },
    close() {
      closed = true;
      if (resolver) {
        resolver({ value: undefined as T, done: true });
      }
    }
  };
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

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string
) => Promise<'allow' | 'allow-always' | 'deny' | 'cancel'>;

/** Options for query execution with optional overrides. */
export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  /** MCP servers @-mentioned in the prompt. */
  mcpMentions?: Set<string>;
  /** MCP servers enabled via UI selector (in addition to @-mentioned servers). */
  enabledMcpServers?: Set<string>;
  /** Enable plan mode (read-only exploration). */
  planMode?: boolean;
}

/** Decision returned after plan approval. */
export type ExitPlanModeDecision =
  | { decision: 'approve' }
  | { decision: 'approve_new_session' }
  | { decision: 'revise'; feedback: string }
  | { decision: 'cancel' };

/** Callback for ExitPlanMode tool - shows approval panel and returns decision. */
export type ExitPlanModeCallback = (planContent: string) => Promise<ExitPlanModeDecision>;

/** Callback for EnterPlanMode tool - notifies UI and triggers re-send with plan mode. */
export type EnterPlanModeCallback = () => Promise<void>;

/** Service for interacting with Claude via the Agent SDK. */
export class ClaudianService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private enterPlanModeCallback: EnterPlanModeCallback | null = null;
  private currentPlanFilePath: string | null = null;
  private approvedPlanContent: string | null = null;
  private vaultPath: string | null = null;

  // Persistent streaming state - keeps subprocess alive across queries
  private persistentQuery: Query | null = null;
  private messageChannel: MessageChannel<SDKUserMessage> | null = null;
  private queryAbortController: AbortController | null = null;
  private responseConsumerRunning = false;

  private preWarmPromise: Promise<void> | null = null;
  private currentModel: string | null = null;
  private currentThinkingTokens: number | null = null;
  private currentPermissionMode: string | null = null;
  private currentMcpServersKey: string | null = null;

  // Response routing - maps each send() to its response chunks
  private activeResponseResolvers: Array<{
    onChunk: (chunk: StreamChunk) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  }> = [];

  // Modular components
  private sessionManager = new SessionManager();
  private approvalManager: ApprovalManager;
  private diffStore = new DiffStore();
  private mcpManager: McpServerManager;

  // Store AskUserQuestion answers by tool_use_id
  private askUserQuestionAnswers = new Map<string, Record<string, string | string[]>>();

  constructor(plugin: ClaudianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;

    // Initialize approval manager with access to persistent approvals
    this.approvalManager = new ApprovalManager(
      () => this.plugin.settings.permissions
    );

    // Set up persistence callback for permanent approvals
    this.approvalManager.setPersistCallback(async (action: Permission) => {
      this.plugin.settings.permissions.push(action);
      await this.plugin.saveSettings();
    });
  }

  /** Load MCP server configurations from storage. */
  async loadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /** Reload MCP server configurations (call after settings change). */
  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /**
   * Pre-warm the Claude Agent SDK by starting a persistent query.
   * This keeps the subprocess alive for the entire conversation, eliminating
   * cold start latency on subsequent messages.
   *
   * @param resumeSessionId Optional session ID to resume (from active conversation)
   */
  async preWarm(resumeSessionId?: string): Promise<void> {
    if (this.persistentQuery) return;
    if (this.preWarmPromise) {
      await this.preWarmPromise;
      return;
    }

    const cliPath = this.plugin.getResolvedClaudeCliPath();
    if (!cliPath) return;

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) return;

    this.vaultPath = vaultPath;
    this.preWarmPromise = this.doPreWarm(vaultPath, cliPath, resumeSessionId);
    try {
      await this.preWarmPromise;
    } finally {
      this.preWarmPromise = null;
    }
  }

  private async doPreWarm(vaultPath: string, cliPath: string, resumeSessionId?: string): Promise<void> {
    try {
      await this.startPersistentQuery(vaultPath, cliPath, resumeSessionId);
    } catch {
      this.persistentQuery = null;
      this.messageChannel = null;
    }
  }

  /**
   * Starts a persistent query with a message generator that keeps the subprocess alive.
   * The subprocess remains running until explicitly closed.
   */
  private async startPersistentQuery(cwd: string, cliPath: string, resumeSessionId?: string): Promise<void> {
    this.vaultPath = cwd;
    this.messageChannel = createMessageChannel<SDKUserMessage>();
    this.queryAbortController = new AbortController();

    const options = this.buildQueryOptions(cwd, cliPath, resumeSessionId);
    this.persistentQuery = agentQuery({
      prompt: this.messageChannel.receive(),
      options,
    });

    this.startResponseConsumer();

    // setModel() triggers subprocess spawn - without this call, spawn is deferred until first message
    const model = this.plugin.settings.model;
    await this.persistentQuery.setModel(model);
    this.currentModel = model;

    const budgetConfig = THINKING_BUDGETS.find(b => b.value === this.plugin.settings.thinkingBudget);
    this.currentThinkingTokens = budgetConfig && budgetConfig.tokens > 0 ? budgetConfig.tokens : null;
    this.currentPermissionMode = this.plugin.settings.permissionMode === 'yolo' ? 'bypassPermissions' : 'default';
    this.currentMcpServersKey = null;
  }

  /**
   * Build the query options for the persistent query.
   * These are the base options that can be dynamically updated.
   */
  private buildQueryOptions(cwd: string, cliPath: string, resumeSessionId?: string): Options {
    const permissionMode = this.plugin.settings.permissionMode;
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);

    // Build hooks
    const blocklistHook = createBlocklistHook(() => ({
      blockedCommands: this.plugin.settings.blockedCommands,
      enableBlocklist: this.plugin.settings.enableBlocklist,
    }));

    const vaultRestrictionHook = createVaultRestrictionHook({
      getPathAccessType: (p) => this.getPathAccessType(p),
    });

    const postCallback: FileEditPostCallback = {
      trackEditedFile: async (name, input, isError) => {
        if (name === 'Write' && !isError) {
          const filePath = input?.file_path as string;
          if (typeof filePath === 'string' && this.isPlanFilePath(filePath)) {
            this.currentPlanFilePath = this.resolvePlanPath(filePath);
          }
        }
      },
    };

    const fileHashPreHook = createFileHashPreHook(cwd, this.diffStore.getOriginalContents());
    const fileHashPostHook = createFileHashPostHook(
      cwd,
      this.diffStore.getOriginalContents(),
      this.diffStore.getPendingDiffData(),
      postCallback
    );

    // Build system prompt (base version - context-specific parts added per-message)
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      allowedContextPaths: this.plugin.settings.allowedContextPaths,
      vaultPath: cwd,
      hasEditorContext: false, // Will be updated per-message if needed
      planMode: false, // Will be updated dynamically
      appendedPlan: this.approvedPlanContent ?? undefined,
    });

    const options: Options = {
      cwd,
      systemPrompt,
      model: this.plugin.settings.model,
      abortController: this.queryAbortController ?? undefined,
      pathToClaudeCodeExecutable: cliPath,
      // Load project settings. Optionally load user settings if enabled.
      settingSources: this.plugin.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...customEnv,
        PATH: enhancedPath,
      },
      canUseTool: this.createUnifiedToolCallback(permissionMode),
      hooks: {
        PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
        PostToolUse: [fileHashPostHook],
      },
      includePartialMessages: true, // For streaming deltas
    };

    // Permission mode
    if (permissionMode === 'yolo') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.permissionMode = 'default';
    }

    // Thinking budget
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === this.plugin.settings.thinkingBudget);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    // Resume session if provided
    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    return options;
  }

  /**
   * Consumes responses from the persistent query in the background.
   * Routes response chunks to the active response handlers.
   */
  private async startResponseConsumer(): Promise<void> {
    if (!this.persistentQuery || this.responseConsumerRunning) {
      return;
    }

    this.responseConsumerRunning = true;

    try {
      for await (const message of this.persistentQuery) {
        // Check for abort
        if (this.queryAbortController?.signal.aborted) {
          break;
        }

        // Transform SDK message to stream chunks
        for (const event of transformSDKMessage(message, {
          intendedModel: this.plugin.settings.model
        })) {
          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
          } else if (isStreamChunk(event)) {
            // Route to active response handler
            this.routeResponseChunk(event);
          }
        }

        // Check for result message (turn complete)
        if (message.type === 'result') {
          this.notifyTurnComplete();
        }
      }
    } catch (error) {
      // AbortError is expected when we intentionally close the query (new conversation, cleanup, etc.)
      const isAbortError = error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'));
      if (!isAbortError) {
        console.error('[Claudian] Response consumer error:', error);
        this.notifyResponseError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      // Resolve any pending handlers so callers don't hang
      this.resolveAllPendingHandlers();
      this.responseConsumerRunning = false;
    }
  }

  /**
   * Resolve all pending response handlers to prevent hanging on interruption/shutdown.
   */
  private resolveAllPendingHandlers(): void {
    for (const handler of this.activeResponseResolvers) {
      handler.onDone();
    }
    this.activeResponseResolvers = [];
  }

  /**
   * Route a response chunk to the first active response handler.
   */
  private routeResponseChunk(chunk: StreamChunk): void {
    const handler = this.activeResponseResolvers[0];
    if (handler) {
      handler.onChunk(chunk);
    }
  }

  /**
   * Notify the first handler that the turn is complete.
   */
  private notifyTurnComplete(): void {
    const handler = this.activeResponseResolvers.shift();
    if (handler) {
      handler.onDone();
    }
  }

  /**
   * Notify the first handler of an error.
   */
  private notifyResponseError(error: Error): void {
    const handler = this.activeResponseResolvers.shift();
    if (handler) {
      handler.onError(error);
    }
  }

  /**
   * Close the persistent query and clean up resources.
   */
  private closePersistentQuery(): void {
    if (this.persistentQuery) {
      this.persistentQuery.interrupt().catch(() => {});
      this.persistentQuery = null;
    }
    if (this.messageChannel) {
      this.messageChannel.close();
      this.messageChannel = null;
    }
    if (this.queryAbortController) {
      this.queryAbortController.abort();
      this.queryAbortController = null;
    }
    this.activeResponseResolvers = [];
    this.responseConsumerRunning = false;

    // Reset tracked option values
    this.currentModel = null;
    this.currentThinkingTokens = null;
    this.currentPermissionMode = null;
    this.currentMcpServersKey = null;
  }

  /** Returns true if persistent query is running. */
  isPersistentQueryActive(): boolean {
    return this.persistentQuery !== null;
  }

  /** Sends a query to Claude via the persistent connection and streams the response. */
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

    // If preWarm is in progress, wait for it instead of starting a new query
    if (this.preWarmPromise) {
      await this.preWarmPromise;
    }

    // Ensure persistent query is running
    if (!this.persistentQuery) {
      try {
        const sessionId = this.sessionManager.getSessionId();
        await this.startPersistentQuery(vaultPath, resolvedClaudePath, sessionId ?? undefined);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error starting persistent query';
        yield { type: 'error', content: msg };
        return;
      }
    }

    if (!this.persistentQuery || !this.messageChannel) {
      yield { type: 'error', content: 'Failed to start persistent query' };
      return;
    }

    this.abortController = new AbortController();

    const hydratedImages = await hydrateImagesData(this.plugin.app, images, vaultPath);

    // After interruption, session is broken - rebuild context proactively
    let queryPrompt = prompt;
    if (this.sessionManager.wasInterrupted() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      if (historyContext) {
        queryPrompt = `${historyContext}\n\nUser: ${prompt}`;
      }
      this.sessionManager.invalidateSession();
      this.sessionManager.clearInterrupted();
    }

    // Rebuild history if no session exists but we have conversation history
    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      if (conversationHistory && conversationHistory.length > 0) {
        const historyContext = buildContextFromHistory(conversationHistory);
        const lastUserMessage = getLastUserMessage(conversationHistory);
        const actualPrompt = stripCurrentNotePrefix(prompt);
        const shouldAppendPrompt = !lastUserMessage || lastUserMessage.content.trim() !== actualPrompt.trim();
        queryPrompt = historyContext
          ? shouldAppendPrompt
            ? `${historyContext}\n\nUser: ${prompt}`
            : historyContext
          : prompt;
      }

      this.sessionManager.invalidateSession();
    }

    // Update dynamic options before sending
    await this.updateQueryOptions(queryOptions);

    // Set pending model for session capture
    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    this.sessionManager.setPendingModel(selectedModel);

    // Build user message
    const userMessage = this.buildSDKUserMessage(queryPrompt, hydratedImages || []);

    // Create response stream
    const responseStream = this.createResponseStream();

    // Send message to persistent query
    this.messageChannel.send(userMessage);

    // Yield responses
    try {
      let streamSessionId: string | null = this.sessionManager.getSessionId();
      for await (const chunk of responseStream) {
        if (chunk.type === 'usage') {
          yield { ...chunk, sessionId: streamSessionId };
        } else {
          yield chunk;
        }
        // Capture session ID if it changed
        const currentSessionId = this.sessionManager.getSessionId();
        if (currentSessionId !== streamSessionId) {
          streamSessionId = currentSessionId;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.abortController = null;
      this.sessionManager.clearPendingModel();
    }

    yield { type: 'done' };
  }

  /**
   * Build an SDKUserMessage from prompt and images.
   */
  private buildSDKUserMessage(prompt: string, images: ImageAttachment[]): SDKUserMessage {
    const content: Array<{ type: string; [key: string]: unknown }> = [];

    // Add images first (Claude recommends images before text)
    for (const image of images.filter(img => !!img.data)) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data!,
        },
      });
    }

    // Add text
    if (prompt.trim()) {
      content.push({ type: 'text', text: prompt });
    }

    return {
      type: 'user',
      message: { role: 'user', content },
      session_id: this.sessionManager.getSessionId() || '',
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  /**
   * Create a response stream that receives chunks from the response consumer.
   */
  private createResponseStream(): AsyncIterable<StreamChunk> {
    return {
      [Symbol.asyncIterator]: () => {
        const chunks: StreamChunk[] = [];
        let resolver: ((result: IteratorResult<StreamChunk>) => void) | null = null;
        let done = false;
        let error: Error | null = null;

        // Register handler
        this.activeResponseResolvers.push({
          onChunk: (chunk) => {
            if (resolver) {
              resolver({ value: chunk, done: false });
              resolver = null;
            } else {
              chunks.push(chunk);
            }
          },
          onDone: () => {
            done = true;
            if (resolver) {
              resolver({ value: undefined as unknown as StreamChunk, done: true });
            }
          },
          onError: (err) => {
            error = err;
            if (resolver) {
              resolver({ value: undefined as unknown as StreamChunk, done: true });
            }
          },
        });

        return {
          async next(): Promise<IteratorResult<StreamChunk>> {
            if (error) throw error;
            if (chunks.length > 0) {
              return { value: chunks.shift()!, done: false };
            }
            if (done) {
              return { value: undefined as unknown as StreamChunk, done: true };
            }
            return new Promise(resolve => {
              resolver = resolve;
            });
          },
        };
      },
    };
  }

  /**
   * Update dynamic options on the persistent query.
   * Only calls SDK methods when values actually change to avoid expensive operations.
   */
  private async updateQueryOptions(queryOptions?: QueryOptions): Promise<void> {
    if (!this.persistentQuery) return;

    const model = queryOptions?.model || this.plugin.settings.model;
    if (model !== this.currentModel) {
      await this.persistentQuery.setModel(model);
      this.currentModel = model;
    }

    const budgetConfig = THINKING_BUDGETS.find(b => b.value === this.plugin.settings.thinkingBudget);
    if (budgetConfig) {
      const tokens = budgetConfig.tokens > 0 ? budgetConfig.tokens : null;
      if (tokens !== this.currentThinkingTokens) {
        await this.persistentQuery.setMaxThinkingTokens(tokens);
        this.currentThinkingTokens = tokens;
      }
    }

    let permissionMode: string;
    if (queryOptions?.planMode) {
      permissionMode = 'plan';
    } else if (this.plugin.settings.permissionMode === 'yolo') {
      permissionMode = 'bypassPermissions';
    } else {
      permissionMode = 'default';
    }
    if (permissionMode !== this.currentPermissionMode) {
      await this.persistentQuery.setPermissionMode(permissionMode as 'plan' | 'bypassPermissions' | 'default');
      this.currentPermissionMode = permissionMode;
    }

    const mcpMentions = queryOptions?.mcpMentions || new Set<string>();
    const uiEnabledServers = queryOptions?.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    const mcpServers = this.mcpManager.getActiveServers(combinedMentions);
    const mcpServersKey = JSON.stringify(Object.entries(mcpServers).sort());
    if (mcpServersKey !== this.currentMcpServersKey) {
      await this.persistentQuery.setMcpServers(mcpServers);
      this.currentMcpServersKey = mcpServersKey;
    }
  }

  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }
    if (this.persistentQuery) {
      this.persistentQuery.interrupt().catch(() => {});
    }
  }

  /** Resets session state while preserving the subprocess for instant response. */
  resetSession() {
    this.sessionManager.reset();
    this.approvalManager.clearSessionApprovals();
    this.diffStore.clear();
    this.approvedPlanContent = null;
    this.currentPlanFilePath = null;
    this.activeResponseResolvers = [];
  }

  /** Get the current session ID. */
  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /** Set the session ID (for restoring from saved conversation). */
  setSessionId(id: string | null): void {
    this.sessionManager.setSessionId(id, this.plugin.settings.model);
  }

  /** Switches session via session_id in messages, preserving subprocess. */
  async switchSession(newSessionId: string | null): Promise<void> {
    this.sessionManager.setSessionId(newSessionId, this.plugin.settings.model);
    this.approvalManager.clearSessionApprovals();
    this.diffStore.clear();
    this.approvedPlanContent = null;
    this.currentPlanFilePath = null;
    this.activeResponseResolvers = [];
  }

  /** Cleanup resources. */
  cleanup() {
    this.cancel();
    this.closePersistentQuery();
    this.resetSession();
  }

  /** Sets the approval callback for UI prompts. */
  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  /** Sets the AskUserQuestion callback for interactive questions. */
  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null) {
    this.askUserQuestionCallback = callback;
  }

  /** Sets the ExitPlanMode callback for plan approval. */
  setExitPlanModeCallback(callback: ExitPlanModeCallback | null) {
    this.exitPlanModeCallback = callback;
  }

  /** Sets the EnterPlanMode callback for plan mode initiation. */
  setEnterPlanModeCallback(callback: EnterPlanModeCallback | null) {
    this.enterPlanModeCallback = callback;
  }

  /** Sets the current plan file path (for ExitPlanMode handling). */
  setCurrentPlanFilePath(path: string | null) {
    this.currentPlanFilePath = path;
  }

  /** Gets the current plan file path. */
  getCurrentPlanFilePath(): string | null {
    return this.currentPlanFilePath;
  }

  /** Sets the approved plan content to be included in future system prompts. */
  setApprovedPlanContent(content: string | null) {
    this.approvedPlanContent = content;
  }

  /** Gets the approved plan content. */
  getApprovedPlanContent(): string | null {
    return this.approvedPlanContent;
  }

  /** Clears the approved plan content. */
  clearApprovedPlanContent() {
    this.approvedPlanContent = null;
  }

  /** Get pending diff data for a tool_use_id (and remove it from pending). */
  getDiffData(toolUseId: string): ToolDiffData | undefined {
    return this.diffStore.getDiffData(toolUseId);
  }

  /** Clear all diff-related state. */
  clearDiffState(): void {
    this.diffStore.clear();
  }

  private getPathAccessType(filePath: string): PathAccessType {
    if (!this.vaultPath) return 'vault';
    return getPathAccessType(
      filePath,
      this.plugin.settings.allowedContextPaths,
      this.plugin.settings.allowedExportPaths,
      this.vaultPath
    );
  }

  private resolvePlanPath(filePath: string): string {
    const normalized = normalizePathForFilesystem(filePath);
    return path.resolve(normalized);
  }

  private isPlanFilePath(filePath: string): boolean {
    const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
    const resolved = this.resolvePlanPath(filePath);
    const normalizedPlans = process.platform === 'win32' ? plansDir.toLowerCase() : plansDir;
    const normalizedResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return (
      normalizedResolved === normalizedPlans ||
      normalizedResolved.startsWith(normalizedPlans + path.sep)
    );
  }

  /**
   * Create unified callback that handles both YOLO and normal modes.
   * AskUserQuestion, EnterPlanMode, and ExitPlanMode have special handling regardless of mode.
   */
  private createUnifiedToolCallback(mode: PermissionMode): CanUseTool {
    return async (toolName, input, context): Promise<PermissionResult> => {
      // Special handling for AskUserQuestion - always prompt user
      if (toolName === TOOL_ASK_USER_QUESTION) {
        return this.handleAskUserQuestionTool(input, context?.toolUseID);
      }

      // Special handling for EnterPlanMode - mark plan mode activation after reply
      if (toolName === TOOL_ENTER_PLAN_MODE) {
        return this.handleEnterPlanModeTool();
      }

      // Special handling for ExitPlanMode - show plan approval UI
      if (toolName === TOOL_EXIT_PLAN_MODE) {
        return this.handleExitPlanModeTool(input, context?.toolUseID);
      }

      // YOLO mode: auto-approve everything else
      if (mode === 'yolo') {
        return { behavior: 'allow', updatedInput: input };
      }

      // Normal mode: use approval flow
      return this.handleNormalModeApproval(toolName, input);
    };
  }

  /**
   * Handle AskUserQuestion tool - shows panel and returns answers.
   */
  private async handleAskUserQuestionTool(
    input: Record<string, unknown>,
    toolUseId?: string
  ): Promise<PermissionResult> {
    if (!this.askUserQuestionCallback) {
      return {
        behavior: 'deny',
        message: 'No question handler available.',
      };
    }

    try {
      const answers = await this.askUserQuestionCallback(input as unknown as AskUserQuestionInput);

      if (answers === null) {
        // User pressed Escape - interrupt the stream like in Claude Code
        return {
          behavior: 'deny',
          message: 'User interrupted.',
          interrupt: true,
        };
      }

      // Store answers for later retrieval by StreamController
      if (toolUseId) {
        this.askUserQuestionAnswers.set(toolUseId, answers);
      }

      // Return updated input with answers
      return {
        behavior: 'allow',
        updatedInput: { ...input, answers },
      };
    } catch {
      return {
        behavior: 'deny',
        message: 'Failed to get user response.',
        interrupt: true,
      };
    }
  }

  /** Get stored AskUserQuestion answers for a tool_use_id. */
  getAskUserQuestionAnswers(toolUseId: string): Record<string, string | string[]> | undefined {
    const answers = this.askUserQuestionAnswers.get(toolUseId);
    if (answers) {
      this.askUserQuestionAnswers.delete(toolUseId);
    }
    return answers;
  }

  /**
   * Handle EnterPlanMode tool - notifies UI to activate plan mode after the reply ends.
   */
  private async handleEnterPlanModeTool(): Promise<PermissionResult> {
    if (!this.enterPlanModeCallback) {
      // No callback - just allow the tool (UI will handle via stream detection)
      return { behavior: 'allow', updatedInput: {} };
    }

    try {
      // Notify UI to update state and queue re-send with plan mode
      await this.enterPlanModeCallback();
    } catch {
      // Non-critical: UI can detect plan mode from stream
    }
    return { behavior: 'allow', updatedInput: {} };
  }

  /**
   * Handle ExitPlanMode tool - shows plan approval UI and handles decision.
   * Reads plan content from the persisted file in ~/.claude/plans/.
   */
  private async handleExitPlanModeTool(
    input: Record<string, unknown>,
    _toolUseId?: string
  ): Promise<PermissionResult> {
    if (!this.exitPlanModeCallback) {
      return {
        behavior: 'deny',
        message: 'No plan mode handler available.',
      };
    }

    // Read plan content from the persisted file
    let planContent: string | null = null;
    if (this.currentPlanFilePath && this.isPlanFilePath(this.currentPlanFilePath)) {
      const planPath = this.resolvePlanPath(this.currentPlanFilePath);
      try {
        const fs = await import('fs');
        if (fs.existsSync(planPath)) {
          planContent = fs.readFileSync(planPath, 'utf-8');
        }
      } catch {
        // Fall back to SDK input
      }
    }

    // Fall back to SDK's input.plan if file read failed
    if (!planContent) {
      planContent = typeof input.plan === 'string' ? input.plan : null;
    }

    if (!planContent) {
      return {
        behavior: 'deny',
        message: 'No plan content available.',
      };
    }

    try {
      const decision = await this.exitPlanModeCallback(planContent);

      switch (decision.decision) {
        case 'approve':
          // Plan approved - interrupt current plan mode query and let caller handle implementation
          // We use 'deny' with a success message because the SDK would otherwise continue in plan mode
          return {
            behavior: 'deny',
            message: 'PLAN APPROVED. Plan mode has ended. The user has approved your plan and it has been saved. Implementation will begin with a new query that has full tool access.',
            interrupt: true,
          };
        case 'approve_new_session':
          // Plan approved with fresh session - interrupt and let caller handle
          return {
            behavior: 'deny',
            message: 'PLAN APPROVED WITH NEW SESSION. Plan mode has ended. Implementation will begin with a fresh session that has full tool access.',
            interrupt: true,
          };
        case 'revise': {
          const feedback = decision.feedback.trim();
          const feedbackSection = feedback ? `\n\nUser feedback:\n${feedback}` : '';
          // User wants to revise - deny to continue planning
          return {
            behavior: 'deny',
            message: `Please revise the plan based on user feedback and call ExitPlanMode again when ready.${feedbackSection}`,
            interrupt: false,
          };
        }
        case 'cancel':
          // User cancelled (Esc) - interrupt
          return {
            behavior: 'deny',
            message: 'Plan cancelled by user.',
            interrupt: true,
          };
        default:
          return {
            behavior: 'deny',
            message: 'Unknown decision.',
            interrupt: true,
          };
      }
    } catch {
      return {
        behavior: 'deny',
        message: 'Failed to get plan approval.',
        interrupt: true,
      };
    }
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
        // User explicitly clicked Deny button - continue with denial
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
    } catch {
      return {
        behavior: 'deny',
        message: 'Approval request failed.',
        interrupt: true,
      };
    }
  }
}
