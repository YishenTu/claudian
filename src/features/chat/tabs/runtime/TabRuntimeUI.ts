import { Notice } from 'obsidian';

import {
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
} from '../../../../core/providers/conversationModel';
import {
  getEnabledProviderForModel,
  getProviderForModel,
} from '../../../../core/providers/modelRouting';
import { ProviderRegistry } from '../../../../core/providers/ProviderRegistry';
import type {
  ProviderChatUIConfig,
  ProviderId,
} from '../../../../core/providers/types';
import { getEnhancedPath } from '../../../../utils/env';
import { getVaultPath } from '../../../../utils/path';
import { MainChatComposerDropdown } from '../../composer/MainChatComposerDropdown';
import { LinkedContentController } from '../../linked-content';
import { BangBashService } from '../../services/BangBashService';
import { BangBashModeManager as BangBashModeManagerClass } from '../../ui/BangBashModeManager';
import { ComposerContextTray } from '../../ui/ComposerContextTray';
import { FileContextManager } from '../../ui/FileContext';
import { ImageContextManager } from '../../ui/ImageContext';
import { createInputToolbar } from '../../ui/InputToolbar';
import { InstructionModeManager as InstructionModeManagerClass } from '../../ui/InstructionModeManager';
import { NavigationSidebar } from '../../ui/NavigationSidebar';
import { StatusPanel } from '../../ui/StatusPanel';
import { autoResizeTextarea } from '../../ui/textareaResize';
import { recalculateUsageForModel } from '../../utils/usageInfo';
import { getTabProviderId } from '../providerResolution';
import { commitProvisionalTab } from '../TabLifecycle';
import { TabModelSelectionCoordinator } from '../TabModelSelectionCoordinator';
import {
  applyProviderUIGating,
  getBlankTabModelOptions,
  getTabCapabilities,
  getTabChatUIConfig,
  getTabHiddenCommands,
  getTabSelectedModel,
  getTabSettingsSnapshot,
  refreshTabProviderUI,
  syncComposerDropdownForProvider,
  syncTabProviderServices,
  type TabProviderSettings,
  updateTabProviderSettings,
  updateTabServiceTier,
} from '../TabProviderState';
import type {
  ProviderCatalogInfo,
  TabServices,
  TabUIComponents,
} from '../types';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from './TabRuntimeConstruction';

function buildContextManagers(
  externalContextSelector: TabUIComponents['externalContextSelector'],
  options: TabRuntimeConstructionContext,
  shell: TabRuntimeShellBundle,
  contextTray: ComposerContextTray,
  onUserModified: () => void,
): Pick<
  TabUIComponents,
  'fileContextManager' | 'imageContextManager' | 'linkedContentController'
> {
  const { dom } = shell;
  const { plugin } = options;
  const fileContextManager = new FileContextManager(
    plugin.app,
    {
      getExternalContexts: () => externalContextSelector.getExternalContexts(),
      onAgentMentionSelect: () => onUserModified(),
    },
  );
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
  linkedContentController.mountContextTray(contextTray);
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
  providerId: ProviderId,
  fileContextManager: FileContextManager,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
  getHiddenCommands?: () => Set<string>,
  catalogInfo?: ProviderCatalogInfo,
): MainChatComposerDropdown {
  const { dom } = shell;
  const dropdown = new MainChatComposerDropdown(
    dom.inputContainerEl,
    dom.inputEl,
    fileContextManager,
    {
      collabReferences: options.plugin.collabComposerReferences,
      providerId,
      hiddenCommands: getHiddenCommands?.() ?? new Set(),
      providerConfig: catalogInfo?.config,
      providerDiscovery: catalogInfo?.discovery,
      onSlashCommandSelected: command => {
        if (command.id !== 'builtin:instruction') return;
        dom.inputEl.value = '';
        runtimeRef.requirePublished().ui.instructionModeManager.enter();
      },
    },
  );
  options.registerCleanup('tab composer dropdown', () => dropdown.destroy());
  return dropdown;
}

function buildInstructionComponents(
  shell: TabRuntimeShellBundle,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
  composerDropdown: MainChatComposerDropdown,
): Pick<
  TabUIComponents,
  'instructionModeManager' | 'bangBashModeManager' | 'statusPanel'
