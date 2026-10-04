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
import type { ComposerDraftController } from '../composer/ComposerDraftController';
import {
  captureLatestCompletedForkSource,
  type ForkSourceUnavailableReason,
} from '../tabs/TabForking';
import type { AssembledTabRuntime } from '../tabs/types';
import { SideChatCommandSubmission } from './SideChatCommandSubmission';
import { SideChatPanel } from './SideChatPanel';
import { SideChatRuntime } from './SideChatRuntime';
import {
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
  readonly drafts: ComposerDraftController;
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
  #mainPlaceholder: string | null = null;
  #startSequence = 0;
  #starting = false;
  #startingCommand: SideChatCommandSubmission | null = null;
  #pendingStart: Promise<boolean> | null = null;
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
    if (this.#disposed) return false;
    if (this.#starting && !this.#runtime) {
      new Notice(t('chat.sideChat.alreadyExists'));
      return false;
    }

    // Capture and consume before any await; recovery belongs to the original main draft.
    const original = this.deps.drafts.capture('main');
    const consumed = detectSideChatCommand(original.content) !== null;
    if (consumed) this.#clearComposer();
    const command = new SideChatCommandSubmission(this.deps.plugin, { content: argument, images, context }, error => {
      if (consumed) this.deps.drafts.restore('main', original, { merge: true });
      if (error) new Notice(error instanceof Error ? error.message : 'Could not prepare the side command.');
    });
    if (this.#runtime) {
      // A collapsed existing child is resumed, never replaced.
      const runtime = this.#runtime;
      if (runtime.isWorking) {
        if (!runtime.enqueue(command)) { command.cancel(); return false; }
        this.handleComposerInput();
        new Notice(t('chat.sideChat.queued'));
        return true;
      }
      this.#setExpanded(true);
      await runtime.submit(command);
      return true;
    }

    this.#startingCommand = command;
    const pending = this.#startSideChat(command);
    this.#pendingStart = pending;
    try {
      return await pending;
    } finally {
      if (this.#pendingStart === pending) this.#pendingStart = null;
      if (this.#startingCommand === command) this.#startingCommand = null;
    }
  }

  /** Returns false when the child could not accept the turn, so the draft survives. */
  async submitToSide(
    content: string,
    images: readonly ImageAttachment[],
    context?: ProviderExecutionContext,
    displayContent?: string,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    if (!runtime) return false;
    if (runtime.isWorking) {
      new Notice(t('chat.sideChat.busySide'));
      return false;
    }
    await runtime.submit({ content, ...(displayContent !== undefined ? { displayContent } : {}), ...(context ? { context } : {}), images });
    return true;
  }

  cancelSide(): void {
    this.#startingCommand?.cancel();
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
    if (!this.#runtime && !this.#panel && !this.#starting) return;
    this.#startSequence += 1;
    this.#startingCommand?.cancel();
    const pendingStart = this.#pendingStart;
    const wasSideSelected = this.destination === 'side';
    const runtime = this.#runtime;
    const removePanel = () => {
      this.#runtime = null;
      this.#boundConversationId = null;
      this.#teardownPanel();
      this.#applyDestinationPresentation('main');
    };
    if (wasSideSelected) this.deps.drafts.changeDestination(removePanel);
    else removePanel();
    this.deps.drafts.restore('side', { content: '', images: [] });
    try {
      this.deps.onDestinationChanged();
    } finally {
      await Promise.all([runtime?.dispose(), pendingStart]);
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
    this.#startingCommand?.cancel();
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#teardownPanel();
    await Promise.all([runtime?.dispose(), this.#pendingStart]);
  }

  async #startSideChat(
    command: SideChatCommandSubmission,
  ): Promise<boolean> {
    const tab = this.deps.getTab();
    const sequence = ++this.#startSequence;
    this.#starting = true;
    this.#boundConversationId = tab.conversationId;
    let transferred = false;
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
      this.deps.drafts.changeDestination(() => this.#mountPanel(source));
      this.deps.onDestinationChanged();
      transferred = true;
      await this.#runtime!.submit(command);
      return true;
    } catch (error) {
      new Notice(t('chat.sideChat.startFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    } finally {
      if (!transferred) {
        command.cancel();
        await command.settled;
      }
      this.#starting = false;
    }
  }

  #assertForkSourceCurrent(source: SideChatSource): void {
    const tab = this.deps.getTab();
    const fullSession = ProviderRegistry.getCapabilities(source.providerId, source.providerState).forkMode === 'full-session';
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
            { lifecycle: 'ephemeral' },
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
    });
    this.#runtime = runtime;
    // The panel is created expanded, so Side becomes the destination immediately.
    this.#applyDestinationPresentation('side');
    this.#refreshPanel();
  }

  #teardownPanel(): void {
    this.deps.composerEl.removeClass('claudian-side-chat-prompt');
    this.#panel?.destroy();
    this.#panel = null;
    this.#previewActive = false;
    this.deps.inputWrapperEl.removeClass('claudian-input-side-chat-preview');
  }

  #setExpanded(expanded: boolean): void {
    const panel = this.#panel;
    if (!panel || panel.isExpanded === expanded) return;

    this.deps.drafts.changeDestination(() => {
      panel.setExpanded(expanded);
      this.#applyDestinationPresentation(expanded ? 'side' : 'main');
    });
    this.deps.onDestinationChanged();
  }

  #applyDestinationPresentation(destination: SideChatDestination): void {
    const isSide = destination === 'side';
    this.#runtime?.setPromptActive(isSide);
    this.deps.composerEl.toggleClass('claudian-side-chat-expanded', isSide);
    this.#syncPromptPresentation();
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

  #syncPromptPresentation(): void {
    this.deps.composerEl.toggleClass('claudian-side-chat-prompt',
      this.isExpanded && this.#runtime?.state.attention?.kind === 'action-required');
  }

  #refreshPanel(): void {
    this.#syncPromptPresentation();
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

  #clearComposer(): void {
    this.deps.drafts.consume();
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
