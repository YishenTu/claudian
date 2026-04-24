import type { Component } from 'obsidian';
import { Notice } from 'obsidian';

import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import type { ProviderCommandDropdownConfig } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import { getEnabledProviderForModel, getProviderForModel } from '../../../core/providers/modelRouting';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCapabilities,
  ProviderChatUIConfig,
  ProviderId,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  DEFAULT_CHAT_PROVIDER_ID,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { AutoTurnResult } from '../../../core/runtime/types';
import type { ChatMessage, Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import { getEnhancedPath } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { BrowserSelectionController } from '../controllers/BrowserSelectionController';
import { CanvasSelectionController } from '../controllers/CanvasSelectionController';
import { ConversationController } from '../controllers/ConversationController';
import { InputController } from '../controllers/InputController';
import { NavigationController } from '../controllers/NavigationController';
import { SelectionController } from '../controllers/SelectionController';
import { StreamController } from '../controllers/StreamController';
import { MessageRenderer } from '../rendering/MessageRenderer';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { findRewindContext } from '../rewind';
import { BangBashService } from '../services/BangBashService';
import { SubagentManager } from '../services/SubagentManager';
import { ChatState } from '../state/ChatState';
import { BangBashModeManager as BangBashModeManagerClass } from '../ui/BangBashModeManager';
import { FileContextManager } from '../ui/FileContext';
import { ImageContextManager } from '../ui/ImageContext';
import { createInputToolbar } from '../ui/InputToolbar';
import { InstructionModeManager as InstructionModeManagerClass } from '../ui/InstructionModeManager';
import { NavigationSidebar } from '../ui/NavigationSidebar';
import { StatusPanel } from '../ui/StatusPanel';
import { recalculateUsageForModel } from '../utils/usageInfo';
import { getTabProviderId } from './providerResolution';
import type { TabData, TabDOMElements, TabId, TabProviderContext } from './types';
import { generateTabId, TEXTAREA_MAX_HEIGHT_PERCENT, TEXTAREA_MIN_MAX_HEIGHT } from './types';

type TabProviderSettings = Record<string, unknown> & {
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  serviceTier: string;
  permissionMode: string;
  customContextLimits?: Record<string, number>;
};

/**
 * Returns model options for a blank tab.
 * Uses provider registration metadata to determine which providers are
 * available and how they should appear in the mixed picker.
 */
export function getBlankTabModelOptions(
  settings: Record<string, unknown>,
): ProviderUIOption[] {
  return ProviderRegistry.getEnabledProviderIds(settings).flatMap((providerId) => {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerIcon = uiConfig.getProviderIcon?.() ?? undefined;
    const group = ProviderRegistry.getProviderDisplayName(providerId);

    return uiConfig.getModelOptions(settings)
      .map(model => ({ ...model, group, providerIcon }));
  });
}

/**
 * Resolves the draft model for a new blank tab by projecting provider-specific
 * saved settings. Without this, `plugin.settings.model` reflects only the
 * settings-provider's model, which may belong to a different provider.
 */
function resolveBlankTabModel(
  plugin: ClaudianPlugin,
  providerId?: ProviderId,
): string {
  const settings = plugin.settings as unknown as Record<string, unknown>;
  if (!providerId) {
    return settings.model as string;
  }

  const targetProviderId = ProviderRegistry.isEnabled(providerId, settings)
    ? providerId
    : ProviderRegistry.resolveSettingsProviderId(settings);
  const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, targetProviderId);
  return snapshot.model as string;
}

export interface TabCreateOptions {
  plugin: ClaudianPlugin;

  containerEl: HTMLElement;
  conversation?: Conversation;
  tabId?: TabId;
  /** Restored draft model for blank tabs. */
  draftModel?: string | null;
  /** Provider to inherit for blank tabs (e.g. from the active tab). */
  defaultProviderId?: ProviderId;
  onStreamingChanged?: (isStreaming: boolean) => void;
  onTitleChanged?: (title: string) => void;
  onAttentionChanged?: (needsAttention: boolean) => void;
  onConversationIdChanged?: (conversationId: string | null) => void;
}

export { getTabProviderId } from './providerResolution';

function getTabCapabilities(
  tab: TabProviderContext,
  plugin: ClaudianPlugin,
  conversation?: Conversation | null,
): ProviderCapabilities {
  const providerId = getTabProviderId(tab, plugin, conversation);
  if (tab.service?.providerId === providerId) {
    return tab.service.getCapabilities();
  }

  return ProviderRegistry.getCapabilities(providerId);
}

function getTabChatUIConfig(
  tab: TabProviderContext,
  plugin: ClaudianPlugin,
  conversation?: Conversation | null,
): ProviderChatUIConfig {
  return ProviderRegistry.getChatUIConfig(getTabProviderId(tab, plugin, conversation));
}

function getTabSettingsSnapshot(
  tab: TabProviderContext,
  plugin: ClaudianPlugin,
): TabProviderSettings {
  return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    plugin.settings as unknown as Record<string, unknown>,
    getTabProviderId(tab, plugin),
  ) as TabProviderSettings;
}

function getTabPermissionMode(
  tab: TabProviderContext,
  plugin: ClaudianPlugin,
): string {
  const permissionMode = getTabSettingsSnapshot(tab, plugin).permissionMode;
  return typeof permissionMode === 'string' && permissionMode
    ? permissionMode
    : 'normal';
}

function getTabHiddenCommands(
  tab: TabProviderContext,
  plugin: ClaudianPlugin,
  conversation?: Conversation | null,
): Set<string> {
  return getHiddenProviderCommandSet(
    plugin.settings,
    getTabProviderId(tab, plugin, conversation),
  );
}

type ProviderCatalogInfo = {
  config: ProviderCommandDropdownConfig;
  getEntries: () => Promise<ProviderCommandEntry[]>;
} | null;

function getRegistryProviderCatalogInfo(providerId: ProviderId): ProviderCatalogInfo {
  const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
  if (!catalog) {
    return null;
  }

  return {
    config: catalog.getDropdownConfig(),
    getEntries: () => catalog.listDropdownEntries({ includeBuiltIns: false }),
  };
}

function getProviderMcpManager(providerId: ProviderId) {
  return ProviderWorkspaceRegistry.getMcpServerManager(providerId);
}

function syncSlashCommandDropdownForProvider(
  tab: TabData,
  plugin: ClaudianPlugin,
  getProviderCatalogConfig?: () => ProviderCatalogInfo,
  conversation?: Conversation | null,
): void {
  const dropdown = tab.ui.slashCommandDropdown;
  if (!dropdown) {
    return;
  }

  const catalogInfo = getProviderCatalogConfig?.()
    ?? getRegistryProviderCatalogInfo(getTabProviderId(tab, plugin, conversation));

  if (catalogInfo) {
    dropdown.setProviderCatalog?.(catalogInfo.config, catalogInfo.getEntries);
  } else {
    dropdown.resetSdkSkillsCache();
  }

  dropdown.setHiddenCommands(getTabHiddenCommands(tab, plugin, conversation));
}

async function updateTabProviderSettings(
  tab: TabProviderContext,
  plugin: ClaudianPlugin,
  update: (settings: TabProviderSettings) => void,
): Promise<TabProviderSettings> {
  const providerId = getTabProviderId(tab, plugin);
  const snapshot = getTabSettingsSnapshot(tab, plugin);
  update(snapshot);
  ProviderSettingsCoordinator.commitProviderSettingsSnapshot(
    plugin.settings as unknown as Record<string, unknown>,
    providerId,
    snapshot,
  );
  await plugin.saveSettings();
  return snapshot;
}

