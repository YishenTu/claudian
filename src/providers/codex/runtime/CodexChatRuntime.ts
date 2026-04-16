import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, ForkSource, SlashCommand, StreamChunk } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { buildContextFromHistory } from '../../../utils/session';
import { CODEX_PROVIDER_CAPABILITIES } from '../capabilities';
import {
  deriveCodexMemoriesDirFromSessionsRoot,
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFile,
} from '../history/CodexHistoryStore';
import { encodeCodexTurn } from '../prompt/encodeCodexTurn';
import { type CodexSafeMode, getCodexProviderSettings } from '../settings';
import {
  extractExplicitCodexSkillNames,
  findPreferredCodexSkillByName,
} from '../skills/CodexSkillListingService';
import { type CodexProviderState, getCodexState } from '../types';
import { CodexAppServerProcess } from './CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from './codexAppServerSupport';
import type {
  SandboxPolicy,
  ServerRequestResolvedNotification,
  SkillInput,
  SkillsListResult,
  ThreadCompactStartResult,
  ThreadForkResult,
  ThreadResumeResult,
  ThreadRollbackResult,
  ThreadStartResult,
  TurnStartedNotification,
  TurnStartResult,
  TurnSteerResult,
  UserInput,
} from './codexAppServerTypes';
import type { CodexLaunchSpec } from './codexLaunchTypes';
import { CodexNotificationRouter } from './CodexNotificationRouter';
import { CodexRpcTransport } from './CodexRpcTransport';
import { type CodexRuntimeContext, createCodexRuntimeContext } from './CodexRuntimeContext';
import { CodexServerRequestRouter } from './CodexServerRequestRouter';
import { CodexFileTailEngine } from './CodexSessionFileTail';
import { CodexSessionManager } from './CodexSessionManager';

