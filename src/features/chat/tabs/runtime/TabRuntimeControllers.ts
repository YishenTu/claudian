import type { Component } from 'obsidian';
import { Notice } from 'obsidian';

import { resolveNewConversationModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID } from '@/core/providers/types';
import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import { BrowserSelectionController } from '@/features/chat/input/BrowserSelectionController';
import { BuiltInCommandController } from '@/features/chat/input/BuiltInCommandController';
import { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { InputController } from '@/features/chat/input/InputController';
import {
  appendQuoteToComposer,
  formatSelectionQuote,
  MessageQuoteController,
} from '@/features/chat/input/MessageQuoteController';
import { SelectionController } from '@/features/chat/input/SelectionController';
import { InlineInteractionPrompts } from '@/features/chat/interactions/InlineInteractionPrompts';
import { NavigationController } from '@/features/chat/navigation/NavigationController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SideChatController } from '@/features/chat/side-chat/SideChatController';
import { AsyncSubagentHistoryRecovery } from '@/features/chat/subagents/AsyncSubagentHistoryRecovery';
import type { TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import {
  captureLatestCompletedForkSource,
  handleForkAll,
  handleForkRequest,
} from '@/features/chat/tabs/forking/ForkSource';
import { getTabProviderId, requireTabProviderId } from '@/features/chat/tabs/providerResolution';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeControllerBundle,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import {
  commitProvisionalTab,
  isClosingLifecycleState,
} from '@/features/chat/tabs/TabLifecycle';
import { syncTabProviderServices } from '@/features/chat/tabs/tabProviderLifecycle';
import { createConversationExecutionBinding, initializeTabExecution } from '@/features/chat/tabs/tabProviderLifecycle';
import { getTabCapabilities, getTabSelectedModel, getTabSettingsSnapshot } from '@/features/chat/tabs/tabProviderSettings';
import { applyProviderUIGating, invalidateTabProviderCommands, refreshTabProviderUI, syncComposerDropdownForProvider, toggleTabServiceTier } from '@/features/chat/tabs/tabProviderUI';
import {
  createTabMessageId,
  enqueueTabBackgroundWork,
} from '@/features/chat/tabs/TabSessionEvents';
import type { TabServices, TabUIComponents } from '@/features/chat/tabs/types';
import { StreamController } from '@/features/chat/turns/StreamController';
import { t } from '@/i18n/i18n';
import { getVaultPath } from '@/utils/path';

function getSharedSelectionFocusScopeEls(component: Component): HTMLElement[] {
  const host = component as Partial<TabManagerViewHost>;
  return host.getSharedSelectionFocusScopeEls?.() ?? [];
}

export function buildTabRuntimeControllers(
  shell: TabRuntimeShellBundle,
  services: TabServices,
  ui: TabUIComponents,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabRuntimeControllerBundle {
  const { component, forkRequestCallback, isRuntimeLive, openConversation, plugin } = options;
  const viewHost = component as Partial<TabManagerViewHost>;
  const owningLeaf = viewHost.leaf;
  const { dom, state } = shell;
  const ensureExecutionInitialized = async (): Promise<boolean> => {
    const tab = runtimeRef.requirePublished();
    if (
      tab.executionCoordinator.state === 'idle'
      || tab.executionCoordinator.state === 'active'
    ) {
      return true;
    }

    try {
      await initializeTabExecution(tab, plugin);
      if (isClosingLifecycleState(tab.lifecycleState)) {
        return false;
      }

      refreshTabProviderUI(tab);
      applyProviderUIGating(tab, plugin);
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Failed to initialize chat execution');
      return false;
    }
  };

  const renderer = new MessageRenderer(
    plugin,
    component,
    dom.messagesEl,
    (id, mode) => runtimeRef.requirePublished().controllers.conversationController.rewind(id, mode),
    forkRequestCallback
      ? (id) => handleForkRequest(
          runtimeRef.requirePublished(),
          plugin,
          id,
          forkRequestCallback,
          isRuntimeLive,
        )
      : undefined,
    () => getTabCapabilities(runtimeRef.requirePublished(), plugin),
    {
      navigate: (id, branchId) => runtimeRef.requirePublished().controllers.conversationController.navigateBranch(id, branchId),
      isBusy: () => !shell.session.canNavigateConversation,
    },
  );
  options.registerCleanup('tab message renderer', () => renderer.dispose());

  const messageQuoteController = new MessageQuoteController({
    messagesEl: dom.messagesEl,
    label: t('chat.quote.buttonLabel'),
    onQuote: (text) => {
      commitProvisionalTab(runtimeRef.requirePublished());
      appendQuoteToComposer(dom.inputEl, formatSelectionQuote(text));
    },
  });
  options.registerCleanup('tab message quote controller', () => messageQuoteController.dispose());

  const composerSelections = new ComposerSelections({
    editor: new SelectionController(
      plugin.app,
      ui.contextTray,
      dom.inputEl,
      [dom.contentEl, dom.inputComposerEl, ...getSharedSelectionFocusScopeEls(component)],
      () => commitProvisionalTab(runtimeRef.requirePublished()),
      owningLeaf,
    ),
    browser: new BrowserSelectionController(
      plugin.app,
      ui.contextTray,
      dom.inputEl,
      () => commitProvisionalTab(runtimeRef.requirePublished()),
    ),
    canvas: new CanvasSelectionController(
      plugin.app,
      ui.contextTray,
      dom.inputEl,
      () => commitProvisionalTab(runtimeRef.requirePublished()),
    ),
  });
  options.registerCleanup('tab composer selections', () => composerSelections.stop());

  const getMessagesEl = () => dom.messagesEl;
  const getProviderId = () => requireTabProviderId(runtimeRef.requirePublished(), plugin);
  const getProviderSessionId = () => shell.executionCoordinator.snapshot?.providerSessionId ?? null;
  const asyncSubagentHistoryRecovery = new AsyncSubagentHistoryRecovery({
    subagentManager: services.subagentManager,
    getMessagesEl,
    getProviderId,
    getProviderSessionId,
    loadSubagentToolCalls: async (request) => {
      const vaultPath = getVaultPath(plugin.app);
      if (!vaultPath) return undefined;
      const service = ProviderRegistry.createSubagentHistoryService(
        plugin.providerHost,
        request.providerId,
      );
      if (!service) return undefined;
      return service.loadToolCalls({
        providerSessionId: request.providerSessionId,
        subagentId: request.subagentId,
        vaultPath,
      });
    },
    loadSubagentFinalResult: async (request) => {
      const vaultPath = getVaultPath(plugin.app);
      if (!vaultPath) return undefined;
      const service = ProviderRegistry.createSubagentHistoryService(
        plugin.providerHost,
        request.providerId,
      );
      if (!service) return undefined;
      return service.loadFinalResult({
        providerSessionId: request.providerSessionId,
        subagentId: request.subagentId,
        vaultPath,
      });
    },
    enqueueBackgroundWork: work => enqueueTabBackgroundWork(runtimeRef.requirePublished(), work),
    persistConversation: async () => {
      const tab = runtimeRef.requirePublished();
      if (tab.state.currentConversationId) {
        await tab.controllers.conversationController.save(false);
      }
    },
  });
  const streamController = new StreamController({
    onQuestionToolChanged: tool => runtimeRef.requirePublished().controllers.inputController.updateAsyncQuestion(tool),
    plugin,
    state,
    renderer,
    subagentManager: services.subagentManager,
    getMessagesEl,
    updateQueueIndicator: () => (
      runtimeRef.requirePublished().controllers.inputController.queue.updateIndicator()
    ),
    getProviderId,
    asyncSubagentHistoryRecovery,
  });
  options.registerCleanup('tab stream controller', () => streamController.dispose());
  const inlinePrompts = new InlineInteractionPrompts({
    getPromptParentEl: () => dom.inputContainerEl.parentElement,
    getSuppressedEl: () => dom.inputContainerEl,
    onBeforeShow: () => {
      const generation = state.streamGeneration;
      streamController.thinkingIndicator.hide();
      return () => streamController.thinkingIndicator.resume(generation);
    },
  });
  streamController.setTabActive(!dom.contentEl.hasClass('claudian-hidden'));

  const renderWindow = dom.messagesEl.ownerDocument.defaultView;
  const IntersectionObserverConstructor = renderWindow?.IntersectionObserver;
  if (IntersectionObserverConstructor) {
    const renderVisibilityObserver = new IntersectionObserverConstructor((entries) => {
      const entry = entries.find(candidate => candidate.target === dom.messagesEl) ?? entries[0];
      streamController.setViewportVisible(entry?.isIntersecting ?? true);
    });
    options.registerCleanup(
      'tab render visibility observer',
      () => renderVisibilityObserver.disconnect(),
    );
    renderVisibilityObserver.observe(dom.messagesEl);
  }

  const drafts = new ComposerDraftController({
    getInput: () => dom.inputEl,
    getImages: () => ui.imageContextManager,
    getDestination: () => runtimeRef.current()?.controllers.sideChatController.destination ?? 'main',
  });

  const conversationController = new ConversationController(
    {
      plugin,
      state,
      renderer,
      drafts,
      subagentManager: services.subagentManager,
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: (element) => {
        dom.welcomeEl = element;
        if (element) {
          ui.linkedContentController.mountWelcome(element);
        } else {
          ui.linkedContentController.unmountWelcome();
        }
      },
      getMessagesEl: () => dom.messagesEl,
      session: shell.session,
      getLinkedContentController: () => ui.linkedContentController,
      clearQueuedMessage: () => (
        runtimeRef.requirePublished().controllers.inputController.queue.clear()
      ),
      getExecutionCoordinator: () => shell.executionCoordinator,
      ensureExecutionInitialized,
      getSelectedModel: () => getTabSelectedModel(runtimeRef.requirePublished(), plugin),
      dismissPendingInlinePrompts: () => (
        runtimeRef.requirePublished().controllers.inputController.dismissPendingApproval()
      ),
      awaitBackgroundWork: () => shell.session.awaitBackgroundWork(),
      isDisposed: () => shell.lifecycleState === 'closing',
      isConversationHydrated: () => shell.hydrationState === 'ready',
      ensureExecutionForConversation: async (conversation) => {
        const tab = runtimeRef.requirePublished();
        const nextProviderId = getTabProviderId(tab, plugin, conversation);
        const nextConversationId = conversation?.id ?? null;
        const providerChanged = tab.providerId !== nextProviderId;
        if (providerChanged || tab.conversationId !== nextConversationId) {
          options.onCommandContextChanged?.(tab);
        }
        tab.session.bindConversation(nextConversationId, nextProviderId);

        if (providerChanged) {
          syncTabProviderServices(tab, services);
        }

        tab.controllers.sideChatController.handleConversationChanged(nextConversationId);
        syncComposerDropdownForProvider(
          tab,
          plugin,
          shell.providerCatalogResolver,
          conversation,
        );

        await shell.executionCoordinator.bindConversation(conversation
          ? createConversationExecutionBinding(conversation)
          : null);

        refreshTabProviderUI(tab);
        applyProviderUIGating(tab, plugin);
      },
    },
    {
      onNewConversation: () => {
        const tab = runtimeRef.requirePublished();
        const previousProviderId = tab.providerId;
        const nextModel = resolveNewConversationModel(plugin.settings);
        void shell.executionCoordinator.bindConversation(null);
        tab.controllers.sideChatController.handleConversationChanged(null);
        commitProvisionalTab(tab);
        tab.session.startDraft(nextModel?.providerId ?? DEFAULT_CHAT_PROVIDER_ID, nextModel?.model ?? null);
        options.onDraftModelChanged?.(tab, tab.draftModel);
        if (tab.providerId !== previousProviderId) {
          syncTabProviderServices(tab, services);
        }
        refreshTabProviderUI(tab);
        applyProviderUIGating(tab, plugin);
        syncComposerDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
      },
      onConversationLoaded: () => {
        const tab = runtimeRef.requirePublished();
        invalidateTabProviderCommands(tab, shell.providerCatalogResolver);
        tab.controllers.inputController.onConversationActivated();
      },
      onConversationSwitched: () => {
        const tab = runtimeRef.requirePublished();
        invalidateTabProviderCommands(tab, shell.providerCatalogResolver);
        tab.controllers.inputController.onConversationActivated();
      },
    },
  );

  const sideChatController = new SideChatController({
    component,
    composerEl: dom.inputComposerEl,
    drafts,
    getInputEl: () => dom.inputEl,
    parent: {
      get conversationId() { return state.currentConversationId; },
      get providerId() { return getTabProviderId(runtimeRef.requirePublished(), plugin); },
      get isLive() { return isRuntimeLive(runtimeRef.requirePublished()); },
      get isStreaming() { return state.isStreaming; },
      get lastMessageId() { return state.lastMessage?.id; },
      captureForkSource: () => captureLatestCompletedForkSource(runtimeRef.requirePublished(), plugin, isRuntimeLive),
    },
    inputWrapperEl: dom.inputWrapper,
    onDestinationChanged: () => {
      const tab = runtimeRef.current();
      if (!tab) return;
      inlinePrompts.setActive(tab.controllers.sideChatController.destination === 'main');
      if (tab.controllers.sideChatController.destination === 'side') conversationController.cancelBranchDraft();
      ui.composerDropdown.setBuiltInsEnabled(
        tab.controllers.sideChatController.destination === 'main',
      );
      refreshTabProviderUI(tab);
      ui.promptSuggestion.refresh();
    },
    onStatusChanged: () => options.onWorkChanged?.(runtimeRef.requirePublished()),
    plugin,
  });
  options.registerCleanup('tab side chat', () => sideChatController.dispose());

  const builtInCommandController = new BuiltInCommandController({
    plugin,
    conversationController,
    getLinkedContentController: () => ui.linkedContentController,
    getCurrentConversationId: () => state.currentConversationId,
    getInputContainerEl: () => dom.inputContainerEl,
    getInputEl: () => dom.inputEl,
    getSideChatController: () => sideChatController,
    openConversation: openConversation
      ? async (conversationId) => {
          const runtime = runtimeRef.requirePublished();
          if (!isRuntimeLive(runtime)) return;
          await openConversation(conversationId);
        }
      : undefined,
    handleNewConversationCommand: viewHost.handleNewConversationCommand
      ? () => {
          if (!isRuntimeLive(runtimeRef.requirePublished())) return Promise.resolve(true);
          return viewHost.handleNewConversationCommand!();
        }
      : undefined,
    onForkAll: forkRequestCallback
      ? () => handleForkAll(
          runtimeRef.requirePublished(),
          plugin,
          forkRequestCallback,
          isRuntimeLive,
        )
      : undefined,
    toggleFastMode: () => toggleTabServiceTier(runtimeRef.requirePublished(), plugin),
  });

  const inputController = new InputController({
    plugin,
    state,
    renderer,
    streamController,
    selections: composerSelections,
    conversationController,
    drafts,
    inlinePrompts,
    getInputEl: () => dom.inputEl,
    getWelcomeEl: () => dom.welcomeEl,
    getMessagesEl: () => dom.messagesEl,
    getLinkedContentController: () => ui.linkedContentController,
    getTitleGenerationService: () => services.titleGenerationService,
    generateId: createTabMessageId,
    getSettings: () => getTabSettingsSnapshot(runtimeRef.requirePublished(), plugin),
    getExecutionCoordinator: () => shell.executionCoordinator,
    getTabProviderId: () => getTabProviderId(runtimeRef.requirePublished(), plugin),
    canStartTurn: () => shell.session.acceptsIntents,
    isClosing: () => shell.lifecycleState === 'closing',
    getSideChatController: () => sideChatController,
    session: shell.session,
    ensureExecutionInitialized,
    builtInCommands: builtInCommandController,
    captureReviewableSettlement: shell.captureReviewableSettlement ?? undefined,
  });
  const navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming || inputController.isPreparingMainTurn,
    shouldSkipEscapeHandling: () => {
      if (builtInCommandController.isResumeDropdownVisible()) return true;
      if (ui.composerDropdown.isVisible()) return true;
      return false;
    },
  });
  options.registerCleanup('tab navigation controller', () => navigationController.dispose());
  navigationController.initialize();

  return {
    renderer,
    controllers: {
      composerSelections,
      inlinePrompts,
      conversationController,
      streamController,
      inputController,
      builtInCommandController,
      navigationController,
      sideChatController,
    },
  };
}