function refreshTabProviderUI(tab: TabData, plugin: ClaudianPlugin): void {
  const capabilities = getTabCapabilities(tab, plugin);
  const permissionMode = getTabPermissionMode(tab, plugin);
  tab.ui.modelSelector?.updateDisplay();
  tab.ui.modelSelector?.renderOptions();
  tab.ui.modeSelector?.updateDisplay();
  tab.ui.modeSelector?.renderOptions();
  tab.ui.thinkingBudgetSelector?.updateDisplay();
  tab.ui.permissionToggle?.updateDisplay();
  tab.ui.serviceTierToggle?.updateDisplay();
  tab.dom.inputWrapper.toggleClass(
    'claudian-input-plan-mode',
    permissionMode === 'plan' && capabilities.supportsPlanMode,
  );
}

/**
 * Hides or disables UI elements that the active provider does not support.
 * Called after toolbar initialization and on provider switches.
 */
function applyProviderUIGating(tab: TabData, plugin: ClaudianPlugin): void {
  const capabilities = getTabCapabilities(tab, plugin);
  const uiConfig = getTabChatUIConfig(tab, plugin);
  const mcpManager = capabilities.supportsMcpTools
    ? getProviderMcpManager(capabilities.providerId)
    : null;
  const hasPermissionToggle = Boolean(uiConfig.getPermissionModeToggle?.());

  if (!capabilities.supportsMcpTools) {
    tab.ui.mcpServerSelector?.clearEnabled();
  }
  tab.ui.mcpServerSelector?.setVisible(capabilities.supportsMcpTools);
  tab.ui.permissionToggle?.setVisible(hasPermissionToggle);
  tab.ui.fileContextManager?.setMcpManager(mcpManager);

  tab.ui.fileContextManager?.setAgentService(
    ProviderWorkspaceRegistry.getAgentMentionProvider(capabilities.providerId),
  );

  tab.ui.imageContextManager?.setEnabled(capabilities.supportsImageAttachments);
  tab.ui.contextUsageMeter?.update(tab.state.usage);
}

function syncTabProviderServices(
  tab: TabData,
  plugin: ClaudianPlugin,
): void {
  tab.services.instructionRefineService?.cancel();
  tab.services.instructionRefineService?.resetConversation();
  tab.services.titleGenerationService?.cancel();
  tab.services.instructionRefineService = ProviderRegistry.createInstructionRefineService(plugin, tab.providerId);
  tab.services.titleGenerationService = ProviderRegistry.createTitleGenerationService(plugin, tab.providerId);
  tab.services.subagentManager.setTaskResultInterpreter?.(
    ProviderRegistry.getTaskResultInterpreter(tab.providerId)
  );
}

function cleanupTabRuntime(tab: TabData): void {
  if (tab.service && typeof tab.service.cleanup === 'function') {
    tab.service.cleanup();
  }
  tab.service = null;
  tab.serviceInitialized = false;
}

/**
 * Called when provider availability changes. If a blank tab targets a provider
 * that is now disabled, it falls back to the first enabled provider's default
 * blank-tab model. Refreshes model selector options for all blank tabs.
 */
export function onProviderAvailabilityChanged(tab: TabData, plugin: ClaudianPlugin): void {
  if (tab.lifecycleState !== 'blank') return;

  const settingsSnapshot = plugin.settings as unknown as Record<string, unknown>;
  const enabledProviderIds = ProviderRegistry.getEnabledProviderIds(settingsSnapshot);
  let nextProviderId = tab.providerId;

  if (tab.draftModel) {
    const draftProvider = getEnabledProviderForModel(tab.draftModel, settingsSnapshot);
    const draftProviderOwnsModel = ProviderRegistry
      .getChatUIConfig(draftProvider)
      .ownsModel(tab.draftModel, settingsSnapshot);
    if (!enabledProviderIds.includes(draftProvider) || !draftProviderOwnsModel) {
      const fallbackProviderId = enabledProviderIds[0] ?? DEFAULT_CHAT_PROVIDER_ID;
      const fallbackModels = ProviderRegistry.getChatUIConfig(fallbackProviderId)
        .getModelOptions(settingsSnapshot);
      tab.draftModel = fallbackModels[0]?.value ?? tab.draftModel;
      nextProviderId = fallbackProviderId;
    } else {
      nextProviderId = draftProvider;
    }
  }

  tab.providerId = nextProviderId;

  // Clean up stale service if provider changed
  if (
    tab.service
    && tab.service.providerId !== nextProviderId
  ) {
    tab.service.cleanup();
    tab.service = null;
    tab.serviceInitialized = false;
  }

  syncTabProviderServices(tab, plugin);
  tab.ui.slashCommandDropdown?.setHiddenCommands(getTabHiddenCommands(tab, plugin));
  tab.ui.slashCommandDropdown?.resetSdkSkillsCache();
  refreshTabProviderUI(tab, plugin);
  applyProviderUIGating(tab, plugin);
}

/**
 * Creates a new Tab instance with all required state.
 */
export function createTab(options: TabCreateOptions): TabData {
  const {
    plugin,
    containerEl,
    conversation,
    tabId,
    onStreamingChanged,
    onAttentionChanged,
    onConversationIdChanged,
  } = options;

  const id = tabId ?? generateTabId();

  const contentEl = containerEl.createDiv({ cls: 'claudian-tab-content' });
  contentEl.style.display = 'none';

  const state = new ChatState({
    onStreamingStateChanged: onStreamingChanged,
    onAttentionChanged: onAttentionChanged,
    onConversationChanged: onConversationIdChanged,
  });

  // Create subagent manager with no-op callback.
  // This placeholder is replaced in initializeTabControllers() with the actual
  // callback that updates the StreamController. We defer the real callback
  // because StreamController doesn't exist until controllers are initialized.
  const subagentManager = new SubagentManager(() => {});

  const dom = buildTabDOM(contentEl);
  state.queueIndicatorEl = dom.queueIndicatorEl;

  const isBound = !!conversation?.id;
  const restoredDraftModel = typeof options.draftModel === 'string'
    ? options.draftModel.trim()
    : '';
  const draftModel = isBound
    ? null
    : (restoredDraftModel || resolveBlankTabModel(plugin, options.defaultProviderId));
  const initialProviderId = conversation?.providerId
    ?? (draftModel
      ? getEnabledProviderForModel(draftModel, plugin.settings as unknown as Record<string, unknown>)
      : DEFAULT_CHAT_PROVIDER_ID);

  const tab: TabData = {
    id,
    lifecycleState: isBound ? 'bound_cold' : 'blank',
    draftModel,
    providerId: initialProviderId,
    conversationId: conversation?.id ?? null,
    service: null,
    serviceInitialized: false,
    state,
    controllers: {
      selectionController: null,
      browserSelectionController: null,
      canvasSelectionController: null,
      conversationController: null,
      streamController: null,
      inputController: null,
      navigationController: null,
    },
    services: {
      subagentManager,
      instructionRefineService: null,
      titleGenerationService: null,
    },
    ui: {
      fileContextManager: null,
      imageContextManager: null,
      modelSelector: null,
      modeSelector: null,
      thinkingBudgetSelector: null,
      externalContextSelector: null,
      mcpServerSelector: null,
      permissionToggle: null,
      serviceTierToggle: null,
      slashCommandDropdown: null,
      instructionModeManager: null,
      bangBashModeManager: null,
      contextUsageMeter: null,
      statusPanel: null,
      navigationSidebar: null,
    },
    dom,
    renderer: null,
  };

  return tab;
}

