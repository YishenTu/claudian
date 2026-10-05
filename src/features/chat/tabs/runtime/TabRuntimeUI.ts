import { Notice } from 'obsidian';

import { getHiddenCommandSet } from '@/core/providers/commands/hiddenCommands';
import {
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
} from '@/core/providers/conversationModel';
import {
  getEnabledProviderForModel,
  getProviderForModel,
} from '@/core/providers/modelRouting';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type {
  ProviderChatUIConfig,
  ProviderId,
} from '@/core/providers/types';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import { ComposerPromptSuggestion } from '@/features/chat/composer/ComposerPromptSuggestion';
import { FileContextManager } from '@/features/chat/composer/FileContextManager';
import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import { MainChatComposerDropdown } from '@/features/chat/composer/MainChatComposerDropdown';
import { installTextareaSizing } from '@/features/chat/composer/textareaSizing';
import { createInputToolbar } from '@/features/chat/composer/toolbar/InputToolbar';
import { LinkedContentController } from '@/features/chat/linked-content';
import { NavigationSidebar } from '@/features/chat/navigation/NavigationSidebar';
import type { SideChatController } from '@/features/chat/side-chat/SideChatController';
import { getTabProviderId } from '@/features/chat/tabs/providerResolution';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import { TabModelSelectionCoordinator } from '@/features/chat/tabs/TabModelSelectionCoordinator';
import { syncTabProviderServices } from '@/features/chat/tabs/tabProviderLifecycle';
import { getBlankTabModelOptions, getTabCapabilities, getTabChatUIConfig, getTabSelectedModel, getTabSettingsSnapshot, type TabSettingsSnapshot, updateTabProviderSettings, updateTabReasoning } from '@/features/chat/tabs/tabProviderSettings';
import { applyProviderUIGating, refreshTabProviderUI, syncComposerDropdownForProvider, updateTabPermissionMode, updateTabServiceTier } from '@/features/chat/tabs/tabProviderUI';
import type {
  ProviderCatalogInfo,
  TabServices,
  TabUIComponents,
} from '@/features/chat/tabs/types';

function buildContextManagers(
  options: TabRuntimeConstructionContext,
  shell: TabRuntimeShellBundle,
  contextTray: ComposerContextTray,
  infoRow: ComposerInfoRow,
  onUserModified: () => void,
  runtimeRef: PublishedTabRuntimeRef,
): Pick<
  TabUIComponents,
  'fileContextManager' | 'imageContextManager' | 'linkedContentController'
> {
  const { dom } = shell;
  const { plugin } = options;
  const fileContextManager = new FileContextManager(options.mentionDataProvider, {
    getConversationList: () => plugin.getConversationList(),
    getCurrentConversationId: () => runtimeRef.current()?.conversationId,
  });
  options.registerCleanup('tab file context manager', () => fileContextManager.destroy());
  const linkedContentController = new LinkedContentController({
    app: plugin.app,
    getExcludedTags: () => plugin.settings.excludedTags,
    getCachedVaultFiles: () => fileContextManager.getCachedVaultFiles(),
    getCachedVaultFolders: () => fileContextManager.getCachedVaultFolders(),
  });
  options.registerCleanup(
    'tab Linked content controller',
    () => linkedContentController.destroy(),
  );
  if (options.conversation?.id) {
    linkedContentController.lock(options.conversation.linkedContentPath);
  } else {
    linkedContentController.resetAutoDraft();
  }
  linkedContentController.mountInfoRow(infoRow);
  if (dom.welcomeEl) linkedContentController.mountWelcome(dom.welcomeEl);
  const imageContextManager = new ImageContextManager(
    dom.inputContainerEl,
    dom.inputEl,
    { onUserImagesChanged: onUserModified },
    dom.contextRowEl,
    contextTray,
  );
  options.registerCleanup('tab image context manager', () => imageContextManager.destroy());
  return { fileContextManager, imageContextManager, linkedContentController };
}

