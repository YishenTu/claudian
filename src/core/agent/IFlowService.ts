/**
 * IFlowService - iFlow SDK wrapper for Claudian
 *
 * Replaces ClaudianService to use iFlow SDK instead of Claude Agent SDK.
 * Maintains the same public interface for compatibility with existing code.
 *
 * Architecture:
 * - Uses IFlowClient for WebSocket communication with iFlow
 * - Transforms iFlow messages to StreamChunks for UI rendering
 * - Manages session persistence and conversation state
 */

import { Notice } from 'obsidian';

import type ClaudianPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../utils/session';
import { stripCurrentNotePrefix } from '../../utils/context';
import {
  IFlowClient,
  transformIFlowMessage,
  isStreamChunk,
  type IFlowOptions,
  type IFlowQueryOptions,
  type IFlowMessage,
} from '../iflow';
import type { McpServerManager } from '../mcp';
import { buildSystemPrompt } from '../prompts/mainAgent';
import { ApprovalManager, getActionDescription } from '../security';
import type {
  CCPermissions,
  ChatMessage,
  ImageAttachment,
  StreamChunk,
} from '../types';
import { SessionManager } from './SessionManager';

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
  /** MCP servers enabled via UI selector. */
  enabledMcpServers?: Set<string>;
  /** Force cold-start query (bypass persistent connection). */
  forceColdStart?: boolean;
  /** Session-specific external context paths. */
  externalContextPaths?: string[];
}

/**
 * Service for interacting with iFlow CLI.
 * Drop-in replacement for ClaudianService.
 */
