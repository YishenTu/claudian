/**
 * Claudian - Claude Agent SDK wrapper
 *
 * Handles communication with Claude via the Agent SDK. Manages streaming,
 * session persistence, permission modes, and security hooks.
 */

import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type ClaudianPlugin from '../../main';
import { stripContextFilesPrefix } from '../../utils/context';
import { parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath, findClaudeCLIPath, getPathAccessType, getVaultPath, type PathAccessType } from '../../utils/path';
import { buildContextFromHistory, getLastUserMessage, isSessionExpiredError } from '../../utils/session';
import {
  createBlocklistHook,
  createFileHashPostHook,
  createFileHashPreHook,
  createVaultRestrictionHook,
  type DiffContentEntry,
  type FileEditPostCallback,
  type FileEditPreCallback,
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
  ApprovedAction,
  AskUserQuestionCallback,
  AskUserQuestionInput,
  ChatMessage,
  ClaudeModel,
  ImageAttachment,
  PermissionMode,
  StreamChunk,
  ToolDiffData,
} from '../types';
import { THINKING_BUDGETS } from '../types';

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
) => Promise<'allow' | 'allow-always' | 'deny' | 'cancel'>;

export interface FileEditTracker {
  markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>): Promise<void>;
  trackEditedFile(toolName: string | undefined, toolInput: Record<string, unknown> | undefined, isError: boolean): Promise<void>;
  cancelFileEdit(toolName: string, toolInput: Record<string, unknown>): void;
}

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
  private resolvedClaudePath: string | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private enterPlanModeCallback: EnterPlanModeCallback | null = null;
  private currentPlanFilePath: string | null = null;
  private approvedPlanContent: string | null = null;
  private fileEditTracker: FileEditTracker | null = null;
  private vaultPath: string | null = null;

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
    this.approvalManager.setPersistCallback(async (action: ApprovedAction) => {
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

  private findClaudeCLI(): string | null {
    // Check for user-specified custom path first
    const customPath = this.plugin.settings.claudeCliPath?.trim();
    if (customPath) {
      const expandedPath = expandHomePath(customPath);
      if (fs.existsSync(expandedPath)) {
        // Validate that the path is a file, not a directory
        try {
          const stat = fs.statSync(expandedPath);
          if (stat.isFile()) {
            return expandedPath;
          }
          console.warn(`Claudian: Custom CLI path is a directory, not a file: ${expandedPath}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Claudian: Custom CLI path not accessible: ${expandedPath} (${message})`);
        }
      } else {
        console.warn(`Claudian: Custom CLI path not found: ${expandedPath}`);
      }
      // Continue to auto-detection if custom path is invalid
    }
    return findClaudeCLIPath();
  }

  /** Sends a query to Claude and streams the response. */
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

    if (!this.resolvedClaudePath) {
      this.resolvedClaudePath = this.findClaudeCLI();
    }

    if (!this.resolvedClaudePath) {
      yield { type: 'error', content: 'Claude CLI not found. Please install Claude Code CLI.' };
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
    // (e.g., after provider change cleared the sessionId).
    // Note: Model switching within same provider doesn't require session reset -
    // the SDK handles it natively with the same session ID.
    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      if (conversationHistory && conversationHistory.length > 0) {
        const historyContext = buildContextFromHistory(conversationHistory);
        const lastUserMessage = getLastUserMessage(conversationHistory);
        const actualPrompt = stripContextFilesPrefix(prompt);
        const shouldAppendPrompt = !lastUserMessage || lastUserMessage.content.trim() !== actualPrompt.trim();
        queryPrompt = historyContext
          ? shouldAppendPrompt
            ? `${historyContext}\n\nUser: ${prompt}`
            : historyContext
          : prompt;
      }

      this.sessionManager.invalidateSession();
    }

    try {
      yield* this.queryViaSDK(queryPrompt, vaultPath, hydratedImages, queryOptions);
    } catch (error) {
      if (isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
        this.sessionManager.invalidateSession();

        const historyContext = buildContextFromHistory(conversationHistory);
        const lastUserMessage = getLastUserMessage(conversationHistory);
        const actualPrompt = stripContextFilesPrefix(prompt);
        const shouldAppendPrompt = !lastUserMessage || lastUserMessage.content.trim() !== actualPrompt.trim();
        const fullPrompt = historyContext
          ? shouldAppendPrompt
            ? `${historyContext}\n\nUser: ${prompt}`
            : historyContext
          : prompt;

        const retryImages = await hydrateImagesData(this.plugin.app, lastUserMessage?.images, vaultPath);

        try {
          yield* this.queryViaSDK(fullPrompt, vaultPath, retryImages, queryOptions);
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
    images?: ImageAttachment[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    const permissionMode = this.plugin.settings.permissionMode;

    this.sessionManager.setPendingModel(selectedModel);
    this.vaultPath = cwd;

    // Parse custom environment variables from settings
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());

    // Build the prompt - either a string or content blocks with images
    const queryPrompt = this.buildPromptWithImages(prompt, images);

    // Build system prompt with settings
    const hasEditorContext = prompt.includes('<editor_selection');
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      allowedContextPaths: this.plugin.settings.allowedContextPaths,
      vaultPath: cwd,
      hasEditorContext,
      planMode: queryOptions?.planMode,
      appendedPlan: this.approvedPlanContent ?? undefined,
    });


    const options: Options = {
      cwd,
      systemPrompt,
      model: selectedModel,
      abortController: this.abortController ?? undefined,
      pathToClaudeCodeExecutable: this.resolvedClaudePath!,
      settingSources: ['user', 'project'],
      env: {
        ...process.env,
        ...customEnv,
      },
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

    // Create hooks for security enforcement
    const blocklistHook = createBlocklistHook(() => ({
      blockedCommands: this.plugin.settings.blockedCommands,
      enableBlocklist: this.plugin.settings.enableBlocklist,
    }));

    const vaultRestrictionHook = createVaultRestrictionHook({
      getPathAccessType: (p) => this.getPathAccessType(p),
      onEditBlocked: (toolName, toolInput) => {
        this.fileEditTracker?.cancelFileEdit(toolName, toolInput);
      },
    });

    // Create file tracking callbacks
    const preCallback: FileEditPreCallback | undefined = this.fileEditTracker
      ? { markFileBeingEdited: (name, input) => this.fileEditTracker!.markFileBeingEdited(name, input) }
      : undefined;

    const postCallback: FileEditPostCallback = {
      trackEditedFile: async (name, input, isError) => {
        // Track plan file writes (to ~/.claude/plans/)
        if (name === 'Write' && !isError) {
          const filePath = input?.file_path as string;
          if (typeof filePath === 'string' && this.isPlanFilePath(filePath)) {
            this.currentPlanFilePath = this.resolvePlanPath(filePath);
          }
        }
        // Forward to file edit tracker if available
        await this.fileEditTracker?.trackEditedFile(name, input, isError);
      },
    };

    // Create file hash tracking hooks
    const fileHashPreHook = createFileHashPreHook(
      this.vaultPath,
      this.diffStore.getOriginalContents(),
      preCallback
    );
    const fileHashPostHook = createFileHashPostHook(
      this.vaultPath,
      this.diffStore.getOriginalContents(),
      this.diffStore.getPendingDiffData(),
      postCallback
    );

    // Apply permission mode
    // Always use canUseTool for AskUserQuestion support in both modes
    options.canUseTool = this.createUnifiedToolCallback(permissionMode);
    options.hooks = {
      PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
      PostToolUse: [fileHashPostHook],
    };

    // Set permission mode based on settings or plan mode
    if (queryOptions?.planMode) {
      // Plan mode: read-only exploration, no tool execution
      options.permissionMode = 'plan';
    } else if (permissionMode === 'yolo') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.permissionMode = 'default';
    }

    // Enable extended thinking based on thinking budget setting
    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    // Apply allowedTools restriction if specified by slash command
    // Include 'Skill' tool to maintain skill availability
    if (queryOptions?.allowedTools && queryOptions.allowedTools.length > 0) {
      options.allowedTools = [...queryOptions.allowedTools, 'Skill'];
    }

    // Resume previous session if we have a session ID
    const sessionId = this.sessionManager.getSessionId();
    if (sessionId) {
      options.resume = sessionId;
    }

    try {
      const response = agentQuery({ prompt: queryPrompt, options });
      let streamSessionId: string | null = this.sessionManager.getSessionId();

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          break;
        }

        for (const event of transformSDKMessage(message, { intendedModel: selectedModel })) {
          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
            streamSessionId = event.sessionId;
          } else if (isStreamChunk(event)) {
            if (event.type === 'usage') {
              yield { ...event, sessionId: streamSessionId };
            } else {
              yield event;
            }
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.sessionManager.clearPendingModel();
    }

    yield { type: 'done' };
  }

  /** Cancel the current query. */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }
  }

  /** Reset the conversation session. */
  resetSession() {
    this.sessionManager.reset();
    this.approvalManager.clearSessionApprovals();
    this.diffStore.clear();
    this.approvedPlanContent = null;
    this.currentPlanFilePath = null;
  }

  /** Get the current session ID. */
  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /** Set the session ID (for restoring from saved conversation). */
  setSessionId(id: string | null): void {
    this.sessionManager.setSessionId(id, this.plugin.settings.model);
  }

  /** Cleanup resources. */
  cleanup() {
    this.cancel();
    this.resetSession();
    this.resolvedClaudePath = null;
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

  /** Sets the file edit tracker for syncing edit state with the UI. */
  setFileEditTracker(tracker: FileEditTracker | null) {
    this.fileEditTracker = tracker;
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
    const expanded = expandHomePath(filePath);
    return path.resolve(expanded);
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
      return { behavior: 'allow', updatedInput: {} };
    } catch {
      return { behavior: 'allow', updatedInput: {} };
    }
  }

  /**
   * Handle ExitPlanMode tool - shows plan approval UI and handles decision.
   * Reads plan content from the persisted file in ~/.claude/plans/.
   */
  private async handleExitPlanModeTool(
    input: Record<string, unknown>,
    toolUseId?: string
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
      this.fileEditTracker?.cancelFileEdit(toolName, input);
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
        this.fileEditTracker?.cancelFileEdit(toolName, input);
        return {
          behavior: 'deny',
          message: 'User interrupted.',
          interrupt: true,
        };
      }

      if (decision === 'deny') {
        // User explicitly clicked Deny button - continue with denial
        this.fileEditTracker?.cancelFileEdit(toolName, input);
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
      this.fileEditTracker?.cancelFileEdit(toolName, input);
      return {
        behavior: 'deny',
        message: 'Approval request failed.',
        interrupt: true,
      };
    }
  }
}
