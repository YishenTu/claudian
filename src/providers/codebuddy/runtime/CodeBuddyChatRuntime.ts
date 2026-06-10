import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { buildSystemPrompt, computeSystemPromptKey, type SystemPromptSettings } from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  ApprovalDecisionOption,
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
  ApprovalDecision,
  ChatMessage,
  Conversation,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  type AcpUsage,
  type AcpUsageUpdate,
  type AcpWriteTextFileRequest,
  buildAcpUsageInfo,
  extractAcpSessionModelState,
  extractAcpSessionThoughtLevelState,
} from '../../acp';
import { CODEBUDDY_PROVIDER_CAPABILITIES } from '../capabilities';
import {
  CODEBUDDY_DEFAULT_REASONING_LEVEL,
  type CodeBuddyDiscoveredModel,
  decodeCodeBuddyModelId,
  encodeCodeBuddyModelId,
} from '../models';
import { getCodeBuddyProviderSettings, updateCodeBuddyProviderSettings } from '../settings';
import { buildCodeBuddyPromptBlocks, buildCodeBuddyPromptText } from './buildCodeBuddyPrompt';
import { buildCodeBuddyRuntimeEnv } from './CodeBuddyRuntimeEnvironment';

interface ActiveTurn {
  queue: StreamChunkQueue;
  sessionId: string;
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

export class CodeBuddyChatRuntime implements ChatRuntime {
  readonly providerId = 'codebuddy' as const;

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private connection: AcpClientConnection | null = null;
  private contextUsage: AcpUsageUpdate | null = null;
  private currentLaunchKey: string | null = null;
  private currentSessionEffortConfigId: string | null = null;
  private currentSessionEffortValue: string | null = null;
  private currentSessionEffortValues = new Set<string>();
  private currentSessionModeId: string | null = null;
  private currentSessionModelId: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private loadedSessionId: string | null = null;
  private permissionModeSyncCallback: ((mode: string) => void) | null = null;
  private process: AcpSubprocess | null = null;
  private promptUsage: AcpUsage | null = null;
  private ready = false;
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private readonly sessionCwds = new Map<string, string>();
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private readonly supportedCommandWaiters: Array<(commands: SlashCommand[]) => void> = [];
  private supportedCommands: SlashCommand[] = [];
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;

  constructor(private readonly plugin: ClaudianPlugin) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CODEBUDDY_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: /^\/compact(\s|$)/i.test(request.text),
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildCodeBuddyPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    if (!conversation) {
      this.clearActiveSession();
      this.sessionInvalidated = false;
      return;
    }
    this.sessionId = conversation.sessionId ?? null;
    this.loadedSessionId = null;
    this.sessionInvalidated = false;
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const settings = getCodeBuddyProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      this.setReady(false);
      return false;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const targetSessionId = this.sessionId;
    const resolvedCliPath = this.plugin.getResolvedProviderCliPath('codebuddy') ?? 'codebuddy';
    const runtimeEnv = buildCodeBuddyRuntimeEnv(this.plugin.settings as unknown as Record<string, unknown>, resolvedCliPath);
    const promptSettings = this.getSystemPromptSettings(cwd);
    const systemPromptPath = await this.prepareSystemPrompt(cwd, promptSettings);
    const nextLaunchKey = JSON.stringify({
      command: resolvedCliPath,
      envText: getRuntimeEnvironmentText(this.plugin.settings, 'codebuddy'),
      promptKey: computeSystemPromptKey(promptSettings),
      systemPromptPath,
    });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.currentLaunchKey !== nextLaunchKey;

    if (shouldRestart) {
      await this.shutdownProcess();
      await this.startProcess({ command: resolvedCliPath, cwd, runtimeEnv, systemPromptPath });
      this.currentLaunchKey = nextLaunchKey;
      this.loadedSessionId = null;
    }