function buildComposerDropdown(
  shell: TabRuntimeShellBundle,
  providerId: ProviderId | null,
  fileContextManager: FileContextManager,
  options: TabRuntimeConstructionContext,
  getHiddenCommands?: () => Set<string>,
  catalogInfo?: ProviderCatalogInfo,
): MainChatComposerDropdown {
  const { dom } = shell;
  const dropdown = new MainChatComposerDropdown(
    dom.inputContainerEl,
    dom.inputEl,
    fileContextManager,
    {
      providerId,
      hiddenCommands: getHiddenCommands?.() ?? new Set(),
      providerConfig: catalogInfo?.config,
      providerDiscovery: catalogInfo?.discovery,
    },
  );
  options.registerCleanup('tab composer dropdown', () => dropdown.destroy());
  return dropdown;
}

function buildInputToolbar(
  shell: TabRuntimeShellBundle,
  services: TabServices,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
  onUserModified: () => void,
): ReturnType<typeof createInputToolbar> {
  const { dom } = shell;
  const { plugin } = options;

  const inputToolbar = dom.inputWrapper.createDiv({ cls: 'claudian-input-toolbar' });

  const blankTabUIConfigProxy = (): ProviderChatUIConfig => {
    const baseConfig = getTabChatUIConfig(shell, plugin);
    return {
      ...baseConfig,
      getModelOptions: (settings: Record<string, unknown>) =>
        getBlankTabModelOptions(settings),
    };
  };

  const modelSelection = new TabModelSelectionCoordinator({
    isOwnerLive: () => {
      const tab = runtimeRef.current();
      return tab !== null && options.isRuntimeLive(tab);
    },
    readDraft: () => ({
      providerId: shell.providerId,
      model: shell.draftModel,
    }),
    applyModel: (model) => {
      shell.session.selectDraft(shell.providerId, model);
    },
    applyProviderTarget: ({ providerId, model }) => {
      shell.session.selectDraft(providerId, model);
      syncTabProviderServices(shell, services);
      runtimeRef.requirePublished().ui.composerDropdown.clearProviderCatalog();
    },
    restoreDraft: ({ providerId, model }) => {
      const tab = runtimeRef.requirePublished();
      shell.session.selectDraft(providerId, model);
      syncTabProviderServices(shell, services);
      syncComposerDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
      refreshTabProviderUI(tab);
      applyProviderUIGating(tab, plugin);
    },
    initializeProvider: async (providerId) => {
      await options.onProviderChanged?.(runtimeRef.requirePublished(), providerId);
    },
  });

  /** Side chat owns an in-memory settings projection while it is selected. */
  const getSelectedSideChat = (): SideChatController | null => {
    const tab = runtimeRef.current();
    if (!tab) return null;
    const sideChat = tab.controllers.sideChatController;
    return sideChat.destination === 'side' ? sideChat : null;
  };

  const applySideSetting = (
    patch: Parameters<SideChatController['updateSideSettings']>[0],
  ): boolean => {
    const sideChat = getSelectedSideChat();
    if (!sideChat) return false;
    sideChat.updateSideSettings(patch);
    const tab = runtimeRef.requirePublished();
    tab.ui.modelSelector.updateDisplay();
    tab.ui.modeSelector.updateDisplay();
    tab.ui.effortSelector.updateDisplay();
    tab.ui.permissionToggle.updateDisplay();
    tab.ui.serviceTierToggle.updateDisplay();
    return true;
  };

  const toolbarComponents = createInputToolbar(inputToolbar, {
    getUIConfig: () => {
      if (shell.conversationId === null) {
        return blankTabUIConfigProxy();
      }
      return getTabChatUIConfig(shell, plugin);
    },
    getCapabilities: () => getTabCapabilities(shell, plugin),
    getSettings: () => {
      const base = getTabSettingsSnapshot(shell, plugin);
      const sideSettings = getSelectedSideChat()?.runtime?.settings;
      if (!sideSettings) return base;
      return { ...base, ...sideSettings };
    },
    getEnvironmentVariables: () => plugin.getActiveEnvironmentVariables(),
    onModelChange: async (model: string) => {
      const tab = runtimeRef.requirePublished();
      if (!options.isRuntimeLive(tab)) return;
      const sideChat = getSelectedSideChat();
      if (sideChat) {
        // Enabled-model checks still apply; a side selection never substitutes one.
        if (getEnabledProviderForModel(model, plugin.settings) !== sideChat.runtime?.providerId) {
          new Notice('Cannot switch provider inside a side chat.');
          tab.ui.modelSelector.updateDisplay();
          return;
        }
        const next = getChatSettingsSnapshot(plugin.settings, sideChat.runtime.providerId, model);
        applySideSetting({ model: next.model, reasoning: next.reasoning });
        return;
      }
      if (tab.conversationId === null) {
        const selectionIntent = plugin.chatModelSelection.beginIntent();
        const request = modelSelection.beginRequest();
        const newProvider = getEnabledProviderForModel(
          model,
          plugin.settings,
        );
        if (!newProvider) {
          new Notice('Select an available model in Claudian settings.');
          tab.ui.modelSelector.updateDisplay();
          return;
        }
        const result = await modelSelection.selectBlank(request, {
          providerId: newProvider,
          model,
        });
        if (result.status === 'superseded') return;

        const isSelectionTargetCurrent = (): boolean => (
          result.isCurrent()
          && options.isRuntimeLive(tab)
          && tab.conversationId === null
          && tab.providerId === newProvider
          && tab.draftModel === model
        );
        if (!isSelectionTargetCurrent()) return;

        const uiConfig = ProviderRegistry.getChatUIConfig(newProvider);
        const didCommit = await plugin.chatModelSelection.commitIntent(
          selectionIntent,
          { providerId: newProvider, model },
          isSelectionTargetCurrent,
        );
        if (!didCommit || !isSelectionTargetCurrent()) return;

        syncComposerDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
        onUserModified();
        options.onDraftModelChanged?.(tab, tab.draftModel);
        await uiConfig.prepareModelMetadata?.(
          model,
          getProviderSettingsSnapshotWithModel(plugin.settings, newProvider, model),
          { plugin: plugin.providerHost },
        );
        if (!isSelectionTargetCurrent()) return;
        tab.ui.effortSelector.updateDisplay();
        tab.ui.serviceTierToggle.updateDisplay();
        tab.ui.modelSelector.updateDisplay();
        tab.ui.modeSelector.updateDisplay();
        tab.ui.modelSelector.renderOptions();
        tab.ui.modeSelector.renderOptions();
        applyProviderUIGating(tab, plugin);
        return;
      }

      const boundProvider = tab.providerId;
      const modelProvider = getProviderForModel(model, plugin.settings);
      if (!boundProvider || modelProvider !== boundProvider) {
        new Notice('Cannot switch provider on a bound session. Start a new conversation instead.');
        tab.ui.modelSelector.updateDisplay();
        return;
      }
      const selectionIntent = plugin.chatModelSelection.beginIntent();
      const request = modelSelection.beginRequest();
      const conversationId = tab.conversationId;

      const uiConfig: ProviderChatUIConfig = getTabChatUIConfig(tab, plugin);
      const normalizedModel = normalizeProviderModelSelection(
        boundProvider,
        plugin.settings,
        model,
      ) ?? model;
      const providerSettings = getChatSettingsSnapshot(
        plugin.settings,
        boundProvider,
        normalizedModel,
      ) as TabSettingsSnapshot;

      const isSelectionTargetCurrent = (): boolean => (
        options.isRuntimeLive(tab)
        && tab.conversationId === conversationId
        && tab.providerId === boundProvider
        && modelSelection.isCurrent(request)
      );
      if (!isSelectionTargetCurrent()) return;

      // Sole writer of a bound conversation's model; blank-tab models change through session identity.
      if (normalizedModel !== getTabSelectedModel(tab, plugin)) tab.ui.promptSuggestion.discard();
      await plugin.updateConversation(conversationId, {
        selectedModel: normalizedModel,
      });
      if (!isSelectionTargetCurrent()) return;

      onUserModified();
      const didCommit = await plugin.chatModelSelection.commitIntent(
        selectionIntent,
        { providerId: boundProvider, model: normalizedModel },
        isSelectionTargetCurrent,
      );
      if (!didCommit || !isSelectionTargetCurrent()) return;

      await uiConfig.prepareModelMetadata?.(
        normalizedModel,
        providerSettings,
        { plugin: plugin.providerHost },
      );
      if (!isSelectionTargetCurrent()) return;
      tab.ui.effortSelector.updateDisplay();
      tab.ui.serviceTierToggle.updateDisplay();
      tab.ui.modelSelector.updateDisplay();
      tab.ui.modelSelector.renderOptions();
    },
    onModeChange: async (mode: string) => {
      const tab = runtimeRef.requirePublished();
      if (getSelectedSideChat()) {
        // Mode selection is provider-owned UI state that side chat does not project.
        new Notice('Mode selection applies to the main chat.');
        tab.ui.modeSelector.updateDisplay();
        return;
      }
      await updateTabProviderSettings(tab, plugin, (settings) => {
        getTabChatUIConfig(tab, plugin).applyModeSelection?.(mode, settings);
      });
      tab.ui.modeSelector.updateDisplay();
      tab.ui.modeSelector.renderOptions();
      onUserModified();
    },
    onEffortLevelChange: async (effort: string) => {
      if (applySideSetting({ reasoning: effort })) return;
      const tab = runtimeRef.requirePublished();
      await updateTabReasoning(tab, plugin, effort);
      onUserModified();
    },
    onServiceTierChange: async (serviceTier: string) => {
      if (applySideSetting({ serviceTier })) return;
      const tab = runtimeRef.requirePublished();
      await updateTabServiceTier(tab, plugin, serviceTier);
      onUserModified();
    },
    onPermissionModeChange: async (mode: string) => {
      if (applySideSetting({ permissionMode: mode })) return;
      const tab = runtimeRef.requirePublished();
      await updateTabPermissionMode(tab, plugin, mode);
      onUserModified();
    },
  });
  options.registerCleanup(
    'tab input toolbar menus',
    () => toolbarComponents.menus.destroy(),
  );
  return toolbarComponents;
}