> {
  const { dom } = shell;
  const { plugin } = options;
  const instructionModeManager = new InstructionModeManagerClass(
    dom.inputEl,
    {
      onSubmit: async (rawInstruction) => {
        await runtimeRef.requirePublished().controllers.inputController
          .handleInstructionSubmit(rawInstruction);
      },
      getInputWrapper: () => dom.inputWrapper,
      onActiveChange: active => {
        if (active) composerDropdown.hide();
      },
    },
  );
  options.registerCleanup(
    'tab instruction mode manager',
    () => instructionModeManager.destroy(),
  );

  const statusPanel = new StatusPanel();
  options.registerCleanup('tab status panel', () => statusPanel.destroy());
  statusPanel.mount(dom.statusPanelContainerEl);

  let bangBashModeManager: TabUIComponents['bangBashModeManager'] = null;
  if (isBangBashEnabled(plugin.settings)) {
    const vaultPath = getVaultPath(plugin.app);
    if (vaultPath) {
      const enhancedPath = getEnhancedPath();
      const bashService = new BangBashService(vaultPath, enhancedPath);

      bangBashModeManager = new BangBashModeManagerClass(
        dom.inputEl,
        {
          onSubmit: async (command) => {
            const id = `bash-${Date.now()}`;
            statusPanel.addBashOutput({ id, command, status: 'running', output: '' });

            const result = await bashService.execute(command);
            const output = [result.stdout, result.stderr, result.error]
              .filter(Boolean)
              .join('\n')
              .trim();
            const status = result.exitCode === 0 ? 'completed' : 'error';
            statusPanel.updateBashOutput(id, { status, output, exitCode: result.exitCode });
          },
          getInputWrapper: () => dom.inputWrapper,
        },
      );
      const ownedBangBashModeManager = bangBashModeManager;
      options.registerCleanup(
        'tab bang-bash mode manager',
        () => ownedBangBashModeManager.destroy(),
      );
    }
  }
  return { bangBashModeManager, instructionModeManager, statusPanel };
}