    if (targetSessionId) {
      if (this.loadedSessionId !== targetSessionId) {
        const loaded = await this.loadSession(targetSessionId, cwd);
        if (!loaded) {
          this.sessionInvalidated = true;
          this.clearActiveSession();
        }
      }
      return true;
    }

    if (!this.sessionId && !this.sessionInvalidated) {
      if (options?.allowSessionCreation === false) {
        return true;
      }
      return Boolean(await this.createSession(cwd));
    }

    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const previousMessages = conversationHistory ?? [];
    const expectedSessionId = this.sessionId;
    let shouldBootstrapHistory = previousMessages.length > 0 && (!expectedSessionId || this.sessionInvalidated);

    if (!(await this.ensureReady())) {
      yield { type: 'error', content: 'Failed to start CodeBuddy. Check the CLI path and login state.' };
      yield { type: 'done' };
      return;
    }

    if (!this.connection) {
      yield { type: 'error', content: 'CodeBuddy runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    if (expectedSessionId && !this.sessionId) {
      shouldBootstrapHistory = previousMessages.length > 0;
    }

    if (!this.sessionId) {
      const sessionId = await this.createSession(cwd);
      if (!sessionId) {
        yield { type: 'error', content: 'Failed to create a CodeBuddy session.' };
        yield { type: 'done' };
        return;
      }
    }

    const sessionId = this.sessionId!;
    this.activeTurn?.queue.close();
    this.activeTurn = { queue: new StreamChunkQueue(), sessionId };
    this.currentTurnMetadata = {};
    this.contextUsage = null;
    this.promptUsage = null;
    this.sessionUpdateNormalizer.reset();

    const activeTurn = this.activeTurn;
    try {
      await this.applySelectedMode(sessionId);
      await this.applySelectedModel(sessionId, queryOptions);
      await this.applySelectedEffort(sessionId);
    } catch (error) {
      yield { type: 'error', content: this.formatRuntimeError(error) };
      yield { type: 'done' };
      activeTurn.queue.close();
      this.activeTurn = null;
      return;
    }

    const promptPromise = this.connection.prompt({
      prompt: buildCodeBuddyPromptBlocks(
        turn.request,
        shouldBootstrapHistory ? previousMessages : [],
      ),
      sessionId,
    }).then((response) => {
      if (response.userMessageId) {
        this.currentTurnMetadata.userMessageId = response.userMessageId;
      }
      this.promptUsage = response.usage ?? null;
      const usage = buildAcpUsageInfo({
        contextWindow: this.contextUsage,
        model: this.getActiveDisplayModel(queryOptions),
        promptUsage: this.promptUsage,
      });
      if (usage) {
        activeTurn.queue.push({ sessionId, type: 'usage', usage });
      }
      activeTurn.queue.push({ type: 'done' });
      activeTurn.queue.close();
    }).catch((error) => {
      activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
      activeTurn.queue.push({ type: 'done' });
      activeTurn.queue.close();
    }).finally(() => {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    });

    try {
      while (true) {
        const chunk = await activeTurn.queue.next();
        if (!chunk) {
          break;
        }
        yield chunk;
      }
      await promptPromise;
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    if (!this.activeTurn || !this.connection) {
      return false;
    }
    await this.connection.prompt({
      prompt: buildCodeBuddyPromptBlocks(turn.request),
      sessionId: this.activeTurn.sessionId,
    });
    return true;
  }

  cancel(): void {
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId });
    }
  }

  resetSession(): void {
    this.clearActiveSession();
    this.sessionInvalidated = false;
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
    return this.waitForSupportedCommands();
  }

  getAuxiliaryModel(): string | null {
    return this.getActiveDisplayModel() ?? null;
  }

  cleanup(): void {
    void this.shutdownProcess();
  }

  async rewind(_userMessageId: string, _assistantMessageId: string, _mode?: ChatRewindMode): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'CodeBuddy rewind is not supported.' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {}
  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: { conversation: Conversation | null; sessionInvalidated: boolean }): SessionUpdateResult {
    const updates: Partial<Conversation> = { sessionId: this.sessionId };
    if (params.sessionInvalidated && !this.sessionId) {
      updates.providerState = undefined;
      updates.sessionId = null;
    }
    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId ?? conversation?.sessionId ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async startProcess(params: {
    command: string;
    cwd: string;
    runtimeEnv: NodeJS.ProcessEnv;
    systemPromptPath: string;
  }): Promise<void> {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...params.runtimeEnv,
      PATH: getEnhancedPath(params.runtimeEnv.PATH, path.isAbsolute(params.command) ? params.command : undefined),
    };

    this.process = new AcpSubprocess({
      args: ['--acp', '--system-prompt-file', params.systemPromptPath],
      command: params.command,
      cwd: params.cwd,
      env: processEnv,
    });
    this.process.start();

    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: (listener) => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    const transport = this.transport;
    this.unregisterTransportClose = transport.onClose(() => {
      if (this.transport === transport) {
        this.setReady(false);
      }
    });
    transport.onRequest('_codebuddy.ai/command', async () => ({}));

    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        fileSystem: {
          readTextFile: (request) => this.readTextFile(request),
          writeTextFile: (request) => this.writeTextFile(request),
        },
        onSessionNotification: (notification) => this.handleSessionNotification(notification),
        requestPermission: (request) => this.handlePermissionRequest(request),
      },
      transport: this.transport,
    });

    this.transport.start();
    await this.connection.initialize();
    this.setReady(true);
  }

  private async shutdownProcess(): Promise<void> {
    this.setReady(false);
    this.activeTurn?.queue.close();
    this.activeTurn = null;
    this.currentSessionEffortConfigId = null;
    this.currentSessionEffortValue = null;
    this.currentSessionEffortValues.clear();
    this.currentSessionModeId = null;
    this.currentSessionModelId = null;
    this.setSupportedCommands([]);

    this.unregisterTransportClose?.();
    this.unregisterTransportClose = null;
    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    if (this.process) {
      await this.process.shutdown().catch(() => {});
      this.process = null;
    }
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

  private getSystemPromptSettings(vaultPath: string): SystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath,
    };
  }

  private async prepareSystemPrompt(cwd: string, settings: SystemPromptSettings): Promise<string> {
    const dir = path.join(cwd, '.claudian', 'codebuddy');
    const filePath = path.join(dir, 'system.md');
    const content = buildSystemPrompt(settings);
    await fs.mkdir(dir, { recursive: true });
    try {
      const existing = await fs.readFile(filePath, 'utf-8');
      if (existing === content) {
        return filePath;
      }
    } catch {
      // Missing/unreadable prompt cache; rewrite it below.
    }
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private getProviderSettings(): Record<string, unknown> {
    try {
      return ProviderSettingsCoordinator.getProviderSettingsSnapshot(this.plugin.settings, this.providerId);
    } catch {
      return this.plugin.settings as unknown as Record<string, unknown>;
    }
  }

  private resolveSelectedRawModelId(queryOptions?: ChatRuntimeQueryOptions): string | null {
    const providerSettings = this.getProviderSettings();
    const selectedModel = typeof queryOptions?.model === 'string'
      ? queryOptions.model
      : typeof providerSettings.model === 'string'
      ? providerSettings.model
      : '';
    return decodeCodeBuddyModelId(selectedModel);
  }

  private getActiveDisplayModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
    const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
    if (selectedRawModelId) {
      return encodeCodeBuddyModelId(selectedRawModelId);
    }
    return this.currentSessionModelId ? encodeCodeBuddyModelId(this.currentSessionModelId) : undefined;
  }

  private resolveSelectedModeId(): string {
    const permissionMode = this.getProviderSettings().permissionMode;
    if (permissionMode === 'plan') {
      return 'plan';
    }
    if (permissionMode === 'yolo') {
      return 'bypassPermissions';
    }
    return 'default';
  }

  private async applySelectedMode(sessionId: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    const selectedModeId = this.resolveSelectedModeId();
    if (selectedModeId === this.currentSessionModeId) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: 'mode',
      sessionId,
      type: 'select',
      value: selectedModeId,
    });
    this.currentSessionModeId = selectedModeId;
    this.syncModeFromConfig(response.configOptions);
  }

  private async applySelectedModel(sessionId: string, queryOptions?: ChatRuntimeQueryOptions): Promise<void> {
    if (!this.connection) {
      return;
    }
    const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
    if (!selectedRawModelId || selectedRawModelId === this.currentSessionModelId) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: 'model',
      sessionId,
      type: 'select',
      value: selectedRawModelId,
    });
    this.currentSessionModelId = selectedRawModelId;
    await this.syncSessionModelState({ configOptions: response.configOptions });
  }

  private resolveSelectedEffortValue(): string | null {
    const selectedEffort = typeof this.getProviderSettings().effortLevel === 'string'
      ? String(this.getProviderSettings().effortLevel).trim()
      : '';
    if (!selectedEffort || selectedEffort === CODEBUDDY_DEFAULT_REASONING_LEVEL) {
      return null;
    }
    return this.currentSessionEffortValues.has(selectedEffort) ? selectedEffort : null;
  }

  private async applySelectedEffort(sessionId: string): Promise<void> {
    if (!this.connection || !this.currentSessionEffortConfigId) {
      return;
    }
    const selectedEffort = this.resolveSelectedEffortValue();
    if (!selectedEffort || selectedEffort === this.currentSessionEffortValue) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: this.currentSessionEffortConfigId,
      sessionId,
      type: 'select',
      value: selectedEffort,
    });
    this.currentSessionEffortValue = selectedEffort;
    await this.syncSessionModelState({ configOptions: response.configOptions });
  }

  private async syncSessionModelState(params: {
    configOptions?: AcpSessionConfigOption[] | null;
    models?: AcpSessionModelState | null;
  }): Promise<void> {
    const modelState = extractAcpSessionModelState(params);
    const thinkingState = extractAcpSessionThoughtLevelState(params);
    const discoveredModels: CodeBuddyDiscoveredModel[] = modelState.availableModels.map((model) => ({
      description: model.description ?? null,
      label: model.name || model.id,
      rawId: model.id,
    }));
    const currentRawModelId = modelState.currentModelId;
    this.currentSessionModelId = currentRawModelId;
    this.currentSessionEffortConfigId = thinkingState.configId;
    this.currentSessionEffortValue = thinkingState.currentLevel;
    this.currentSessionEffortValues = new Set(thinkingState.availableLevels.map((option) => option.id));

    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const currentSettings = getCodeBuddyProviderSettings(settingsBag);
    const nextVisibleModels = currentSettings.visibleModels.length === 0 && currentRawModelId
      ? [currentRawModelId]
      : currentSettings.visibleModels;
    const nextPreferredThinking = currentRawModelId && thinkingState.currentLevel
      ? {
        ...currentSettings.preferredThinkingByModel,
        [currentRawModelId]: currentSettings.preferredThinkingByModel[currentRawModelId]
          ?? thinkingState.currentLevel,
      }
      : currentSettings.preferredThinkingByModel;

    let changed = false;
    if (currentRawModelId) {
      changed = this.seedActiveModelSelection(settingsBag, encodeCodeBuddyModelId(currentRawModelId), thinkingState.currentLevel) || changed;
    }

    const shouldUpdateSettings = !sameJson(currentSettings.discoveredModels, discoveredModels)
      || !sameJson(currentSettings.visibleModels, nextVisibleModels)
      || !sameJson(currentSettings.preferredThinkingByModel, nextPreferredThinking);
    if (!shouldUpdateSettings && !changed) {
      return;
    }

    updateCodeBuddyProviderSettings(settingsBag, {
      discoveredModels,
      preferredThinkingByModel: nextPreferredThinking,
      visibleModels: nextVisibleModels,
    });
    await this.plugin.saveSettings();
    this.refreshModelSelectors();
  }

  private seedActiveModelSelection(settingsBag: Record<string, unknown>, modelSelection: string, thinkingLevel: string | null): boolean {
    let changed = false;
    const savedProviderModel = ensureProviderProjectionMap(settingsBag, 'savedProviderModel');
    const savedModel = typeof savedProviderModel.codebuddy === 'string' ? savedProviderModel.codebuddy : '';
    if (!savedModel || savedModel === 'codebuddy') {
      savedProviderModel.codebuddy = modelSelection;
      changed = true;
    }

    if (thinkingLevel) {
      const savedProviderEffort = ensureProviderProjectionMap(settingsBag, 'savedProviderEffort');
      const savedEffort = typeof savedProviderEffort.codebuddy === 'string' ? savedProviderEffort.codebuddy : '';
      if (!savedEffort || savedEffort === CODEBUDDY_DEFAULT_REASONING_LEVEL) {
        savedProviderEffort.codebuddy = thinkingLevel;
        changed = true;
      }
    }

    if (this.isActiveSettingsProvider(settingsBag)) {
      return this.seedActiveTopLevelSelection(settingsBag, modelSelection, thinkingLevel) || changed;
    }

    return changed;
  }

  private seedActiveTopLevelSelection(
    settingsBag: Record<string, unknown>,
    modelSelection: string,
    thinkingLevel: string | null,
  ): boolean {
    let changed = false;
    const activeModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';
    if (!activeModel || activeModel === 'codebuddy') {
      settingsBag.model = modelSelection;
      changed = true;
    }
    if (thinkingLevel) {
      const activeEffort = typeof settingsBag.effortLevel === 'string' ? settingsBag.effortLevel : '';
      if (!activeEffort || activeEffort === CODEBUDDY_DEFAULT_REASONING_LEVEL) {
        settingsBag.effortLevel = thinkingLevel;
        changed = true;
      }
    }
    return changed;
  }

  private isActiveSettingsProvider(settingsBag: Record<string, unknown>): boolean {
    return settingsBag.settingsProvider === this.providerId;
  }

  private syncModeFromConfig(configOptions?: AcpSessionConfigOption[] | null): void {
    const modeOption = configOptions?.find((option) => option.type === 'select' && option.category === 'mode');
    if (modeOption?.type !== 'select') {
      return;
    }
    this.currentSessionModeId = modeOption.currentValue;
    this.emitPermissionModeSync(modeOption.currentValue);
  }

  private refreshModelSelectors(): void {
    for (const view of this.plugin.getAllViews()) {
      view.refreshModelSelector();
    }
  }

  private emitPermissionModeSync(modeId: string): void {
    if (!this.permissionModeSyncCallback) {
      return;
    }
    const permissionMode = modeId === 'plan'
      ? 'plan'
      : (modeId === 'bypassPermissions' || modeId === 'fullAccess')
      ? 'yolo'
      : 'normal';
    try {
      this.permissionModeSyncCallback(permissionMode);
    } catch {
      // Non-critical UI sync callback.
    }
  }

  private async createSession(cwd: string): Promise<string | null> {
    if (!this.connection) {
      return null;
    }
    try {
      this.setSupportedCommands([]);
      const response = await this.connection.newSession({ cwd, mcpServers: [] });
      this.loadedSessionId = response.sessionId;
      this.sessionId = response.sessionId;
      this.sessionCwds.set(response.sessionId, cwd);
      await this.syncSessionModelState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      });
      this.syncModeFromConfig(response.configOptions ?? null);
      return response.sessionId;
    } catch {
      return null;
    }
  }

  private async loadSession(sessionId: string, cwd: string): Promise<boolean> {
    if (!this.connection) {
      return false;
    }
    try {
      this.setSupportedCommands([]);
      const response = await this.connection.loadSession({ cwd, mcpServers: [], sessionId });
      this.sessionInvalidated = false;
      this.loadedSessionId = response.sessionId;
      this.sessionId = response.sessionId;
      this.sessionCwds.set(response.sessionId, cwd);
      await this.syncSessionModelState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      });
      this.syncModeFromConfig(response.configOptions ?? null);
      return true;
    } catch {
      return false;
    }
  }

  private async handleSessionNotification(notification: AcpSessionNotification): Promise<void> {
    if (notification.sessionId !== this.sessionId) {
      return;
    }

    const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
    if (normalized.type === 'config_options') {
      await this.syncSessionModelState({ configOptions: normalized.configOptions });
      this.syncModeFromConfig(normalized.configOptions);
      return;
    }
    if (normalized.type === 'commands') {
      this.setSupportedCommands(normalized.commands);
      return;
    }

    if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) {
      return;
    }

    switch (normalized.type) {
      case 'message_chunk':
        if (normalized.role === 'assistant' && normalized.messageId) {
          this.currentTurnMetadata.assistantMessageId = normalized.messageId;
        }
        if (normalized.role === 'user' && normalized.messageId) {
          this.currentTurnMetadata.userMessageId = normalized.messageId;
        }
        for (const chunk of normalized.streamChunks) {
          this.activeTurn.queue.push(chunk);
        }
        return;
      case 'tool_call':
      case 'tool_call_update':
        for (const chunk of normalized.streamChunks) {
          this.activeTurn.queue.push(chunk);
        }
        return;
      case 'usage': {
        this.contextUsage = normalized.usage;
        const usage = buildAcpUsageInfo({
          contextWindow: normalized.usage,
          model: this.getActiveDisplayModel(),
          promptUsage: this.promptUsage,
        });
        if (usage) {
          this.activeTurn.queue.push({ sessionId: notification.sessionId, type: 'usage', usage });
        }
        return;
      }
      default:
        return;
    }
  }

  private async handlePermissionRequest(request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse> {
    if (!this.approvalCallback) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const input = normalizeApprovalInput(request.toolCall.rawInput);
    const presentation = buildPermissionPresentation(request.toolCall.title, input, request.toolCall.locations);
    const decision = await this.approvalCallback(
      presentation.toolName,
      input,
      presentation.description,
      {
        ...(presentation.blockedPath ? { blockedPath: presentation.blockedPath } : {}),
        ...(presentation.decisionReason ? { decisionReason: presentation.decisionReason } : {}),
        decisionOptions: buildAcpApprovalDecisionOptions(request.options),
      },
    );
    return mapApprovalDecision(decision, request.options);
  }

  private setSupportedCommands(commands: SlashCommand[]): void {
    this.supportedCommands = commands.map((command) => ({ ...command }));
    const waiters = this.supportedCommandWaiters.splice(0);
    for (const waiter of waiters) {
      waiter(this.supportedCommands);
    }
  }

  private waitForSupportedCommands(timeoutMs = 250): Promise<SlashCommand[]> {
    if (this.supportedCommands.length > 0) {
      return Promise.resolve([...this.supportedCommands]);
    }
    return new Promise((resolve) => {
      const waiter = (commands: SlashCommand[]) => {
        window.clearTimeout(timeoutId);
        resolve([...commands]);
      };
      const timeoutId = window.setTimeout(() => {
        const index = this.supportedCommandWaiters.indexOf(waiter);
        if (index >= 0) {
          this.supportedCommandWaiters.splice(index, 1);
        }
        resolve([...this.supportedCommands]);
      }, timeoutMs);
      this.supportedCommandWaiters.push(waiter);
    });
  }

  private async readTextFile(request: AcpReadTextFileRequest): Promise<{ content: string }> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    if (request.line === undefined && request.limit === undefined) {
      return { content };
    }
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, (request.line ?? 1) - 1);
    const endIndex = request.limit ? startIndex + Math.max(0, request.limit) : lines.length;
    return { content: lines.slice(startIndex, endIndex).join('\n') };
  }

  private async writeTextFile(request: AcpWriteTextFileRequest): Promise<Record<string, never>> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, request.content, 'utf-8');
    return {};
  }

  private resolveSessionPath(sessionId: string, rawPath: string): string {
    if (path.isAbsolute(rawPath)) {
      return rawPath;
    }
    const cwd = this.sessionCwds.get(sessionId) ?? getVaultPath(this.plugin.app) ?? process.cwd();
    return path.resolve(cwd, rawPath);
  }

  private formatRuntimeError(error: unknown): string {
    const baseMessage = error instanceof Error ? error.message : 'CodeBuddy request failed';
    const stderr = this.process?.getStderrSnapshot();
    return stderr ? `${baseMessage}\n\n${stderr}` : baseMessage;
  }

  private clearActiveSession(): void {
    this.sessionId = null;
    this.loadedSessionId = null;
    this.currentSessionEffortConfigId = null;
    this.currentSessionEffortValue = null;
    this.currentSessionEffortValues.clear();
    this.currentSessionModeId = null;
    this.currentSessionModelId = null;
    this.setSupportedCommands([]);
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ensureProviderProjectionMap(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = settings[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  settings[key] = next;
  return next;
}

function normalizeApprovalInput(rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  if (rawInput === undefined) {
    return {};
  }
  return { value: rawInput };
}

function buildPermissionPresentation(
  rawTitle: string | null | undefined,
  input: Record<string, unknown>,
  locations: Array<{ path: string }> | null | undefined,
): { blockedPath?: string; decisionReason?: string; description: string; toolName: string } {
  const permissionId = rawTitle?.trim() || 'tool';
  const blockedPath = extractPermissionPath(input, locations);
  return {
    ...(blockedPath ? { blockedPath } : {}),
    description: blockedPath
      ? `CodeBuddy wants permission to use ${formatPermissionLabel(permissionId)} on this path.`
      : `CodeBuddy wants permission to use ${formatPermissionLabel(permissionId)}.`,
    toolName: formatPermissionLabel(permissionId),
  };
}

function extractPermissionPath(
  input: Record<string, unknown>,
  locations: Array<{ path: string }> | null | undefined,
): string | undefined {
  for (const key of ['filepath', 'filePath', 'path', 'parentDir']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return locations?.find((location) => location.path.trim())?.path.trim() || undefined;
}

function formatPermissionLabel(permissionId: string): string {
  return permissionId
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function mapApprovalDecision(
  decision: ApprovalDecision,
  options: readonly { kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'; optionId: string }[],
): AcpRequestPermissionResponse {
  if (decision === 'allow') {
    return selectPermissionOption(options, ['allow_once', 'allow_always']);
  }
  if (decision === 'allow-always') {
    return selectPermissionOption(options, ['allow_always', 'allow_once']);
  }
  if (decision === 'deny') {
    return selectPermissionOption(options, ['reject_once', 'reject_always']);
  }
  if (typeof decision === 'object' && decision.type === 'select-option') {
    return { outcome: { optionId: decision.value, outcome: 'selected' } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

function buildAcpApprovalDecisionOptions(
  options: readonly { kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'; name: string; optionId: string }[],
): ApprovalDecisionOption[] {
  return options.map((option) => ({
    ...(option.kind === 'allow_once'
      ? { decision: 'allow' as const }
      : option.kind === 'allow_always'
      ? { decision: 'allow-always' as const }
      : {}),
    label: option.name,
    value: option.optionId,
  }));
}

function selectPermissionOption(
  options: readonly { kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'; optionId: string }[],
  preferredKinds: readonly ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[],
): AcpRequestPermissionResponse {
  for (const kind of preferredKinds) {
    const option = options.find((entry) => entry.kind === kind);
    if (option) {
      return { outcome: { optionId: option.optionId, outcome: 'selected' } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}
