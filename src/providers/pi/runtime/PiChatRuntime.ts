import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
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
import type {
  ChatMessage,
  Conversation,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
  UsageInfo,
} from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { PI_PROVIDER_CAPABILITIES } from '../capabilities';
import {
  createPiForkSessionFile,
  findPiSessionFile,
  parsePiSessionEntries,
  resolvePiActivePath,
} from '../history/PiHistoryStore';
import {
  clampPiThinkingLevel,
  decodePiModelId,
  findPiModel,
  PI_SYNTHETIC_MODEL_ID,
} from '../models';
import {
  createPiEventNormalizationState,
  getPiTerminalErrorMessage,
  normalizePiRpcEvent,
  type PiEventNormalizationState,
} from '../normalizations/piEventNormalization';
import { getPiProviderSettings } from '../settings';
import {
  buildPersistedPiState,
  getPiState,
  type PiForkSource,
  type PiProviderState,
} from '../types';
import { buildPiPromptImages, buildPiPromptText } from './buildPiPrompt';
import { buildPiUsageInfo } from './buildPiUsageInfo';
import { PiExtensionUiBridge, type PiExtensionUiRenderer } from './PiExtensionUiBridge';
import { buildPiLaunchSpec, type PiLaunchSpec } from './PiLaunchSpec';
import { buildPiSetModelPayload } from './PiRpcPayloads';
import { type PiRpcRecord, PiRpcTransport } from './PiRpcTransport';
import { PiSubprocess } from './PiSubprocess';

interface ActiveTurn {
  cancel: (error: Error) => void;
  cancelled: boolean;
  queue: StreamChunkQueue;
  rejectTerminal: (error: Error) => void;
  resolveTerminal: () => void;
  terminalPromise: Promise<void>;
}

class StreamChunkQueue {
  private closed = false;
  private readonly items: StreamChunk[] = [];
  private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

  push(chunk: StreamChunk): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
      return;
    }
    this.items.push(chunk);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }

  async next(): Promise<StreamChunk | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }

    if (this.closed) {
      return null;
    }

    return new Promise<StreamChunk | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export interface PiChatRuntimeOptions {
  extensionUiRenderer?: PiExtensionUiRenderer | null;
}

export class PiChatRuntime implements ChatRuntime {
  readonly providerId = 'pi' as const;

  private activeTurn: ActiveTurn | null = null;
  private currentLaunchKey: string | null = null;
  private currentModel: string | null = null;
  private currentSessionTarget: string | null = null;
  private currentThinkingLevel: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private extensionBridge: PiExtensionUiBridge | null = null;
  private leafEntryId: string | null = null;
  private parentSession: string | null = null;
  private pendingFork: PiForkSource | null = null;
  private pendingForkSourceSessionFile: string | null = null;
  private process: PiSubprocess | null = null;
  private ready = false;
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private sessionFile: string | null = null;
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private supportedCommands: SlashCommand[] = [];
  private shutdownPromise: Promise<void> | null = null;
  private transport: PiRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;

