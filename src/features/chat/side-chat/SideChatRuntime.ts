import type { Component } from 'obsidian';

import type {
  ProviderExecutionBackend,
  ProviderExecutionContext,
  ProviderExecutionLifecycleRegistry,
  ProviderSessionEvent,
} from '../../../core/execution';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderId, TitleGenerationService } from '../../../core/providers/types';
import type { AskUserAnswers, ChatMessage, ImageAttachment, ToolCallInfo } from '../../../core/types';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import {
  StreamController,
} from '../controllers/StreamController';
import { TurnCoordinator } from '../controllers/TurnCoordinator';
import { buildChatExecutionConfiguration, resolveChatDynamicSections } from '../execution/chatExecutionConfiguration';
import { AsyncQuestionPrompts } from '../rendering/AsyncQuestionPrompts';
import { BackgroundResponses } from '../rendering/BackgroundResponses';
import { renderSessionTaskNotification } from '../rendering/BackgroundTurnRenderer';
import { InlineInteractionPrompts } from '../rendering/InlineInteractionPrompts';
import { createInteractionPromptPort } from '../rendering/interactionPromptPort';
import { MessageRenderer } from '../rendering/MessageRenderer';
import { ResponseStream } from '../rendering/ResponseStream';
import { deliverAsyncQuestion } from '../services/asyncQuestionDelivery';
import { SubagentManager } from '../services/SubagentManager';
import { ChatState } from '../state/ChatState';
import { SideChatCommandSubmission } from './SideChatCommandSubmission';
import { SideChatSession } from './SideChatSession';
import type {
  SideChatSettingsProjection,
  SideChatSource,
  SideChatStatus,
} from './SideChatTypes';

export interface SideChatRuntimeDeps {
  readonly plugin: ChatFeatureHost;
  readonly component: Component;
  readonly source: SideChatSource;
  readonly settings: SideChatSettingsProjection;
  readonly messagesEl: HTMLElement;
  /** Host for this side chat's own inline approval and question prompts. */
  readonly getPromptParentEl: () => HTMLElement | null;
  readonly lifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly resolveBackend: (providerId: ProviderId) => ProviderExecutionBackend;
  readonly buildChildResumeState: () => Promise<Readonly<Record<string, unknown>>>;
  readonly vaultWorkingDirectory: string;
  readonly onStatusChanged: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface SideChatSubmission {
  /** Queue admission detaches this transient interaction guard. */
  readonly assertBeforeHandoff?: () => void;
  readonly onDelivery?: (accepted: boolean) => void;
  readonly content: string;
  readonly displayContent?: string;
  readonly images?: readonly ImageAttachment[];
  readonly context?: ProviderExecutionContext;
}

/**
 * One temporary side conversation: its own messages, rendering, settings
 * projection and execution owner. Nothing here writes a Claudian conversation,
 * accepted-input record, or tab shell.
 */
export class SideChatRuntime {
  readonly state: ChatState;
  readonly renderer: MessageRenderer;
  readonly #stream: StreamController;
  readonly #subagents: SubagentManager;
  readonly #session: SideChatSession;
  readonly #prompts: InlineInteractionPrompts;
  readonly #asyncQuestions: AsyncQuestionPrompts;
  readonly #settings: SideChatSettingsProjection;
  #activeDelivery: SideChatSubmission['onDelivery'];
  readonly #responseStream: ResponseStream;
  /** Owns the requested side turn; presentation state derives from it. */
  readonly #turns = new TurnCoordinator();
  #status: SideChatStatus = 'preparing';
  #lastError: string | null = null;
  #disposed = false;
  #preparation: { controller: AbortController; pending: Promise<unknown> } | null = null;
  #draining = false;
  #requestedSettlement: Promise<void> | null = null;
  #sessionEventWork: Promise<void> = Promise.resolve();
  readonly #backgroundResponses: BackgroundResponses;
  readonly #queuedSubmissions: Array<SideChatSubmission | SideChatCommandSubmission> = [];
  readonly #pendingCommands = new Set<SideChatCommandSubmission>();
  #activeCommand: SideChatCommandSubmission | null = null;
  #title: string | null = null;
  #titleService: TitleGenerationService | null = null;

