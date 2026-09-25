import type { Component } from 'obsidian';
import { Notice } from 'obsidian';

import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

import { detectSideChatCommand } from '../../../core/commands/builtInCommands';
import type { ProviderExecutionContext } from '../../../core/execution';
import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ImageAttachment } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { getVaultPath } from '../../../utils/path';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import { getChatSettingsSnapshot } from '../ChatSettings';
import {
  captureLatestCompletedForkSource,
  type ForkSourceUnavailableReason,
} from '../tabs/TabForking';
import type { AssembledTabRuntime } from '../tabs/types';
import type { ImageContextManager } from '../ui/ImageContext';
import { SideChatPanel } from './SideChatPanel';
import { SideChatRuntime } from './SideChatRuntime';
import {
  EMPTY_SIDE_CHAT_DRAFT,
  type SideChatComposerDraft,
  type SideChatDestination,
  type SideChatSettingsProjection,
  type SideChatSource,
} from './SideChatTypes';

export interface SideChatControllerDeps {
  readonly plugin: ChatFeatureHost;
  readonly component: Component;
  /** Composer root that carries the joined side border while expanded. */
  readonly composerEl: HTMLElement;
  readonly inputWrapperEl: HTMLElement;
  readonly getInputEl: () => ComposerInputElement;
  readonly getImageContextManager: () => ImageContextManager | null;
  readonly getTab: () => AssembledTabRuntime;
  readonly isRuntimeLive: (tab: AssembledTabRuntime) => boolean;
  readonly onDestinationChanged: () => void;
  readonly onStatusChanged?: () => void;
}

/**
 * Per-main-conversation owner of at most one temporary side chat.
 *
 * Panel expansion alone derives the composer destination; there is no separate
 * selector. Side state lives in memory and is disposed with the parent runtime
 * or a committed replacement of its main conversation.
 */
export class SideChatController {
  #panel: SideChatPanel | null = null;
  #runtime: SideChatRuntime | null = null;
  #collapsedHost: HTMLElement | null = null;
  #boundConversationId: string | null = null;
  #mainDraft: SideChatComposerDraft = EMPTY_SIDE_CHAT_DRAFT;
  #sideDraft: SideChatComposerDraft = EMPTY_SIDE_CHAT_DRAFT;
  #mainPlaceholder: string | null = null;
  #startSequence = 0;
  #starting = false;
  #previewActive = false;
  #disposed = false;

  constructor(private readonly deps: SideChatControllerDeps) {}

  get hasSideChat(): boolean {
    return this.#runtime !== null || this.#starting;
  }

  get isExpanded(): boolean {
    return this.#panel?.isExpanded ?? false;
  }

  /** Expanded means Side; collapsed or absent means Main. */
  get destination(): SideChatDestination {
    return this.#runtime !== null && this.isExpanded ? 'side' : 'main';
  }

  get runtime(): SideChatRuntime | null {
    return this.#runtime;
  }

  setCollapsedHost(host: HTMLElement | null): void {
    this.#collapsedHost = host;
    this.#panel?.setCollapsedHost(host);
  }

