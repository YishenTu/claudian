import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ComposerEditor } from '@/features/chat/composer/ComposerEditor';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { createInteractionPromptPort } from '@/features/chat/interactions/interactionPromptPort';
import { cleanupThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import { createWelcomeElement } from '@/features/chat/rendering/WelcomeRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabProviderCatalogContext } from '@/features/chat/tabs/ChatTab';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { createTabSessionState, generateTabId } from '@/features/chat/tabs/TabIdentity';
import { refreshTabContextUsage } from '@/features/chat/tabs/tabProviderUI';
import { TabSession } from '@/features/chat/tabs/TabSession';
import {
  createTabMessageId,
  enqueueTabSessionEvent,
} from '@/features/chat/tabs/TabSessionEvents';
import type { TabDOMElements } from '@/features/chat/tabs/types';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { getVaultPath } from '@/utils/path';

export function buildTabRuntimeShell(
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabRuntimeShellBundle {
  const { plugin, conversation } = options;
  const id = options.tabId ?? generateTabId();
  const contentEl = options.containerEl.createDiv({
    cls: 'claudian-tab-content claudian-hidden',
  });
  options.registerCleanup('tab DOM root', () => contentEl.remove());

  const dom = buildTabDOM(contentEl, options);
  // Presentation state derives from the turn owner, so it exists before the session that owns it.
  const turns: TurnCoordinator = new TurnCoordinator(() => session.admitsConversationOperations);
  const state: ChatState = new ChatState({
    onStreamingStateChanged: isStreaming => {
      if (isStreaming) runtimeRef.requirePublished().ui.promptSuggestion.beginTurn();
      runtimeRef.requirePublished().renderer.refreshBranchButtonState();
      options.onStreamingChanged?.(runtimeRef.requirePublished(), isStreaming);
    },
    onRewindingStateChanged: isRewinding => {
      runtimeRef.requirePublished().renderer.refreshBranchButtonState();
      options.onRewindingChanged?.(runtimeRef.requirePublished(), isRewinding);
    },
    onAttentionChanged: attention => {
      options.onAttentionChanged?.(runtimeRef.requirePublished(), attention);
    },
    onConversationChanged: conversationId => {
      options.onConversationIdChanged?.(runtimeRef.requirePublished(), conversationId);
    },
    onUsageChanged: () => refreshTabContextUsage(runtimeRef.requirePublished(), plugin),
    onAutoScrollChanged: () => runtimeRef.requirePublished().ui.navigationSidebar.updateVisibility(),
  }, { get: () => session.conversationId, set: id => session.setConversationId(id) }, turns);
  state.queueIndicatorEl = dom.queueIndicatorEl;

  options.registerCleanup('tab thinking state', () => {
    cleanupThinkingBlock(state.currentThinkingState);
    state.currentThinkingState = null;
  });

  const sessionState = options.initialState
    ? { ...options.initialState }
    : createTabSessionState(plugin.settings, conversation, { ...options, tabId: id });
  const executionCoordinator = createTabExecutionCoordinator(
    state,
    options,
    runtimeRef,
  );
  const session: TabSession = new TabSession(sessionState, executionCoordinator, {
    turns,
    onIdentityChanged: () => runtimeRef.current()?.ui.promptSuggestion.discard(),
    onWorkChanged: () => {
      const tab = runtimeRef.requirePublished();
      tab.renderer.refreshBranchButtonState();
      options.onWorkChanged?.(tab);
    },
    isConversationBusy: () => state.isRewinding || state.isResettingToNewChat || state.isSwitchingConversation,
    hasDetachedWork: () => {
      const tab = runtimeRef.current();
      return !!tab && (tab.services.subagentManager.hasActiveAsyncSubagents()
        // Collapsed side work stays discoverable from the tab bar.
        || (tab.controllers.sideChatController.runtime?.isWorking ?? false));
    },
    dismissInteractions: () => runtimeRef.current()?.controllers.inputController.dismissPendingApproval(),
  });
  options.registerCleanup(
    'tab execution coordinator',
    () => session.disposeExecutionCoordinator(),
  );
  const providerCatalogContext: TabProviderCatalogContext = Object.freeze({
    get id() {
      return session.id;
    },
    get lifecycleState() {
      return session.lifecycleState;
    },
    get draftModel() {
      return session.draftModel;
    },
    get providerId() {
      return session.providerId;
    },
    get conversationId() {
      return session.conversationId;
    },
  });

  return {
    session,
    get id() {
      return session.id;
    },
    get lifecycleState() {
      return session.lifecycleState;
    },
    hydrationState: sessionState.conversationId ? 'idle' : 'ready',
    get draftModel() {
      return session.draftModel;
    },
    get providerId() {
      return session.providerId;
    },
    get conversationId() {
      return session.conversationId;
    },
    executionCoordinator,
    providerCatalogResolver: () => options.getProviderCatalogConfig(providerCatalogContext),
    captureReviewableSettlement: options.captureReviewableSettlement
      ? outcome => options.captureReviewableSettlement!(runtimeRef.requirePublished(), outcome)
      : null,
    state,
    dom,
  };
}

function buildTabDOM(contentEl: HTMLElement, options: TabRuntimeConstructionContext): TabDOMElements {
  const messagesWrapperEl = contentEl.createDiv({ cls: 'claudian-messages-wrapper' });
  const messagesEl = messagesWrapperEl.createDiv({ cls: 'claudian-messages' });
  const welcomeEl = createWelcomeElement(messagesEl);
  const inputComposerEl = contentEl.createDiv({ cls: 'claudian-input-composer' });
  const inputContainerEl = inputComposerEl.createDiv({ cls: 'claudian-input-container' });
  const navRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-nav-row' });
  const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });
  // A queued follow-up is attached to the top of the box it will be sent from.
  const queueIndicatorEl = inputWrapper.createDiv({ cls: 'claudian-input-queue-strip claudian-hidden' });
  const contextRowEl = inputWrapper.createDiv({ cls: 'claudian-context-row' });
  const composerEditor = new ComposerEditor(inputWrapper, options.plugin.app, options.component);
  const infoRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-info-row' });
  options.registerCleanup('tab composer editor', () => composerEditor.destroy());
  const vault = options.plugin.app.vault;
  const refresh = () => composerEditor.refreshLinks();
  for (const subscribe of [
    () => vault.on('create', refresh),
    () => vault.on('delete', refresh),
    () => vault.on('rename', refresh),
  ]) {
    const ref = subscribe();
    options.registerCleanup('composer vault listener', () => vault.offref(ref));
  }
  const inputEl = composerEditor.element;

  return {
    contentEl,
    messagesWrapperEl,
    messagesEl,
    welcomeEl,
    inputComposerEl,
    inputContainerEl,
    queueIndicatorEl,
    inputWrapper,
    inputEl,
    navRowEl,
    contextRowEl,
    infoRowEl,
  };
}