function isBangBashEnabled(settings: Record<string, unknown>): boolean {
  return ProviderRegistry.getEnabledProviderIds(settings).some((providerId) => (
    ProviderRegistry.getChatUIConfig(providerId).isBangBashEnabled?.(settings) ?? false
  ));
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
    const draftProvider = shell.providerId;
    const baseConfig = ProviderRegistry.getChatUIConfig(draftProvider);
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
      shell.draftModel = model;
    },
    applyProviderTarget: ({ providerId, model }) => {
      shell.draftModel = model;
      shell.providerId = providerId;
      syncTabProviderServices(shell, services, plugin);
      runtimeRef.requirePublished().ui.composerDropdown.clearProviderCatalog();
    },
    restoreDraft: ({ providerId, model }) => {
      const tab = runtimeRef.requirePublished();
      shell.draftModel = model;
      shell.providerId = providerId;
      syncTabProviderServices(shell, services, plugin);
      syncComposerDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
      refreshTabProviderUI(tab, plugin);
      applyProviderUIGating(tab, plugin);
    },
    initializeProvider: async (providerId) => {
      await options.onProviderChanged?.(runtimeRef.requirePublished(), providerId);
    },
  });

  const toolbarComponents = createInputToolbar(inputToolbar, {
    getUIConfig: () => {
      if (shell.conversationId === null) {
        return blankTabUIConfigProxy();
      }
      return getTabChatUIConfig(shell, plugin);
    },
    getCapabilities: () => getTabCapabilities(shell, plugin),
    getSettings: () => getTabSettingsSnapshot(shell, plugin),
    getEnvironmentVariables: () => plugin.getActiveEnvironmentVariables(),
    onModelChange: async (model: string) => {
      const tab = runtimeRef.requirePublished();
      if (!options.isRuntimeLive(tab)) return;
      if (tab.conversationId === null) {
        const selectionIntent = plugin.chatModelSelection.beginIntent();
        const request = modelSelection.beginRequest();
        const newProvider = getEnabledProviderForModel(
          model,
          plugin.settings,
        );
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
        tab.ui.thinkingBudgetSelector.updateDisplay();
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
      if (modelProvider !== boundProvider) {
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
      const providerSettings = getProviderSettingsSnapshotWithModel(
        plugin.settings,
        boundProvider,
        normalizedModel,
      ) as TabProviderSettings;

      const isSelectionTargetCurrent = (): boolean => (
        options.isRuntimeLive(tab)
        && tab.conversationId === conversationId
        && tab.providerId === boundProvider
        && modelSelection.isCurrent(request)
      );
      if (!isSelectionTargetCurrent()) return;

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
      tab.ui.thinkingBudgetSelector.updateDisplay();
      tab.ui.serviceTierToggle.updateDisplay();
      tab.ui.modelSelector.updateDisplay();
      tab.ui.modelSelector.renderOptions();

      const currentUsage = tab.state.usage;
      if (currentUsage) {
        const newContextWindow = uiConfig.getContextWindowSize(
          normalizedModel,
          providerSettings.customContextLimits,
          providerSettings,
        );
        tab.state.usage = recalculateUsageForModel(
          currentUsage,
          normalizedModel,
          newContextWindow,
        );
      }
    },
    onModeChange: async (mode: string) => {
      const tab = runtimeRef.requirePublished();
      await updateTabProviderSettings(tab, plugin, (settings) => {
        getTabChatUIConfig(tab, plugin).applyModeSelection?.(mode, settings);
      });
      tab.ui.modeSelector.updateDisplay();
      tab.ui.modeSelector.renderOptions();
      onUserModified();
    },
    onThinkingBudgetChange: async (budget: string) => {
      const tab = runtimeRef.requirePublished();
      await updateTabProviderSettings(tab, plugin, (settings) => {
        const model = getTabSelectedModel(tab, plugin) ?? settings.model;
        settings.thinkingBudget = budget;
        getTabChatUIConfig(tab, plugin).applyReasoningSelection?.(model, budget, settings);
      });
      onUserModified();
    },
    onEffortLevelChange: async (effort: string) => {
      const tab = runtimeRef.requirePublished();
      await updateTabProviderSettings(tab, plugin, (settings) => {
        const model = getTabSelectedModel(tab, plugin) ?? settings.model;
        settings.effortLevel = effort;
        getTabChatUIConfig(tab, plugin).applyReasoningSelection?.(model, effort, settings);
      });
      onUserModified();
    },
    onServiceTierChange: async (serviceTier: string) => {
      const tab = runtimeRef.requirePublished();
      await updateTabServiceTier(tab, plugin, serviceTier);
      onUserModified();
    },
    onPermissionModeChange: async (mode: string) => {
      const tab = runtimeRef.requirePublished();
      await updateTabProviderSettings(tab, plugin, (settings) => {
        const uiConfig = getTabChatUIConfig(tab, plugin);
        if (uiConfig.applyPermissionMode) {
          uiConfig.applyPermissionMode(mode, settings);
        } else {
          settings.permissionMode = mode;
        }
      });
      tab.ui.permissionToggle.updateDisplay();
      shell.dom.inputWrapper.toggleClass(
        'claudian-input-plan-mode',
        mode === 'plan' && getTabCapabilities(tab, plugin).supportsPlanMode,
      );
      onUserModified();
    },
  });
  options.registerCleanup(
    'tab input toolbar layout',
    () => toolbarComponents.layoutController.destroy(),
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
  const contextTray = new ComposerContextTray(dom.contextRowEl, {
    onDidChange: () => {
      autoResizeTextarea(dom.inputEl);
      runtimeRef.current()?.renderer.scrollToBottomIfNeeded();
    },
  });
  options.registerCleanup('tab composer context tray', () => contextTray.destroy());

  const toolbar = buildInputToolbar(shell, services, options, runtimeRef, onUserModified);
  const contextManagers = buildContextManagers(
    toolbar.externalContextSelector,
    options,
    shell,
    contextTray,
    onUserModified,
  );
  const catalogInfo = shell.providerCatalogResolver();
  const composerDropdown = buildComposerDropdown(
    shell,
    getTabProviderId(shell, plugin),
    contextManagers.fileContextManager,
    options,
    runtimeRef,
    () => getTabHiddenCommands(shell, plugin),
    catalogInfo,
  );
  const instructionComponents = buildInstructionComponents(
    shell,
    options,
    runtimeRef,
    composerDropdown,
  );
  const navigationSidebar = new NavigationSidebar(
    dom.messagesWrapperEl,
    dom.messagesEl,
  );
  options.registerCleanup('tab navigation sidebar', () => navigationSidebar.destroy());

  const ui: TabUIComponents = {
    contextTray,
    ...contextManagers,
    modelSelector: toolbar.modelSelector,
    modeSelector: toolbar.modeSelector,
    thinkingBudgetSelector: toolbar.thinkingBudgetSelector,
    externalContextSelector: toolbar.externalContextSelector,
    permissionToggle: toolbar.permissionToggle,
    serviceTierToggle: toolbar.serviceTierToggle,
    composerDropdown,
    ...instructionComponents,
    contextUsageMeter: toolbar.contextUsageMeter,
    navigationSidebar,
  };

  ui.externalContextSelector.setOnChange(() => {
    ui.fileContextManager.preScanExternalContexts();
    options.onCommandContextChanged?.(runtimeRef.requirePublished());
    onUserModified();
  });
  ui.externalContextSelector.setPersistentPaths(
    plugin.settings.persistentExternalContextPaths || [],
  );
  ui.externalContextSelector.setOnPersistenceChange((paths) => {
    void plugin.mutateSettings((settings) => {
      settings.persistentExternalContextPaths = paths;
    });
  });

  const resizeObserver = new ResizeObserver(() => {
    navigationSidebar.updateVisibility();
  });
  options.registerCleanup('tab navigation resize observer', () => resizeObserver.disconnect());
  resizeObserver.observe(dom.messagesEl);
  return ui;
}