/**
 * Auto-resizes a textarea based on its content.
 *
 * Logic:
 * - At minimum wrapper height: let flexbox allocate space (textarea fills available)
 * - When content exceeds flex allocation: set min-height to force wrapper growth
 * - When content shrinks: remove min-height override to let wrapper shrink
 * - Max height is capped at 55% of view height (minimum 150px)
 */
function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  // Clear inline min-height to let flexbox compute natural allocation
  textarea.style.minHeight = '';

  // Calculate max height: 55% of view height, minimum 150px
  const viewHeight = textarea.closest('.claudian-container')?.clientHeight ?? window.innerHeight;
  const maxHeight = Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);

  // Get flex-allocated height (what flexbox gives the textarea)
  const flexAllocatedHeight = textarea.offsetHeight;

  // Get content height (what the content actually needs), capped at max
  const contentHeight = Math.min(textarea.scrollHeight, maxHeight);

  // Only set min-height if content exceeds flex allocation
  // This forces the wrapper to grow while letting it shrink when content reduces
  if (contentHeight > flexAllocatedHeight) {
    textarea.style.minHeight = `${contentHeight}px`;
  }

  // Always set max-height to enforce the cap
  textarea.style.maxHeight = `${maxHeight}px`;
}

/**
 * Builds the DOM structure for a tab.
 */
function buildTabDOM(contentEl: HTMLElement): TabDOMElements {
  const messagesWrapperEl = contentEl.createDiv({ cls: 'claudian-messages-wrapper' });
  const messagesEl = messagesWrapperEl.createDiv({ cls: 'claudian-messages' });
  const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
  const statusPanelContainerEl = contentEl.createDiv({ cls: 'claudian-status-panel-container' });
  const inputContainerEl = contentEl.createDiv({ cls: 'claudian-input-container' });
  const queueIndicatorEl = inputContainerEl.createDiv({ cls: 'claudian-input-queue-row' });
  const navRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-nav-row' });
  const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });
  const contextRowEl = inputWrapper.createDiv({ cls: 'claudian-context-row' });
  const inputEl = inputWrapper.createEl('textarea', {
    cls: 'claudian-input',
    attr: {
      placeholder: 'How can I help you today?',
      rows: '3',
      dir: 'auto',
    },
  });

  return {
    contentEl,
    messagesEl,
    welcomeEl,
    statusPanelContainerEl,
    inputContainerEl,
    queueIndicatorEl,
    inputWrapper,
    inputEl,
    navRowEl,
    contextRowEl,
    selectionIndicatorEl: null,
    browserIndicatorEl: null,
    canvasIndicatorEl: null,
    eventCleanups: [],
  };
}

/**
 * Initializes the tab's chat runtime for the send path.
 *
 * This is the ONLY place a runtime is created. Called from:
 * - ensureServiceInitialized() in InputController.sendMessage()
 *
 * Session sync is passive (state update only). The runtime is started
 * on demand by query() inside the send path.
 */
export async function initializeTabService(
  tab: TabData,
  plugin: ClaudianPlugin,
  conversationOverride?: Conversation | null,
): Promise<void>;
export async function initializeTabService(
  tab: TabData,
  plugin: ClaudianPlugin,
  _legacyArg: unknown,
  conversationOverride?: Conversation | null,
): Promise<void>;
export async function initializeTabService(
  tab: TabData,
  plugin: ClaudianPlugin,
  argOrOverride?: unknown,
  maybeOverride?: Conversation | null,
): Promise<void> {
  if (tab.lifecycleState === 'closing') {
    return;
  }

  // Support legacy 4-arg call sites (3rd arg was previously an MCP manager)
  const conversationOverride = isConversationLike(argOrOverride)
    ? argOrOverride
    : (argOrOverride === null ? null : maybeOverride);

  const conversation = conversationOverride ?? (
    tab.conversationId
      ? await plugin.getConversationById(tab.conversationId)
      : null
  );
  const providerId = getTabProviderId(tab, plugin, conversation);

  if (tab.serviceInitialized && tab.service?.providerId === providerId) {
    return;
  }

  let service: ChatRuntime | null = null;
  let unsubscribeReadyState: (() => void) | null = null;
  const previousService = tab.service;

  try {
    if (typeof previousService?.cleanup === 'function') {
      previousService.cleanup();
    }
    tab.service = null;
    tab.serviceInitialized = false;

    const runtime = ProviderRegistry.createChatRuntime({ plugin, providerId });
    service = runtime;
    unsubscribeReadyState = runtime.onReadyStateChange(() => {});
    tab.dom.eventCleanups.push(() => unsubscribeReadyState?.());

    // Passive sync: set session state without starting the runtime process.
    // The runtime starts on demand when query() is called.
    if (conversation) {
      const hasMessages = conversation.messages.length > 0;
      const externalContextPaths = hasMessages
        ? conversation.externalContextPaths || []
        : (plugin.settings.persistentExternalContextPaths || []);

      runtime.syncConversationState(conversation, externalContextPaths);
    }

    // Re-check after async operations — tab may have been closed during init
    if ((tab as TabData).lifecycleState === 'closing') {
      unsubscribeReadyState?.();
      service?.cleanup();
      return;
    }


    tab.providerId = providerId;
    tab.service = service;
    tab.serviceInitialized = true;

    // Update lifecycle state
    if (tab.lifecycleState === 'blank') {
      tab.draftModel = null;
    }
    tab.lifecycleState = 'bound_active';
  } catch (error) {
    // Clean up partial state on failure
    unsubscribeReadyState?.();
    service?.cleanup();
    tab.service = null;
    tab.serviceInitialized = false;

    // Re-throw to let caller handle (e.g., show error to user)
    throw error;
  }
}

function isConversationLike(value: unknown): value is Conversation {
  return !!value
    && typeof value === 'object'
    && typeof (value as Conversation).id === 'string'
    && Array.isArray((value as Conversation).messages);
}

function initializeContextManagers(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom } = tab;
  const app = plugin.app;

  // File context manager - chips in contextRowEl, dropdown in inputContainerEl
  tab.ui.fileContextManager = new FileContextManager(
    app,
    dom.contextRowEl,
    dom.inputEl,
    {
      getExcludedTags: () => plugin.settings.excludedTags,
      onChipsChanged: () => {
        tab.controllers.selectionController?.updateContextRowVisibility();
        tab.controllers.browserSelectionController?.updateContextRowVisibility();
        tab.controllers.canvasSelectionController?.updateContextRowVisibility();
        autoResizeTextarea(dom.inputEl);
        tab.renderer?.scrollToBottomIfNeeded();
      },
      getExternalContexts: () => tab.ui.externalContextSelector?.getExternalContexts() || [],
    },
    dom.inputContainerEl
  );
  tab.ui.fileContextManager.setMcpManager(getProviderMcpManager(getTabProviderId(tab, plugin)));

  // Image context manager - drag/drop uses inputContainerEl, preview in contextRowEl
  tab.ui.imageContextManager = new ImageContextManager(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onImagesChanged: () => {
        tab.controllers.selectionController?.updateContextRowVisibility();
        tab.controllers.browserSelectionController?.updateContextRowVisibility();
        tab.controllers.canvasSelectionController?.updateContextRowVisibility();
        autoResizeTextarea(dom.inputEl);
        tab.renderer?.scrollToBottomIfNeeded();
      },
    },
    dom.contextRowEl
  );
}