const IDLE_SESSION_RELEASE_MS = 30 * 60_000;

function createTabExecutionCoordinator(
  state: ChatState,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): ChatExecutionCoordinator {
  const { plugin } = options;
  const interactionPort = createInteractionPromptPort(
    state,
    () => runtimeRef.requirePublished().controllers.inlinePrompts,
  );
  return new ChatExecutionCoordinator({
    lifecycleRegistry: plugin.providerHost.executionLifecycleRegistry,
    resolveBackend: providerId => ProviderRegistry.createExecutionBackend(
      plugin.providerHost,
      providerId,
    ),
    persistence: plugin.executionPersistence,
    interactionPort,
    vaultWorkingDirectory: getVaultPath(plugin.app) ?? '.',
    createId: createTabMessageId,
    onRequestedEvent: (event, context) => {
      const tab = runtimeRef.requirePublished();
      if (event.type === 'turn_started') {
        // Identity and model switches discard eagerly through their owners; this fences delivery only.
        tab.ui.promptSuggestion.bindTurn(event.scope.turnId, () => tab.executionCoordinator.isEventContextCurrent(context));
      }
      return tab.controllers.inputController.handleExecutionEvent(event);
    },
    onSessionEvent: (event, context) => {
      const tab = runtimeRef.requirePublished();
      if (event.type === 'commands_changed') {
        options.onCommandContextChanged?.(tab);
        return;
      }
      return enqueueTabSessionEvent(tab, plugin, event, context);
    },
    onBackgroundWorkChanged: () => {
      const tab = runtimeRef.requirePublished();
      tab.renderer.refreshBranchButtonState();
      options.onWorkChanged?.(tab);
    },
    resolveMissingProviderSession: (conversationId, missingProviderSessionId) =>
      plugin.handleMissingProviderSession(conversationId, missingProviderSessionId),
    onError: error => {
      new Notice(error instanceof Error ? error.message : 'Provider execution failed.');
    },
    idleReleaseMs: IDLE_SESSION_RELEASE_MS,
    isOwnerIdle: () => {
      const tab = runtimeRef.requirePublished();
      return tab.session.isIdle && !state.requiresAction;
    },
    onIdleRelease: () => {
      const tab = runtimeRef.requirePublished();
      if (tab.lifecycleState !== 'closing') options.onCommandContextChanged?.(tab);
    },
  });
}