  /** Draft-only colour preview; it never captures a source or starts work. */
  handleComposerInput(): void {
    const isPreview = this.destination === 'main'
      && detectSideChatCommand(this.deps.getInputEl().value) !== null;
    if (isPreview === this.#previewActive) return;
    this.#previewActive = isPreview;
    this.deps.inputWrapperEl.toggleClass('claudian-input-side-chat-preview', isPreview);
  }

  /**
   * Handles a submitted side command. Returns true when the submitted draft was
   * consumed; a rejected command leaves the composer untouched.
   */
  async handleCommandSubmission(
    argument: string,
    images: readonly ImageAttachment[],
    context?: ProviderExecutionContext,
  ): Promise<boolean> {
    if (this.destination === 'side') {
      new Notice(t('chat.sideChat.nestedUnavailable'));
      return false;
    }
    if (!argument) {
      new Notice(t('chat.sideChat.needsPrompt'));
      return false;
    }
    if (this.#runtime) {
      // A collapsed existing child is resumed, never replaced.
      if (this.#runtime.isWorking) {
        if (!this.#runtime.enqueue({ content: argument, images, context })) return false;
        if (detectSideChatCommand(this.deps.getInputEl().value)) this.#clearComposer();
        this.handleComposerInput();
        new Notice(t('chat.sideChat.queued'));
        return true;
      }
      // Consume the main command before restoring the independent side draft.
      if (detectSideChatCommand(this.deps.getInputEl().value)) this.#clearComposer();
      this.#setExpanded(true);
      await this.submitToSide(argument, images, context);
      return true;
    }

    if (this.#starting) {
      new Notice(t('chat.sideChat.alreadyExists'));
      return false;
    }

    return this.#startSideChat(argument, images, context);
  }

  /** Returns false when the child could not accept the turn, so the draft survives. */
  async submitToSide(
    content: string,
    images: readonly ImageAttachment[],
    context?: ProviderExecutionContext,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    if (!runtime) return false;
    if (runtime.isWorking) {
      new Notice(t('chat.sideChat.busySide'));
      return false;
    }
    await runtime.submit({ content, ...(context ? { context } : {}), images });
    return true;
  }

  /** Main retries restore behind the expanded side composer without changing destination. */
  getMainDraft(): SideChatComposerDraft {
    return this.destination === 'side' ? this.#mainDraft : this.#captureDraft();
  }

  restoreMainDraft(draft: SideChatComposerDraft): void {
    this.#mainDraft = { content: draft.content, images: [...draft.images] };
    if (this.destination === 'main') this.#restoreDraft(this.#mainDraft);
  }

  cancelSide(): void {
    this.#runtime?.cancel();
  }

  expand(): void {
    if (!this.#runtime) return;
    this.#setExpanded(true);
  }

  collapse(): void {
    if (!this.#runtime) return;
    this.#setExpanded(false);
  }

  async discard(): Promise<void> {
    if (!this.#runtime && !this.#panel) return;
    this.#startSequence += 1;
    const wasSideSelected = this.destination === 'side';
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#sideDraft = EMPTY_SIDE_CHAT_DRAFT;
    this.#boundConversationId = null;
    this.#teardownPanel();
    this.#applyDestinationPresentation('main');
    // Collapsed discards leave the live main draft alone.
    if (wasSideSelected) this.#restoreDraft(this.#mainDraft);
    try {
      this.deps.onDestinationChanged();
    } finally {
      await runtime?.dispose();
    }
  }

  /** Disposes the child when its bound main conversation is replaced. */
  handleConversationChanged(conversationId: string | null): void {
    if (!this.#runtime && !this.#starting) return;
    if (this.#boundConversationId === conversationId) return;
    void this.discard();
  }

  setTabActive(active: boolean): void {
    this.#runtime?.setTabActive(active);
  }

  updateSideSettings(patch: SideChatSettingsProjection): void {
    this.#runtime?.updateSettings(patch);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#startSequence += 1;
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#teardownPanel();
    await runtime?.dispose();
  }

  async #startSideChat(
    argument: string,
    images: readonly ImageAttachment[],
    context?: ProviderExecutionContext,
  ): Promise<boolean> {
    const tab = this.deps.getTab();
    const sequence = ++this.#startSequence;
    this.#starting = true;
    try {
      const capture = await captureLatestCompletedForkSource(
        tab,
        this.deps.plugin,
        this.deps.isRuntimeLive,
      );
      if (sequence !== this.#startSequence || this.#disposed) return false;
      if (!capture.ok) {
        new Notice(describeUnavailable(capture.reason));
        return false;
      }

      const providerId = capture.context.providerId ?? tab.providerId;
      if (!providerId) return false;
      const source: SideChatSource = {
        conversationId: capture.context.sourceConversationId,
        linkedContentPath: capture.context.linkedContentPath,
        messages: capture.context.messages,
        providerId,
        providerState: capture.context.sourceProviderState,
        resumeAt: capture.context.resumeAt,
        selectedModel: capture.context.sourceSelectedModel,
        sessionId: capture.context.sourceSessionId,
      };

      this.#boundConversationId = source.conversationId;
      // The submitted command and its attachments are consumed by the side turn,
      // so only residual composer content survives as the main draft.
      this.#mainDraft = detectSideChatCommand(this.deps.getInputEl().value)
        ? EMPTY_SIDE_CHAT_DRAFT
        : this.#captureDraft();
      this.#mountPanel(source);
      this.#clearComposer();
      await this.submitToSide(argument, images, context);
      return true;
    } catch (error) {
      new Notice(t('chat.sideChat.startFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    } finally {
      this.#starting = false;
    }
  }

  #assertForkSourceCurrent(source: SideChatSource): void {
    const tab = this.deps.getTab();
    const fullSession = ProviderRegistry.getCapabilities(source.providerId).forkMode === 'full-session';
    if (!this.deps.isRuntimeLive(tab)
      || tab.conversationId !== source.conversationId
      || (fullSession && (tab.state.isStreaming || tab.state.messages.at(-1)?.id !== source.messages.at(-1)?.id))) {
      throw new Error('The source conversation changed. Discard this side chat and start a new one.');
    }
  }

  #mountPanel(source: SideChatSource): void {
    const panel = new SideChatPanel(this.deps.composerEl, {
      onCollapse: () => this.collapse(),
      onDiscard: () => { void this.discard(); },
      onExpand: () => this.expand(),
    });
    this.deps.composerEl.insertBefore(panel.rootEl, this.deps.composerEl.firstChild);
    this.#panel = panel;
    panel.setCollapsedHost(this.#collapsedHost);

    const vaultPath = getVaultPath(this.deps.plugin.app);
    const settingsSnapshot = getChatSettingsSnapshot(
      this.deps.plugin.settings,
      source.providerId,
      source.selectedModel,
    );
    const runtime = new SideChatRuntime({
      buildChildResumeState: async () => {
        this.#assertForkSourceCurrent(source);
        const state = await ProviderRegistry
          .getConversationHistoryService(source.providerId)
          .buildForkProviderState(
            source.sessionId,
            source.resumeAt,
            source.providerState,
            vaultPath,
            {
              environment: {
                ...process.env,
                ...getRuntimeEnvironmentVariables(this.deps.plugin.settings, source.providerId),
              },
              hostPlatform: process.platform,
              settings: this.deps.plugin.settings,
              vaultPath,
            },
          );
        this.#assertForkSourceCurrent(source);
        return state;
      },
      component: this.deps.component,
      getPromptParentEl: () => panel.promptsEl,
      lifecycleRegistry: this.deps.plugin.providerHost.executionLifecycleRegistry,
      messagesEl: panel.messagesEl,
      onError: error => {
        new Notice(error instanceof Error ? error.message : 'Side chat execution failed.');
      },
      onStatusChanged: () => this.#refreshPanel(),
      plugin: this.deps.plugin,
      resolveBackend: providerId => ProviderRegistry.createExecutionBackend(
        this.deps.plugin.providerHost,
        providerId,
      ),
      settings: {
        model: settingsSnapshot.model,
        permissionMode: settingsSnapshot.permissionMode,
        reasoning: settingsSnapshot.reasoning,
        serviceTier: settingsSnapshot.serviceTier,
      },
      source,
      vaultWorkingDirectory: vaultPath ?? '.',
      warmExecution: {
        ownerId: `${this.deps.getTab().id}:side`,
        pool: this.deps.plugin.warmExecutionPool,
      },
    });
    this.#runtime = runtime;
    // The panel is created expanded, so Side becomes the destination immediately.
    this.#applyDestinationPresentation('side');
    this.#refreshPanel();
    this.deps.onDestinationChanged();
  }

  #teardownPanel(): void {
    this.#panel?.destroy();
    this.#panel = null;
    this.#previewActive = false;
    this.deps.inputWrapperEl.removeClass('claudian-input-side-chat-preview');
  }

  #setExpanded(expanded: boolean): void {
    const panel = this.#panel;
    if (!panel || panel.isExpanded === expanded) return;

    const outgoing = this.#captureDraft();
    if (expanded) this.#mainDraft = outgoing;
    else this.#sideDraft = outgoing;

    panel.setExpanded(expanded);
    this.#applyDestinationPresentation(expanded ? 'side' : 'main');
    this.#restoreDraft(expanded ? this.#sideDraft : this.#mainDraft);
    this.deps.onDestinationChanged();
  }

  #applyDestinationPresentation(destination: SideChatDestination): void {
    const isSide = destination === 'side';
    this.deps.composerEl.toggleClass('claudian-side-chat-expanded', isSide);
    this.#previewActive = false;
    this.deps.inputWrapperEl.removeClass('claudian-input-side-chat-preview');

    const inputEl = this.deps.getInputEl();
    if (isSide) {
      this.#mainPlaceholder ??= inputEl.placeholder;
      inputEl.placeholder = t('chat.sideChat.placeholder');
      inputEl.setAttribute('aria-label', t('chat.sideChat.composerLabel'));
    } else {
      if (this.#mainPlaceholder !== null) inputEl.placeholder = this.#mainPlaceholder;
      inputEl.removeAttribute('aria-label');
    }
  }

  #refreshPanel(): void {
    const runtime = this.#runtime;
    const panel = this.#panel;
    if (!runtime || !panel) return;
    panel.update(runtime.status, {
      queuedCount: runtime.queuedCount,
      title: runtime.title,
      error: runtime.lastError,
    });
    this.deps.onStatusChanged?.();
  }

  #captureDraft(): SideChatComposerDraft {
    const images = this.deps.getImageContextManager()?.getAttachedImages() ?? [];
    return { content: this.deps.getInputEl().value, images: [...images] };
  }

  #restoreDraft(draft: SideChatComposerDraft): void {
    const inputEl = this.deps.getInputEl();
    inputEl.value = draft.content;
    this.deps.getImageContextManager()?.setImages([...draft.images]);
  }

  #clearComposer(): void {
    this.deps.getInputEl().value = '';
    this.deps.getImageContextManager()?.clearImages();
  }
}

function describeUnavailable(reason: ForkSourceUnavailableReason): string {
  switch (reason) {
    case 'unsupported-provider':
      return t('chat.sideChat.unsupportedProvider');
    case 'streaming':
    case 'rewinding':
    case 'stale-binding':
      return t('chat.sideChat.unavailableBusy');
    case 'no-messages':
    case 'no-checkpoint':
      return t('chat.sideChat.unavailableNoCheckpoint');
    case 'not-latest-reply':
      return 'This provider can fork only from the latest reply.';
    case 'no-session':
      return t('chat.sideChat.unavailableNoSession');
  }
}
