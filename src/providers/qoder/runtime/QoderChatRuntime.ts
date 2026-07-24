import { randomUUID } from 'node:crypto';

import type {
  CanUseToolOptions,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@qoder-ai/qoder-agent-sdk';

import { getProviderSettingsSnapshotWithModel } from '../../../core/providers/conversationModel';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindPreview,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_EXIT_PLAN_MODE,
} from '../../../core/tools/toolNames';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
  UsageInfo,
} from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import { QODER_PROVIDER_CAPABILITIES } from '../capabilities';
import { findQoderModel, resolveQoderContextWindow } from '../models';
import { getQoderProviderSettings } from '../settings';
import {
  buildPersistedQoderProviderState,
  parseQoderProviderState,
  type QoderProviderState,
} from '../types';
import { loadQoderQuery, loadQoderSdkModule } from './loadQoderSdk';
import { QoderCliResolver } from './QoderCliResolver';
import {
  buildQoderBaseOptions,
  closeQoderQuery,
  collectQoderCommands,
} from './QoderSdkBridge';
import {
  resolveQoderContextUsage,
  resolveQoderUsageContextWindow,
} from './QoderUsage';

interface ActiveTurn {
  abortController: AbortController;
  query: Query;
  queue: StreamChunkQueue;
}

interface ToolUseAccumulator {
  emitted: boolean;
  id: string;
  inputChunks: string[];
  name: string;
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

export interface QoderChatRuntimeOptions {
  capabilities?: Readonly<ProviderCapabilities>;
  cliResolver?: QoderCliResolver;
}

export class QoderChatRuntime implements ChatRuntime {
  readonly providerId = 'qoder' as const;

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private currentConversationModel: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private externalContextPaths: string[] = [];
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private pendingResumeCheckpoint: string | undefined;
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private ready = false;
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private supportedCommands: SlashCommand[] = [];
  private turnDiscoveryState: QoderProviderState = {};

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: QoderChatRuntimeOptions = {},
  ) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return this.options.capabilities ?? QODER_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: request.text,
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.pendingResumeCheckpoint = checkpointId;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    externalContextPaths?: string[],
  ): void {
    this.currentConversationModel = conversation?.selectedModel ?? null;
    this.externalContextPaths = [...(externalContextPaths ?? [])];
    const state = parseQoderProviderState(conversation?.providerState);
    const isPendingFork = !!state.forkSource && !conversation?.sessionId;
    this.turnDiscoveryState = state;
    this.sessionId = isPendingFork
      ? null
      : state.sessionId ?? conversation?.sessionId ?? null;
    this.sessionInvalidated = false;
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const vaultPath = getVaultPath(this.plugin.app);
    const cliPath = this.getCliResolver().resolveFromSettings(
      this.plugin.settings,
    );
    const nextReady = Boolean(vaultPath && cliPath);
    if (this.ready !== nextReady) {
      this.ready = nextReady;
      this.notifyReadyState();
    }
    return nextReady;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    if (this.activeTurn) {
      yield { type: 'error', content: 'Qoder does not support overlapping turns.' };
      return;
    }

    const ready = await this.ensureReady();
    if (!ready) {
      yield { type: 'error', content: 'Qoder CLI not found. Please install qodercli or configure its path.' };
      return;
    }

    const queue = new StreamChunkQueue();
    const abortController = new AbortController();
    const userMessageId = randomUUID();
    this.currentTurnMetadata = { userMessageId, wasSent: true };

    const q = await this.createTurnQuery(turn, userMessageId, abortController, queryOptions);
    this.activeTurn = { abortController, query: q, queue };

    void this.consumeTurnStream(q, queue, userMessageId).finally(() => {
      queue.push({ type: 'done' });
      queue.close();
      if (this.activeTurn?.query === q) {
        this.activeTurn = null;
      }
    });

    while (true) {
      const chunk = await queue.next();
      if (!chunk) {
        return;
      }
      yield chunk;
      if (chunk.type === 'done') {
        return;
      }
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return false;
    }

    const message = buildQoderUserMessage(
      turn.prompt,
      randomUUID(),
      turn.request.images,
      'now',
    );
    await activeTurn.query.streamInput(createQoderInputStream(message));
    return true;
  }

  cancel(): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }
    activeTurn.abortController.abort();
    void activeTurn.query.interrupt().catch(() => undefined);
  }

  resetSession(): void {
    this.sessionId = null;
    this.pendingResumeCheckpoint = undefined;
    this.turnDiscoveryState = {};
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
      return this.supportedCommands.map(command => ({ ...command }));
    }
    const commands = await collectQoderCommands({
      cliResolver: this.getCliResolver(),
      model: this.currentConversationModel,
      plugin: this.plugin,
    });
    this.supportedCommands = commands;
    return commands.map(command => ({ ...command }));
  }

  cleanup(): void {
    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    void closeQoderQuery(activeTurn?.query ?? null);
    activeTurn?.queue.close();
    this.ready = false;
    this.notifyReadyState();
  }

  async previewRewind(
    userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindPreview> {
    const query = await this.createControlQuery();
    if (!query) {
      return { canRewind: false, error: 'No active Qoder session to rewind.' };
    }

    try {
      const result = await query.rewindFiles(userMessageId, { dryRun: true });
      return {
        canRewind: result.canRewind,
        ...(result.error ? { error: result.error } : {}),
        ...(result.filesChanged ? { filesChanged: result.filesChanged } : {}),
      };
    } finally {
      await closeQoderQuery(query);
    }
  }

  async rewind(
    userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    const query = await this.createControlQuery();
    if (!query) {
      return { canRewind: false, error: 'No active Qoder session to rewind.' };
    }

    try {
      const result = await query.rewindFiles(userMessageId);
      return {
        canRewind: result.canRewind,
        ...(result.error ? { error: result.error } : {}),
        ...(result.filesChanged ? { filesChanged: result.filesChanged } : {}),
        ...(typeof result.insertions === 'number' ? { insertions: result.insertions } : {}),
        ...(typeof result.deletions === 'number' ? { deletions: result.deletions } : {}),
        sessionStrategy: 'preserve-provider-session',
      };
    } catch (error) {
      return {
        canRewind: false,
        error: error instanceof Error ? error.message : 'Failed to rewind Qoder files.',
      };
    } finally {
      await closeQoderQuery(query);
    }
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setAutoTurnCallback(callback: AutoTurnCallback | null): void {
    void callback;
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const currentState = parseQoderProviderState(params.conversation?.providerState);
    const providerState = buildPersistedQoderProviderState({
      ...currentState,
      ...this.turnDiscoveryState,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    return {
      updates: {
        providerState: providerState as Record<string, unknown> | undefined,
        sessionId: params.sessionInvalidated ? null : this.sessionId,
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return parseQoderProviderState(conversation?.providerState).sessionId
      ?? conversation?.sessionId
      ?? this.sessionId;
  }

  private async createTurnQuery(
    turn: PreparedChatTurn,
    userMessageId: string,
    abortController: AbortController,
    queryOptions?: ChatRuntimeQueryOptions,
  ): Promise<Query> {
    await this.materializePendingFork();
    const queryFactory = await loadQoderQuery();
    const prompt = createSingleTurnInput(
      turn.prompt,
      userMessageId,
      turn.request.images,
    );
    const settings = getQoderProviderSettings(this.plugin.settings);
    const model = queryOptions?.model ?? this.currentConversationModel;
    const permissionMode = resolveQoderPermissionMode(
      queryOptions?.model,
      settings.selectedPermissionMode,
      this.plugin.settings,
    );

    return queryFactory({
      prompt,
      options: {
        ...buildQoderBaseOptions({
          cliResolver: this.getCliResolver(),
          model,
          plugin: this.plugin,
          reasoningEffort: this.resolveReasoningEffort(model),
        }),
        abortController,
        additionalDirectories: queryOptions?.externalContextPaths ?? this.externalContextPaths,
        canUseTool: (toolName, input, options) => this.handlePermissionRequest(toolName, input, options),
        continue: Boolean(this.sessionId),
        ...(this.pendingResumeCheckpoint ? { resume: this.pendingResumeCheckpoint } : this.sessionId ? { resume: this.sessionId } : {}),
        permissionMode,
      },
    });
  }

  private async materializePendingFork(): Promise<void> {
    const forkSource = this.turnDiscoveryState.forkSource;
    if (!forkSource) {
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app) ?? undefined;
    const { forkSession } = await loadQoderSdkModule();
    const forked = await forkSession(forkSource.sessionId, {
      ...(vaultPath ? { dir: vaultPath } : {}),
      upToMessageId: forkSource.resumeAt,
    });
    const { forkSource: _consumedForkSource, ...remainingState } = this.turnDiscoveryState;
    this.sessionId = forked.sessionId;
    this.turnDiscoveryState = {
      ...remainingState,
      sessionId: forked.sessionId,
    };
  }

  /**
   * Resolves the reasoning effort for the given model using the same projected
   * settings the composer selector reflects, so the runtime sends exactly what
   * the user sees selected. Returns undefined when the model has no effort.
   */
  private resolveReasoningEffort(model: string | null | undefined): string | undefined {
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (!normalizedModel) {
      return undefined;
    }
    const projected = getProviderSettingsSnapshotWithModel(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
      normalizedModel,
    );
    const effort = typeof projected.effortLevel === 'string' ? projected.effortLevel.trim() : '';
    return effort || undefined;
  }

  private async consumeTurnStream(
    query: Query,
    queue: StreamChunkQueue,
    userMessageId: string,
  ): Promise<void> {
    const toolUses = new Map<number, ToolUseAccumulator>();
    const emittedFinalMessageKinds = new Set<string>();

    try {
      for await (const message of query) {
        if ('session_id' in message && typeof message.session_id === 'string') {
          this.sessionId = message.session_id;
        }
        switch (message.type) {
          case 'system':
            this.handleSystemMessage(message, queue);
            break;
          case 'stream_event':
            this.handleStreamEvent(message, queue, toolUses, emittedFinalMessageKinds);
            break;
          case 'assistant':
            this.handleAssistantMessage(message, queue, emittedFinalMessageKinds);
            break;
          case 'user':
            this.handleUserReplay(message, queue);
            break;
          case 'result':
            if (message.subtype === 'success') {
              this.currentTurnMetadata.planCompleted = message.stop_reason === 'pause_turn';
            } else {
              queue.push({ type: 'error', content: message.errors.join('\n') || 'Qoder turn failed.' });
            }
            queue.push({
              type: 'usage',
              sessionId: message.session_id,
              usage: this.buildUsageInfo(message),
            });
            break;
          default:
            break;
        }
      }
    } catch (error) {
      queue.push({
        type: 'error',
        content: error instanceof Error ? error.message : 'Qoder turn failed.',
      });
      this.sessionInvalidated = true;
    } finally {
      this.currentTurnMetadata.userMessageId ??= userMessageId;
      await closeQoderQuery(query);
    }
  }

  private handleSystemMessage(
    message: Extract<SDKMessage, { type: 'system' }>,
    queue: StreamChunkQueue,
  ): void {
    if (message.subtype === 'init') {
      this.sessionId = message.session_id;
      this.permissionModeSyncCallback?.(message.permissionMode);
      this.supportedCommands = message.slash_commands.map((name) => ({
        argumentHint: '',
        content: '',
        description: 'Qoder command',
        id: `qoder:${name}`,
        kind: 'command',
        name,
        source: 'sdk',
      }));
      this.turnDiscoveryState = {
        ...this.turnDiscoveryState,
        discovery: {
          agents: [],
          commands: this.supportedCommands,
          plugins: message.plugins,
          skills: message.skills,
        },
        sessionId: message.session_id,
      };
      return;
    }

    if (message.subtype === 'permission_denied') {
      queue.push({
        type: 'error',
        content: message.message,
      });
      return;
    }

    if (message.subtype === 'session_title_changed') {
      this.turnDiscoveryState = {
        ...this.turnDiscoveryState,
        lastKnownTitle: message.title,
      };
      return;
    }

    if (message.subtype === 'compact_boundary') {
      queue.push({ type: 'context_compacted' });
      return;
    }

    if (message.subtype === 'local_command_output') {
      queue.push({ type: 'notice', content: message.content });
      return;
    }
  }

  private handleStreamEvent(
    message: Extract<SDKMessage, { type: 'stream_event' }>,
    queue: StreamChunkQueue,
    toolUses: Map<number, ToolUseAccumulator>,
    emittedKinds: Set<string>,
  ): void {
    const event = message.event as Record<string, unknown>;
    const eventType = typeof event.type === 'string' ? event.type : '';
    const index = typeof event.index === 'number' ? event.index : -1;

    if (eventType === 'content_block_start') {
      const contentBlock = isRecord(event.content_block) ? event.content_block : null;
      if (contentBlock?.type === 'tool_use') {
        toolUses.set(index, {
          emitted: false,
          id: typeof contentBlock.id === 'string' ? contentBlock.id : randomUUID(),
          inputChunks: [],
          name: typeof contentBlock.name === 'string' ? contentBlock.name : 'Tool',
        });
      } else if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string') {
        emittedKinds.add('text');
        queue.push({ type: 'text', content: contentBlock.text });
      } else if (
        contentBlock?.type === 'thinking'
        && typeof contentBlock.thinking === 'string'
      ) {
        emittedKinds.add('thinking');
        queue.push({ type: 'thinking', content: contentBlock.thinking });
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : null;
      if (!delta) {
        return;
      }
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        emittedKinds.add('text');
        queue.push({ type: 'text', content: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        emittedKinds.add('thinking');
        queue.push({ type: 'thinking', content: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        toolUses.get(index)?.inputChunks.push(delta.partial_json);
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const toolUse = toolUses.get(index);
      if (!toolUse || toolUse.emitted) {
        return;
      }
      toolUse.emitted = true;
      emittedKinds.add(`tool_use:${toolUse.id}`);
      queue.push({
        type: 'tool_use',
        id: toolUse.id,
        input: parseToolInput(toolUse.inputChunks.join('')),
        name: toolUse.name,
      });
    }
  }

  private handleAssistantMessage(
    message: Extract<SDKMessage, { type: 'assistant' }>,
    queue: StreamChunkQueue,
    emittedKinds: Set<string>,
  ): void {
    for (const block of Array.isArray(message.message.content) ? message.message.content : []) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        continue;
      }
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string' && !emittedKinds.has('text')) {
        queue.push({ type: 'text', content: record.text });
      } else if (record.type === 'thinking' && typeof record.thinking === 'string' && !emittedKinds.has('thinking')) {
        queue.push({ type: 'thinking', content: record.thinking });
      } else if (record.type === 'tool_use') {
        const toolUseId = typeof record.id === 'string' ? record.id : randomUUID();
        if (emittedKinds.has(`tool_use:${toolUseId}`)) {
          continue;
        }
        queue.push({
          type: 'tool_use',
          id: toolUseId,
          input: isRecord(record.input) ? record.input : {},
          name: typeof record.name === 'string' ? record.name : 'Tool',
        });
      }
    }

    const blockKinds = Array.isArray(message.message.content)
      ? message.message.content
        .filter((block): block is { type: string } => !!block && typeof block === 'object' && !Array.isArray(block) && typeof (block as { type?: unknown }).type === 'string')
        .map(block => block.type)
      : [];
    for (const kind of blockKinds) {
      emittedKinds.add(kind);
    }
  }

  private handleUserReplay(
    message: Extract<SDKMessage, { type: 'user' }>,
    queue: StreamChunkQueue,
  ): void {
    this.currentTurnMetadata.userMessageId = message.uuid ?? this.currentTurnMetadata.userMessageId;
    const contentBlocks = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    for (const block of contentBlocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        continue;
      }
      const record = block as Record<string, unknown>;
      if (record.type !== 'tool_result') {
        continue;
      }
      queue.push({
        type: 'tool_result',
        id: typeof record.tool_use_id === 'string' ? record.tool_use_id : randomUUID(),
        content: typeof record.content === 'string' ? record.content : '',
        isError: record.is_error === true,
        ...(message.tool_use_result !== undefined ? { toolUseResult: message.tool_use_result as never } : {}),
      });
    }
  }

  private buildUsageInfo(
    message: Extract<SDKMessage, { type: 'result' }>,
  ): UsageInfo {
    const selectedModel = this.currentConversationModel ?? '';
    const providerSettings = getQoderProviderSettings(
      this.plugin.settings,
    );
    const discoveredModels = providerSettings.discoveredModels;
    const model = findQoderModel(discoveredModels, selectedModel);
    const modelUsageEntries = Object.entries(message.modelUsage ?? {});
    const matchingModelUsage = modelUsageEntries.find(([modelId]) => (
      selectedModel.endsWith(modelId) || modelId === selectedModel
    ))?.[1] ?? modelUsageEntries[0]?.[1];
    const contextWindow = resolveQoderUsageContextWindow(
      matchingModelUsage?.contextWindow,
      resolveQoderContextWindow(selectedModel, discoveredModels),
    );
    const inputTokens = message.usage.input_tokens;
    const cacheCreationInputTokens = message.usage.cache_creation_input_tokens;
    const cacheReadInputTokens = message.usage.cache_read_input_tokens;
    const reportedContextTokens = inputTokens
      + cacheCreationInputTokens
      + cacheReadInputTokens;
    const { contextTokens, percentage } = resolveQoderContextUsage({
      contextUsageRatio: message.usage.context_usage_ratio,
      contextWindow,
      reportedContextTokens,
    });

    return {
      cacheCreationInputTokens,
      cacheReadInputTokens,
      contextTokens,
      contextWindow,
      contextWindowIsAuthoritative: Boolean(
        matchingModelUsage?.contextWindow || model?.contextWindowIsAuthoritative,
      ),
      inputTokens,
      model: (model?.displayName ?? selectedModel) || undefined,
      percentage,
    };
  }

  private async createControlQuery(): Promise<Query | null> {
    if (!this.sessionId) {
      return null;
    }
    const queryFactory = await loadQoderQuery();
    return queryFactory({
      prompt: 'Return OK.',
      options: {
        ...buildQoderBaseOptions({
          cliResolver: this.getCliResolver(),
          model: this.currentConversationModel,
          plugin: this.plugin,
        }),
        continue: true,
        resume: this.sessionId,
      },
    });
  }

  private async handlePermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    if (toolName === TOOL_ASK_USER_QUESTION && this.askUserQuestionCallback) {
      return this.handleAskUserQuestion(input, options);
    }
    if (toolName === TOOL_EXIT_PLAN_MODE && this.exitPlanModeCallback) {
      return this.handleExitPlanMode(input, options);
    }

    const approvalCallback = this.approvalCallback;
    if (!approvalCallback) {
      return { behavior: 'allow', toolUseID: options.toolUseID };
    }

    const decision = await approvalCallback(
      toolName,
      input,
      options.description ?? options.title ?? toolName,
      {
        agentID: options.agentID,
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
      },
    );
    this.approvalDismisser?.();

    if (decision === 'allow' || decision === 'allow-always') {
      return { behavior: 'allow', toolUseID: options.toolUseID };
    }
    if (decision === 'cancel') {
      return { behavior: 'deny', interrupt: true, message: 'Cancelled by user.', toolUseID: options.toolUseID };
    }
    return { behavior: 'deny', message: 'Denied by user.', toolUseID: options.toolUseID };
  }

  private async handleAskUserQuestion(
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    const question = typeof input.question === 'string' ? input.question : '';
    const callbackInput = Array.isArray(input.questions)
      ? input
      : {
        questions: [{
          isOther: true,
          ...(Array.isArray(input.options) ? { options: input.options } : {}),
          question,
        }],
      };
    try {
      const answers = await this.askUserQuestionCallback?.(
        callbackInput,
        options.signal,
      );
      if (!answers) {
        return {
          behavior: 'deny',
          interrupt: true,
          message: 'User declined to answer.',
          toolUseID: options.toolUseID,
        };
      }
      const answer = answers[question] ?? Object.values(answers)[0];
      return {
        behavior: 'allow',
        toolUseID: options.toolUseID,
        updatedInput: {
          ...input,
          answer: Array.isArray(answer) ? answer.join(', ') : answer ?? '',
        },
      };
    } catch (error) {
      return {
        behavior: 'deny',
        interrupt: true,
        message: `Failed to get user answer: ${formatError(error)}`,
        toolUseID: options.toolUseID,
      };
    }
  }

  private async handleExitPlanMode(
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    try {
      const decision = await this.exitPlanModeCallback?.(input, options.signal);
      if (!decision) {
        return {
          behavior: 'deny',
          interrupt: true,
          message: 'User cancelled.',
          toolUseID: options.toolUseID,
        };
      }
      if (decision.type === 'feedback') {
        return {
          behavior: 'deny',
          message: decision.text,
          toolUseID: options.toolUseID,
        };
      }
      if (decision.type === 'abandon') {
        return {
          behavior: 'deny',
          interrupt: true,
          message: 'User abandoned the plan.',
          toolUseID: options.toolUseID,
        };
      }
      return {
        behavior: 'allow',
        toolUseID: options.toolUseID,
        updatedInput: { ...input, confirm: true },
      };
    } catch (error) {
      return {
        behavior: 'deny',
        interrupt: true,
        message: `Failed to handle plan mode exit: ${formatError(error)}`,
        toolUseID: options.toolUseID,
      };
    }
  }

  private getCliResolver(): QoderCliResolver {
    return this.options.cliResolver ?? new QoderCliResolver();
  }

  private notifyReadyState(): void {
    for (const listener of this.readyListeners) {
      listener(this.ready);
    }
  }
}

function createSingleTurnInput(
  prompt: string,
  userMessageId: string,
  images?: ImageAttachment[],
): AsyncIterable<SDKUserMessage> {
  return createQoderInputStream(
    buildQoderUserMessage(prompt, userMessageId, images),
  );
}

function createQoderInputStream(
  message: SDKUserMessage,
): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
}

export function buildQoderUserMessage(
  prompt: string,
  userMessageId: string,
  images?: ImageAttachment[],
  priority?: SDKUserMessage['priority'],
): SDKUserMessage {
  const content: Array<{ type: string; [key: string]: unknown }> = [
    { text: prompt, type: 'text' },
  ];
  for (const image of images ?? []) {
    if (!image.data) {
      continue;
    }
    content.push({
      source: {
        data: image.data,
        media_type: image.mediaType,
        type: 'base64',
      },
      type: 'image',
    });
  }

  return {
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    type: 'user',
    uuid: userMessageId,
  };
}

function resolveQoderPermissionMode(
  selectedModel: string | undefined,
  fallbackMode: string,
  settings: Record<string, unknown>,
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'yolo' | 'plan' | 'dontAsk' | 'auto' {
  const normalized = typeof settings.permissionMode === 'string'
    ? settings.permissionMode
    : fallbackMode;
  if (
    normalized === 'default'
    || normalized === 'acceptEdits'
    || normalized === 'bypassPermissions'
    || normalized === 'yolo'
    || normalized === 'plan'
    || normalized === 'dontAsk'
    || normalized === 'auto'
  ) {
    return normalized;
  }
  return selectedModel === 'plan' ? 'plan' : 'default';
}

function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