function initializeSlashCommands(
  tab: TabData,
  getHiddenCommands?: () => Set<string>,
  catalogInfo?: { config: ProviderCommandDropdownConfig; getEntries: () => Promise<ProviderCommandEntry[]> } | null,
): void {
  const { dom } = tab;

  tab.ui.slashCommandDropdown = new SlashCommandDropdown(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onSelect: () => {},
      onHide: () => {},
    },
    {
      hiddenCommands: getHiddenCommands?.() ?? new Set(),
      providerConfig: catalogInfo?.config,
      getProviderEntries: catalogInfo?.getEntries,
    }
  );
}

/**
 * Initializes instruction mode and todo panel for a tab.
 */
function initializeInstructionAndTodo(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom } = tab;

  syncTabProviderServices(tab, plugin);
  tab.ui.instructionModeManager = new InstructionModeManagerClass(
    dom.inputEl,
    {
      onSubmit: async (rawInstruction) => {
        await tab.controllers.inputController?.handleInstructionSubmit(rawInstruction);
      },
      getInputWrapper: () => dom.inputWrapper,
    }
  );

  // Bang bash mode (! command execution)
  if (isBangBashEnabled(plugin.settings as unknown as Record<string, unknown>)) {
    const vaultPath = getVaultPath(plugin.app);
    if (vaultPath) {
      const enhancedPath = getEnhancedPath();
      const bashService = new BangBashService(vaultPath, enhancedPath);

      tab.ui.bangBashModeManager = new BangBashModeManagerClass(
        dom.inputEl,
        {
          onSubmit: async (command) => {
            const statusPanel = tab.ui.statusPanel;
            if (!statusPanel) return;

            const id = `bash-${Date.now()}`;
            statusPanel.addBashOutput({ id, command, status: 'running', output: '' });

            const result = await bashService.execute(command);
            const output = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
            const status = result.exitCode === 0 ? 'completed' : 'error';
            statusPanel.updateBashOutput(id, { status, output, exitCode: result.exitCode });
          },
          getInputWrapper: () => dom.inputWrapper,
        }
      );
    }
  }

  tab.ui.statusPanel = new StatusPanel();
  tab.ui.statusPanel.mount(dom.statusPanelContainerEl);
}

function isBangBashEnabled(settings: Record<string, unknown>): boolean {
  return ProviderRegistry.getEnabledProviderIds(settings).some((providerId) => (
    ProviderRegistry.getChatUIConfig(providerId).isBangBashEnabled?.(settings) ?? false
  ));
}

/**
 * Creates and wires the input toolbar for a tab.
 */
function initializeInputToolbar(
  tab: TabData,
  plugin: ClaudianPlugin,
  getProviderCatalogConfig?: () => ProviderCatalogInfo,
  onProviderChanged?: (providerId: ProviderId) => void,
): void {
  const { dom } = tab;

  const inputToolbar = dom.inputWrapper.createDiv({ cls: 'claudian-input-toolbar' });

  // Blank-tab UI config wrapper that returns mixed model options
  const blankTabUIConfigProxy = (): ProviderChatUIConfig => {
    const draftProvider = tab.draftModel
      ? getEnabledProviderForModel(tab.draftModel, plugin.settings as unknown as Record<string, unknown>)
      : DEFAULT_CHAT_PROVIDER_ID;
    const baseConfig = ProviderRegistry.getChatUIConfig(draftProvider);
    return {
      ...baseConfig,
      getModelOptions: (settings: Record<string, unknown>) =>
        getBlankTabModelOptions(settings),
    };
  };

  const toolbarComponents = createInputToolbar(inputToolbar, {
    getUIConfig: () => {
      if (tab.lifecycleState === 'blank') {
        return blankTabUIConfigProxy();
      }
      return getTabChatUIConfig(tab, plugin);
    },
    getCapabilities: () => getTabCapabilities(tab, plugin),
    getSettings: () => getTabSettingsSnapshot(tab, plugin),
    getEnvironmentVariables: () => plugin.getActiveEnvironmentVariables(),
    onModelChange: async (model: string) => {
      // For blank tabs, update draft model and derive provider
      if (tab.lifecycleState === 'blank') {
        const previousProvider = tab.providerId;
        tab.draftModel = model;
        const newProvider = getEnabledProviderForModel(
          model,
          plugin.settings as unknown as Record<string, unknown>,
        );
        const didProviderChange = newProvider !== previousProvider;
        if (tab.service) {
          cleanupTabRuntime(tab);
        }
        tab.providerId = newProvider;
        if (didProviderChange) {
          syncTabProviderServices(tab, plugin);
        }
        syncSlashCommandDropdownForProvider(tab, plugin, getProviderCatalogConfig);

        // Update settings for the new provider
        const uiConfig = ProviderRegistry.getChatUIConfig(newProvider);
        await updateTabProviderSettings(tab, plugin, (settings) => {
          settings.model = model;
          uiConfig.applyModelDefaults(model, settings);
        });
        if (didProviderChange) {
          await onProviderChanged?.(newProvider);
        }
        tab.ui.thinkingBudgetSelector?.updateDisplay();
        tab.ui.serviceTierToggle?.updateDisplay();
        tab.ui.modelSelector?.updateDisplay();
        tab.ui.modeSelector?.updateDisplay();
        // Re-render options (provider may have changed reasoning controls)
        tab.ui.modelSelector?.renderOptions();
        tab.ui.modeSelector?.renderOptions();
        applyProviderUIGating(tab, plugin);
        return;
      }

      // For bound tabs, reject cross-provider model changes
      const boundProvider = tab.providerId;
      const modelProvider = getProviderForModel(model, plugin.settings as unknown as Record<string, unknown>);
      if (modelProvider !== boundProvider) {
        new Notice('Cannot switch provider on a bound session. Start a new tab instead.');
        tab.ui.modelSelector?.updateDisplay();
        return;
      }

      const uiConfig: ProviderChatUIConfig = getTabChatUIConfig(tab, plugin);
      const providerSettings = await updateTabProviderSettings(tab, plugin, (settings) => {
        settings.model = model;
        uiConfig.applyModelDefaults(model, settings);
      });
      tab.ui.thinkingBudgetSelector?.updateDisplay();
      tab.ui.serviceTierToggle?.updateDisplay();
      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();

      // Recalculate context usage percentage for the new model's context window
      const currentUsage = tab.state.usage;
      if (currentUsage) {
        const newContextWindow = uiConfig.getContextWindowSize(
          model,
          providerSettings.customContextLimits as Record<string, number> | undefined,
        );
        tab.state.usage = recalculateUsageForModel(currentUsage, model, newContextWindow);
      }
    },
    onModeChange: async (mode: string) => {
      await updateTabProviderSettings(tab, plugin, (settings) => {
        getTabChatUIConfig(tab, plugin).applyModeSelection?.(mode, settings);
      });
      tab.ui.modeSelector?.updateDisplay();
      tab.ui.modeSelector?.renderOptions();
    },
    onThinkingBudgetChange: async (budget: string) => {
      await updateTabProviderSettings(tab, plugin, (settings) => {
        settings.thinkingBudget = budget;
        getTabChatUIConfig(tab, plugin).applyReasoningSelection?.(settings.model, budget, settings);
      });
    },
    onEffortLevelChange: async (effort: string) => {
      await updateTabProviderSettings(tab, plugin, (settings) => {
        settings.effortLevel = effort;
        getTabChatUIConfig(tab, plugin).applyReasoningSelection?.(settings.model, effort, settings);
      });
    },
    onServiceTierChange: async (serviceTier: string) => {
      await updateTabProviderSettings(tab, plugin, (settings) => {
        settings.serviceTier = serviceTier;
      });
      tab.ui.serviceTierToggle?.updateDisplay();
    },
    onPermissionModeChange: async (mode: string) => {
      await updateTabProviderSettings(tab, plugin, (settings) => {
        const uiConfig = getTabChatUIConfig(tab, plugin);
        if (uiConfig.applyPermissionMode) {
          uiConfig.applyPermissionMode(mode, settings);
        } else {
          settings.permissionMode = mode;
        }
      });
      tab.ui.permissionToggle?.updateDisplay();
      dom.inputWrapper.toggleClass(
        'claudian-input-plan-mode',
        mode === 'plan' && getTabCapabilities(tab, plugin).supportsPlanMode,
      );
    },
  });

  tab.ui.modelSelector = toolbarComponents.modelSelector;
  tab.ui.modeSelector = toolbarComponents.modeSelector;
  tab.ui.thinkingBudgetSelector = toolbarComponents.thinkingBudgetSelector;
  tab.ui.contextUsageMeter = toolbarComponents.contextUsageMeter;
  tab.ui.externalContextSelector = toolbarComponents.externalContextSelector;
  tab.ui.mcpServerSelector = toolbarComponents.mcpServerSelector;
  tab.ui.permissionToggle = toolbarComponents.permissionToggle;
  tab.ui.serviceTierToggle = toolbarComponents.serviceTierToggle;

  tab.ui.mcpServerSelector.setMcpManager(getProviderMcpManager(getTabProviderId(tab, plugin)));

  // Sync @-mentions to UI selector
  tab.ui.fileContextManager?.setOnMcpMentionChange((servers) => {
    tab.ui.mcpServerSelector?.addMentionedServers(servers);
  });

  // Wire external context changes
  tab.ui.externalContextSelector.setOnChange(() => {
    tab.ui.fileContextManager?.preScanExternalContexts();
  });

  // Initialize persistent paths
  tab.ui.externalContextSelector.setPersistentPaths(
    plugin.settings.persistentExternalContextPaths || []
  );

  // Wire persistence changes
  tab.ui.externalContextSelector.setOnPersistenceChange(async (paths) => {
    plugin.settings.persistentExternalContextPaths = paths;
    await plugin.saveSettings();
  });

  refreshTabProviderUI(tab, plugin);

  // Gate provider-specific UI elements
  applyProviderUIGating(tab, plugin);
}