  constructor(
    private readonly plugin: ClaudianPlugin,
    private readonly options: PiChatRuntimeOptions = {},
  ) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return PI_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    const isCompact = isCompactCommand(request.text);
    return {
      isCompact,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildPiPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    if (!conversation) {
      this.sessionId = null;
      this.sessionFile = null;
      this.leafEntryId = null;
      this.parentSession = null;
      this.pendingFork = null;
      this.pendingForkSourceSessionFile = null;
      this.sessionInvalidated = false;
      return;
    }

    const state = getPiState(conversation.providerState);
    if (state.forkSource && !state.sessionId && !state.sessionFile && !conversation.sessionId) {
      this.sessionId = null;
      this.sessionFile = null;
      this.leafEntryId = null;
      this.parentSession = null;
      this.pendingFork = state.forkSource;
      this.pendingForkSourceSessionFile = state.forkSourceSessionFile ?? null;
      this.sessionInvalidated = false;
      return;
    }

    this.sessionId = state.sessionId ?? conversation.sessionId ?? null;
    this.sessionFile = state.sessionFile ?? null;
    this.leafEntryId = state.leafEntryId ?? null;
    this.parentSession = state.parentSession ?? null;
    this.pendingFork = null;
    this.pendingForkSourceSessionFile = null;
    this.sessionInvalidated = false;
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const settings = getPiProviderSettings(this.plugin.settings as unknown as Record<string, unknown>);
    if (!settings.enabled) {
      this.setReady(false);
      return false;
    }

    const allowSessionCreation = options?.allowSessionCreation !== false;
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const resolvedCliPath = this.plugin.getResolvedProviderCliPath('pi') ?? 'pi';
    const runtimeEnvText = getRuntimeEnvironmentText(this.plugin.settings as unknown as Record<string, unknown>, 'pi');
    if (allowSessionCreation) {
      await this.materializePendingFork(cwd, runtimeEnvText);
    }

    const hasSessionTarget = Boolean(this.sessionId || this.sessionFile);
    const promptSettings = this.getSystemPromptSettings(cwd);
    const systemPrompt = buildSystemPrompt(promptSettings);
    const noSession = !allowSessionCreation && !hasSessionTarget;
    const launchSpec = buildPiLaunchSpec({
      command: resolvedCliPath,
      cwd,
      env: this.buildRuntimeEnv(runtimeEnvText),
      envText: runtimeEnvText,
      noSession,
      providerState: this.getCurrentProviderState(),
      settings,
      systemPrompt,
    });
    const sessionTarget = this.sessionFile ?? this.sessionId ?? null;
    const nextLaunchKey = JSON.stringify({
      command: resolvedCliPath,
      cwd,
      envText: runtimeEnvText,
      noSession,
      promptKey: computeSystemPromptKey(promptSettings),
      systemPrompt,
      toolMode: settings.toolMode,
    });
    const sessionTargetChanged = sessionTarget !== this.currentSessionTarget;
    const canSwitchSessionTarget = sessionTargetChanged && this.isSwitchableSessionFile(this.sessionFile);
    const unSwitchableSessionTargetChanged = sessionTargetChanged && !canSwitchSessionTarget;

    const shouldRestart = !this.process
      || !this.transport
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.currentLaunchKey !== nextLaunchKey
      || unSwitchableSessionTargetChanged;

    if (shouldRestart) {
      await this.shutdownProcess();
      await this.startProcess(launchSpec);
      this.currentLaunchKey = nextLaunchKey;
      this.currentSessionTarget = sessionTarget;
    } else if (canSwitchSessionTarget && this.sessionFile) {
      await this.switchSession(this.sessionFile, launchSpec, nextLaunchKey);
    }

    if (allowSessionCreation || hasSessionTarget) {
      await this.refreshStateAndSessionTarget();
    }
    this.setReady(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.currentTurnMetadata = {};
    let isReady: boolean;
    try {
      isReady = await this.ensureReady();
    } catch (error) {
      yield { type: 'error', content: this.formatRuntimeError(error) };
      yield { type: 'done' };
      return;
    }

    if (!isReady) {
      yield { type: 'error', content: 'Failed to start Pi. Check the CLI path and login state.' };
      yield { type: 'done' };
      return;
    }

    if (!this.transport) {
      yield { type: 'error', content: 'Pi runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    const activeTurn = this.createActiveTurn();
    this.activeTurn = activeTurn;
    this.normalizationState = createPiEventNormalizationState();
    const shouldBootstrapHistory = (conversationHistory?.length ?? 0) > 0
      && !this.sessionId
      && !this.sessionFile;
    const promptText = buildPiPromptText(
      turn.request,
      shouldBootstrapHistory ? conversationHistory : [],
    );
    const images = buildPiPromptImages(turn.request.images);

    const runTurn = this.runTurn(
      activeTurn,
      turn,
      promptText,
      images,
      queryOptions,
    );

    try {
      while (true) {
        const chunk = await activeTurn.queue.next();
        if (!chunk) {
          break;
        }
        yield chunk;
      }
      await runTurn;
    } finally {
      if (this.activeTurn === activeTurn) {
        this.transport?.send({ type: 'abort' });
        activeTurn.cancel(new Error('Pi turn cancelled'));
        activeTurn.queue.close();
        this.activeTurn = null;
        void this.shutdownProcess();
      }
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    if (!this.transport || this.transport.isClosed) {
      return false;
    }

    try {
      const images = buildPiPromptImages(turn.request.images);
      await this.transport.request('steer', {
        ...(images.length > 0 ? { images } : {}),
        message: buildPiPromptText(turn.request),
      });
      this.activeTurn?.queue.push({
        type: 'user_message_start',
        content: turn.request.text,
      });
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    this.transport?.send({ type: 'abort' });
  }

  resetSession(): void {
    this.sessionInvalidated = true;
    this.sessionId = null;
    this.sessionFile = null;
    this.leafEntryId = null;
    this.parentSession = null;
    this.pendingFork = null;
    this.pendingForkSourceSessionFile = null;
    this.currentSessionTarget = null;
    if (this.transport && !this.transport.isClosed) {
      void this.transport.request('new_session')
        .then((response) => {
          this.applyStateResponse(response);
          this.currentSessionTarget = this.sessionFile ?? this.sessionId ?? null;
        })
        .catch(() => {});
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    if (this.supportedCommands.length > 0) {
      return [...this.supportedCommands];
    }
    if (!this.transport || this.transport.isClosed) {
      return [];
    }

    try {
      const response = await this.transport.request('get_commands', {}, 10_000);
      this.supportedCommands = normalizePiRuntimeCommands(response);
      return [...this.supportedCommands];
    } catch {
      return [];
    }
  }

  getAuxiliaryModel(): string | null {
    return this.currentModel;
  }

  cleanup(): void {
    this.activeTurn?.queue.close();
    this.extensionBridge?.cleanup();
    void this.shutdownProcess();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void {}
  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}
  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {}
  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const providerState = buildPersistedPiState(this.getCurrentProviderState());
    const updates: Partial<Conversation> = {
      providerState: providerState as Record<string, unknown> | undefined,
      sessionId: this.sessionId,
    };

    if (params.sessionInvalidated && !this.sessionId) {
      updates.providerState = undefined;
      updates.sessionId = null;
    }

    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    const state = getPiState(conversation?.providerState);
    return this.sessionFile
      ?? this.sessionId
      ?? state.sessionFile
      ?? state.sessionId
      ?? conversation?.sessionId
      ?? state.forkSource?.sessionId
      ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private createActiveTurn(): ActiveTurn {
    let terminalSettled = false;
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminalPromise = new Promise<void>((resolve, reject) => {
      resolveTerminal = () => {
        if (terminalSettled) {
          return;
        }
        terminalSettled = true;
        resolve();
      };
      rejectTerminal = (error) => {
        if (terminalSettled) {
          return;
        }
        terminalSettled = true;
        reject(error);
      };
    });
    terminalPromise.catch(() => {});

    const activeTurn: ActiveTurn = {
      cancel: (error) => {
        activeTurn.cancelled = true;
        rejectTerminal(error);
      },
      cancelled: false,
      queue: new StreamChunkQueue(),
      rejectTerminal,
      resolveTerminal,
      terminalPromise,
    };
    return activeTurn;
  }

  private async runTurn(
    activeTurn: ActiveTurn,
    turn: PreparedChatTurn,
    promptText: string,
    images: ReturnType<typeof buildPiPromptImages>,
    queryOptions?: ChatRuntimeQueryOptions,
  ): Promise<void> {
    try {
      const turnStartLeafId = await this.resolveCurrentLeafEntryId();
      await this.applySelectedModel(queryOptions);
      await this.applySelectedThinkingLevel(queryOptions);
      if (activeTurn.cancelled) {
        throw new Error('Pi turn cancelled');
      }

      if (turn.isCompact) {
        await this.transport!.request('compact', {
          customInstructions: stripCompactCommand(turn.request.text),
        });
        this.currentTurnMetadata.wasSent = true;
        activeTurn.queue.push({ type: 'context_compacted' });
      } else {
        activeTurn.queue.push({
          type: 'user_message_start',
          content: turn.request.text,
        });
        await this.transport!.request('prompt', {
          ...(images.length > 0 ? { images } : {}),
          message: promptText,
        });
        this.currentTurnMetadata.wasSent = true;
        await activeTurn.terminalPromise;
      }

      await this.refreshStateAndSessionTarget();
      await this.updateTurnMetadataFromSessionFile(turnStartLeafId);
      const usage = await this.fetchUsage(queryOptions).catch(() => null);
      if (usage) {
        activeTurn.queue.push({ sessionId: this.sessionId, type: 'usage', usage });
      }
      activeTurn.queue.push({ type: 'done' });
    } catch (error) {
      activeTurn.queue.push({
        type: 'error',
        content: this.formatRuntimeError(error),
      });
      activeTurn.queue.push({ type: 'done' });
    } finally {
      activeTurn.queue.close();
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    }
  }

  private async startProcess(launchSpec: PiLaunchSpec): Promise<void> {
    this.process = new PiSubprocess(launchSpec);
    this.process.start();
    this.transport = new PiRpcTransport({
      input: this.process.stdout,
      onClose: (listener) => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    this.transport.start();
    this.extensionBridge = new PiExtensionUiBridge(
      this.transport,
      this.options.extensionUiRenderer ?? null,
      (chunk) => this.activeTurn?.queue.push(chunk),
    );
    this.transport.onEvent((event) => this.handleRpcEvent(event));
    this.unregisterTransportClose = this.transport.onClose((error) => {
      this.setReady(false);
      this.extensionBridge?.cleanup();
      this.activeTurn?.rejectTerminal(error ?? new Error('Pi runtime closed'));
    });
    this.setReady(true);
  }

  private async shutdownProcess(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.doShutdownProcess().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  private async doShutdownProcess(): Promise<void> {
    this.setReady(false);
    this.activeTurn?.cancel(new Error('Pi runtime stopped'));
    this.activeTurn?.queue.close();
    this.activeTurn = null;
    this.extensionBridge?.cleanup();
    this.extensionBridge = null;
    this.unregisterTransportClose?.();
    this.unregisterTransportClose = null;
    this.transport?.dispose();
    this.transport = null;
    const process = this.process;
    this.process = null;
    this.currentModel = null;
    this.currentSessionTarget = null;
    this.currentThinkingLevel = null;
    if (process) {
      await process.shutdown().catch(() => {});
    }
    this.supportedCommands = [];
  }

  private handleRpcEvent(event: PiRpcRecord): void {
    if (this.extensionBridge?.handleRequest(event)) {
      return;
    }

    if (event.type === 'agent_end') {
      this.activeTurn?.resolveTerminal();
      return;
    }

    if (event.type === 'error') {
      this.activeTurn?.queue.push({
        type: 'error',
        content: typeof event.error === 'string' ? event.error : 'Pi runtime error.',
      });
      this.activeTurn?.resolveTerminal();
      return;
    }

    const state = this.getNormalizationState();
    const chunks = normalizePiRpcEvent(event, state);
    for (const chunk of chunks) {
      this.activeTurn?.queue.push(chunk);
    }
    if (getPiTerminalErrorMessage(event)) {
      this.activeTurn?.resolveTerminal();
    }
  }

  private normalizationState: PiEventNormalizationState = createPiEventNormalizationState();

  private getNormalizationState(): PiEventNormalizationState {
    if (!this.activeTurn) {
      this.normalizationState = createPiEventNormalizationState();
      return this.normalizationState;
    }
    return this.normalizationState;
  }

  private async applySelectedModel(queryOptions?: ChatRuntimeQueryOptions): Promise<void> {
    if (!this.transport) {
      return;
    }

    const selectedModel = this.resolveSelectedModel(this.getProviderSettings(), queryOptions);
    const payload = selectedModel ? buildPiSetModelPayload(selectedModel) : null;
    if (!payload || this.currentModel === selectedModel) {
      return;
    }

    await this.transport.request('set_model', payload);
    this.currentModel = selectedModel;
    this.currentThinkingLevel = null;
  }

  private async applySelectedThinkingLevel(queryOptions?: ChatRuntimeQueryOptions): Promise<void> {
    if (!this.transport) {
      return;
    }

    const providerSettings = this.getProviderSettings();
    const selectedThinkingLevel = this.resolveSelectedThinkingLevel(providerSettings, queryOptions);
    if (!selectedThinkingLevel || this.currentThinkingLevel === selectedThinkingLevel) {
      return;
    }

    await this.transport.request('set_thinking_level', {
      level: selectedThinkingLevel,
    });
    this.currentThinkingLevel = selectedThinkingLevel;
  }

  private async refreshState(): Promise<void> {
    if (!this.transport || this.transport.isClosed) {
      return;
    }

    const response = await this.transport.request('get_state', {}, 10_000);
    this.applyStateResponse(response);
  }

  private async refreshStateAndSessionTarget(): Promise<void> {
    try {
      await this.refreshState();
      this.currentSessionTarget = this.sessionFile ?? this.sessionId ?? null;
    } catch {
      // State refresh is opportunistic; the next turn can still proceed.
    }
  }

  private applyStateResponse(response: unknown): void {
    const state = extractStateRecord(response);
    this.sessionId = getString(state.sessionId)
      ?? getString(state.session_id)
      ?? getString(getRecord(state.session)?.id)
      ?? this.sessionId;
    this.sessionFile = getString(state.sessionFile)
      ?? getString(state.session_file)
      ?? getString(state.sessionPath)
      ?? getString(state.session_path)
      ?? getString(state.path)
      ?? this.sessionFile;
    this.leafEntryId = getString(state.leafEntryId)
      ?? getString(state.leaf_entry_id)
      ?? this.leafEntryId;
    this.parentSession = getString(state.parentSession)
      ?? getString(state.parent_session)
      ?? this.parentSession;
  }

  private async fetchUsage(queryOptions?: ChatRuntimeQueryOptions): Promise<UsageInfo | null> {
    if (!this.transport || this.transport.isClosed) {
      return null;
    }

    const providerSettings = this.getProviderSettings();
    const selectedModel = this.resolveSelectedModel(providerSettings, queryOptions);
    const fallbackContextWindow = selectedModel
      ? findPiModel(getPiProviderSettings(providerSettings), selectedModel)?.contextWindow
      : undefined;
    const response = await this.transport.request('get_session_stats', {}, 10_000);
    return buildPiUsageInfo(response, selectedModel, fallbackContextWindow);
  }

  private async materializePendingFork(cwd: string, runtimeEnvText: string): Promise<void> {
    if (!this.pendingFork) {
      return;
    }

    const env = parseEnvironmentVariables(runtimeEnvText);
    const sourceSessionFile = this.pendingForkSourceSessionFile
      ?? findPiSessionFile(
        this.pendingFork.sessionId,
        cwd,
        typeof env.PI_CODING_AGENT_SESSION_DIR === 'string' ? env.PI_CODING_AGENT_SESSION_DIR : null,
      );
    if (!sourceSessionFile) {
      throw new Error(`Pi fork source session not found: ${this.pendingFork.sessionId}`);
    }

    const forkedSession = await createPiForkSessionFile(
      sourceSessionFile,
      this.pendingFork.resumeAt,
      { targetCwd: cwd },
    );
    this.sessionId = forkedSession.sessionId;
    this.sessionFile = forkedSession.sessionFile;
    this.leafEntryId = forkedSession.leafEntryId;
    this.parentSession = forkedSession.parentSession;
    this.pendingFork = null;
    this.pendingForkSourceSessionFile = null;
    this.sessionInvalidated = false;
    this.currentSessionTarget = null;
  }

  private async resolveCurrentLeafEntryId(): Promise<string | null> {
    if (this.leafEntryId) {
      return this.leafEntryId;
    }
    if (!this.sessionFile) {
      return null;
    }

    try {
      const content = await fsp.readFile(this.sessionFile, 'utf-8');
      const entries = parsePiSessionEntries(content).entries;
      const activePath = resolvePiActivePath(entries);
      const leafEntryId = getLastPiEntryId(activePath);
      this.leafEntryId = leafEntryId;
      return leafEntryId;
    } catch {
      return null;
    }
  }

  private async updateTurnMetadataFromSessionFile(previousLeafEntryId: string | null): Promise<void> {
    if (!this.sessionFile) {
      return;
    }

    try {
      const content = await fsp.readFile(this.sessionFile, 'utf-8');
      const entries = parsePiSessionEntries(content).entries;
      const activePath = resolvePiActivePath(entries);
      if (activePath.length === 0) {
        return;
      }

      this.leafEntryId = getLastPiEntryId(activePath) ?? this.leafEntryId;
      const previousLeafIndex = previousLeafEntryId
        ? activePath.findIndex(entry => entry.id === previousLeafEntryId)
        : -1;
      const newEntries = previousLeafIndex >= 0
        ? activePath.slice(previousLeafIndex + 1)
        : activePath;
      const userEntry = previousLeafIndex >= 0
        ? newEntries.find(entry => getPiEntryRole(entry) === 'user')
        : findLastPiEntryByRole(newEntries, 'user');
      const assistantEntry = findLastPiEntryByRole(newEntries, 'assistant');

      if (userEntry?.id) {
        this.currentTurnMetadata.userMessageId = userEntry.id;
      }
      if (assistantEntry?.id) {
        this.currentTurnMetadata.assistantMessageId = assistantEntry.id;
      }
    } catch {
      // Live checkpoint metadata is best-effort; hydration can still recover IDs later.
    }
  }

  private getSystemPromptSettings(vaultPath: string): SystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath,
    };
  }

  private getProviderSettings(): Record<string, unknown> {
    return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
  }

  private resolveSelectedModel(
    providerSettings: Record<string, unknown>,
    queryOptions?: ChatRuntimeQueryOptions,
  ): string | null {
    const selectedModel = typeof queryOptions?.model === 'string'
      ? queryOptions.model
      : typeof providerSettings.model === 'string'
      ? providerSettings.model
      : '';

    if (!selectedModel || selectedModel === PI_SYNTHETIC_MODEL_ID || !decodePiModelId(selectedModel)) {
      return null;
    }

    return selectedModel;
  }

  private resolveSelectedThinkingLevel(
    providerSettings: Record<string, unknown>,
    queryOptions?: ChatRuntimeQueryOptions,
  ): string | null {
    const selectedModel = this.resolveSelectedModel(providerSettings, queryOptions);
    if (!selectedModel) {
      return null;
    }

    const piSettings = getPiProviderSettings(providerSettings);
    const selectedThinkingLevel = typeof providerSettings.effortLevel === 'string' && providerSettings.effortLevel.trim()
      ? providerSettings.effortLevel.trim()
      : piSettings.preferredThinkingByModel[selectedModel];
    const selectedPiModel = findPiModel(piSettings, selectedModel);
    if (selectedPiModel) {
      return clampPiThinkingLevel(selectedThinkingLevel, selectedPiModel.thinkingLevels);
    }

    return selectedThinkingLevel ?? null;
  }

  private buildRuntimeEnv(runtimeEnvText: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...parseEnvironmentVariables(runtimeEnvText),
    };
  }

  private getCurrentProviderState(): PiProviderState {
    if (this.pendingFork) {
      return {
        forkSource: this.pendingFork,
        ...(this.pendingForkSourceSessionFile
          ? { forkSourceSessionFile: this.pendingForkSourceSessionFile }
          : {}),
      };
    }

    return {
      ...(this.leafEntryId ? { leafEntryId: this.leafEntryId } : {}),
      ...(this.parentSession ? { parentSession: this.parentSession } : {}),
      ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return;
    }

    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private formatRuntimeError(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Pi request failed';
    const stderr = this.process?.getStderrSnapshot();
    return stderr ? `${message}\n\n${stderr}` : message;
  }

  private isSwitchableSessionFile(sessionFile: string | null): sessionFile is string {
    return typeof sessionFile === 'string'
      && sessionFile.trim().length > 0
      && path.isAbsolute(sessionFile);
  }

  private async switchSession(
    sessionFile: string,
    launchSpec: PiLaunchSpec,
    nextLaunchKey: string,
  ): Promise<void> {
    try {
      await this.transport!.request('switch_session', { sessionPath: sessionFile });
      this.currentLaunchKey = nextLaunchKey;
      this.currentSessionTarget = sessionFile;
      this.sessionInvalidated = false;
    } catch {
      await this.shutdownProcess();
      await this.startProcess(launchSpec);
      this.currentLaunchKey = nextLaunchKey;
      this.currentSessionTarget = this.sessionFile ?? this.sessionId ?? null;
    }
  }
}

function stripCompactCommand(text: string): string {
  return text.trim().replace(/^\/compact(?:\s|$)/i, '').trim();
}

function isCompactCommand(text: string): boolean {
  return /^\/compact(\s|$)/i.test(text);
}

function normalizePiRuntimeCommands(response: unknown): SlashCommand[] {
  const records = Array.isArray(response)
    ? response
    : Array.isArray(getRecord(response).commands)
    ? getRecord(response).commands as unknown[]
    : [];
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const entry = getRecord(record);
    const name = getString(entry.name)?.replace(/^\/+/, '');
    if (!name || seen.has(name.toLowerCase())) {
      continue;
    }

    seen.add(name.toLowerCase());
    const source = getString(entry.source);
    commands.push({
      content: '',
      description: getString(entry.description) ?? undefined,
      id: `pi:${source ?? 'runtime'}:${name}`,
      kind: source === 'skill' ? 'skill' : 'command',
      name,
      source: 'sdk',
    });
  }

  return commands;
}

function extractStateRecord(response: unknown): Record<string, unknown> {
  const record = getRecord(response);
  return getRecord(record.state ?? record.session ?? response);
}

function getPiEntryRole(entry: { message?: Record<string, unknown>; type: string }): string | null {
  const message = entry.message ?? {};
  const role = getString(message.role);
  if (role) {
    return role;
  }

  if (entry.type === 'toolResult') {
    return 'toolResult';
  }
  return null;
}

function getLastPiEntryId(entries: Array<{ id?: string }>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i].id;
    if (id) {
      return id;
    }
  }
  return null;
}

function findLastPiEntryByRole<T extends { message?: Record<string, unknown>; type: string }>(
  entries: T[],
  role: string,
): T | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (getPiEntryRole(entries[i]) === role) {
      return entries[i];
    }
  }
  return undefined;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