function resolveCodexSandboxConfig(
  permissionMode: string,
  codexSafeMode: CodexSafeMode = 'workspace-write',
): { approvalPolicy: string; sandbox: string } {
  if (permissionMode === 'yolo') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
  if (permissionMode === 'plan') {
    return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
  // normal — resolve through the user's configured safe mode
  return { approvalPolicy: 'on-request', sandbox: codexSafeMode };
}

function resolveCodexServiceTier(serviceTier: unknown, model: string | undefined): string | null {
  if (model !== 'gpt-5.4') {
    return null;
  }
  return serviceTier === 'fast' ? 'fast' : null;
}

const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export class CodexChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'codex';

  private plugin: ClaudianPlugin;
  private session = new CodexSessionManager();
  private process: CodexAppServerProcess | null = null;
  private transport: CodexRpcTransport | null = null;
  private launchSpec: CodexLaunchSpec | null = null;
  private runtimeContext: CodexRuntimeContext | null = null;
  private notificationRouter: CodexNotificationRouter | null = null;
  private serverRequestRouter = new CodexServerRequestRouter();
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private clientConfigKey: string | null = null;
  private currentTurnId: string | null = null;
  private currentQueryThreadId: string | null = null;
  private loadedThreadId: string | null = null;
  private currentThreadPath: string | null = null;
  private pendingTurnNotifications: Array<{ method: string; params: unknown }> = [];

  // Chunk buffer: notifications push here, query() drains
  private chunkBuffer: StreamChunk[] = [];
  private chunkResolve: (() => void) | null = null;

  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;
  private resumeCheckpoint: string | undefined;
  private activeInputBundles = new Set<CodexInputBundle>();

  // Fork state
  private pendingFork: ForkSource | null = null;

  // Cancellation
  private canceled = false;
  private turnMetadata: ChatTurnMetadata = {};

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CODEX_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeCodexTurn(request);
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.turnMetadata };
    this.turnMetadata = {};
    return metadata;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.resumeCheckpoint = checkpointId;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.session.reset();
      this.loadedThreadId = null;
      this.currentThreadPath = null;
      this.pendingFork = null;
      return;
    }

    const state = getCodexState(conversation.providerState);

    // Pending fork: store fork metadata, don't set the source thread as our session
    if (state.forkSource && !state.threadId && !conversation.sessionId) {
      this.pendingFork = state.forkSource;
      this.session.reset();
      this.loadedThreadId = null;
      this.currentThreadPath = null;
      return;
    }

    this.pendingFork = null;
    const threadId = state.threadId ?? conversation.sessionId ?? null;

    if (!threadId) {
      this.session.reset();
      this.loadedThreadId = null;
      this.currentThreadPath = null;
      return;
    }

    this.session.setThread(threadId, state.sessionFilePath);
  }

  async reloadMcpServers(): Promise<void> {
    // No-op: Codex handles MCP internally
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const promptSettings = this.getSystemPromptSettings();
    const promptKey = computeSystemPromptKey(promptSettings);
    const launchSpec = resolveCodexAppServerLaunchSpec(this.plugin, this.providerId);
    const clientConfigKey = [promptKey, JSON.stringify({
      command: launchSpec.command,
      args: launchSpec.args,
      spawnCwd: launchSpec.spawnCwd,
      targetCwd: launchSpec.targetCwd,
      target: launchSpec.target,
    })].join('::');
    const shouldRebuild = !this.process
      || !this.transport
      || !this.process.isAlive()
      || options?.force === true
      || this.clientConfigKey !== clientConfigKey;

    if (shouldRebuild) {
      await this.shutdownProcess();
      await this.startAppServer(launchSpec, clientConfigKey);
    }

    this.setReady(true);
    return shouldRebuild;
  }

  async *query(
    originalTurn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.resetTurnMetadata();
    let turn = originalTurn;
    await this.ensureReady();

    this.canceled = false;
    this.cleanupActiveInputBundles();
    this.chunkBuffer = [];
    this.chunkResolve = null;
    this.currentQueryThreadId = null;
    this.pendingTurnNotifications = [];
    let tailEngine: CodexFileTailEngine | null = null;
    let tailDrainInterval: ReturnType<typeof setInterval> | null = null;
    let toolSourceMode: 'transcript' | 'fallback' = 'fallback';
    let tailDonePromise: Promise<void> | null = null;
    let transcriptSessionFilePath: string | null | undefined;

    const model = this.resolveModel(queryOptions);
    const promptSettings = this.getSystemPromptSettings();
    const promptText = buildSystemPrompt(promptSettings);

    const enqueueChunk = (chunk: StreamChunk): void => {
      this.chunkBuffer.push(chunk);
      if (this.chunkResolve) {
        this.chunkResolve();
        this.chunkResolve = null;
      }
    };

    const switchToLiveToolFallback = (): void => {
      if (toolSourceMode === 'fallback') {
        return;
      }

      toolSourceMode = 'fallback';
      if (tailDrainInterval) {
        clearInterval(tailDrainInterval);
        tailDrainInterval = null;
      }

      if (tailEngine) {
        void tailEngine.stopPolling().catch(() => {});
      }
    };

    const syncTailPollingState = (): Error | null => {
      if (!tailEngine) return null;

      const tailError = tailEngine.consumePollingError();
      if (tailError) {
        switchToLiveToolFallback();
        return tailError;
      }

      return null;
    };

    const drainTailToolChunks = (): void => {
      if (!tailEngine) return;
      if (toolSourceMode !== 'transcript') return;
      if (syncTailPollingState()) return;

      const toolChunks = tailEngine.collectPendingEvents().filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'tool_use' | 'tool_result' }> =>
          chunk.type === 'tool_use' || chunk.type === 'tool_result',
      );

      for (const chunk of toolChunks) {
        enqueueChunk(chunk);
      }
    };

    const stopTailToolPolling = async (): Promise<void> => {
      if (tailDrainInterval) {
        clearInterval(tailDrainInterval);
        tailDrainInterval = null;
      }
      if (tailEngine) {
        await tailEngine.stopPolling();
      }
    };

    const flushTailToolsBeforeDone = (): void => {
      if (toolSourceMode !== 'transcript' || !tailEngine) {
        enqueueChunk({ type: 'done' });
        return;
      }
      if (tailDonePromise) {
        return;
      }

      tailDonePromise = (async () => {
        try {
          await tailEngine!.waitForSettle();
          if (syncTailPollingState()) {
            return;
          }
          drainTailToolChunks();
        } finally {
          await stopTailToolPolling();
          enqueueChunk({ type: 'done' });
        }
      })();
    };

    // Set up notification router to push chunks
    this.notificationRouter = new CodexNotificationRouter(
      (chunk) => {
        syncTailPollingState();

        if (toolSourceMode === 'transcript') {
          if (chunk.type === 'tool_use' || chunk.type === 'tool_result') {
            return;
          }
          if (chunk.type === 'done') {
            flushTailToolsBeforeDone();
            return;
          }
        }

        enqueueChunk(chunk);
      },
      (update) => this.recordTurnMetadata(update),
    );

    this.wireTransportHandlers();

    const compactValidationError = this.validateCompactTurn(originalTurn);
    if (compactValidationError) {
      yield { type: 'error', content: compactValidationError };
      yield { type: 'done' };
      return;
    }

    try {
      // Thread lifecycle
      const existingThreadId = this.session.getThreadId();
      let threadId: string;
      let threadPath: string | null = null;
      let threadTargetPath: string | null = null;
      let completedPendingFork = false;

      if (this.pendingFork) {
        // Pending fork: fork the source thread, optionally roll back, then start a turn
        const fork = this.pendingFork;

        const forkResult = await this.transport!.request<ThreadForkResult>('thread/fork', {
          threadId: fork.sessionId,
        });
        threadId = forkResult.thread.id;
        threadTargetPath = forkResult.thread.path ?? null;
        threadPath = this.toHostSessionPath(threadTargetPath);

        // Compute rollback: count turns after the resumeAt checkpoint
        const forkTurns = forkResult.thread.turns ?? [];
        const checkpointIndex = forkTurns.findIndex(t => t.id === fork.resumeAt);
        if (checkpointIndex < 0) {
          throw new Error(`Fork checkpoint not found: ${fork.resumeAt}`);
        }
        const numTurnsToRollback = forkTurns.length - checkpointIndex - 1;

        // Resume the forked thread (required before rollback and turn/start)
        const permissionMode = this.resolveSandboxConfig();
        await this.transport!.request<ThreadResumeResult>('thread/resume', {
          threadId,
          model: model ?? 'gpt-5.4',
          approvalPolicy: permissionMode.approvalPolicy,
          sandbox: permissionMode.sandbox,
          serviceTier: resolveCodexServiceTier(this.getProviderSettings().serviceTier, model ?? 'gpt-5.4'),
          baseInstructions: promptText,
          persistExtendedHistory: true,
        });

        if (numTurnsToRollback > 0) {
          await this.transport!.request<ThreadRollbackResult>('thread/rollback', {
            threadId,
            numTurns: numTurnsToRollback,
          });
        }

        this.loadedThreadId = threadId;
        completedPendingFork = true;

        // Build replay suffix from conversation history after the checkpoint
        if (_conversationHistory && _conversationHistory.length > 0) {
          const checkpointIdx = _conversationHistory.findIndex(
            m => m.assistantMessageId === fork.resumeAt,
          );
          if (checkpointIdx >= 0 && checkpointIdx < _conversationHistory.length - 1) {
            const suffix = _conversationHistory.slice(checkpointIdx + 1);
            const replayContext = buildContextFromHistory(suffix);
            if (replayContext.trim()) {
              turn = {
                ...turn,
                prompt: `${replayContext}\n\nUser: ${turn.prompt}`,
              };
            }
          }
        }
      } else if (existingThreadId && existingThreadId !== this.loadedThreadId) {
        // Resume a persisted thread not yet loaded in this daemon
        const permissionMode = this.resolveSandboxConfig();
        const resumeResult = await this.transport!.request<ThreadResumeResult>('thread/resume', {
          threadId: existingThreadId,
          model: model ?? 'gpt-5.4',
          approvalPolicy: permissionMode.approvalPolicy,
          sandbox: permissionMode.sandbox,
          serviceTier: resolveCodexServiceTier(this.getProviderSettings().serviceTier, model ?? 'gpt-5.4'),
          baseInstructions: promptText,
          persistExtendedHistory: true,
        });
        threadId = resumeResult.thread.id;
        threadTargetPath = resumeResult.thread.path ?? null;
        threadPath = this.toHostSessionPath(threadTargetPath);
        this.loadedThreadId = threadId;
      } else if (existingThreadId && existingThreadId === this.loadedThreadId) {
        // Thread already loaded — just start a new turn
        threadId = existingThreadId;
      } else {
        // New thread
        const permissionMode = this.resolveSandboxConfig();
        const startResult = await this.transport!.request<ThreadStartResult>('thread/start', {
          model: model ?? 'gpt-5.4',
          cwd: this.launchSpec?.targetCwd ?? getVaultPath(this.plugin.app) ?? undefined,
          approvalPolicy: permissionMode.approvalPolicy,
          sandbox: permissionMode.sandbox,
          serviceTier: resolveCodexServiceTier(this.getProviderSettings().serviceTier, model ?? 'gpt-5.4'),
          baseInstructions: promptText,
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        });
        threadId = startResult.thread.id;
        threadTargetPath = startResult.thread.path ?? null;
        threadPath = this.toHostSessionPath(threadTargetPath);
        this.loadedThreadId = threadId;
      }

      // Update session with thread info
      this.session.setThread(threadId, threadPath ?? this.currentThreadPath ?? undefined);
      if (threadPath) this.currentThreadPath = threadPath;
      this.currentQueryThreadId = threadId;
      if (completedPendingFork) {
        this.pendingFork = null;
      }

      if (turn.isCompact) {
        // --- Manual compact path: thread/compact/start ---
        this.notificationRouter?.beginTurn({ isPlanTurn: false });

        await this.transport!.request<ThreadCompactStartResult>(
          'thread/compact/start',
          { threadId },
        );
        this.recordTurnMetadata({ wasSent: true });
        // currentTurnId will be set by turn/started notification
      } else {
        // --- Normal turn path ---
        tailEngine = new CodexFileTailEngine(
          this.resolveTranscriptRootHost(threadPath) ?? path.join(os.homedir(), '.codex', 'sessions'),
          200_000,
        );
        tailEngine.resetForNewTurn();
        transcriptSessionFilePath = threadPath ?? this.session.getSessionFilePath() ?? null;
        const transcriptReady = await tailEngine.primeCursor(
          threadId,
          transcriptSessionFilePath ?? undefined,
        );
        if (transcriptReady) {
          toolSourceMode = 'transcript';
        }

        // Build input
        const skillInputs = await this.resolveSkillInputs(turn.request.text);
        const turnInputBundle = this.buildInput(turn.prompt, turn.request.images, skillInputs);
        this.registerActiveInputBundle(turnInputBundle);

        // Start turn
        const providerSettings = this.getProviderSettings();
        const effort = EFFORT_MAP[providerSettings.effortLevel as string] ?? 'medium';
        const resolvedModel = model ?? 'gpt-5.4';
        const isPlanMode = providerSettings.permissionMode === 'plan';
        const externalContextPaths = this.resolveExternalContextPaths(turn, queryOptions);
        const permissionMode = this.resolveSandboxConfig();
        const transcriptRootTarget = this.runtimeContext?.sessionsDirTarget
          ?? deriveCodexSessionsRootFromSessionPath(threadTargetPath)
          ?? this.resolveTranscriptRootTarget(threadPath ?? transcriptSessionFilePath);
        const sandboxPolicy = this.buildTurnSandboxPolicy(
          externalContextPaths,
          permissionMode.sandbox,
          transcriptRootTarget,
          threadPath ?? transcriptSessionFilePath,
        );

        const collaborationMode = isPlanMode
          ? {
              mode: 'plan' as const,
              settings: {
                model: resolvedModel,
                reasoning_effort: effort,
                developer_instructions: null,
              },
            }
          : undefined;

        const summary = getCodexProviderSettings(providerSettings).reasoningSummary;
        const serviceTier = resolveCodexServiceTier(providerSettings.serviceTier, resolvedModel);

        // Configure router plan state before turn/start so buffered notifications
        // that arrive before currentTurnId is set already see the correct state.
        this.notificationRouter?.beginTurn({ isPlanTurn: isPlanMode });

        const turnResult = await this.transport!.request<TurnStartResult>('turn/start', {
          threadId,
          input: turnInputBundle.input,
          approvalPolicy: permissionMode.approvalPolicy,
          model: resolvedModel,
          serviceTier,
          effort,
          summary,
          sandboxPolicy,
          ...(collaborationMode ? { collaborationMode } : {}),
        });
        this.currentTurnId = turnResult.turn.id;
        this.recordTurnMetadata({
          userMessageId: turnResult.turn.id,
          wasSent: true,
        });
        this.flushPendingTurnNotifications();

        if (toolSourceMode === 'transcript' && tailEngine) {
          const transcriptPollingStarted = tailEngine.startPolling(
            threadId,
            transcriptSessionFilePath ?? undefined,
          );
          if (transcriptPollingStarted) {
            tailDrainInterval = setInterval(() => {
              drainTailToolChunks();
            }, 50);
          } else {
            switchToLiveToolFallback();
          }
        }
      }

      // Yield chunks until done or canceled
      while (true) {
        if (this.canceled) {
          // Drain remaining chunks before exiting
          while (this.chunkBuffer.length > 0) {
            const chunk = this.chunkBuffer.shift()!;
            yield chunk;
            if (chunk.type === 'done') return;
          }
          yield { type: 'done' };
          return;
        }

        if (this.chunkBuffer.length === 0) {
          await new Promise<void>((resolve) => {
            this.chunkResolve = resolve;
            if (this.chunkBuffer.length > 0 || this.canceled) {
              resolve();
              this.chunkResolve = null;
            }
          });
        }

        while (this.chunkBuffer.length > 0) {
          const chunk = this.chunkBuffer.shift()!;
          yield chunk;
          if (chunk.type === 'done') {
            return;
          }
        }
      }
    } catch (err: unknown) {
      if (this.canceled) {
        yield { type: 'done' };
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown Codex error';
      yield { type: 'error', content: message };
      yield { type: 'done' };
      return;
    } finally {
      this.notificationRouter?.endTurn();

      if (!tailDonePromise) {
        await stopTailToolPolling().catch(() => {});
      }

      this.cleanupActiveInputBundles();
      this.currentTurnId = null;
      this.currentQueryThreadId = null;
      this.pendingTurnNotifications = [];

      // Session file discovery fallback
      if (!this.session.getSessionFilePath()) {
        const threadId = this.session.getThreadId();
        if (threadId) {
          const sessionFilePath = findCodexSessionFile(
            threadId,
            this.resolveTranscriptRootHost(this.session.getSessionFilePath() ?? this.currentThreadPath) ?? undefined,
          );
          if (sessionFilePath) {
            this.session.setThread(threadId, sessionFilePath);
          }
        }
      }
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    if (turn.isCompact || this.canceled) {
      return false;
    }

    const transport = this.transport;
    const threadId = this.currentQueryThreadId;
    const turnId = this.currentTurnId;
    if (!transport || !threadId || !turnId) {
      return false;
    }

    const skillInputs = await this.resolveSkillInputs(turn.request.text);
    const inputBundle = this.buildInput(turn.prompt, turn.request.images, skillInputs);
    this.registerActiveInputBundle(inputBundle);

    try {
      const result = await transport.request<TurnSteerResult>('turn/steer', {
        threadId,
        input: inputBundle.input,
        expectedTurnId: turnId,
      });

      if (result.turnId !== turnId) {
        return false;
      }

      return this.currentQueryThreadId === threadId
        && this.currentTurnId === turnId
        && !this.canceled;
    } catch (error) {
      this.disposeInputBundle(inputBundle);
      throw error;
    }
  }

  cancel(): void {
    this.canceled = true;
    this.dismissAllPendingPrompts();

    const threadId = this.session.getThreadId();
    const turnId = this.currentTurnId;

    if (this.transport && threadId && turnId) {
      this.transport.request('turn/interrupt', { threadId, turnId }).catch(() => {
        // best-effort
      });
    }

    // Unblock the chunk-wait loop
    if (this.chunkResolve) {
      this.chunkResolve();
      this.chunkResolve = null;
    }
  }

  resetSession(): void {
    this.teardownState();
  }

  getSessionId(): string | null {
    return this.session.getThreadId();
  }

  consumeSessionInvalidation(): boolean {
    return this.session.consumeInvalidation();
  }

  isReady(): boolean {
    return this.ready;
  }

  private resetTurnMetadata(): void {
    this.turnMetadata = {};
  }

  private recordTurnMetadata(update: Partial<ChatTurnMetadata>): void {
    this.turnMetadata = {
      ...this.turnMetadata,
      ...update,
    };
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.cancel();
    this.teardownState();
    this.readyListeners.clear();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Codex does not support rewind' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
    this.serverRequestRouter.setApprovalCallback(callback);
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
    this.serverRequestRouter.setAskUserCallback(callback);
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.subagentHookProvider = getState;
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const threadId = this.session.getThreadId();
    const sessionFilePath = this.session.getSessionFilePath() ?? this.currentThreadPath;
    const transcriptRootPath = this.resolveTranscriptRootHost(sessionFilePath);

    // Preserve forkSource from existing conversation state
    const existingState = params.conversation
      ? getCodexState(params.conversation.providerState)
      : null;

    const providerState: CodexProviderState = {
      ...(threadId ? { threadId } : {}),
      ...(sessionFilePath ? { sessionFilePath } : {}),
      ...(
        transcriptRootPath || existingState?.transcriptRootPath
          ? { transcriptRootPath: transcriptRootPath ?? existingState?.transcriptRootPath }
          : {}
      ),
      ...(existingState?.forkSource ? { forkSource: existingState.forkSource } : {}),
      ...(
        existingState?.forkSourceSessionFilePath
          ? { forkSourceSessionFilePath: existingState.forkSourceSessionFilePath }
          : {}
      ),
      ...(
        existingState?.forkSourceTranscriptRootPath
          ? { forkSourceTranscriptRootPath: existingState.forkSourceTranscriptRootPath }
          : {}
      ),
    };

    const updates: Partial<Conversation> = {
      sessionId: threadId,
      providerState: providerState as Record<string, unknown>,
    };

    if (params.sessionInvalidated && params.conversation) {
      updates.sessionId = null;
      updates.providerState = undefined;
    }

    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    const threadId = this.session.getThreadId();
    if (threadId) return threadId;

    if (!conversation) return null;
    const state = getCodexState(conversation.providerState);
    return state.threadId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private teardownState(): void {
    this.cleanupActiveInputBundles();
    this.session.reset();
    this.launchSpec = null;
    this.runtimeContext = null;
    this.loadedThreadId = null;
    this.currentThreadPath = null;
    this.currentTurnId = null;
    this.currentQueryThreadId = null;
    this.pendingTurnNotifications = [];
    this.pendingFork = null;
    this.clientConfigKey = null;
    this.shutdownProcess().catch(() => {});
    this.setReady(false);
  }

  private dismissApprovalUI(): void {
    if (this.approvalDismisser) {
      this.approvalDismisser();
    }
  }

  private dismissAllPendingPrompts(): void {
    this.dismissApprovalUI();
    this.serverRequestRouter.abortPendingAskUser();
  }

  private registerActiveInputBundle(bundle: CodexInputBundle): void {
    this.activeInputBundles.add(bundle);
  }

  private disposeInputBundle(bundle: CodexInputBundle): void {
    if (this.activeInputBundles.delete(bundle)) {
      bundle.cleanup();
      return;
    }

    bundle.cleanup();
  }

  private cleanupActiveInputBundles(): void {
    for (const bundle of this.activeInputBundles) {
      bundle.cleanup();
    }
    this.activeInputBundles.clear();
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private getSystemPromptSettings(): SystemPromptSettings {
    const settings = this.plugin.settings;
    return {
      mediaFolder: settings.mediaFolder,
      customPrompt: settings.systemPrompt,
      vaultPath: getVaultPath(this.plugin.app) ?? undefined,
      userName: settings.userName,
    };
  }

  private getProviderSettings(): Record<string, unknown> {
    return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
  }

  private resolveModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
    const providerSettings = this.getProviderSettings();
    return queryOptions?.model ?? providerSettings.model as string | undefined;
  }

  private resolveSandboxConfig(): { approvalPolicy: string; sandbox: string } {
    const providerSettings = this.getProviderSettings();
    return resolveCodexSandboxConfig(
      providerSettings.permissionMode as string,
      getCodexProviderSettings(providerSettings).safeMode,
    );
  }

  private async startAppServer(launchSpec: CodexLaunchSpec, clientConfigKey: string): Promise<void> {
    this.launchSpec = launchSpec;
    this.process = new CodexAppServerProcess(launchSpec);
    this.process.start();

    this.transport = new CodexRpcTransport(this.process);
    this.transport.start();

    const initializeResult = await initializeCodexAppServerTransport(this.transport);
    this.runtimeContext = createCodexRuntimeContext(launchSpec, initializeResult);
    this.clientConfigKey = clientConfigKey;
  }

  private wireTransportHandlers(): void {
    if (!this.transport || !this.notificationRouter) return;

    const router = this.notificationRouter;
    const methods = [
      'item/agentMessage/delta',
      'item/started',
      'item/completed',
      'item/plan/delta',
      'item/reasoning/textDelta',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/summaryPartAdded',
      'thread/tokenUsage/updated',
      'turn/plan/updated',
      'turn/completed',
      'error',
      'thread/started',
      'thread/status/changed',
      'turn/started',
      'serverRequest/resolved',
      'item/commandExecution/outputDelta',
      'item/fileChange/outputDelta',
    ];

    for (const method of methods) {
      this.transport.onNotification(method, (params) => {
        if (method === 'serverRequest/resolved') {
          this.handleServerRequestResolved(params as ServerRequestResolvedNotification);
          return;
        }
        if (!this.routeNotification(method, params)) {
          return;
        }
        router.handleNotification(method, params);
      });
    }

    // Server requests (approvals, ask-user)
    const requestMethods = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ];

    for (const method of requestMethods) {
      this.transport.onServerRequest(method, (requestId, params) => {
        return this.serverRequestRouter.handleServerRequest(requestId, method, params);
      });
    }
  }

  private async shutdownProcess(): Promise<void> {
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.process) {
      await this.process.shutdown();
      this.process = null;
    }
    this.launchSpec = null;
    this.runtimeContext = null;
    this.notificationRouter = null;
    this.currentTurnId = null;
    this.currentQueryThreadId = null;
    this.pendingTurnNotifications = [];
    this.loadedThreadId = null;
  }

  private resolveExternalContextPaths(
    turn: PreparedChatTurn,
    queryOptions?: ChatRuntimeQueryOptions,
  ): string[] {
    const externalContextPaths = turn.request.externalContextPaths ?? queryOptions?.externalContextPaths ?? [];
    return [...new Set(externalContextPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
  }

  private buildTurnSandboxPolicy(
    externalContextPaths: string[],
    sandboxMode: string,
    transcriptRootTargetHint?: string | null,
    sessionFilePathHint?: string | null,
  ): SandboxPolicy | undefined {
    if (sandboxMode === 'danger-full-access') {
      return { type: 'dangerFullAccess' };
    }

    if (sandboxMode === 'read-only') {
      return {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      };
    }

    if (sandboxMode !== 'workspace-write') {
      return undefined;
    }

    const mappedExternalContextPaths = this.mapRequiredHostPathsToTarget(
      externalContextPaths,
      'external context path',
    );
    const memoriesDirTarget = deriveCodexMemoriesDirFromSessionsRoot(transcriptRootTargetHint)
      ?? this.resolveMemoriesDirTarget(sessionFilePathHint)
      ?? (
        this.launchSpec?.target.method === 'wsl'
          ? null
          : path.join(os.homedir(), '.codex', 'memories')
      );

    const writableRoots = [
      this.launchSpec?.targetCwd ?? getVaultPath(this.plugin.app),
      ...mappedExternalContextPaths,
      memoriesDirTarget,
      this.mapHostPathToTarget(os.tmpdir()),
      this.launchSpec?.target.platformFamily === 'unix' ? '/tmp' : null,
      this.mapHostPathToTarget(process.env.TMPDIR),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return {
      type: 'workspaceWrite',
      writableRoots: [...new Set(writableRoots)],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private handleServerRequestResolved(params: ServerRequestResolvedNotification): void {
    if (this.serverRequestRouter.hasPendingApprovalRequest(params.requestId, params.threadId)) {
      this.dismissApprovalUI();
      return;
    }

    this.serverRequestRouter.abortPendingAskUser(params.requestId, params.threadId);
  }

  private routeNotification(
    method: string,
    params: unknown,
  ): boolean {
    // turn/started can establish the active turn ID when the query didn't
    // receive one from the RPC response (e.g. thread/compact/start).
    if (method === 'turn/started') {
      this.handleTurnStartedNotification(params);
      return false;
    }

    const scope = this.extractNotificationScope(method, params);
    if (!scope) {
      return true;
    }

    if (!this.currentQueryThreadId || scope.threadId !== this.currentQueryThreadId) {
      return false;
    }

    if (!this.currentTurnId) {
      this.pendingTurnNotifications.push({ method, params });
      return false;
    }

    if (scope.turnId !== this.currentTurnId) {
      return false;
    }

    return true;
  }

  private handleTurnStartedNotification(params: unknown): void {
    if (!params || typeof params !== 'object') return;

    const notification = params as TurnStartedNotification;
    const threadId = notification.threadId;
    const turnId = notification.turn?.id;

    if (!threadId || !turnId) return;
    if (threadId !== this.currentQueryThreadId) return;

    // Only establish the turn ID if the current query doesn't have one yet.
    // Normal turn/start responses already set it; this path covers
    // thread/compact/start which returns {} without a turn.
    if (!this.currentTurnId) {
      this.currentTurnId = turnId;
      this.flushPendingTurnNotifications();
    }
  }

  private validateCompactTurn(turn: PreparedChatTurn): string | null {
    if (!turn.isCompact) {
      return null;
    }

    if (turn.request.text.trim() !== '/compact') {
      return '/compact does not accept arguments';
    }

    return null;
  }

  private flushPendingTurnNotifications(): void {
    if (!this.notificationRouter || !this.currentTurnId) {
      this.pendingTurnNotifications = [];
      return;
    }

    const pending = this.pendingTurnNotifications;
    this.pendingTurnNotifications = [];

    for (const notification of pending) {
      const scope = this.extractNotificationScope(notification.method, notification.params);
      if (!scope) {
        this.notificationRouter.handleNotification(notification.method, notification.params);
        continue;
      }

      if (
        scope.threadId === this.currentQueryThreadId
        && scope.turnId === this.currentTurnId
      ) {
        this.notificationRouter.handleNotification(notification.method, notification.params);
      }
    }
  }

  private extractNotificationScope(
    method: string,
    params: unknown,
  ): { threadId: string; turnId: string } | null {
    if (!params || typeof params !== 'object') {
      return null;
    }

    const notification = params as Record<string, unknown>;
    const threadId = typeof notification.threadId === 'string' ? notification.threadId : null;

    if (method === 'turn/completed') {
      const turn = notification.turn;
      const turnId = turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string'
        ? (turn as Record<string, unknown>).id as string
        : null;

      return threadId && turnId ? { threadId, turnId } : null;
    }

    const turnId = typeof notification.turnId === 'string' ? notification.turnId : null;
    return threadId && turnId ? { threadId, turnId } : null;
  }

  private async resolveSkillInputs(text: string): Promise<SkillInput[]> {
    const skillNames = extractExplicitCodexSkillNames(text);
    if (skillNames.length === 0 || !this.transport) {
      return [];
    }

    try {
      const cwd = this.launchSpec?.targetCwd ?? getVaultPath(this.plugin.app) ?? process.cwd();
      const result = await this.transport.request<SkillsListResult>('skills/list', {
        cwds: [cwd],
      });
      const skills = result.data.find(entry => entry.cwd === cwd)?.skills ?? result.data[0]?.skills ?? [];
      const resolvedInputs: SkillInput[] = [];

      for (const skillName of skillNames) {
        const resolvedSkill = findPreferredCodexSkillByName(skills, skillName);
        if (!resolvedSkill) {
          continue;
        }

        resolvedInputs.push({
          type: 'skill',
          name: resolvedSkill.name,
          path: resolvedSkill.path,
        });
      }

      return resolvedInputs;
    } catch {
      return [];
    }
  }

  private buildInput(text: string, images?: ImageAttachment[], skills?: SkillInput[]): CodexInputBundle {
    const input: UserInput[] = [];
    let tempDir: string | null = null;

    const cleanup = (): void => {
      if (!tempDir) {
        return;
      }

      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    };

    try {
      if (images && images.length > 0) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-images-'));
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (!img.mediaType.startsWith('image/')) continue;

          const filename = toAttachmentFilename(img, i);
          const filePath = path.join(tempDir, `${i + 1}-${filename}`);
          fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
          const targetFilePath = this.mapHostPathToTarget(filePath);
          if (!targetFilePath) {
            throw new Error(`Codex cannot access image attachment path from the selected target: ${filePath}`);
          }
          input.push({ type: 'localImage', path: targetFilePath });
        }
      }

      if (text) {
        input.push({ type: 'text', text, text_elements: [] });
      }

      if (skills && skills.length > 0) {
        input.push(...skills);
      }

      return { input, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private toHostSessionPath(targetPath: string | null | undefined): string | null {
    if (!targetPath) {
      return null;
    }

    return this.launchSpec?.pathMapper.toHostPath(targetPath) ?? targetPath;
  }

  private toTargetSessionPath(sessionPath: string | null | undefined): string | null {
    if (!sessionPath) {
      return null;
    }

    if (!this.launchSpec) {
      return sessionPath;
    }

    if (this.launchSpec.target.platformFamily === 'unix' && sessionPath.startsWith('/')) {
      return sessionPath;
    }

    if (
      this.launchSpec.target.platformFamily === 'windows'
      && (/^[A-Za-z]:[\\/]/.test(sessionPath) || sessionPath.startsWith('\\\\'))
    ) {
      return sessionPath;
    }

    return this.launchSpec.pathMapper.toTargetPath(sessionPath) ?? sessionPath;
  }

  private mapHostPathToTarget(hostPath: string | null | undefined): string | null {
    if (!hostPath) {
      return null;
    }

    return this.launchSpec?.pathMapper.toTargetPath(hostPath) ?? hostPath;
  }

  private mapRequiredHostPathsToTarget(hostPaths: string[], label: string): string[] {
    if (!this.launchSpec) {
      return hostPaths;
    }

    return hostPaths.map((hostPath) => {
      const targetPath = this.launchSpec!.pathMapper.toTargetPath(hostPath);
      if (!targetPath) {
        throw new Error(`Codex cannot access ${label} from the selected target: ${hostPath}`);
      }
      return targetPath;
    });
  }

  private resolveTranscriptRootHost(sessionFilePath?: string | null): string | null {
    return this.runtimeContext?.sessionsDirHost
      ?? deriveCodexSessionsRootFromSessionPath(
        sessionFilePath ?? this.session.getSessionFilePath() ?? this.currentThreadPath,
      );
  }

  private resolveTranscriptRootTarget(sessionFilePath?: string | null): string | null {
    if (this.runtimeContext?.sessionsDirTarget) {
      return this.runtimeContext.sessionsDirTarget;
    }

    const targetSessionPath = this.toTargetSessionPath(
      sessionFilePath ?? this.session.getSessionFilePath() ?? this.currentThreadPath,
    );
    return deriveCodexSessionsRootFromSessionPath(targetSessionPath);
  }

  private resolveMemoriesDirTarget(sessionFilePath?: string | null): string | null {
    if (this.runtimeContext?.memoriesDirTarget) {
      return this.runtimeContext.memoriesDirTarget;
    }

    return deriveCodexMemoriesDirFromSessionsRoot(
      this.resolveTranscriptRootTarget(sessionFilePath),
    );
  }
}

// ---------------------------------------------------------------------------
// Image attachment helpers
// ---------------------------------------------------------------------------

interface ImageAttachment {
  data: string;
  mediaType: string;
  filename?: string;
}

interface CodexInputBundle {
  input: UserInput[];
  cleanup: () => void;
}

function toAttachmentFilename(attachment: ImageAttachment, index: number): string {
  const base = (attachment.filename ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_') || `image-${index + 1}`;
  if (base.includes('.')) return base;
  const subtype = attachment.mediaType.split('/')[1] ?? 'img';
  const extension = subtype === 'jpeg' ? 'jpg' : subtype;
  return `${base}.${extension}`;
}

export { toAttachmentFilename as _toAttachmentFilename };

// ---------------------------------------------------------------------------
// Interrupt kind classification (preserved for history parsing)
// ---------------------------------------------------------------------------

export type CodexInterruptKind = 'user_request' | 'tool_use' | 'compaction_canceled';

export function mapCodexAbortReasonToInterruptKind(reason: string): CodexInterruptKind | undefined {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'user_request';
  }
  if (normalized.includes('tool')) {
    return 'tool_use';
  }
  if (normalized.includes('compact')) {
    return 'compaction_canceled';
  }

  return undefined;
}