export interface InitializeTabUIOptions {
  getProviderCatalogConfig?: () => ProviderCatalogInfo;
  onProviderChanged?: (providerId: ProviderId) => void | Promise<void>;
}

/**
 * Initializes the tab's UI components.
 * Call this after the tab is created and before it becomes active.
 */
export function initializeTabUI(
  tab: TabData,
  plugin: ClaudianPlugin,
  options: InitializeTabUIOptions = {}
): void {
  const { dom, state } = tab;

  // Initialize context managers (file/image)
  initializeContextManagers(tab, plugin);

  // Selection indicator - add to contextRowEl
  dom.selectionIndicatorEl = dom.contextRowEl.createDiv({ cls: 'claudian-selection-indicator' });
  dom.selectionIndicatorEl.style.display = 'none';

  dom.browserIndicatorEl = dom.contextRowEl.createDiv({ cls: 'claudian-browser-selection-indicator' });
  dom.browserIndicatorEl.style.display = 'none';

  dom.canvasIndicatorEl = dom.contextRowEl.createDiv({ cls: 'claudian-canvas-indicator' });
  dom.canvasIndicatorEl.style.display = 'none';

  const catalogInfo = options.getProviderCatalogConfig?.() ?? null;
  initializeSlashCommands(
    tab,
    () => getTabHiddenCommands(tab, plugin),
    catalogInfo,
  );

  if (dom.messagesEl.parentElement) {
    tab.ui.navigationSidebar = new NavigationSidebar(
      dom.messagesEl.parentElement,
      dom.messagesEl
    );
  }

  initializeInstructionAndTodo(tab, plugin);
  initializeInputToolbar(tab, plugin, options.getProviderCatalogConfig, options.onProviderChanged);

  state.callbacks = {
    ...state.callbacks,
    onUsageChanged: (usage) => {
      tab.ui.contextUsageMeter?.update(usage);
    },
    onTodosChanged: (todos) => tab.ui.statusPanel?.updateTodos(todos),
    onAutoScrollChanged: () => tab.ui.navigationSidebar?.updateVisibility(),
  };

  // ResizeObserver to detect overflow changes (e.g., content growth)
  const resizeObserver = new ResizeObserver(() => {
    tab.ui.navigationSidebar?.updateVisibility();
  });
  resizeObserver.observe(dom.messagesEl);
  dom.eventCleanups.push(() => resizeObserver.disconnect());
}

export interface ForkContext {
  messages: ChatMessage[];
  providerId?: ProviderId;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  resumeAt: string;
  sourceTitle?: string;
  /** 1-based index used for fork title suffix (counts only non-interrupt user messages). */
  forkAtUserMessage?: number;
  currentNote?: string;
}

function deepCloneMessages(messages: ChatMessage[]): ChatMessage[] {
  const sc = (globalThis as unknown as { structuredClone?: <T>(value: T) => T }).structuredClone;
  if (typeof sc === 'function') {
    return sc(messages);
  }
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function countUserMessagesForForkTitle(messages: ChatMessage[]): number {
  // Keep fork numbering stable by excluding non-semantic user messages.
  return messages.filter(m => m.role === 'user' && !m.isInterrupt && !m.isRebuiltContext).length;
}

interface ForkSource {
  providerId?: ProviderId;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  sourceTitle?: string;
  currentNote?: string;
}

/**
 * Resolves session ID and conversation metadata needed for forking.
 * Prefers the live service session ID; falls back to persisted conversation metadata.
 * Shows a notice and returns null when no session can be resolved.
 */
function resolveForkSource(tab: TabData, plugin: ClaudianPlugin): ForkSource | null {
  const conversation = tab.conversationId
    ? plugin.getConversationSync(tab.conversationId)
    : null;

  // Delegate session ID resolution to the runtime when available;
  // fall back to persisted conversation metadata when no runtime is active.
  const sourceSessionId = tab.service
    ? tab.service.resolveSessionIdForFork(conversation ?? null)
    : ProviderRegistry
      .getConversationHistoryService(conversation?.providerId ?? tab.providerId)
      .resolveSessionIdForConversation(conversation);

  if (!sourceSessionId) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoSession') }));
    return null;
  }

  return {
    providerId: getTabProviderId(tab, plugin, conversation),
    sourceSessionId,
    sourceProviderState: conversation?.providerState,
    sourceTitle: conversation?.title,
    currentNote: conversation?.currentNote,
  };
}

async function handleForkRequest(
  tab: TabData,
  plugin: ClaudianPlugin,
  userMessageId: string,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
): Promise<void> {
  const { state } = tab;

  if (!getTabCapabilities(tab, plugin).supportsFork) {
    new Notice('Fork is not supported by this provider.');
    return;
  }

  if (state.isStreaming) {
    new Notice(t('chat.fork.unavailableStreaming'));
    return;
  }

  const msgs = state.messages;
  const userIdx = msgs.findIndex(m => m.id === userMessageId);
  if (userIdx === -1) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorMessageNotFound') }));
    return;
  }

  if (!msgs[userIdx].userMessageId) {
    new Notice(t('chat.fork.unavailableNoUuid'));
    return;
  }

  const rewindCtx = findRewindContext(msgs, userIdx);
  if (!rewindCtx.hasResponse || !rewindCtx.prevAssistantUuid) {
    new Notice(t('chat.fork.unavailableNoResponse'));
    return;
  }

  const source = resolveForkSource(tab, plugin);
  if (!source) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs.slice(0, userIdx)),
    providerId: source.providerId,
    sourceSessionId: source.sourceSessionId,
    sourceProviderState: source.sourceProviderState,
    resumeAt: rewindCtx.prevAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: countUserMessagesForForkTitle(msgs.slice(0, userIdx + 1)),
    currentNote: source.currentNote,
  });
}

