import type { Component } from 'obsidian';

import type {
  ProviderBackgroundOutputEvent,
  ProviderExecutionBackend,
  ProviderExecutionContext,
  ProviderExecutionLifecycleRegistry,
  ProviderInteractionPort,
  ProviderSessionEvent,
} from '../../../core/execution';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderId, TitleGenerationService } from '../../../core/providers/types';
import type { ChatMessage, ImageAttachment } from '../../../core/types';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import {
  providerOutputEventToStreamChunk,
  StreamController,
} from '../controllers/StreamController';
import type { WarmExecutionPool } from '../execution/WarmExecutionPool';
import { type BackgroundTurnRenderTarget, discardBackgroundTurn, renderAutoTriggeredTurn, renderSessionTaskNotification, reserveBackgroundTurn } from '../rendering/BackgroundTurnRenderer';
import { InlineInteractionPrompts } from '../rendering/InlineInteractionPrompts';
import { MessageRenderer } from '../rendering/MessageRenderer';
import { continueResponseAfterNotification } from '../rendering/ResponseContinuation';
import { SubagentManager } from '../services/SubagentManager';
import { ChatState } from '../state/ChatState';
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
  readonly warmExecution?: { readonly ownerId: string; readonly pool: WarmExecutionPool };
  readonly onStatusChanged: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface SideChatSubmission {
  readonly content: string;
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
  readonly #settings: SideChatSettingsProjection;
  #activeAssistant: ChatMessage | null = null;
  #status: SideChatStatus = 'preparing';
  #lastError: string | null = null;
  #disposed = false;
  #draining = false;
  #requestedSettlement: Promise<void> | null = null;
  #sessionEventWork: Promise<void> = Promise.resolve();
  readonly #backgroundTurns = new Map<string, { events: ProviderBackgroundOutputEvent[]; target?: BackgroundTurnRenderTarget }>();
  readonly #queuedSubmissions: SideChatSubmission[] = [];
  #title: string | null = null;
  #titleService: TitleGenerationService | null = null;

  constructor(private readonly deps: SideChatRuntimeDeps) {
    this.#settings = { ...deps.settings };
    this.state = new ChatState({
      onAttentionChanged: () => this.#refreshStatus(),
      onStreamingStateChanged: () => this.#refreshStatus(),
    });
    this.renderer = new MessageRenderer(
      deps.plugin,
      deps.component,
      deps.messagesEl,
      undefined,
      undefined,
      () => this.capabilities,
    );
    this.#subagents = new SubagentManager(() => undefined);
    this.#prompts = new InlineInteractionPrompts({
      getPromptParentEl: () => deps.getPromptParentEl(),
      onBeforeShow: () => this.#stream.hideThinkingIndicator(),
    });
    this.#stream = new StreamController({
      getMessagesEl: () => deps.messagesEl,
      getProviderId: () => deps.source.providerId,
      getProviderSessionId: () => this.#session.providerSessionId ?? null,
      plugin: deps.plugin,
      renderer: this.renderer,
      state: this.state,
      subagentManager: this.#subagents,
      updateQueueIndicator: () => undefined,
    });
    const ephemeral = this.capabilities.supportsEphemeralFork ?? this.capabilities.supportsEphemeralSessions;
    this.#session = new SideChatSession({
      buildChildResumeState: deps.buildChildResumeState,
      interactionPort: this.#createInteractionPort(),
      lifecycleRegistry: deps.lifecycleRegistry,
      onError: error => deps.onError?.(error),
      onInvalidated: () => {
        this.#queuedSubmissions.length = 0;
        this.#discardBackgroundTurns();
        this.#lastError = ephemeral
          ? 'This side chat has ended. Discard it and start a new side chat.'
          : 'The provider session was replaced. Send again to resume the side chat.';
        this.#refreshStatus();
      },
      onRequestedEvent: event => this.#handleExecutionEvent(event),
      onSessionEvent: (event, isCurrent) => this.#enqueueSessionEvent(event, isCurrent),
      onBackgroundWorkChanged: () => {
        this.#refreshStatus();
        if (!this.#disposed && !this.isWorking && this.#queuedSubmissions.length > 0) {
          void this.submit(this.#queuedSubmissions.shift()!).catch(error => deps.onError?.(error));
        }
      },
      providerId: deps.source.providerId,
      ephemeral,
      resolveBackend: deps.resolveBackend,
      vaultWorkingDirectory: deps.vaultWorkingDirectory,
      ...(deps.warmExecution ? { warmExecution: deps.warmExecution } : {}),
    });
  }

  get source(): SideChatSource {
    return this.deps.source;
  }

  get providerId(): ProviderId {
    return this.deps.source.providerId;
  }

  get capabilities(): ProviderCapabilities {
    return ProviderRegistry.getCapabilities(this.deps.source.providerId);
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
    return this.#draining || Boolean(this.#session?.hasBackgroundWork);
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

  setTabActive(active: boolean): void {
    this.#stream.setTabActive(active);
  }

  /** Accept a detached snapshot without changing the shared composer's destination. */
  enqueue(submission: SideChatSubmission): boolean {
    if (this.#disposed || !this.isWorking || !submission.content.trim()) return false;
    // Submission data contains only text, image metadata and plain selection context.
    this.#queuedSubmissions.push(JSON.parse(JSON.stringify(submission)) as SideChatSubmission);
    this.#refreshStatus();
    return true;
  }

  async submit(submission: SideChatSubmission): Promise<void> {
    if (this.#disposed || this.isWorking) return;
    this.#draining = true;
    try {
      let next: SideChatSubmission | undefined = submission;
      while (next && !this.#disposed) {
        await this.#submitTurn(next);
        next = this.#session.hasBackgroundWork ? undefined : this.#queuedSubmissions.shift();
      }
    } finally {
      this.#draining = false;
      this.#refreshStatus();
    }
  }

  async #submitTurn(submission: SideChatSubmission): Promise<void> {
    let settle!: () => void;
    this.#requestedSettlement = new Promise(resolve => { settle = resolve; });
    try {
      await this.#runRequestedTurn(submission);
    } finally {
      this.#requestedSettlement = null;
      settle();
    }
  }

  async #runRequestedTurn(submission: SideChatSubmission): Promise<void> {
    if (this.#disposed) return;
    const content = submission.content.trim();
    const images = [...(submission.images ?? [])];
    if (!content && images.length === 0) return;
    if (this.state.isStreaming) return;

    this.#lastError = null;
    const userMessage: ChatMessage = {
      content,
      displayContent: content,
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

    const assistantMessage: ChatMessage = {
      content: '',
      contentBlocks: [],
      id: createSideMessageId(),
      role: 'assistant',
      timestamp: Date.now(),
      toolCalls: [],
    };
    this.state.addMessage(assistantMessage);
    this.#activeAssistant = assistantMessage;
    this.#activateAssistantMessage(assistantMessage);
    this.state.isStreaming = true;
    this.state.cancelRequested = false;
    this.state.autoScrollEnabled = true;
    this.#stream.showThinkingIndicator();
    this.state.responseStartTime = performance.now();
    this.#refreshStatus();

    let interrupted = false;
    let failed = false;
    try {
      let dynamicSections: readonly string[] = [];
      try {
        dynamicSections = await this.deps.plugin.getMainAgentDynamicSystemPromptSections?.() ?? [];
      } catch {
        // Dynamic system context is best-effort, as it is for main chat.
      }
      if (this.#disposed || this.state.cancelRequested) return;
      const result = await this.#session.execute({
        ...(submission.context ? { context: submission.context } : {}),
        configuration: {
          ...(this.#settings.model ? { model: this.#settings.model } : {}),
          ...(this.#settings.permissionMode
            ? { permissionMode: this.#settings.permissionMode }
            : {}),
          ...(this.#settings.reasoning !== undefined ? { reasoning: this.#settings.reasoning } : {}),
          ...(this.#settings.serviceTier ? { serviceTier: this.#settings.serviceTier } : {}),
          systemInstructions: {
            kind: 'provider-default',
            ...(dynamicSections.length ? { dynamicSections: [...dynamicSections] } : {}),
          },
        },
        conversationHistory: [
          ...this.deps.source.messages,
          ...this.state.messages.slice(0, -2),
        ],
        images,
        text: content,
        // Side chat uses the same normal chat tool policy as its parent.
        toolPolicy: { kind: 'provider-default' },
      });

      if (result.status === 'completed') {
        const finalAssistant = this.#activeAssistant ?? assistantMessage;
        finalAssistant.completedAt = Date.now();
        if (result.checkpointId) finalAssistant.assistantMessageId = result.checkpointId;
      }
      if (result.status === 'cancelled') {
        interrupted = true;
      } else if (result.status === 'error' || result.status === 'missing-session') {
        failed = true;
        this.#lastError = result.error?.message
          ?? 'The side chat provider session is no longer available.';
        await this.#stream.appendText(`\n\n**Error:** ${this.#lastError}`);
      }
    } catch (error) {
      failed = true;
      this.#lastError = error instanceof Error ? error.message : String(error);
      await this.#stream.appendText(`\n\n**Error:** ${this.#lastError}`);
    } finally {
      const finalAssistant = this.#activeAssistant ?? assistantMessage;
      this.state.clearFlavorTimerInterval();
      this.#stream.hideThinkingIndicator();
      const wasCancelled = interrupted || this.state.cancelRequested;
      if (wasCancelled) {
        this.#queuedSubmissions.length = 0;
        finalAssistant.isInterrupt = true;
        if (this.state.currentContentEl) {
          this.renderer.appendInterruptIndicator(this.state.currentContentEl);
        }
      }
      const hasCompactBoundary = finalAssistant.contentBlocks?.some(block => block.type === 'context_compacted');
      if (!wasCancelled && !failed && finalAssistant.completedAt !== undefined && !hasCompactBoundary) {
        finalAssistant.durationSeconds = this.state.responseStartTime !== null
          ? Math.floor((performance.now() - this.state.responseStartTime) / 1000)
          : 0;
      }
      this.state.responseStartTime = null;
      this.state.isStreaming = false;
      this.state.cancelRequested = false;
      this.state.currentContentEl = null;
      await this.#stream.finalizeCurrentThinkingBlock(finalAssistant);
      await this.#stream.finalizeCurrentTextBlock(finalAssistant);
      this.renderer.finalizeResponse(
        finalAssistant,
        this.state.messages,
        !wasCancelled && !failed,
      );
      this.#stream.resetSubagentStreamingState();
      this.#activeAssistant = null;
      this.#refreshStatus();
    }
  }

  cancel(): void {
    this.#queuedSubmissions.length = 0;
    this.#refreshStatus();
    if (this.state.isStreaming) this.state.cancelRequested = true;
    this.#session.cancel();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#discardBackgroundTurns();
    this.#queuedSubmissions.length = 0;
    this.#titleService?.cancel();
    this.#titleService = null;
    this.state.cancelRequested = true;
    this.#session.cancel();
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

  #discardBackgroundTurns(): void {
    for (const buffer of this.#backgroundTurns.values()) {
      if (buffer.target) discardBackgroundTurn(this.state, buffer.target);
    }
    this.#backgroundTurns.clear();
  }

  #enqueueSessionEvent(event: ProviderSessionEvent, isCurrent: () => boolean): Promise<void> {
    if (this.#disposed || !isCurrent()) return Promise.resolve();
    if (event.type === 'background_turn_started') {
      this.#backgroundTurns.set(event.scope.turnId, {
        events: [],
        target: this.deps.messagesEl.isConnected ? reserveBackgroundTurn({
          state: this.state, renderer: this.renderer, createMessageId: createSideMessageId,
        }) : undefined,
      });
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
      this.#queuedSubmissions.length = 0;
      this.#lastError = event.message;
      this.#discardBackgroundTurns();
      this.#refreshStatus();
      return;
    }
    if (event.scope.kind !== 'background') return;
    const turnId = event.scope.turnId;
    if (event.type === 'background_turn_started') {
      return;
    } else if (event.type === 'background_turn_completed') {
      const buffer = this.#backgroundTurns.get(turnId);
      this.#backgroundTurns.delete(turnId);
      if (!buffer) return;
      await renderAutoTriggeredTurn({
        state: this.state, renderer: this.renderer, stream: this.#stream,
        isConnected: () => this.deps.messagesEl.isConnected, createMessageId: createSideMessageId,
      }, {
        target: buffer.target,
        events: buffer.events,
        metadata: { assistantMessageId: event.nativeAssistantId },
      }, () => !this.#disposed && isCurrent());
    } else {
      this.#backgroundTurns.get(turnId)?.events.push(event as ProviderBackgroundOutputEvent);
    }
  }

  async #handleExecutionEvent(event: Parameters<
    NonNullable<ConstructorParameters<typeof SideChatSession>[0]['onRequestedEvent']>
  >[0]): Promise<void> {
    const assistant = this.#activeAssistant;
    if (!assistant) return;
    if (event.type === 'turn_completed') {
      this.state.cancelRequested = false;
      assistant.turnStats = event.turnStats;
      return;
    }
    const chunk = providerOutputEventToStreamChunk(event);
    if (!chunk) return;
    this.#activeAssistant = await continueResponseAfterNotification({
      state: this.state, renderer: this.renderer, stream: this.#stream, createMessageId: createSideMessageId,
    }, assistant, chunk, event.scope);
    await this.#stream.handleStreamChunk(chunk, this.#activeAssistant);
  }

  #activateAssistantMessage(message: ChatMessage): void {
    const messageEl = this.renderer.addMessage(message);
    const contentEl = messageEl.querySelector<HTMLElement>('.claudian-message-content');
    if (!contentEl) return;
    if (!this.state.currentContentEl) this.state.toolCallElements.clear();
    this.state.currentContentEl = contentEl;
    this.state.currentTextEl = null;
    this.state.currentTextContent = '';
    this.state.currentThinkingState = null;
  }

  #createInteractionPort(): ProviderInteractionPort {
    const kinds = new Map<string, 'approval' | 'question'>();
    return {
      askUserQuestion: async (request, signal) => {
        kinds.set(request.interactionId, request.kind);
        this.state.beginActionRequired(request.interactionId);
        try {
          const answers = await this.#prompts.askUserQuestion({ ...request.input }, signal);
          return { answers, interactionId: request.interactionId };
        } finally {
          kinds.delete(request.interactionId);
          this.state.endActionRequired(request.interactionId);
        }
      },
      dismissInteraction: (interactionId) => {
        const kind = kinds.get(interactionId);
        if (!kind) return;
        this.#prompts.dismiss(kind);
        kinds.delete(interactionId);
        this.state.endActionRequired(interactionId);
      },
      requestApproval: async (request) => {
        kinds.set(request.interactionId, request.kind);
        this.state.beginActionRequired(request.interactionId);
        try {
          const decision = await this.#prompts.requestApproval(
            request.toolName,
            { ...request.input },
            request.description,
            {
              ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
              ...(request.blockedPath ? { blockedPath: request.blockedPath } : {}),
              ...(request.decisionOptions
                ? { decisionOptions: request.decisionOptions.map(option => ({ ...option })) }
                : {}),
              ...(request.additionalPermissions !== undefined
                ? { additionalPermissions: request.additionalPermissions }
                : {}),
            },
          );
          return { decision, interactionId: request.interactionId };
        } finally {
          kinds.delete(request.interactionId);
          this.state.endActionRequired(request.interactionId);
        }
      },
    };
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
