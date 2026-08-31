import type { Component } from 'obsidian';
import { Notice } from 'obsidian';

import { resolveNewConversationModel } from '../../../../core/providers/conversationModel';
import { getEnabledProviderForModel } from '../../../../core/providers/modelRouting';
import { ProviderRegistry } from '../../../../core/providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID } from '../../../../core/providers/types';
import { getVaultPath } from '../../../../utils/path';
import { BrowserSelectionController } from '../../controllers/BrowserSelectionController';
import { CanvasSelectionController } from '../../controllers/CanvasSelectionController';
import { ConversationController } from '../../controllers/ConversationController';
import { InputController } from '../../controllers/InputController';
import { NavigationController } from '../../controllers/NavigationController';
import { SelectionController } from '../../controllers/SelectionController';
import { StreamController } from '../../controllers/StreamController';
import { MessageRenderer } from '../../rendering/MessageRenderer';
import { getTabProviderId } from '../providerResolution';
import {
  handleForkAll,
  handleForkRequest,
} from '../TabForking';
import {
  commitProvisionalTab,
  isClosingLifecycleState,
} from '../TabLifecycle';
import {
  applyProviderUIGating,
  createConversationExecutionBinding,
  getTabCapabilities,
  getTabSelectedModel,
  initializeTabExecution,
  invalidateTabProviderCommands,
  refreshTabProviderUI,
  restorePrePlanMode,
  syncComposerDropdownForProvider,
  syncTabProviderServices,
  toggleTabServiceTier,
} from '../TabProviderState';
import {
  createTabMessageId,
  enqueueTabBackgroundWork,
} from '../TabSessionEvents';
import type {
  TabManagerViewHost,
  TabServices,
  TabUIComponents,
} from '../types';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeControllerBundle,
  TabRuntimeShellBundle,
} from './TabRuntimeConstruction';

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
      tab.lifecycleState === 'warm'
      && (tab.executionCoordinator.state === 'idle'
        || tab.executionCoordinator.state === 'active')
    ) {
      return true;
    }

    try {
      if (tab.conversationId === null && tab.draftModel) {
        tab.providerId = getEnabledProviderForModel(tab.draftModel, plugin.settings);
      }

      await initializeTabExecution(tab, plugin);
      if (isClosingLifecycleState(tab.lifecycleState)) {
        return false;
      }

      refreshTabProviderUI(tab, plugin);
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
  );
  options.registerCleanup('tab message renderer', () => renderer.dispose());

  const selectionController = new SelectionController(
    plugin.app,
    ui.contextTray,
    dom.inputEl,
    undefined,
    [dom.contentEl, dom.inputComposerEl, ...getSharedSelectionFocusScopeEls(component)],
    () => commitProvisionalTab(runtimeRef.requirePublished()),
    owningLeaf,
  );
  options.registerCleanup('tab editor selection controller', () => selectionController.stop());

  const browserSelectionController = new BrowserSelectionController(
    plugin.app,
    ui.contextTray,
    dom.inputEl,
    undefined,
    () => commitProvisionalTab(runtimeRef.requirePublished()),
  );
  options.registerCleanup(
    'tab browser selection controller',
    () => browserSelectionController.stop(),
  );

  const canvasSelectionController = new CanvasSelectionController(
    plugin.app,
    ui.contextTray,
    dom.inputEl,
    undefined,
    () => commitProvisionalTab(runtimeRef.requirePublished()),
  );
  options.registerCleanup(
    'tab canvas selection controller',
    () => canvasSelectionController.stop(),
  );

  const streamController = new StreamController({
    plugin,
    state,
    renderer,
    subagentManager: services.subagentManager,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    updateQueueIndicator: () => (
      runtimeRef.requirePublished().controllers.inputController.updateQueueIndicator()
    ),
    getProviderId: () => getTabProviderId(runtimeRef.requirePublished(), plugin),
    getProviderSessionId: () => shell.executionCoordinator.snapshot?.providerSessionId ?? null,
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
  options.registerCleanup('tab stream controller', () => streamController.dispose());
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

  const conversationController = new ConversationController(
    {
      plugin,
      state,
      renderer,
      subagentManager: services.subagentManager,
      getHistoryDropdown: () => null,
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
      getInputEl: () => dom.inputEl,
      restoreMessageToComposer: message => (
        runtimeRef.requirePublished().controllers.inputController
          .restoreRewoundMessageToComposer(message)
      ),
      getFileContextManager: () => ui.fileContextManager,
      getLinkedContentController: () => ui.linkedContentController,
      getImageContextManager: () => ui.imageContextManager,
      getExternalContextSelector: () => ui.externalContextSelector,
      clearQueuedMessage: () => (
        runtimeRef.requirePublished().controllers.inputController.clearQueuedMessage()
      ),
      getTitleGenerationService: () => services.titleGenerationService,
      getStatusPanel: () => ui.statusPanel,
      getExecutionCoordinator: () => shell.executionCoordinator,
      ensureExecutionInitialized,
      getProviderId: () => getTabProviderId(runtimeRef.requirePublished(), plugin),
      getSelectedModel: () => getTabSelectedModel(runtimeRef.requirePublished(), plugin),
      dismissPendingInlinePrompts: () => (
        runtimeRef.requirePublished().controllers.inputController.dismissPendingApproval()
      ),
      awaitBackgroundWork: () => shell.session.awaitBackgroundWork(),
      isDisposed: () => shell.lifecycleState === 'closing',
      ensureExecutionForConversation: async (conversation) => {
        const tab = runtimeRef.requirePublished();
        const nextProviderId = getTabProviderId(tab, plugin, conversation);
        const nextConversationId = conversation?.id ?? null;
        const providerChanged = tab.providerId !== nextProviderId;
        if (providerChanged || tab.conversationId !== nextConversationId) {
          options.onCommandContextChanged?.(tab);
        }
        tab.providerId = nextProviderId;

        if (providerChanged) {
          syncTabProviderServices(tab, services, plugin);
        }

        tab.conversationId = nextConversationId;
        tab.draftModel = null;
        if (tab.lifecycleState !== 'provisional') {
          tab.lifecycleState = 'cold';
        }
        syncComposerDropdownForProvider(
          tab,
          plugin,
          shell.providerCatalogResolver,
          conversation,
        );

        await shell.executionCoordinator.bindConversation(conversation
          ? createConversationExecutionBinding(conversation)
          : null);

        refreshTabProviderUI(tab, plugin);
        applyProviderUIGating(tab, plugin);
      },
    },
    {
      onNewConversation: () => {
        const tab = runtimeRef.requirePublished();
        const previousProviderId = tab.providerId;
        const nextModel = resolveNewConversationModel(plugin.settings);
        void shell.executionCoordinator.bindConversation(null);
        commitProvisionalTab(tab);
        tab.draftModel = nextModel?.model ?? null;
        tab.conversationId = null;
        tab.providerId = nextModel?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
        options.onDraftModelChanged?.(tab, tab.draftModel);
        if (tab.providerId !== previousProviderId) {
          syncTabProviderServices(tab, services, plugin);
        }
        refreshTabProviderUI(tab, plugin);
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

  const inputController = new InputController({
    plugin,
    state,
    renderer,
    streamController,
    selectionController,
    browserSelectionController,
    canvasSelectionController,
    conversationController,
    getInputEl: () => dom.inputEl,
    getInputContainerEl: () => dom.inputContainerEl,
    getWelcomeEl: () => dom.welcomeEl,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    getLinkedContentController: () => ui.linkedContentController,
    getImageContextManager: () => ui.imageContextManager,
    getExternalContextSelector: () => ui.externalContextSelector,
    getInstructionModeManager: () => ui.instructionModeManager,
    getInstructionRefineService: () => services.instructionRefineService,
    getTitleGenerationService: () => services.titleGenerationService,
    getStatusPanel: () => ui.statusPanel,
    generateId: createTabMessageId,
    getAuxiliaryModel: () => getTabSelectedModel(runtimeRef.requirePublished(), plugin),
    getExecutionCoordinator: () => shell.executionCoordinator,
    getSubagentManager: () => services.subagentManager,
    getTabProviderId: () => getTabProviderId(runtimeRef.requirePublished(), plugin),
    canStartTurn: () => shell.session.acceptsIntents,
    turnOwner: shell.session,
    ensureExecutionInitialized,
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
    handleNewSessionPlan: viewHost.handleNewSessionPlan
      ? (planContent) => {
          const runtime = runtimeRef.requirePublished();
          if (!isRuntimeLive(runtime)) return Promise.resolve(true);
          return viewHost.handleNewSessionPlan!(
            planContent,
            () => isRuntimeLive(runtime),
          );
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
    restorePrePlanPermissionModeIfNeeded: () => (
      restorePrePlanMode(runtimeRef.requirePublished(), plugin)
    ),
    captureReviewableSettlement: shell.captureReviewableSettlement ?? undefined,
  });
  const navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming,
    shouldSkipEscapeHandling: () => {
      if (ui.instructionModeManager.isActive()) return true;
      if (ui.bangBashModeManager?.isActive()) return true;
      if (inputController.isResumeDropdownVisible()) return true;
      if (ui.composerDropdown.isVisible()) return true;
      return false;
    },
  });
  options.registerCleanup('tab navigation controller', () => navigationController.dispose());
  navigationController.initialize();

  return {
    renderer,
    controllers: {
      selectionController,
      browserSelectionController,
      canvasSelectionController,
      conversationController,
      streamController,
      inputController,
      navigationController,
    },
  };
}