async function handleForkAll(
  tab: TabData,
  plugin: ClaudianPlugin,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
): Promise<void> {
  const { state } = tab;

  if (!getTabCapabilities(tab, plugin).supportsFork) {
    new Notice('Fork is not supported by this provider.');
    return;
  }

  if (state.isStreaming) {
    new Notice(t('chat.fork.unavailableStreaming'));
    return;
  }

  const msgs = state.messages;
  if (msgs.length === 0) {
    new Notice(t('chat.fork.commandNoMessages'));
    return;
  }

  let lastAssistantUuid: string | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].assistantMessageId) {
      lastAssistantUuid = msgs[i].assistantMessageId;
      break;
    }
  }

  if (!lastAssistantUuid) {
    new Notice(t('chat.fork.commandNoAssistantUuid'));
    return;
  }

  const source = resolveForkSource(tab, plugin);
  if (!source) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs),
    providerId: source.providerId,
    sourceSessionId: source.sourceSessionId,
    sourceProviderState: source.sourceProviderState,
    resumeAt: lastAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: countUserMessagesForForkTitle(msgs) + 1,
    currentNote: source.currentNote,
  });
}

export function initializeTabControllers(
  tab: TabData,
  plugin: ClaudianPlugin,
  component: Component,
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>,
  openConversation?: (conversationId: string) => Promise<void>,
  getProviderCatalogConfig?: () => ProviderCatalogInfo,
): void;
/** @deprecated Legacy 7-arg overload — 4th arg was previously an MCP manager. */
export function initializeTabControllers(
  tab: TabData,
  plugin: ClaudianPlugin,
  component: Component,
  _legacyArg: unknown,
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>,
  openConversation?: (conversationId: string) => Promise<void>,
  getProviderCatalogConfig?: () => ProviderCatalogInfo,
): void;
export function initializeTabControllers(
  tab: TabData,
  plugin: ClaudianPlugin,
  component: Component,
  arg4?: unknown,
  arg5?: unknown,
  arg6?: unknown,
  arg7?: unknown,
): void {
  // Support legacy 7-arg call sites (4th arg was previously an MCP manager)
  const isLegacy = arg4 !== undefined && typeof arg4 !== 'function';
  const forkRequestCallback = (isLegacy ? arg5 : arg4) as
    ((forkContext: ForkContext) => Promise<void>) | undefined;
  const openConversation = (isLegacy ? arg6 : arg5) as
    ((conversationId: string) => Promise<void>) | undefined;
  const getProviderCatalogConfig = (isLegacy ? arg7 : arg6) as
    (() => ProviderCatalogInfo) | undefined;

  const { dom, state, services, ui } = tab;

  // Create renderer
  tab.renderer = new MessageRenderer(
    plugin,
    component,
    dom.messagesEl,
    (id) => tab.controllers.conversationController!.rewind(id),
    forkRequestCallback
      ? (id) => handleForkRequest(tab, plugin, id, forkRequestCallback)
      : undefined,
    () => getTabCapabilities(tab, plugin),
  );

  // Selection controller
  tab.controllers.selectionController = new SelectionController(
    plugin.app,
    dom.selectionIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl),
    dom.contentEl,
  );

  tab.controllers.browserSelectionController = new BrowserSelectionController(
    plugin.app,
    dom.browserIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl)
  );

  tab.controllers.canvasSelectionController = new CanvasSelectionController(
    plugin.app,
    dom.canvasIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl)
  );

  tab.controllers.streamController = new StreamController({
    plugin,
    state,
    renderer: tab.renderer,
    subagentManager: services.subagentManager,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    updateQueueIndicator: () => tab.controllers.inputController?.updateQueueIndicator(),
    getAgentService: () => tab.service,
  });

  // Wire subagent callback now that StreamController exists
  // DOM updates for async subagents are handled by SubagentManager directly;
  // this callback handles message persistence.
  services.subagentManager.setCallback(
    (subagent) => {
      tab.controllers.streamController?.onAsyncSubagentStateChange(subagent);

      // During active stream, regular end-of-turn save captures latest state.
      if (!tab.state.isStreaming && tab.state.currentConversationId) {
        void tab.controllers.conversationController?.save(false).catch(() => {
          // Best-effort persistence; avoid surfacing background-save failures here.
        });
      }
    }
  );

  tab.controllers.conversationController = new ConversationController(
    {
      plugin,
      state,
      renderer: tab.renderer,
      subagentManager: services.subagentManager,
      getHistoryDropdown: () => null, // Tab doesn't have its own history dropdown
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: (el) => { dom.welcomeEl = el; },
      getMessagesEl: () => dom.messagesEl,
      getInputEl: () => dom.inputEl,
      getFileContextManager: () => ui.fileContextManager,
      getImageContextManager: () => ui.imageContextManager,
      getMcpServerSelector: () => ui.mcpServerSelector,
      getExternalContextSelector: () => ui.externalContextSelector,
      clearQueuedMessage: () => tab.controllers.inputController?.clearQueuedMessage(),
      getTitleGenerationService: () => services.titleGenerationService,
      getStatusPanel: () => ui.statusPanel,
      getAgentService: () => tab.service, // Use tab's service instead of plugin's
      dismissPendingInlinePrompts: () => tab.controllers.inputController?.dismissPendingApproval(),
      ensureServiceForConversation: async (conversation) => {
        const nextProviderId = getTabProviderId(tab, plugin, conversation);
        const providerChanged = tab.providerId !== nextProviderId;
        tab.providerId = nextProviderId;

        if (providerChanged) {
          syncTabProviderServices(tab, plugin);
        }

        // Bind session state only — runtime starts on send
        tab.conversationId = conversation?.id ?? null;
        tab.draftModel = null;
        tab.lifecycleState = conversation ? 'bound_cold' : 'blank';
        syncSlashCommandDropdownForProvider(tab, plugin, getProviderCatalogConfig, conversation);

        // If the runtime already exists for the right provider, sync it passively
        if (tab.service && tab.service.providerId === nextProviderId && conversation) {
          const hasMessages = conversation.messages.length > 0;
          const externalContextPaths = hasMessages
            ? conversation.externalContextPaths || []
            : (plugin.settings.persistentExternalContextPaths || []);
          tab.service.syncConversationState(conversation, externalContextPaths);
        }

        refreshTabProviderUI(tab, plugin);
        applyProviderUIGating(tab, plugin);
      },
    },
    {
      onNewConversation: () => {
        // Reset to blank state and drop the bound runtime so the next send
        // reinitializes against the currently selected blank-tab provider.
        const previousProviderId = tab.providerId;
        cleanupTabRuntime(tab);
        tab.lifecycleState = 'blank';
        tab.draftModel = resolveBlankTabModel(plugin, previousProviderId);
        tab.conversationId = null;
        tab.providerId = getTabProviderId(tab, plugin);
        if (tab.providerId !== previousProviderId) {
          syncTabProviderServices(tab, plugin);
        }
        refreshTabProviderUI(tab, plugin);
        applyProviderUIGating(tab, plugin);
        syncSlashCommandDropdownForProvider(tab, plugin, getProviderCatalogConfig);
      },
      onConversationLoaded: () => ui.slashCommandDropdown?.resetSdkSkillsCache(),
      onConversationSwitched: () => ui.slashCommandDropdown?.resetSdkSkillsCache(),
    }
  );

  tab.controllers.inputController = new InputController({
    plugin,
    state,
    renderer: tab.renderer,
    streamController: tab.controllers.streamController,
    selectionController: tab.controllers.selectionController,
    browserSelectionController: tab.controllers.browserSelectionController,
    canvasSelectionController: tab.controllers.canvasSelectionController,
    conversationController: tab.controllers.conversationController,
    getInputEl: () => dom.inputEl,
    getInputContainerEl: () => dom.inputContainerEl,
    getWelcomeEl: () => dom.welcomeEl,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    getImageContextManager: () => ui.imageContextManager,
    getMcpServerSelector: () => ui.mcpServerSelector,
    getExternalContextSelector: () => ui.externalContextSelector,
    getInstructionModeManager: () => ui.instructionModeManager,
    getInstructionRefineService: () => services.instructionRefineService,
    getTitleGenerationService: () => services.titleGenerationService,
    getStatusPanel: () => ui.statusPanel,
    generateId: generateMessageId,
    resetInputHeight: () => {
      // Per-tab input height is managed by CSS, no dynamic adjustment needed
    },
    getAuxiliaryModel: () => tab.service?.getAuxiliaryModel?.() ?? tab.draftModel ?? null,
    getAgentService: () => tab.service,
    getSubagentManager: () => services.subagentManager,
    getTabProviderId: () => getTabProviderId(tab, plugin),
    ensureServiceInitialized: async () => {
      if (tab.serviceInitialized && tab.lifecycleState === 'bound_active') {
        return true;
      }

      try {
        // For blank tabs on first send: derive provider from draft model
        if (tab.lifecycleState === 'blank' && tab.draftModel) {
          const derivedProvider = getEnabledProviderForModel(
            tab.draftModel,
            plugin.settings as unknown as Record<string, unknown>,
          );
          tab.providerId = derivedProvider;
        }

        await initializeTabService(tab, plugin);
        setupServiceCallbacks(tab, plugin);

        // Transition: lock model selector to bound provider
        refreshTabProviderUI(tab, plugin);
        applyProviderUIGating(tab, plugin);
        return true;
      } catch (error) {
        new Notice(error instanceof Error ? error.message : 'Failed to initialize chat service');
        return false;
      }
    },
    openConversation,
    onForkAll: forkRequestCallback
      ? () => handleForkAll(tab, plugin, forkRequestCallback)
      : undefined,
    restorePrePlanPermissionModeIfNeeded: () => {
      if (getTabPermissionMode(tab, plugin) === 'plan') {
        const restoreMode = tab.state.prePlanPermissionMode ?? 'normal';
        tab.state.prePlanPermissionMode = null;
        updatePlanModeUI(tab, plugin, restoreMode);
      }
    },
  });

  tab.controllers.navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming,
    shouldSkipEscapeHandling: () => {
      if (ui.instructionModeManager?.isActive()) return true;
      if (ui.bangBashModeManager?.isActive()) return true;
      if (tab.controllers.inputController?.isResumeDropdownVisible()) return true;
      if (ui.slashCommandDropdown?.isVisible()) return true;
      if (ui.fileContextManager?.isMentionDropdownVisible()) return true;
      return false;
    },
  });
  tab.controllers.navigationController.initialize();
}

