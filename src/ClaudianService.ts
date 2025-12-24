/**
 * Claudian - Claude Agent SDK wrapper
 *
 * Handles communication with Claude via the Agent SDK. Manages streaming,
 * session persistence, permission modes, and security hooks.
 */

import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  createBlocklistHook,
  createFileHashPostHook,
  createFileHashPreHook,
  createVaultRestrictionHook,
  type DiffContentEntry,
  type FileEditPostCallback,
  type FileEditPreCallback,
} from './hooks';
import { hydrateImagesData } from './images/imageLoader';
import type ClaudianPlugin from './main';
import { isSessionInitEvent, isStreamChunk, transformSDKMessage } from './sdk/MessageTransformer';
import {
  ApprovalManager,
  getActionDescription,
} from './security';
import { buildSystemPrompt } from './system-prompt/mainAgent';
import type {
  ApprovedAction,
  ChatMessage,
  ClaudeModel,
  ImageAttachment,
  StreamChunk,
  ToolDiffData,
} from './types';
import { THINKING_BUDGETS } from './types';
import {
  buildContextFromHistory,
  findClaudeCLIPath,
  getLastUserMessage,
  getVaultPath,
  isPathInAllowedExportPaths,
  isPathWithinVault as isPathWithinVaultUtil,
  isSessionExpiredError,
  parseEnvironmentVariables,
  stripContextFilesPrefix,
} from './utils';

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

  needsSessionReset(requestedModel: ClaudeModel, defaultModel: ClaudeModel): boolean {
    if (!this.state.sessionId) {
      return false;
    }
    const activeModel = this.state.sessionModel ?? defaultModel;
    return requestedModel !== activeModel;
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
) => Promise<'allow' | 'allow-always' | 'deny'>;

export interface FileEditTracker {
  markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>): Promise<void>;
  trackEditedFile(toolName: string | undefined, toolInput: Record<string, unknown> | undefined, isError: boolean): Promise<void>;
  cancelFileEdit(toolName: string, toolInput: Record<string, unknown>): void;
}

/** Options for query execution with optional overrides. */
export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
}

/** Service for interacting with Claude via the Agent SDK. */
export class ClaudianService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private resolvedClaudePath: string | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private fileEditTracker: FileEditTracker | null = null;
  private vaultPath: string | null = null;

  // Modular components
  private sessionManager = new SessionManager();
  private approvalManager: ApprovalManager;
  private diffStore = new DiffStore();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;

    // Initialize approval manager with access to persistent approvals
    this.approvalManager = new ApprovalManager(
      () => this.plugin.settings.approvedActions
    );

    // Set up persistence callback for permanent approvals
    this.approvalManager.setPersistCallback(async (action: ApprovedAction) => {
      this.plugin.settings.approvedActions.push(action);
      await this.plugin.saveSettings();
    });
  }

  private findClaudeCLI(): string | null {
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

    // If a command overrides the model, avoid resuming a potentially incompatible session.
    const requestedModel = queryOptions?.model || this.plugin.settings.model;
    if (this.sessionManager.needsSessionReset(requestedModel, this.plugin.settings.model)) {
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
      vaultPath: cwd,
      hasEditorContext,
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

    // Create hooks for security enforcement
    const blocklistHook = createBlocklistHook(() => ({
      blockedCommands: this.plugin.settings.blockedCommands,
      enableBlocklist: this.plugin.settings.enableBlocklist,
    }));

    const vaultRestrictionHook = createVaultRestrictionHook({
      isPathWithinVault: (p) => this.isPathWithinVault(p),
      isAllowedExportPath: (p) => this.isAllowedExportPath(p),
      onEditBlocked: (toolName, toolInput) => {
        this.fileEditTracker?.cancelFileEdit(toolName, toolInput);
      },
    });

    // Create file tracking callbacks
    const preCallback: FileEditPreCallback | undefined = this.fileEditTracker
      ? { markFileBeingEdited: (name, input) => this.fileEditTracker!.markFileBeingEdited(name, input) }
      : undefined;

    const postCallback: FileEditPostCallback | undefined = this.fileEditTracker
      ? { trackEditedFile: (name, input, isError) => this.fileEditTracker!.trackEditedFile(name, input, isError) }
      : undefined;

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
    if (permissionMode === 'yolo') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
      options.hooks = {
        PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
        PostToolUse: [fileHashPostHook],
      };
    } else {
      options.permissionMode = 'default';
      options.canUseTool = this.createSafeModeCallback();
      options.hooks = {
        PreToolUse: [blocklistHook, vaultRestrictionHook, fileHashPreHook],
        PostToolUse: [fileHashPostHook],
      };
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

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          break;
        }

        for (const event of transformSDKMessage(message)) {
          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
          } else if (isStreamChunk(event)) {
            yield event;
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
  }

  /** Sets the approval callback for UI prompts. */
  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
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

  /**
   * Check if a path is within the vault directory.
   */
  private isPathWithinVault(filePath: string): boolean {
    if (!this.vaultPath) return true;
    return isPathWithinVaultUtil(filePath, this.vaultPath);
  }

  /**
   * Check if a path is within the allowed export paths.
   */
  private isAllowedExportPath(filePath: string): boolean {
    if (!this.vaultPath) return false;
    const allowedPaths = this.plugin.settings.allowedExportPaths;
    return isPathInAllowedExportPaths(filePath, allowedPaths, this.vaultPath);
  }

  /**
   * Create callback for Safe mode - check approved actions, then prompt user.
   */
  private createSafeModeCallback(): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
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

        if (decision === 'deny') {
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
    };
  }
}