  constructor(private readonly deps: SideChatRuntimeDeps) {
    this.#settings = { ...deps.settings };
    this.state = new ChatState({
      onAttentionChanged: () => this.#refreshStatus(),
      onStreamingStateChanged: () => this.#refreshStatus(),
    }, undefined, this.#turns);
    this.renderer = new MessageRenderer(
      deps.plugin,
      deps.component,
      deps.messagesEl,
      undefined,
      undefined,
      () => this.capabilities,
      undefined,
    );
    this.#subagents = new SubagentManager(() => undefined);
    this.#prompts = new InlineInteractionPrompts({
      getPromptParentEl: () => deps.getPromptParentEl(),
      onBeforeShow: () => this.#stream.hideThinkingIndicator(),
      onAfterSettle: () => this.#stream.resumeThinkingIndicator(),
    });
    this.#asyncQuestions = new AsyncQuestionPrompts({
      prompts: this.#prompts,
      answer: (tool, answers, signal) => this.#answerQuestion(tool, answers, signal),
      onChange: tool => this.renderer.updateQuestionTool(tool),
      onPendingChange: (id, pending) => pending ? this.state.beginActionRequired(id) : this.state.endActionRequired(id),
    });
    this.#stream = new StreamController({
      onQuestionToolChanged: tool => this.#asyncQuestions.update(tool),
      getMessagesEl: () => deps.messagesEl,
      getProviderId: () => deps.source.providerId,
      getProviderSessionId: () => this.#session.providerSessionId ?? null,
      plugin: deps.plugin,
      renderer: this.renderer,
      state: this.state,
      subagentManager: this.#subagents,
      updateQueueIndicator: () => undefined,
    });
    this.#responseStream = new ResponseStream({
      state: this.state, renderer: this.renderer, stream: this.#stream, turns: this.#turns,
      createMessageId: createSideMessageId,
    });
    this.#backgroundResponses = new BackgroundResponses({
      state: this.state, renderer: this.renderer, stream: this.#stream,
      isConnected: () => deps.messagesEl.isConnected, createMessageId: createSideMessageId,
    });
    const ephemeral = this.capabilities.supportsEphemeralFork ?? this.capabilities.supportsEphemeralSessions;
    this.#session = new SideChatSession({
      buildChildResumeState: deps.buildChildResumeState,
      interactionPort: createInteractionPromptPort(this.state, () => this.#prompts),
      lifecycleRegistry: deps.lifecycleRegistry,
      onError: error => deps.onError?.(error),
      onInvalidated: () => {
        this.#asyncQuestions.expireAll();
        this.#discardQueuedSubmissions();
        this.#backgroundResponses.discard();
        this.#lastError = ephemeral
          ? 'This side chat has ended. Discard it and start a new side chat.'
          : 'The provider session was replaced. Send again to resume the side chat.';
        this.#refreshStatus();
      },
      onRequestedEvent: event => this.#handleExecutionEvent(event),
      onSessionEvent: (event, isCurrent) => this.#enqueueSessionEvent(event, isCurrent),
      onBackgroundWorkChanged: () => {
        this.#refreshStatus();
        this.#resumeQueuedSubmissions();
      },
      providerId: deps.source.providerId,
      ephemeral,
      resolveBackend: deps.resolveBackend,
      vaultWorkingDirectory: deps.vaultWorkingDirectory,
    });
  }

  async #answerQuestion(tool: ToolCallInfo, answers: AskUserAnswers, signal: AbortSignal): Promise<void> {
    await deliverAsyncQuestion(tool, answers, {
      providerId: this.providerId,
      assertCurrent: () => {
        if (this.#disposed || !this.state.messages.some(message => message.toolCalls?.includes(tool))) {
          throw new Error('This side chat is no longer available.');
        }
        if (this.state.cancelRequested) throw new Error('The answer was not sent. Please try again.');
      },
      prepare: reply => ({
        steer: async () => {
          if (!this.state.isStreaming) return 'not-sent';
          let accepted: boolean;
          try {
            accepted = await this.#session.steer(reply.content);
          } catch {
            return 'uncertain';
          }
          if (!accepted) return 'not-sent';
          if (!this.#disposed) {
            const message: ChatMessage = {
              content: reply.content, displayContent: reply.displayContent,
              id: createSideMessageId(), role: 'user', timestamp: Date.now(),
            };
            this.state.addMessage(message);
            this.renderer.addMessage(message);
          }
          return 'accepted';
        },
        submit: async (onDelivery, assertBeforeHandoff) => {
          const submission = { content: reply.content, displayContent: reply.displayContent, onDelivery };
          if (this.isWorking) onDelivery(this.enqueue(submission));
          else await this.submit({ ...submission, assertBeforeHandoff });
        },
      }),
    }, signal);
  }

  get source(): SideChatSource {
    return this.deps.source;
  }

  get providerId(): ProviderId {
    return this.deps.source.providerId;
  }

  get capabilities(): ProviderCapabilities {
    return ProviderRegistry.getCapabilities(this.deps.source.providerId, this.deps.source.providerState);
  }

  get status(): SideChatStatus {
    return this.#status;
  }

  get title(): string | null {
    return this.#title;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get isWorking(): boolean {
    return this.#preparation !== null || this.#draining || Boolean(this.#session?.hasBackgroundWork);
  }

  get queuedCount(): number {
    return this.#queuedSubmissions.length;
  }

  get settings(): Readonly<SideChatSettingsProjection> {
    return this.#settings;
  }

  updateSettings(patch: SideChatSettingsProjection): void {
    Object.assign(this.#settings, patch);
  }

  setPromptActive(active: boolean): void {
    this.#prompts.setActive(active);
  }

  setTabActive(active: boolean): void {
    this.#stream.setTabActive(active);
  }

  /** Preparation belongs to this child, including cancellation and disposal. */
  async prepareSubmission<T>(prepare: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposed || this.isWorking) throw new Error('The side chat is busy.');
    const controller = new AbortController();
    const pending = prepare(controller.signal);
    this.#preparation = { controller, pending };
    this.#refreshStatus();
    let prepared = false;
    try {
      const result = await pending;
      controller.signal.throwIfAborted();
      prepared = true;
      return result;
    } finally {
      this.#preparation = null;
      if (!this.#disposed) this.#refreshStatus();
      if (!prepared) this.#resumeQueuedSubmissions();
    }
  }

  /** Accept a detached snapshot without changing the shared composer's destination. */
  enqueue(submission: SideChatSubmission | SideChatCommandSubmission): boolean {
    if (this.#disposed || !this.isWorking) return false;
    if (submission instanceof SideChatCommandSubmission) {
      this.#trackCommand(submission);
      this.#queuedSubmissions.push(submission);
    } else {
      if (!submission.content.trim()) return false;
      // Submission data contains only text, image metadata and plain selection context.
      this.#queuedSubmissions.push({ ...JSON.parse(JSON.stringify(submission)) as SideChatSubmission, onDelivery: submission.onDelivery });
    }
    this.#refreshStatus();
    return true;
  }

  async submit(submission: SideChatSubmission | SideChatCommandSubmission): Promise<void> {
    if (this.#disposed || this.isWorking) {
      if (submission instanceof SideChatCommandSubmission) submission.cancel();
      else submission.onDelivery?.(false);
      return;
    }
    if (submission instanceof SideChatCommandSubmission) this.#trackCommand(submission);
    this.#draining = true;
    this.#refreshStatus();
    try {
      let next: SideChatSubmission | SideChatCommandSubmission | undefined = submission;
      while (next && !this.#disposed) {
        await this.#submitTurn(next);
        next = this.#session.hasBackgroundWork ? undefined : this.#queuedSubmissions.shift();
      }
    } finally {
      this.#draining = false;
      this.#refreshStatus();
    }
  }

  #trackCommand(command: SideChatCommandSubmission): void {
    this.#pendingCommands.add(command);
    void command.settled.then(() => this.#pendingCommands.delete(command));
  }

  async #submitTurn(entry: SideChatSubmission | SideChatCommandSubmission): Promise<void> {
    let settle!: () => void;
    let submission: SideChatSubmission | null = null;
    this.#requestedSettlement = new Promise(resolve => { settle = resolve; });
    try {
      if (entry instanceof SideChatCommandSubmission) {
        this.#activeCommand = entry;
        submission = await entry.settled;
        if (!entry.accept()) submission = null;
      } else submission = entry;
      if (submission) await this.#runRequestedTurn(submission);
    } finally {
      this.#activeCommand = null;
      this.#requestedSettlement = null;
      submission?.onDelivery?.(false);
      settle();
    }
  }

  async #runRequestedTurn(submission: SideChatSubmission): Promise<void> {
    if (this.#disposed) return;
    const content = submission.content.trim();
    const images = [...(submission.images ?? [])];
    if (!content && images.length === 0) return;
    if (this.#turns.isActive) return;
    await this.#turns.run(() => this.#respond(submission, content, images));
  }

  async #respond(submission: SideChatSubmission, content: string, images: ImageAttachment[]): Promise<void> {
    this.#lastError = null;
    const userMessage: ChatMessage = {
      content,
      displayContent: submission.displayContent ?? content,
      id: createSideMessageId(),
      images: images.length > 0 ? images : undefined,
      role: 'user',
      timestamp: Date.now(),
    };
    this.state.addMessage(userMessage);
    this.renderer.addMessage(userMessage);
    if (this.state.messages.length === 1 && this.deps.plugin.settings.enableAutoTitleGeneration) {
      void this.#generateTitle(userMessage);
    }

    const assistantMessage = this.#responseStream.start();
    this.#turns.beginResponse();
    this.state.autoScrollEnabled = true;
    this.#stream.showThinkingIndicator();
    this.state.responseStartTime = performance.now();
    this.#refreshStatus();

    let interrupted = false;
    let failed = false;
    let completed = false;
    try {
      const dynamicSections = await resolveChatDynamicSections(this.deps.plugin);
      if (this.#disposed || this.state.cancelRequested) return;
      this.#activeDelivery = submission.onDelivery;
      const result = await this.#session.execute({
        assertBeforeHandoff: submission.assertBeforeHandoff,
        ...(submission.context ? { context: submission.context } : {}),
        configuration: buildChatExecutionConfiguration(
          this.#settings, this.deps.plugin.getSessionSnapshotDirectory(), dynamicSections,
        ),
        conversationHistory: [
          ...this.deps.source.messages,
          ...this.state.messages.slice(0, -2),
        ],
        images,
        text: content,
        // Side chat uses the same normal chat tool policy as its parent.
        toolPolicy: { kind: 'provider-default' },
      });

      if (result.accepted) submission.onDelivery?.(true);
      if (result.status === 'completed') {
        completed = true;
        const finalAssistant = this.#responseStream.active ?? assistantMessage;
        finalAssistant.completedAt = Date.now();
        if (result.checkpointId) finalAssistant.assistantMessageId = result.checkpointId;
      }
      if (result.status === 'cancelled') {
        interrupted = true;
      } else if (result.status === 'error' || result.status === 'missing-session') {
        failed = true;
        this.#lastError = result.error?.message
          ?? 'The side chat provider session is no longer available.';
        await this.#stream.appendError(this.#lastError);
      }
    } catch (error) {
      failed = true;
      this.#lastError = error instanceof Error ? error.message : String(error);
      await this.#stream.appendError(this.#lastError);
    } finally {
      this.#activeDelivery = undefined;
      const finalAssistant = this.#responseStream.active ?? assistantMessage;
      // Native completion wins over a cancel that reached the provider too late.
      const wasCancelled = interrupted || (this.state.cancelRequested && !completed);
      if (wasCancelled) this.#discardQueuedSubmissions();
      await this.#responseStream.finish(finalAssistant, { interrupted: wasCancelled, failed });
      this.#responseStream.clear();
      this.#refreshStatus();
    }
  }

  #discardQueuedSubmissions(): void {
    for (const submission of this.#queuedSubmissions.splice(0)) {
      if (submission instanceof SideChatCommandSubmission) submission.cancel();
      else submission.onDelivery?.(false);
    }
  }

  #resumeQueuedSubmissions(): void {
    if (this.#disposed || this.isWorking) return;
    const submission = this.#queuedSubmissions.shift();
    if (submission) void this.submit(submission).catch(error => this.deps.onError?.(error));
  }

  cancel(): void {
    this.#asyncQuestions.cancelSubmissions();
    this.#activeCommand?.cancel();
    this.#preparation?.controller.abort();
    this.#discardQueuedSubmissions();
    this.#refreshStatus();
    this.#turns.cancel('user');
    this.#session.cancel();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#turns.cancel('shutdown');
    this.#session.cancel();
    this.#activeCommand?.cancel();
    this.#preparation?.controller.abort();
    this.#discardQueuedSubmissions();
    await Promise.allSettled([
      this.#preparation?.pending,
      ...[...this.#pendingCommands].map(command => command.settled),
    ]);
    this.#backgroundResponses.discard();
    this.#titleService?.cancel();
    this.#titleService = null;
    this.#asyncQuestions.expireAll();
    this.#prompts.dismissAll();
    await this.#session.dispose();
    this.state.clearFlavorTimerInterval();
    this.state.clearThinkingIndicatorTimeout();
    this.#stream.dispose();
    this.renderer.dispose();
    this.#subagents.resetStreamingState();
  }

  async #generateTitle(initialMessage: ChatMessage): Promise<void> {
    const firstSentence = initialMessage.content.split(/[.!?\n]/)[0].trim();
    this.#title = (firstSentence.slice(0, 50) + (firstSentence.length > 50 ? '...' : '')) || null;
    this.#refreshStatus();
    if (!ProviderRegistry.resolveTitleGenerationSelection(this.deps.plugin.settings)) return;
    try {
      // Own a separate routed service so discarding Side cannot cancel main titles.
      const service = ProviderRegistry.createTitleGenerationService(this.deps.plugin.providerHost);
      this.#titleService = service;
      await service.generateTitle(initialMessage.id, initialMessage.content, async (_id, result) => {
        if (this.#disposed || !result.success) return;
        this.#title = result.title;
        this.#refreshStatus();
      });
    } catch {
      // Title generation is best effort; retain the initial-prompt fallback.
    } finally {
      this.#titleService = null;
    }
  }

  #enqueueSessionEvent(event: ProviderSessionEvent, isCurrent: () => boolean): Promise<void> {
    if (this.#disposed || !isCurrent()) return Promise.resolve();
    // Display-only progress must reach running cards before the requested turn settles.
    if (event.type === 'subagent_updated') {
      this.#stream.handleSubagentUpdate(event.subagent);
      return Promise.resolve();
    }
    if (event.type === 'subagent_progress') {
      this.#stream.handleSubagentProgress(event.progress);
      return Promise.resolve();
    }
    if (event.type === 'background_turn_started') {
      this.#backgroundResponses.reserve(event.scope.sessionInstanceId, event.scope.turnId);
    }
    const deliver = () => this.#handleSessionEvent(event, isCurrent);
    if (event.type === 'task_notification' && event.scope.kind === 'session') return deliver();
    const work = this.#sessionEventWork.then(deliver);
    this.#sessionEventWork = work.catch(() => undefined);
    return work;
  }

  async #handleSessionEvent(event: ProviderSessionEvent, isCurrent: () => boolean): Promise<void> {
    if (this.#disposed || !isCurrent()) return;
    if (event.type === 'task_notification' && event.scope.kind === 'session') {
      renderSessionTaskNotification({
        state: this.state, renderer: this.renderer,
        isConnected: () => this.deps.messagesEl.isConnected, createMessageId: createSideMessageId,
      }, event.content, event.afterRequestedEvent, event.afterBackgroundEvent);
      return;
    }
    await this.#requestedSettlement;
    if (this.#disposed || !isCurrent()) return;
    if (event.type === 'permission_mode_changed') {
      this.#settings.permissionMode = event.permissionMode;
      this.#refreshStatus();
      return;
    }
    if (event.type === 'async_subagent_completed') {
      const providerSessionId = event.providerSessionId ?? this.#session.providerSessionId;
      if (providerSessionId) await this.#stream.handleAsyncSubagentCompletion({
        type: 'async_subagent_completion', providerSessionId,
        taskId: event.subagentId, status: event.status,
        ...(event.result !== undefined ? { result: event.result } : {}),
      });
      return;
    }
    if (event.type === 'session_error') {
      this.#discardQueuedSubmissions();
      this.#lastError = event.message;
      this.#backgroundResponses.discard();
      this.#refreshStatus();
      return;
    }
    await this.#backgroundResponses.handle(event.scope.sessionInstanceId, event, () => !this.#disposed && isCurrent());
  }

  async #handleExecutionEvent(event: Parameters<
    NonNullable<ConstructorParameters<typeof SideChatSession>[0]['onRequestedEvent']>
  >[0]): Promise<void> {
    if (event.type === 'turn_started' && event.accepted) this.#activeDelivery?.(true);
    await this.#responseStream.handleEvent(event);
  }

  #refreshStatus(): void {
    this.#status = this.state.requiresAction
      ? 'action-required'
      : this.isWorking
        ? 'working'
        : this.#lastError
          ? 'error'
          : this.state.messages.length === 0
            ? 'preparing'
            : 'idle';
    this.deps.onStatusChanged();
  }
}

let sideMessageSequence = 0;

function createSideMessageId(): string {
  sideMessageSequence += 1;
  return `side-${Date.now().toString(36)}-${sideMessageSequence}`;
}