/**
 * Wires up input event handlers for a tab.
 * Call this after controllers are initialized.
 * Stores cleanup functions in dom.eventCleanups for proper memory management.
 */
export function wireTabInputEvents(tab: TabData, plugin: ClaudianPlugin): void {
  const { dom, ui, state, controllers } = tab;

  let wasBangBashActive = ui.bangBashModeManager?.isActive() ?? false;
  const syncBangBashSuppression = (): void => {
    const isActive = ui.bangBashModeManager?.isActive() ?? false;
    if (isActive === wasBangBashActive) return;
    wasBangBashActive = isActive;

    ui.slashCommandDropdown?.setEnabled(!isActive);
    if (isActive) {
      ui.fileContextManager?.hideMentionDropdown();
    }
  };

  const keydownHandler = (e: KeyboardEvent) => {
    if (ui.bangBashModeManager?.isActive()) {
      ui.bangBashModeManager.handleKeydown(e);
      syncBangBashSuppression();
      return;
    }

    if (getTabCapabilities(tab, plugin).supportsInstructionMode && ui.instructionModeManager?.handleTriggerKey(e)) {
      return;
    }

    if (ui.bangBashModeManager?.handleTriggerKey(e)) {
      syncBangBashSuppression();
      return;
    }

    if (getTabCapabilities(tab, plugin).supportsInstructionMode && ui.instructionModeManager?.handleKeydown(e)) {
      return;
    }

    if (controllers.inputController?.handleResumeKeydown(e)) {
      return;
    }

    if (ui.slashCommandDropdown?.handleKeydown(e)) {
      return;
    }

    if (ui.fileContextManager?.handleMentionKeydown(e)) {
      return;
    }

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Escape' && !e.isComposing && state.isStreaming) {
      e.preventDefault();
      controllers.inputController?.cancelStreaming();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void controllers.inputController?.sendMessage();
    }
  };
  dom.inputEl.addEventListener('keydown', keydownHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('keydown', keydownHandler));

  const inputHandler = () => {
    if (!ui.bangBashModeManager?.isActive()) {
      ui.fileContextManager?.handleInputChange();
    }
    ui.instructionModeManager?.handleInputChange();
    ui.bangBashModeManager?.handleInputChange();
    syncBangBashSuppression();
    autoResizeTextarea(dom.inputEl);
  };
  dom.inputEl.addEventListener('input', inputHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('input', inputHandler));

  // Sidebar focus handler — show selection highlight when focus enters the tab from outside
  const focusHandler = (e: FocusEvent) => {
    if (e.relatedTarget && dom.contentEl.contains(e.relatedTarget as Node)) return;
    controllers.selectionController?.showHighlight();
  };
  dom.contentEl.addEventListener('focusin', focusHandler);
  dom.eventCleanups.push(() => dom.contentEl.removeEventListener('focusin', focusHandler));

  // Scroll listener for auto-scroll control (tracks position always, not just during streaming)
  const SCROLL_THRESHOLD = 20; // pixels from bottom to consider "at bottom"
  const RE_ENABLE_DELAY = 150; // ms to wait before re-enabling auto-scroll
  let reEnableTimeout: ReturnType<typeof setTimeout> | null = null;

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      if (reEnableTimeout) {
        clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;

    if (!isAtBottom) {
      // Immediately disable when user scrolls up
      if (reEnableTimeout) {
        clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
    } else if (!state.autoScrollEnabled) {
      // Debounce re-enabling to avoid bounce during scroll animation
      if (!reEnableTimeout) {
        reEnableTimeout = setTimeout(() => {
          reEnableTimeout = null;
          // Re-verify position before enabling (content may have changed)
          const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
          if (scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD) {
            state.autoScrollEnabled = true;
          }
        }, RE_ENABLE_DELAY);
      }
    }
  };
  dom.messagesEl.addEventListener('scroll', scrollHandler, { passive: true });
  dom.eventCleanups.push(() => {
    dom.messagesEl.removeEventListener('scroll', scrollHandler);
    if (reEnableTimeout) clearTimeout(reEnableTimeout);
  });
}