export class IFlowService {
  private plugin: ClaudianPlugin;
  private client: IFlowClient | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];

  // Modular components
  private sessionManager = new SessionManager();
  private approvalManager: ApprovalManager;
  private mcpManager: McpServerManager;
  private ccPermissions: CCPermissions = { allow: [], deny: [], ask: [] };

  // Current allowed tools for enforcement
  private currentAllowedTools: string[] | null = null;

  constructor(plugin: ClaudianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;

    // Initialize approval manager
    this.approvalManager = new ApprovalManager(() => this.ccPermissions);

    // Set up callbacks for persisting permissions
    this.approvalManager.setAddAllowRuleCallback(async (rule) => {
      try {
        await this.plugin.storage.addAllowRule(rule);
        await this.loadCCPermissions();
      } catch {
        new Notice('Failed to save permission rule');
      }
    });

    this.approvalManager.setAddDenyRuleCallback(async (rule) => {
      try {
        await this.plugin.storage.addDenyRule(rule);
        await this.loadCCPermissions();
      } catch {
        new Notice('Failed to save permission rule');
      }
    });
  }

  /**
   * Load CC permissions from storage.
   */
  async loadCCPermissions(): Promise<void> {
    this.ccPermissions = await this.plugin.storage.getPermissions();
  }

  /** Load MCP server configurations from storage. */
  async loadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /** Reload MCP server configurations. */
  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  // ============================================
  // Connection Lifecycle
  // ============================================

  /**
   * Pre-warm the iFlow connection.
   */
  async preWarm(resumeSessionId?: string, externalContextPaths?: string[]): Promise<void> {
    if (this.client?.isConnected()) {
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return;
    }

    this.vaultPath = vaultPath;

    if (externalContextPaths && externalContextPaths.length > 0) {
      this.currentExternalContextPaths = externalContextPaths;
    }

    await this.ensureConnected();

    if (resumeSessionId && this.client) {
      this.client.setSessionId(resumeSessionId);
    }
  }

  /**
   * Ensure client is connected.
   */
  private async ensureConnected(): Promise<void> {
    if (this.client?.isConnected()) {
      return;
    }

    const options = this.buildClientOptions();
    this.client = new IFlowClient(options);
    await this.client.connect();
  }

  /**
   * Build iFlow client options.
   */
  private buildClientOptions(): IFlowOptions {
    const vaultPath = getVaultPath(this.plugin.app) || process.cwd();
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const cliPath = this.plugin.getResolvedClaudeCliPath();
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath || '');

    return {
      cwd: vaultPath,
      env: {
        ...customEnv,
        PATH: enhancedPath,
      },
      autoStart: true,
      timeout: 30000,
    };
  }

  /**
   * Close the connection.
   */
  async closeConnection(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  /** Check if connection is active. */
  isPersistentQueryActive(): boolean {
    return this.client?.isConnected() ?? false;
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Sends a query and streams the response.
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

    this.vaultPath = vaultPath;

    // Handle history rebuild if needed
    let promptToSend = prompt;

    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNotePrefix(prompt);
      promptToSend = buildPromptWithHistoryContext(
        historyContext,
        prompt,
        actualPrompt,
        conversationHistory!
      );
    }

    // Ensure connected
    try {
      await this.ensureConnected();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Connection failed';
      yield { type: 'error', content: `Failed to connect to iFlow: ${msg}` };
      return;
    }

    if (!this.client) {
      yield { type: 'error', content: 'iFlow client not initialized' };
      return;
    }

    // Set allowed tools
    if (queryOptions?.allowedTools !== undefined) {
      this.currentAllowedTools = queryOptions.allowedTools.length > 0
        ? [...queryOptions.allowedTools]
        : [];
    } else {
      this.currentAllowedTools = null;
    }

    // Update external context paths
    if (queryOptions?.externalContextPaths) {
      this.currentExternalContextPaths = queryOptions.externalContextPaths;
    }

    // Build query options
    const iflowOptions = this.buildQueryOptions(queryOptions);

    try {
      // Send message and stream responses
      const messageGenerator = images && images.length > 0
        ? this.client.sendMessageWithImages(
            promptToSend,
            images.map(img => ({ data: img.data, mediaType: img.mediaType })),
            iflowOptions
          )
        : this.client.sendMessage(promptToSend, iflowOptions);

      for await (const message of messageGenerator) {
        // Check for tool approval if needed
        if (message.type === 'tool_call' && message.status === 'pending') {
          const approved = await this.handleToolApproval(message);
          if (!approved) {
            yield { type: 'blocked', content: `Tool "${message.toolName}" was denied` };
            continue;
          }
        }

        // Transform and yield chunks
        for (const event of transformIFlowMessage(message)) {
          if (isStreamChunk(event)) {
            yield event;
          }
        }

        // Capture session ID
        const sessionId = this.client.getSessionId();
        if (sessionId && sessionId !== this.sessionManager.getSessionId()) {
          this.sessionManager.captureSession(sessionId);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.currentAllowedTools = null;
    }

    yield { type: 'done' };
  }

  /**
   * Build iFlow query options.
   */
  private buildQueryOptions(queryOptions?: QueryOptions): IFlowQueryOptions {
    const selectedModel = queryOptions?.model || this.plugin.settings.model;

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      vaultPath: this.vaultPath || '',
      hasEditorContext: true,
    });

    // Get MCP servers
    const mcpMentions = queryOptions?.mcpMentions || new Set<string>();
    const uiEnabledServers = queryOptions?.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    const mcpServers = this.mcpManager.getActiveServers(combinedMentions);

    return {
      sessionId: this.sessionManager.getSessionId() || undefined,
      model: selectedModel,
      systemPrompt,
      maxThinkingTokens: this.getThinkingTokens(),
      tools: queryOptions?.allowedTools,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      additionalDirectories: this.currentExternalContextPaths.length > 0
        ? this.currentExternalContextPaths
        : undefined,
    };
  }

  /**
   * Get thinking tokens from settings.
   */
  private getThinkingTokens(): number | undefined {
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgets: Record<string, number> = {
      'off': 0,
      'low': 4000,
      'medium': 8000,
      'high': 16000,
      'xhigh': 32000,
    };
    const tokens = budgets[budgetSetting] || 0;
    return tokens > 0 ? tokens : undefined;
  }

  /**
   * Handle tool approval in normal mode.
   */
  private async handleToolApproval(message: IFlowMessage): Promise<boolean> {
    if (message.type !== 'tool_call') return true;

    const toolName = message.toolName;
    const input = message.input || {};

    // Check allowed tools restriction
    if (this.currentAllowedTools !== null) {
      if (!this.currentAllowedTools.includes(toolName)) {
        return false;
      }
    }

    // YOLO mode - always allow
    if (this.plugin.settings.permissionMode === 'yolo') {
      return true;
    }

    // Check if pre-approved using the new method
    const preApprovalResult = this.approvalManager.checkPermission(toolName, input);
    if (preApprovalResult === 'allow') {
      return true;
    }
    if (preApprovalResult === 'deny') {
      return false;
    }

    // Request user approval
    if (!this.approvalCallback) {
      return false;
    }

    const description = getActionDescription(toolName, input);
    const decision = await this.approvalCallback(toolName, input, description);

    if (decision === 'cancel' || decision === 'deny' || decision === 'deny-always') {
      if (decision === 'deny-always') {
        await this.approvalManager.denyAction(toolName, input, 'always');
      } else if (decision === 'deny') {
        await this.approvalManager.denyAction(toolName, input, 'session');
      }
      return false;
    }

    if (decision === 'allow-always') {
      await this.approvalManager.approveAction(toolName, input, 'always');
    } else if (decision === 'allow') {
      await this.approvalManager.approveAction(toolName, input, 'session');
    }

    return true;
  }

  /** Cancel the current query. */
  cancel(): void {
    if (this.client) {
      void this.client.interrupt();
      this.sessionManager.markInterrupted();
    }
  }

  /**
   * Reset the conversation session.
   */
  resetSession(): void {
    this.sessionManager.reset();
    this.approvalManager.clearSessionPermissions();

    if (this.client) {
      this.client.setSessionId(null);
    }
  }

  /** Get the current session ID. */
  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /** Consume session invalidation flag. */
  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  /**
   * Set the session ID for restoring conversations.
   */
  setSessionId(id: string | null): void {
    this.sessionManager.setSessionId(id, this.plugin.settings.model);

    if (this.client) {
      this.client.setSessionId(id);
    }

    // Pre-warm connection
    this.preWarm().catch(() => {
      // Best-effort
    });
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    void this.closeConnection();
    this.cancel();
    this.resetSession();
  }

  /** Sets the approval callback for UI prompts. */
  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  // ============================================
  // Compatibility Methods (for ClaudianService interface)
  // ============================================

  /** Alias for closeConnection */
  closePersistentQuery(_reason?: string): void {
    void this.closeConnection();
  }

  /** Restart connection */
  async restartPersistentQuery(_reason?: string): Promise<void> {
    await this.closeConnection();
    await this.ensureConnected();
  }
}