export function buildTabRuntimeUI(
  shell: TabRuntimeShellBundle,
  services: TabServices,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabUIComponents {
  const { dom } = shell;
  const { plugin } = options;
  const onUserModified = (): void => {
    commitProvisionalTab(runtimeRef.requirePublished());
  };
  options.registerCleanup(
    'tab textarea sizing',
    installTextareaSizing(dom.inputEl),
  );
  const contextTray = new ComposerContextTray(dom.contextRowEl, {
    onDidChange: () => {
      runtimeRef.current()?.renderer.scrollToBottomIfNeeded();
      runtimeRef.current()?.ui.promptSuggestion.refresh();
    },
  });
  options.registerCleanup('tab composer context tray', () => contextTray.destroy());
  const infoRow = new ComposerInfoRow(dom.infoRowEl);
  options.registerCleanup('tab composer info row', () => infoRow.destroy());

  const toolbar = buildInputToolbar(shell, services, options, runtimeRef, onUserModified);
  const contextManagers = buildContextManagers(
    options,
    shell,
    contextTray,
    infoRow,
    onUserModified,
    runtimeRef,
  );
  const catalogInfo = shell.providerCatalogResolver();
  const composerDropdown = buildComposerDropdown(
    shell,
    getTabProviderId(shell, plugin),
    contextManagers.fileContextManager,
    options,
    () => getHiddenCommandSet(plugin.settings),
    catalogInfo,
  );
  const navigationSidebar = new NavigationSidebar(
    dom.messagesWrapperEl,
    dom.messagesEl,
  );
  options.registerCleanup('tab navigation sidebar', () => navigationSidebar.destroy());

  const ui: TabUIComponents = {
    promptSuggestion: new ComposerPromptSuggestion(dom.inputEl, () => {
      const tab = runtimeRef.current();
      return !!tab && tab.controllers.sideChatController.destination === 'main'
        && !contextTray.hasContent
        // The resume picker removes the input's aria-expanded instead of setting it.
        && !tab.controllers.builtInCommandController.isResumeDropdownVisible();
    }, dom.inputContainerEl),
    contextTray,
    ...contextManagers,
    modelSelector: toolbar.modelSelector,
    modeSelector: toolbar.modeSelector,
    effortSelector: toolbar.effortSelector,
    permissionToggle: toolbar.permissionToggle,
    serviceTierToggle: toolbar.serviceTierToggle,
    composerDropdown,
    contextUsageMeter: toolbar.contextUsageMeter,
    toolbarMenus: toolbar.menus,
    navigationSidebar,
  };
  options.registerCleanup('tab prompt suggestion', () => ui.promptSuggestion.destroy());

  const resizeObserver = new ResizeObserver(() => {
    navigationSidebar.updateVisibility();
  });
  options.registerCleanup('tab navigation resize observer', () => resizeObserver.disconnect());
  resizeObserver.observe(dom.messagesEl);
  return ui;
}