/**
 * Activates a tab (shows it and starts services).
 */
export function activateTab(tab: TabData): void {
  tab.dom.contentEl.style.display = 'flex';
  tab.controllers.selectionController?.start();
  tab.controllers.browserSelectionController?.start();
  tab.controllers.canvasSelectionController?.start();
  // Refresh navigation sidebar visibility (dimensions now available after display)
  tab.ui.navigationSidebar?.updateVisibility();
}

/**
 * Deactivates a tab (hides it and stops services).
 */
export function deactivateTab(tab: TabData): void {
  tab.dom.contentEl.style.display = 'none';
  tab.controllers.selectionController?.stop();
  tab.controllers.browserSelectionController?.stop();
  tab.controllers.canvasSelectionController?.stop();
}

/**
 * Cleans up a tab and releases all resources.
 * Made async to ensure proper cleanup ordering.
 */
export async function destroyTab(tab: TabData): Promise<void> {
  tab.lifecycleState = 'closing';

  tab.controllers.selectionController?.stop();
  tab.controllers.selectionController?.clear();
  tab.controllers.browserSelectionController?.stop();
  tab.controllers.browserSelectionController?.clear();
  tab.controllers.canvasSelectionController?.stop();
  tab.controllers.canvasSelectionController?.clear();
  tab.controllers.navigationController?.dispose();

  cleanupThinkingBlock(tab.state.currentThinkingState);
  tab.state.currentThinkingState = null;

  // Dismiss pending inline prompts before DOM teardown
  tab.controllers.inputController?.dismissPendingApproval();

  tab.controllers.inputController?.destroyResumeDropdown();
  tab.ui.fileContextManager?.destroy();
  tab.ui.slashCommandDropdown?.destroy();
  tab.ui.slashCommandDropdown = null;
  tab.ui.instructionModeManager?.destroy();
  tab.ui.instructionModeManager = null;
  tab.ui.bangBashModeManager?.destroy();
  tab.ui.bangBashModeManager = null;
  tab.services.instructionRefineService?.cancel();
  tab.services.instructionRefineService?.resetConversation();
  tab.services.instructionRefineService = null;
  tab.services.titleGenerationService?.cancel();
  tab.services.titleGenerationService = null;
  tab.ui.statusPanel?.destroy();
  tab.ui.statusPanel = null;
  tab.ui.navigationSidebar?.destroy();
  tab.ui.navigationSidebar = null;

  tab.services.subagentManager.orphanAllActive();
  tab.services.subagentManager.clear();

  for (const cleanup of tab.dom.eventCleanups) {
    cleanup();
  }
  tab.dom.eventCleanups.length = 0;

  // Clean up runtime before removing DOM
  tab.service?.cleanup();
  tab.service = null;
  tab.dom.contentEl.remove();
}

/**
 * Gets the display title for a tab.
 * Uses synchronous access since we only need the title, not messages.
 */
export function getTabTitle(tab: TabData, plugin: ClaudianPlugin): string {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.title) {
      return conversation.title;
    }
  }
  return 'New Chat';
}

/** Shared between Tab.ts and TabManager.ts to avoid duplication. */
export function setupServiceCallbacks(tab: TabData, plugin: ClaudianPlugin): void {
  if (tab.service && tab.controllers.inputController) {
    tab.service.setApprovalCallback(
      async (toolName, input, description, options) =>
        await tab.controllers.inputController?.handleApprovalRequest(toolName, input, description, options)
        ?? 'cancel'
    );
    tab.service.setApprovalDismisser(
      () => tab.controllers.inputController?.dismissPendingApprovalPrompt()
    );
    tab.service.setAskUserQuestionCallback(
      async (input, signal) =>
        await tab.controllers.inputController?.handleAskUserQuestion(input, signal)
        ?? null
    );
    tab.service.setExitPlanModeCallback(
      async (input, signal) => {
        const decision = await tab.controllers.inputController?.handleExitPlanMode(input, signal) ?? null;
        // Revert only on approve; feedback and cancel keep plan mode active.
        if (decision !== null && decision.type !== 'feedback') {
          // Only restore permission mode if still in plan mode — user may have toggled out via Shift+Tab
          if (getTabPermissionMode(tab, plugin) === 'plan') {
            const restoreMode = tab.state.prePlanPermissionMode ?? 'normal';
            tab.state.prePlanPermissionMode = null;
            updatePlanModeUI(tab, plugin, restoreMode);
          }
          if (decision.type === 'approve-new-session') {
            tab.state.pendingNewSessionPlan = decision.planContent;
            tab.state.cancelRequested = true;
          }
        }
        return decision;
      }
    );
    tab.service.setSubagentHookProvider(
      () => ({
        hasRunning: tab.services.subagentManager.hasRunningSubagents(),
      })
    );
    tab.service.setAutoTurnCallback((result: AutoTurnResult) => {
      renderAutoTriggeredTurn(tab, result);
    });
    tab.service.setPermissionModeSyncCallback((sdkMode) => {
      const mode = sdkMode === 'bypassPermissions' || sdkMode === 'yolo'
        ? 'yolo'
        : sdkMode === 'plan'
        ? 'plan'
        : 'normal';
      const currentMode = getTabPermissionMode(tab, plugin);

      if (currentMode !== mode) {
        // Save pre-plan mode when entering plan (for Shift+Tab toggle restore)
        if (mode === 'plan' && tab.state.prePlanPermissionMode === null) {
          tab.state.prePlanPermissionMode = currentMode;
        }
        updatePlanModeUI(tab, plugin, mode);
      }
    });
  }
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Renders an auto-triggered turn (e.g., agent response to task-notification)
 * that arrives after the main handler has completed.
 */
function renderAutoTriggeredTurn(tab: TabData, result: AutoTurnResult): void {
  if (!tab.dom.contentEl.isConnected) {
    return;
  }

  const { chunks, metadata } = result;
  const hasToolActivity = chunks.some(
    chunk => chunk.type === 'tool_use' || chunk.type === 'tool_result'
  );
  let textContent = '';

  for (const chunk of chunks) {
    if (chunk.type === 'text') {
      textContent += chunk.content;
    }
  }

  if (!textContent.trim() && !hasToolActivity) return;

  const content = textContent.trim() || '(background task completed)';

  const assistantMsg: ChatMessage = {
    id: metadata.assistantMessageId ?? generateMessageId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    contentBlocks: [{ type: 'text', content }],
    ...(metadata.assistantMessageId && { assistantMessageId: metadata.assistantMessageId }),
  };

  tab.state.addMessage(assistantMsg);
  tab.renderer?.renderStoredMessage(assistantMsg);
  tab.renderer?.scrollToBottom();
}

export function updatePlanModeUI(tab: TabData, plugin: ClaudianPlugin, mode: string): void {
  const providerId = getTabProviderId(tab, plugin);
  const snapshot = getTabSettingsSnapshot(tab, plugin);
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  if (uiConfig.applyPermissionMode) {
    uiConfig.applyPermissionMode(mode, snapshot);
  } else {
    snapshot.permissionMode = mode;
  }
  ProviderSettingsCoordinator.commitProviderSettingsSnapshot(
    plugin.settings as unknown as Record<string, unknown>,
    providerId,
    snapshot,
  );
  void plugin.saveSettings();
  tab.ui.permissionToggle?.updateDisplay();
  tab.dom.inputWrapper.toggleClass(
    'claudian-input-plan-mode',
    mode === 'plan' && getTabCapabilities(tab, plugin).supportsPlanMode,
  );
}
