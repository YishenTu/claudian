import type { Component } from 'obsidian';

import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { PromptHistoryNavigation } from '@/features/chat/composer/PromptHistoryNavigation';
import { BrowserSelectionController } from '@/features/chat/input/BrowserSelectionController';
import { BuiltInCommandController } from '@/features/chat/input/BuiltInCommandController';
import { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { appendQuoteToComposer, formatSelectionQuote, MessageQuoteController } from '@/features/chat/input/MessageQuoteController';
import { SelectionController } from '@/features/chat/input/SelectionController';
import { NavigationController } from '@/features/chat/navigation/NavigationController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { handleForkRequest } from '@/features/chat/sessions/SessionForkSource';
import type { SessionChange } from '@/features/chat/sessions/SessionModel';
import { getSessionCapabilities } from '@/features/chat/sessions/sessionSettings';
import type { TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import type { PublishedTabRuntimeRef, TabRuntimeConstructionContext, TabRuntimeControllerBundle, TabRuntimeCore } from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { hasCancellableSelectedWork } from '@/features/chat/tabs/TabInputEvents';
import { applyProviderUIGating, invalidateTabProviderCommands, refreshTabContextUsage, refreshTabProviderUI, syncComposerDropdownForProvider, toggleTabServiceTier } from '@/features/chat/tabs/tabProviderUI';
import type { TabUIComponents } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';

function getSharedSelectionFocusScopeEls(component: Component): HTMLElement[] {
  return (component as Partial<TabManagerViewHost>).getSharedSelectionFocusScopeEls?.() ?? [];
}

export function buildTabRuntimeControllers(
  core: TabRuntimeCore,
  ui: TabUIComponents,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabRuntimeControllerBundle {
  const { component, forkRequestCallback, isRuntimeLive, openConversation, plugin, startNewConversation } = options;
  const owningLeaf = (component as Partial<TabManagerViewHost>).leaf;
  const { dom, state } = core;
  const model = core.session.runtime.model;
  const { conversationController, inputController, streamController, inlinePrompts } = model;
  const sideChatController = core.session.runtime.sideChat;
  const renderer = new MessageRenderer(plugin, component, dom.messagesEl,
    (id, mode) => conversationController.rewind(id, mode),
    forkRequestCallback ? id => handleForkRequest({
      get conversationId() { return core.session.runtime.conversationId; },
      get providerId() { return core.session.runtime.providerId; },
      get draftModel() { return core.session.runtime.draftModel; },
      state, executionCoordinator: core.executionCoordinator,
    }, plugin, id, forkRequestCallback, () => !core.session.runtime.isDisposed) : undefined,
    () => getSessionCapabilities(core, plugin),
    { navigate: (id, branchId) => conversationController.navigateBranch(id, branchId),
      isBusy: () => !core.session.canNavigateConversation },
    async id => { if (isRuntimeLive(runtimeRef.requirePublished())) await openConversation(id); });
  options.registerCleanup('tab message renderer', () => renderer.dispose());
  const messageQuoteController = new MessageQuoteController({
    messagesEl: dom.messagesEl,
    label: t('chat.quote.buttonLabel'),
    onQuote: (text) => {
      runtimeRef.requirePublished().session.claimUserOwnership();
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
      () => runtimeRef.requirePublished().session.claimUserOwnership(),
      owningLeaf,
    ),
    browser: new BrowserSelectionController(
      plugin.app,
      ui.contextTray,
      dom.inputEl,
      () => runtimeRef.requirePublished().session.claimUserOwnership(),
    ),
    canvas: new CanvasSelectionController(
      plugin.app,
      ui.contextTray,
      dom.inputEl,
      () => runtimeRef.requirePublished().session.claimUserOwnership(),
    ),
  });
  options.registerCleanup('tab composer selections', () => composerSelections.stop());


  const drafts = new ComposerDraftController({
    getInput: () => dom.inputEl,
    getImages: () => ui.imageContextManager,
    getDestination: () => sideChatController.destination,
  });
  const builtInCommandController = new BuiltInCommandController({
    plugin,
    getCurrentConversationId: () => state.currentConversationId,
    getInputContainerEl: () => dom.inputContainerEl,
    getInputEl: () => dom.inputEl,
    getSideChatController: () => sideChatController,
    openConversation: async id => {
      if (isRuntimeLive(runtimeRef.requirePublished())) await openConversation(id);
    },
    startNewConversation: async () => {
      if (isRuntimeLive(runtimeRef.requirePublished())) await startNewConversation();
    },
    toggleFastMode: () => toggleTabServiceTier(runtimeRef.requirePublished(), plugin),
    onResumeDropdownVisibilityChange: () => ui.promptSuggestion.refresh(),
  });
  const promptHistoryNavigation = new PromptHistoryNavigation({
    getMessages: () => conversationController.visibleMessages,
    input: dom.inputEl,
    isEnabled: () => sideChatController.destination === 'main'
      && dom.inputEl.contains(dom.inputEl.ownerDocument.activeElement),
  });
  options.registerCleanup('tab prompt history', () => promptHistoryNavigation.destroy());
  const navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming || inputController.isPreparingMainTurn,
    shouldSkipEscapeHandling: () => {
      if (builtInCommandController.isResumeDropdownVisible()) return true;
      if (ui.composerDropdown.isVisible()) return true;
      if (promptHistoryNavigation.isRecalling) return true;
      return hasCancellableSelectedWork(runtimeRef.requirePublished());
    },
  });
  options.registerCleanup('tab navigation controller', () => navigationController.dispose());
  navigationController.initialize();

  // The tab badge follows the session's status projection, which includes side-chat input requests.
  let publishedAttention = core.session.runtime.statusAttention;
  const publishAttention = (): void => {
    const tab = runtimeRef.current();
    const attention = core.session.runtime.statusAttention;
    if (!tab || attention === publishedAttention) return;
    publishedAttention = attention;
    options.onAttentionChanged?.(tab, attention);
  };
  const unsubscribeAttention = core.session.runtime.subscribe(publishAttention);
  options.registerCleanup('tab session attention listener', () => { unsubscribeAttention(); });

  const onChanged = (change: SessionChange): void => {
    const tab = runtimeRef.current();
    if (!tab) return;
    switch (change) {
      case 'streaming':
        renderer.refreshBranchButtonState();
        options.onStreamingChanged?.(tab, state.isStreaming);
        break;
      case 'rewinding':
        renderer.refreshBranchButtonState();
        options.onRewindingChanged?.(tab, state.isRewinding);
        break;
      case 'attention': publishAttention(); break;
      case 'conversation': options.onConversationIdChanged?.(tab, state.currentConversationId); break;
      case 'identity':
        promptHistoryNavigation.reset();
        ui.promptSuggestion.discard();
        options.onDraftModelChanged?.(tab, tab.draftModel);
        break;
      case 'usage': refreshTabContextUsage(tab, plugin); break;
      case 'scroll': ui.navigationSidebar.updateVisibility(); break;
      case 'work':
        renderer.refreshBranchButtonState();
        options.onWorkChanged?.(tab);
        break;
      case 'commands':
        invalidateTabProviderCommands(tab, core.providerCatalogResolver);
        options.onCommandContextChanged?.(tab);
        break;
      case 'settings':
        refreshTabProviderUI(tab);
        applyProviderUIGating(tab, plugin);
        syncComposerDropdownForProvider(tab, plugin, core.providerCatalogResolver);
        break;
      case 'destination':
        promptHistoryNavigation.reset();
        ui.composerDropdown.setBuiltInsEnabled(sideChatController.destination === 'main');
        refreshTabProviderUI(tab);
        ui.promptSuggestion.refresh();
        break;
    }
  };
  const view = dom.messagesEl.ownerDocument.defaultView;
  if (view?.IntersectionObserver) {
    const observer = new view.IntersectionObserver(entries => {
      streamController.setViewportVisible(entries[0]?.isIntersecting ?? true);
      model.acknowledgeReviewIfVisible();
    });
    observer.observe(dom.messagesEl);
    options.registerCleanup('tab render visibility observer', () => observer.disconnect());
  }
  return {
    renderer,
    controllers: { drafts, composerSelections, inlinePrompts, conversationController, streamController,
      inputController, builtInCommandController, navigationController, promptHistoryNavigation, sideChatController },
    presentation: {
      renderer, messagesEl: dom.messagesEl, queueIndicatorEl: dom.queueIndicatorEl,
      drafts, selections: composerSelections, builtInCommands: builtInCommandController,
      suggestions: ui.promptSuggestion,
      vaultIndex: ui.fileContextManager,
      side: { component, composerEl: dom.inputComposerEl, inputWrapperEl: dom.inputWrapper, getInputEl: () => dom.inputEl },
      getInputEl: () => dom.inputEl,
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: element => {
        dom.welcomeEl = element;
        if (element) ui.linkedContentController.mountWelcome(element);
        else ui.linkedContentController.unmountWelcome();
      },
      getPromptParentEl: () => dom.inputContainerEl.parentElement,
      getSuppressedEl: () => dom.inputContainerEl,
      isVisible: () => dom.messagesEl.isConnected && dom.messagesEl.getClientRects().length > 0
        && dom.messagesEl.ownerDocument.visibilityState !== 'hidden',
      onChanged,
    },
  };
}
