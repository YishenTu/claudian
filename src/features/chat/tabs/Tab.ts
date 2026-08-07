import type { Component } from 'obsidian';
import { Notice, Platform } from 'obsidian';

import type {
  ProviderBackgroundOutputEvent,
  ProviderInteractionPort,
  ProviderSessionEvent,
} from '../../../core/execution';
import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import { normalizeProviderCommandDiscoveryItems } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '../../../core/providers/commands/ProviderCommandDiscoveryStore';
import {
  findProviderModelOption,
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
  resolveConversationModel,
  resolveNewConversationModel,
} from '../../../core/providers/conversationModel';
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
import { TOOL_AGENT_OUTPUT } from '../../../core/tools/toolNames';
import {
  type ChatMessage,
  type ClaudianSettings,
  type Conversation,
  isCanonicalUserMessage,
  type StreamChunk,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import { getEnhancedPath } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import type { FeatureHost } from '../../FeatureHost';
import { toggleServiceTier } from '../actions/toggleServiceTier';
import { BrowserSelectionController } from '../controllers/BrowserSelectionController';
import { CanvasSelectionController } from '../controllers/CanvasSelectionController';
import { ConversationController } from '../controllers/ConversationController';
import { InputController } from '../controllers/InputController';
import { NavigationController } from '../controllers/NavigationController';
import { SelectionController } from '../controllers/SelectionController';
import {
  providerOutputEventToStreamChunk,
  StreamController,
} from '../controllers/StreamController';
import {
  ChatExecutionCoordinator,
  type ChatExecutionEventContext,
} from '../execution/ChatExecutionCoordinator';
import { MessageRenderer } from '../rendering/MessageRenderer';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { createWelcomeElement } from '../rendering/WelcomeRenderer';
import { findRewindContext } from '../rewind';
import { BangBashService } from '../services/BangBashService';
import { SubagentManager } from '../services/SubagentManager';
import { ChatState } from '../state/ChatState';
import type { TabAttention } from '../state/types';
import { BangBashModeManager as BangBashModeManagerClass } from '../ui/BangBashModeManager';
import { ComposerContextTray } from '../ui/ComposerContextTray';
import { FileContextManager } from '../ui/FileContext';
import { ImageContextManager } from '../ui/ImageContext';
import { createInputToolbar } from '../ui/InputToolbar';
import { InstructionModeManager as InstructionModeManagerClass } from '../ui/InstructionModeManager';
import { NavigationSidebar } from '../ui/NavigationSidebar';
import { StatusPanel } from '../ui/StatusPanel';
import { autoResizeTextarea } from '../ui/textareaResize';
import { recalculateUsageForModel } from '../utils/usageInfo';
import { getTabProviderId } from './providerResolution';
import { TabModelSelectionCoordinator } from './TabModelSelectionCoordinator';
import { TabSession } from './TabSession';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  ProviderCatalogResolver,
  TabControllers,
  TabDOMElements,
  TabId,
  TabInputBindings,
  TabManagerViewHost,
  TabProviderCatalogContext,
  TabProviderContext,
  TabRuntimeCleanupFailure,
  TabRuntimeResourceOwner,
  TabServices,
  TabUIComponents,
} from './types';
import { generateTabId } from './types';

type TabProviderSettings = Record<string, unknown> & {
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  serviceTier: string;
  permissionMode: string;
  customContextLimits?: Record<string, number>;
};

interface BackgroundTurnRenderResult {
  chunks: StreamChunk[];
  metadata: {
    assistantMessageId?: string;
  };
}

const backgroundTurnBuffers = new WeakMap<
  AssembledTabRuntime,
  Map<string, Map<string, ProviderBackgroundOutputEvent[]>>
>();
const tabDestructionPromises = new WeakMap<AssembledTabRuntime, Promise<void>>();
const tabShutdownDrainPromises = new WeakMap<
  AssembledTabRuntime,
  Promise<TabShutdownDrainResult>
>();
const tabRuntimeResourceOwners = new WeakMap<
  AssembledTabRuntime,
  TabRuntimeResourceOwner
>();

function getSharedSelectionFocusScopeEls(component: Component): HTMLElement[] {
  const host = component as Partial<TabManagerViewHost>;
  return host.getSharedSelectionFocusScopeEls?.() ?? [];
}

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

export type TabRuntimeCleanup = () => void | Promise<void>;

export interface TabRuntimeAssemblyOptions {
  plugin: FeatureHost;
  containerEl: HTMLElement;
  component: Component;
  conversation?: Conversation;
  tabId?: TabId;
  draftModel?: string | null;
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'cold'>;
  getProviderCatalogConfig: (
    tab: TabProviderCatalogContext,
  ) => ProviderCatalogInfo;
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean;
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>;
  openConversation?: (conversationId: string) => Promise<void>;
  onStreamingChanged?: (tab: AssembledTabRuntime, isStreaming: boolean) => void;
  onRewindingChanged?: (tab: AssembledTabRuntime, isRewinding: boolean) => void;
  onAttentionChanged?: (tab: AssembledTabRuntime, attention: TabAttention) => void;
  onConversationIdChanged?: (
    tab: AssembledTabRuntime,
    conversationId: string | null,
  ) => void;
  onProviderChanged?: (
    tab: AssembledTabRuntime,
    providerId: ProviderId,
  ) => void | Promise<void>;
  onCommandContextChanged?: (tab: AssembledTabRuntime) => void;
  captureReviewableSettlement?: (tab: AssembledTabRuntime) => () => void;
  registerCleanup: (resource: string, cleanup: TabRuntimeCleanup) => void;
  resourceOwner: TabRuntimeResourceOwner;
}

/** One-shot reference used only by callbacks that can run after assembly. */
interface PublishedTabRuntimeRef {
  requirePublished(): AssembledTabRuntime;
  current(): AssembledTabRuntime | null;
  publish(runtime: AssembledTabRuntime): void;
}

interface TabShellBundle extends TabProviderContext {
  readonly session: TabSession;
  readonly id: TabId;
  hydrationState: AssembledTabRuntime['hydrationState'];
  readonly executionCoordinator: ChatExecutionCoordinator;
  readonly providerCatalogResolver: ProviderCatalogResolver;
  readonly captureReviewableSettlement: (() => () => void) | null;
  readonly state: ChatState;
  readonly dom: TabDOMElements;
}

interface TabControllerBundle {
  readonly controllers: TabControllers;
  readonly renderer: MessageRenderer;
}

export { getTabProviderId } from './providerResolution';

function getTabCapabilities(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): ProviderCapabilities {
  const providerId = getTabProviderId(tab, plugin, conversation);
  return ProviderRegistry.getCapabilities(providerId);
}

function getTabChatUIConfig(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): ProviderChatUIConfig {
  return ProviderRegistry.getChatUIConfig(getTabProviderId(tab, plugin, conversation));
}

function getTabSettingsSnapshot(
  tab: TabProviderContext,
  plugin: FeatureHost,
): TabProviderSettings {
  const providerId = getTabProviderId(tab, plugin);
  return getProviderSettingsSnapshotWithModel(
    plugin.settings,
    providerId,
    getTabSelectedModel(tab, plugin),
  );
}

function getWritableTabSettingsSnapshot(
  tab: TabProviderContext,
  plugin: FeatureHost,
  settings: ClaudianSettings = plugin.settings,
): TabProviderSettings {
  return getProviderSettingsSnapshotWithModel(
    settings,
    getTabProviderId(tab, plugin),
    getTabSelectedModel(tab, plugin),
  );
}

function getTabConversation(
  tab: TabProviderContext,
  plugin: FeatureHost,
): Conversation | null {
  return tab.conversationId ? plugin.getConversationSync(tab.conversationId) : null;
}

function getTabSelectedModel(
  tab: TabProviderContext,
  plugin: FeatureHost,
): string | null {
  const providerId = getTabProviderId(tab, plugin);
  if (tab.conversationId === null) {
    return normalizeProviderModelSelection(providerId, plugin.settings, tab.draftModel)
      ?? tab.draftModel
      ?? null;
  }

  const conversation = getTabConversation(tab, plugin);
  if (conversation) {
    return resolveConversationModel(plugin.settings, providerId, conversation).model;
  }

  return null;
}

function getTabPermissionMode(
  tab: TabProviderContext,
  plugin: FeatureHost,
): string {
  const permissionMode = getTabSettingsSnapshot(tab, plugin).permissionMode;
  return typeof permissionMode === 'string' && permissionMode
    ? permissionMode
    : 'normal';
}

function getTabHiddenCommands(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): Set<string> {
  return getHiddenProviderCommandSet(
    plugin.settings,
    getTabProviderId(tab, plugin, conversation),
  );
}

function isEnterWithoutShiftOrComposition(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) {
    return false;
  }

  return true;
}

function hasPlatformSendModifier(e: KeyboardEvent): boolean {
  if (Platform.isMacOS) {
    return e.metaKey === true && !e.ctrlKey && !e.altKey;
  }

  return e.ctrlKey === true && !e.metaKey && !e.altKey;
}

function shouldSendMessageFromExplicitEnterShortcut(e: KeyboardEvent): boolean {
  return isEnterWithoutShiftOrComposition(e) && hasPlatformSendModifier(e);
}

function shouldSendMessageFromEnterKey(
  e: KeyboardEvent,
  settings: Pick<ClaudianSettings, 'requireCommandOrControlEnterToSend'>,
): boolean {
  if (!isEnterWithoutShiftOrComposition(e)) {
    return false;
  }

  if (settings.requireCommandOrControlEnterToSend === true) {
    return hasPlatformSendModifier(e);
  }

  return true;
}

function isTabInputFocused(tab: AssembledTabRuntime): boolean {
  return tab.dom.inputEl.ownerDocument.activeElement === tab.dom.inputEl;
}

function sendTabInputMessage(
  tab: AssembledTabRuntime,
  e: KeyboardEvent,
  options?: { requireInputFocus?: boolean },
): boolean {
  if (options?.requireInputFocus && !isTabInputFocused(tab)) {
    return false;
  }

  const inputController = tab.controllers.inputController;
  if (!inputController) {
    return false;
  }

  e.preventDefault();
  void inputController.sendMessage();
  return true;
}

export function sendTabInputMessageFromExplicitEnterShortcut(
  tab: AssembledTabRuntime,
  e: KeyboardEvent,
  options?: { requireInputFocus?: boolean },
): boolean {
  if (!shouldSendMessageFromExplicitEnterShortcut(e)) {
    return false;
  }

  return sendTabInputMessage(tab, e, options);
}

function sendTabInputMessageFromEnterKey(
  tab: AssembledTabRuntime,
  settings: Pick<ClaudianSettings, 'requireCommandOrControlEnterToSend'>,
  e: KeyboardEvent,
): boolean {
  if (!shouldSendMessageFromEnterKey(e, settings)) {
    return false;
  }

  return sendTabInputMessage(tab, e);
}

function getRegistryProviderCatalogInfo(providerId: ProviderId): ProviderCatalogInfo {
  const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
  if (!catalog) {
    return null;
  }

  return {
    config: catalog.getDropdownConfig(),
    discovery: new ProviderCommandDiscoveryStore(async signal =>
      normalizeProviderCommandDiscoveryItems(
        await catalog.listDropdownEntries({ includeBuiltIns: false, signal }),
      ),
    ),
  };
}

function getProviderMcpManager(providerId: ProviderId) {
  return ProviderWorkspaceRegistry.getMcpServerManager(providerId);
}

function syncSlashCommandDropdownForProvider(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  getProviderCatalogConfig?: ProviderCatalogResolver,
  conversation?: Conversation | null,
): void {
  const dropdown = tab.ui.slashCommandDropdown;
  if (!dropdown) {
    return;
  }

  const providerId = getTabProviderId(tab, plugin, conversation);
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.()
    ?? getRegistryProviderCatalogInfo(providerId);

  dropdown.setProviderId(providerId);

  if (catalogInfo) {
    dropdown.setProviderCatalog?.(catalogInfo.config, catalogInfo.discovery);
  } else {
    dropdown.clearProviderCatalog?.();
  }

  dropdown.setHiddenCommands(getTabHiddenCommands(tab, plugin, conversation));
}

function invalidateTabProviderCommands(
  tab: AssembledTabRuntime,
  getProviderCatalogConfig?: ProviderCatalogResolver,
): void {
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.() ?? null;
  catalogInfo?.discovery.invalidate();
}

async function updateTabProviderSettings(
  tab: TabProviderContext,
  plugin: FeatureHost,
  update: (settings: TabProviderSettings) => void,
): Promise<TabProviderSettings> {
  const providerId = getTabProviderId(tab, plugin);
  let snapshot!: TabProviderSettings;
  await plugin.mutateSettings((settings) => {
    snapshot = getWritableTabSettingsSnapshot(tab, plugin, settings);
    update(snapshot);
    ProviderSettingsCoordinator.commitProviderSettingsSnapshot(
      settings,
      providerId,
      snapshot,
    );
  });
  return snapshot;
}

async function updateTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  serviceTier: string,
): Promise<void> {
  await updateTabProviderSettings(tab, plugin, (settings) => {
    settings.serviceTier = serviceTier;
  });
  tab.ui.serviceTierToggle.updateDisplay();
}

async function toggleTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
): Promise<boolean> {
  return await toggleServiceTier({
    getUIConfig: () => getTabChatUIConfig(tab, plugin),
    getSettings: () => getTabSettingsSnapshot(tab, plugin),
    onServiceTierChange: serviceTier => updateTabServiceTier(tab, plugin, serviceTier),
  });
}

function refreshTabProviderUI(tab: AssembledTabRuntime, plugin: FeatureHost): void {
  const capabilities = getTabCapabilities(tab, plugin);
  const permissionMode = getTabPermissionMode(tab, plugin);
  tab.ui.modelSelector.updateDisplay();
  tab.ui.modelSelector.renderOptions();
  tab.ui.modeSelector.updateDisplay();
  tab.ui.modeSelector.renderOptions();
  tab.ui.thinkingBudgetSelector.updateDisplay();
  tab.ui.permissionToggle.updateDisplay();
  tab.ui.serviceTierToggle.updateDisplay();
  tab.dom.inputWrapper.toggleClass(
    'claudian-input-plan-mode',
    permissionMode === 'plan' && capabilities.supportsPlanMode,
  );
}

/**
 * Hides or disables UI elements that the active provider does not support.
 * Called after toolbar initialization and on provider switches.
 */
function applyProviderUIGating(tab: AssembledTabRuntime, plugin: FeatureHost): void {
  const capabilities = getTabCapabilities(tab, plugin);
  const uiConfig = getTabChatUIConfig(tab, plugin);
  const mcpManager = capabilities.supportsMcpTools
    ? getProviderMcpManager(capabilities.providerId)
    : null;
  const hasPermissionToggle = Boolean(uiConfig.getPermissionModeToggle?.());

  if (!capabilities.supportsMcpTools) {
    tab.ui.mcpServerSelector.clearEnabled();
  }
  tab.ui.mcpServerSelector.setVisible(capabilities.supportsMcpTools);
  tab.ui.permissionToggle.setVisible(hasPermissionToggle);
  tab.ui.fileContextManager.setMcpManager(mcpManager);

  tab.ui.fileContextManager.setAgentService(
    ProviderWorkspaceRegistry.getAgentMentionProvider(capabilities.providerId),
  );

  tab.ui.imageContextManager.setEnabled(capabilities.supportsImageAttachments);
  tab.ui.contextUsageMeter.update(tab.state.usage);
}

export function refreshTabWorkspaceServices(tab: AssembledTabRuntime, plugin: FeatureHost): void {
  const providerId = getTabProviderId(tab, plugin);
  tab.ui.mcpServerSelector.setMcpManager(getProviderMcpManager(providerId));
  syncSlashCommandDropdownForProvider(tab, plugin);
  applyProviderUIGating(tab, plugin);
}

function syncTabProviderServices(
  tab: TabProviderContext,
  services: TabServices,
  plugin: FeatureHost,
): void {
  services.instructionRefineService?.cancel();
  services.instructionRefineService?.resetConversation();
  services.instructionRefineService = ProviderWorkspaceRegistry.getIfInitialized(tab.providerId)
    ? ProviderRegistry.createInstructionRefineService(
      plugin.providerHost,
      tab.providerId,
    )
    : null;
  services.subagentManager.setTaskResultInterpreter(
    ProviderRegistry.getTaskResultInterpreter(tab.providerId)
  );
}

function buildTabServices(
  shell: TabShellBundle,
  options: TabRuntimeAssemblyOptions,
  runtimeRef: PublishedTabRuntimeRef,
): TabServices {
  const subagentManager = new SubagentManager((subagent) => {
    runtimeRef.requirePublished().controllers.streamController.onAsyncSubagentStateChange(subagent);
  });
  options.registerCleanup('tab subagent state', () => subagentManager.clear());

  const titleGenerationService = ProviderRegistry.createTitleGenerationService(
    options.plugin.providerHost,
  );
  options.registerCleanup(
    'tab title generation',
    () => titleGenerationService.cancel(),
  );

  const services: TabServices = {
    subagentManager,
    instructionRefineService: null,
    titleGenerationService,
  };
  options.registerCleanup('tab instruction refinement state', () => {
    services.instructionRefineService?.resetConversation();
  });
  options.registerCleanup('tab instruction refinement', () => {
    services.instructionRefineService?.cancel();
  });

  syncTabProviderServices(shell, services, options.plugin);
  return services;
}

function resolveBlankTabFallback(
  settings: Record<string, unknown>,
  enabledProviderIds: ProviderId[],
  preferredProviderId: ProviderId,
): { model: string; providerId: ProviderId } | null {
  const providerIds = [
    ...(enabledProviderIds.includes(preferredProviderId) ? [preferredProviderId] : []),
    ...ProviderRegistry.getBlankTabProviderIds(settings)
      .filter(providerId => providerId !== preferredProviderId),
  ];

  for (const providerId of providerIds) {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const modelOptions = uiConfig.getModelOptions(settings);
    if (modelOptions.length === 0) {
      continue;
    }

    const defaultModel = uiConfig.getDefaultModel?.(settings);
    const availableDefault = defaultModel
      ? findProviderModelOption(providerId, defaultModel, settings)
      : null;
    return {
      model: availableDefault ?? modelOptions[0].value,
      providerId,
    };
  }

  return null;
}

/**
 * Reconciles blank drafts after provider or model availability changes.
 * Prefer the draft provider's advertised default before crossing providers.
 */
export function onProviderAvailabilityChanged(tab: AssembledTabRuntime, plugin: FeatureHost): boolean {
  if (tab.conversationId !== null) return false;

  const settingsSnapshot = plugin.settings as unknown as Record<string, unknown>;
  const enabledProviderIds = ProviderRegistry.getEnabledProviderIds(settingsSnapshot);
  const previousDraftModel = tab.draftModel;
  const previousProviderId = tab.providerId;
  let nextProviderId = tab.providerId;

  if (tab.draftModel) {
    const draftProvider = getEnabledProviderForModel(
      tab.draftModel,
      settingsSnapshot,
      tab.providerId,
    );
    const availableDraftModel = enabledProviderIds.includes(draftProvider)
      ? findProviderModelOption(draftProvider, tab.draftModel, settingsSnapshot)
      : null;
    if (!availableDraftModel) {
      const fallback = resolveBlankTabFallback(
        settingsSnapshot,
        enabledProviderIds,
        draftProvider,
      );
      if (fallback) {
        tab.draftModel = fallback.model;
        nextProviderId = fallback.providerId;
      }
    } else {
      tab.draftModel = availableDraftModel;
      nextProviderId = draftProvider;
    }
  } else {
    const fallback = resolveBlankTabFallback(
      settingsSnapshot,
      enabledProviderIds,
      tab.providerId,
    );
    if (fallback) {
      tab.draftModel = fallback.model;
      nextProviderId = fallback.providerId;
    }
  }

  tab.providerId = nextProviderId;

  syncTabProviderServices(tab, tab.services, plugin);
  syncSlashCommandDropdownForProvider(tab, plugin);
  invalidateTabProviderCommands(tab);
  refreshTabProviderUI(tab, plugin);
  applyProviderUIGating(tab, plugin);
  return tab.draftModel !== previousDraftModel || tab.providerId !== previousProviderId;
}

function createPublishedTabRuntimeRef(): PublishedTabRuntimeRef {
  let publishedRuntime: AssembledTabRuntime | null = null;
  return {
    requirePublished: () => {
      if (!publishedRuntime) {
        throw new Error('Tab runtime callback invoked before assembly completed');
      }
      return publishedRuntime;
    },
    current: () => publishedRuntime,
    publish: (runtime) => {
      if (publishedRuntime) {
        throw new Error('Tab runtime was published more than once');
      }
      publishedRuntime = runtime;
    },
  };
}

/** Factory-owned construction entry point. Production callers use createTabRuntime. */
export function assembleTabRuntime(
  options: TabRuntimeAssemblyOptions,
): AssembledTabRuntime {
  const runtimeRef = createPublishedTabRuntimeRef();
  const shell = buildTabShell(options, runtimeRef);
  const services = buildTabServices(shell, options, runtimeRef);
  const ui = buildTabUI(shell, services, options, runtimeRef);
  const controllerBundle = buildTabControllers(
    shell,
    services,
    ui,
    options,
    runtimeRef,
  );
  const inputBindings = buildTabInputBindings(
    shell,
    ui,
    controllerBundle.controllers,
    options,
    runtimeRef,
  );
  const runtime = composeTabRuntime(
    shell,
    services,
    ui,
    controllerBundle,
    inputBindings,
    options.resourceOwner,
  );
  tabRuntimeResourceOwners.set(runtime, options.resourceOwner);
  runtimeRef.publish(runtime);

  refreshTabProviderUI(runtime, options.plugin);
  applyProviderUIGating(runtime, options.plugin);
  return runtime;
}

function buildTabShell(
  options: TabRuntimeAssemblyOptions,
  runtimeRef: PublishedTabRuntimeRef,
): TabShellBundle {
  const { plugin, conversation } = options;
  const id = options.tabId ?? generateTabId();
  const contentEl = options.containerEl.createDiv({
    cls: 'claudian-tab-content claudian-hidden',
  });
  options.registerCleanup('tab DOM root', () => contentEl.remove());

  const dom = buildTabDOM(contentEl);
  const state = new ChatState({
    onStreamingStateChanged: isStreaming => {
      options.onStreamingChanged?.(runtimeRef.requirePublished(), isStreaming);
    },
    onRewindingStateChanged: isRewinding => {
      options.onRewindingChanged?.(runtimeRef.requirePublished(), isRewinding);
    },
    onAttentionChanged: attention => {
      options.onAttentionChanged?.(runtimeRef.requirePublished(), attention);
    },
    onConversationChanged: conversationId => {
      options.onConversationIdChanged?.(runtimeRef.requirePublished(), conversationId);
    },
    onUsageChanged: usage => runtimeRef.requirePublished().ui.contextUsageMeter.update(usage),
    onTodosChanged: todos => runtimeRef.requirePublished().ui.statusPanel.updateTodos(todos),
    onAutoScrollChanged: () => runtimeRef.requirePublished().ui.navigationSidebar.updateVisibility(),
  });
  state.queueIndicatorEl = dom.queueIndicatorEl;

  options.registerCleanup('tab thinking state', () => {
    cleanupThinkingBlock(state.currentThinkingState);
    state.currentThinkingState = null;
  });

  const isBound = !!conversation?.id;
  const restoredDraftModel = typeof options.draftModel === 'string'
    ? options.draftModel.trim()
    : '';
  const newConversationModel = !isBound && !restoredDraftModel
    ? resolveNewConversationModel(plugin.settings)
    : null;
  const draftModel = isBound
    ? null
    : (restoredDraftModel || newConversationModel?.model || null);
  const initialProviderId = conversation?.providerId
    ?? newConversationModel?.providerId
    ?? (draftModel
      ? getEnabledProviderForModel(draftModel, plugin.settings)
      : DEFAULT_CHAT_PROVIDER_ID);
  const sessionState = {
    id,
    lifecycleState: options.lifecycleState ?? 'cold',
    draftModel,
    providerId: initialProviderId,
    conversationId: conversation?.id ?? null,
  };
  const executionCoordinator = createTabExecutionCoordinator(
    id,
    state,
    plugin,
    runtimeRef,
  );
  const session = new TabSession(sessionState, executionCoordinator);
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

  const shell: TabShellBundle = {
    session,
    get id() {
      return session.id;
    },
    get lifecycleState() {
      return session.lifecycleState;
    },
    set lifecycleState(value) {
      session.lifecycleState = value;
    },
    hydrationState: isBound ? 'idle' : 'ready',
    get draftModel() {
      return session.draftModel;
    },
    set draftModel(value) {
      session.draftModel = value;
    },
    get providerId() {
      return session.providerId;
    },
    set providerId(value) {
      session.providerId = value;
    },
    get conversationId() {
      return session.conversationId;
    },
    set conversationId(value) {
      session.conversationId = value;
    },
    executionCoordinator,
    providerCatalogResolver: () => options.getProviderCatalogConfig(providerCatalogContext),
    captureReviewableSettlement: options.captureReviewableSettlement
      ? () => options.captureReviewableSettlement!(runtimeRef.requirePublished())
      : null,
    state,
    dom,
  };
  return shell;
}

function composeTabRuntime(
  shell: TabShellBundle,
  services: TabServices,
  ui: TabUIComponents,
  controllerBundle: TabControllerBundle,
  inputBindings: TabInputBindings,
  resourceOwner: TabRuntimeResourceOwner,
): AssembledTabRuntime {
  return {
    session: shell.session,
    get id() {
      return shell.id;
    },
    get lifecycleState() {
      return shell.lifecycleState;
    },
    set lifecycleState(value) {
      shell.lifecycleState = value;
    },
    get hydrationState() {
      return shell.hydrationState;
    },
    set hydrationState(value) {
      shell.hydrationState = value;
    },
    get draftModel() {
      return shell.draftModel;
    },
    set draftModel(value) {
      shell.draftModel = value;
    },
    get providerId() {
      return shell.providerId;
    },
    set providerId(value) {
      shell.providerId = value;
    },
    get conversationId() {
      return shell.conversationId;
    },
    set conversationId(value) {
      shell.conversationId = value;
    },
    executionCoordinator: shell.executionCoordinator,
    providerCatalogResolver: shell.providerCatalogResolver,
    captureReviewableSettlement: shell.captureReviewableSettlement,
    state: shell.state,
    controllers: controllerBundle.controllers,
    services,
    ui,
    dom: shell.dom,
    renderer: controllerBundle.renderer,
    inputBindings,
    resources: {
      get isDisposed() {
        return resourceOwner.isDisposed;
      },
    },
  };
}

function createConversationExecutionBinding(conversation: Conversation) {
  return {
    conversationId: conversation.id,
    providerId: conversation.providerId,
    resumeSeed: {
      ...(conversation.sessionId ? { providerSessionId: conversation.sessionId } : {}),
      ...(conversation.providerState ? { providerState: conversation.providerState } : {}),
      ...(conversation.resumeAtMessageId
        ? { resumeCheckpoint: conversation.resumeAtMessageId }
        : {}),
    },
  };
}

function createTabExecutionCoordinator(
  id: TabId,
  state: ChatState,
  plugin: FeatureHost,
  runtimeRef: PublishedTabRuntimeRef,
): ChatExecutionCoordinator {
  const interactionKinds = new Map<
    string,
    'approval' | 'question' | 'plan-decision'
  >();
  const interactionPort: ProviderInteractionPort = {
    requestApproval: async (request) => {
      const tab = runtimeRef.requirePublished();
      interactionKinds.set(request.interactionId, request.kind);
      state.beginActionRequired(request.interactionId);
      try {
        const decision = await tab.controllers.inputController.handleApprovalRequest(
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
        return { interactionId: request.interactionId, decision };
      } finally {
        interactionKinds.delete(request.interactionId);
        state.endActionRequired(request.interactionId);
      }
    },
    askUserQuestion: async (request, signal) => {
      const tab = runtimeRef.requirePublished();
      interactionKinds.set(request.interactionId, request.kind);
      state.beginActionRequired(request.interactionId);
      try {
        const answers = await tab.controllers.inputController.handleAskUserQuestion(
          { ...request.input },
          signal,
        );
        return { interactionId: request.interactionId, answers };
      } finally {
        interactionKinds.delete(request.interactionId);
        state.endActionRequired(request.interactionId);
      }
    },
    requestPlanDecision: async (request, signal) => {
      const tab = runtimeRef.requirePublished();
      interactionKinds.set(request.interactionId, request.kind);
      state.beginActionRequired(request.interactionId);
      try {
        const decision = await tab.controllers.inputController.handleExitPlanMode(
          { ...request.input },
          signal,
          request.presentation,
        );
        if (decision !== null && decision.type !== 'feedback') {
          await restorePrePlanMode(tab, plugin);
          if (decision.type === 'approve-new-session') {
            tab.state.pendingNewSessionPlan = decision.planContent;
            tab.state.cancelRequested = true;
          }
        }
        return { interactionId: request.interactionId, decision };
      } finally {
        interactionKinds.delete(request.interactionId);
        state.endActionRequired(request.interactionId);
      }
    },
    dismissInteraction: (interactionId) => {
      const tab = runtimeRef.requirePublished();
      const kind = interactionKinds.get(interactionId);
      if (kind) {
        tab.controllers.inputController.dismissProviderInteraction(kind);
        interactionKinds.delete(interactionId);
        state.endActionRequired(interactionId);
      }
    },
  };
  return new ChatExecutionCoordinator({
    lifecycleRegistry: plugin.providerHost.executionLifecycleRegistry,
    resolveBackend: providerId => ProviderRegistry.createExecutionBackend(
      plugin.providerHost,
      providerId,
    ),
    persistence: plugin.executionPersistence,
    interactionPort,
    vaultWorkingDirectory: getVaultPath(plugin.app) ?? '.',
    createId: generateMessageId,
    onRequestedEvent: event => runtimeRef.requirePublished().controllers.inputController.handleExecutionEvent(event),
    onSessionEvent: (event, context) => enqueueTabSessionEvent(
      runtimeRef.requirePublished(),
      plugin,
      event,
      context,
    ),
    resolveMissingProviderSession: (conversationId, missingProviderSessionId) =>
      plugin.handleMissingProviderSession(conversationId, missingProviderSessionId),
    onError: error => {
      new Notice(error instanceof Error ? error.message : 'Provider execution failed.');
    },
    warmExecution: {
      ownerId: id,
      pool: plugin.warmExecutionPool,
      canCool: () => {
        const tab = runtimeRef.requirePublished();
        return !state.isStreaming
          && !state.isRewinding
          && !state.requiresAction
          && tab.session.activeTurn === null
          && tab.lifecycleState !== 'closing';
      },
      onWarmStateChanged: (isWarm) => {
        const tab = runtimeRef.requirePublished();
        if (tab.lifecycleState === 'closing') return;
        tab.lifecycleState = isWarm ? 'warm' : 'cold';
      },
    },
  });
}

async function restorePrePlanMode(tab: AssembledTabRuntime, plugin: FeatureHost): Promise<void> {
  if (getTabPermissionMode(tab, plugin) !== 'plan') return;
  const restoreMode = tab.state.prePlanPermissionMode ?? 'normal';
  try {
    await updatePlanModeUI(tab, plugin, restoreMode);
  } finally {
    if (getTabPermissionMode(tab, plugin) !== 'plan') {
      tab.state.prePlanPermissionMode = null;
    }
  }
}

async function handleTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  if (event.type === 'mode_changed') {
    await updatePlanModeUI(tab, plugin, normalizeProviderMode(event.mode));
    if (!isCurrent()) return;
    return;
  }
  if (event.type === 'async_subagent_completed') {
    const providerSessionId = event.providerSessionId
      ?? tab.executionCoordinator.snapshot?.providerSessionId;
    if (!providerSessionId) return;
    const applied = await tab.controllers.streamController.handleAsyncSubagentCompletion({
      type: 'async_subagent_completion',
      providerSessionId,
      taskId: event.subagentId,
      status: event.status,
      ...(event.result !== undefined ? { result: event.result } : {}),
    });
    if (applied && isCurrent()) {
      const reportReviewableSettlement = tab.captureReviewableSettlement?.();
      try {
        await tab.controllers.conversationController.save(true);
      } finally {
        if (isCurrent()) reportReviewableSettlement?.();
      }
    }
    return;
  }
  if (event.type === 'session_error') {
    new Notice(event.message);
    return;
  }
  if (event.scope.kind !== 'background') return;

  const turns = getBackgroundTurnBuffers(tab, context.bindingId);
  if (event.type === 'background_turn_started') {
    turns.set(event.scope.turnId, []);
    return;
  }
  if (event.type === 'background_turn_completed') {
    const hasBufferedTurn = turns.has(event.scope.turnId);
    const events = turns.get(event.scope.turnId) ?? [];
    turns.delete(event.scope.turnId);
    deleteBackgroundTurnBuffersIfEmpty(tab, context.bindingId, turns);
    if (!hasBufferedTurn) return;
    const chunks = events
      .map(providerOutputEventToStreamChunk)
      .filter((chunk): chunk is StreamChunk => chunk !== null);
    const hasVisibleOutput = await renderAutoTriggeredTurn(tab, {
      chunks,
      metadata: {
        ...(event.nativeAssistantId
          ? { assistantMessageId: event.nativeAssistantId }
          : {}),
      },
    }, isCurrent);
    if (isCurrent()) {
      const reportReviewableSettlement = hasVisibleOutput
        ? tab.captureReviewableSettlement?.()
        : null;
      try {
        await tab.controllers.conversationController.save(true);
      } finally {
        if (isCurrent()) reportReviewableSettlement?.();
      }
    }
    return;
  }
  turns.get(event.scope.turnId)?.push(event as ProviderBackgroundOutputEvent);
}

function enqueueTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
): Promise<void> | undefined {
  const coordinator = tab.executionCoordinator;
  const isCurrent = () => (
    tab.executionCoordinator === coordinator
    && coordinator.isEventContextCurrent(context)
  );
  if (!isCurrent()) {
    discardBackgroundTurnBuffers(tab, context.bindingId);
    return undefined;
  }

  const pending = enqueueTabBackgroundWork(tab, async () => {
    if (!isCurrent()) {
      discardBackgroundTurnBuffers(tab, context.bindingId);
      return;
    }
    await handleTabSessionEvent(tab, plugin, event, context, isCurrent);
  });
  if (!pending) {
    discardBackgroundTurnBuffers(tab, context.bindingId);
  }
  return pending ?? undefined;
}

function getBackgroundTurnBuffers(
  tab: AssembledTabRuntime,
  bindingId: string,
): Map<string, ProviderBackgroundOutputEvent[]> {
  let bindings = backgroundTurnBuffers.get(tab);
  if (!bindings) {
    bindings = new Map();
    backgroundTurnBuffers.set(tab, bindings);
  }
  let turns = bindings.get(bindingId);
  if (!turns) {
    turns = new Map();
    bindings.set(bindingId, turns);
  }
  return turns;
}

function deleteBackgroundTurnBuffersIfEmpty(
  tab: AssembledTabRuntime,
  bindingId: string,
  turns: Map<string, ProviderBackgroundOutputEvent[]>,
): void {
  if (turns.size > 0) return;
  const bindings = backgroundTurnBuffers.get(tab);
  bindings?.delete(bindingId);
  if (bindings?.size === 0) backgroundTurnBuffers.delete(tab);
}

function discardBackgroundTurnBuffers(tab: AssembledTabRuntime, bindingId: string): void {
  const bindings = backgroundTurnBuffers.get(tab);
  bindings?.delete(bindingId);
  if (bindings?.size === 0) backgroundTurnBuffers.delete(tab);
}

function normalizeProviderMode(mode: string): string {
  if (mode === 'bypassPermissions' || mode === 'yolo') return 'yolo';
  if (mode === 'plan') return 'plan';
  return 'normal';
}

/**
 * Builds the DOM structure for a tab.
 */
function buildTabDOM(contentEl: HTMLElement): TabDOMElements {
  const messagesWrapperEl = contentEl.createDiv({ cls: 'claudian-messages-wrapper' });
  const messagesEl = messagesWrapperEl.createDiv({ cls: 'claudian-messages' });
  const welcomeEl = createWelcomeElement(messagesEl);
  const statusPanelContainerEl = contentEl.createDiv({ cls: 'claudian-status-panel-container' });
  const inputComposerEl = contentEl.createDiv({ cls: 'claudian-input-composer' });
  const inputContainerEl = inputComposerEl.createDiv({ cls: 'claudian-input-container' });
  const queueIndicatorEl = inputContainerEl.createDiv({ cls: 'claudian-input-queue-row' });
  const navRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-nav-row' });
  const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });
  const contextRowEl = inputWrapper.createDiv({ cls: 'claudian-context-row' });
  const inputEl = inputWrapper.createEl('textarea', {
    cls: 'claudian-input',
    attr: {
      placeholder: 'Ask to make changes, @mention files, run /commands',
      rows: '3',
      dir: 'auto',
    },
  });

  return {
    contentEl,
    messagesWrapperEl,
    messagesEl,
    welcomeEl,
    statusPanelContainerEl,
    inputComposerEl,
    inputContainerEl,
    queueIndicatorEl,
    inputWrapper,
    inputEl,
    navRowEl,
    contextRowEl,
  };
}

/**
 * Binds and prepares the tab's provider execution session.
 */
export async function initializeTabExecution(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  conversationOverride?: Conversation | null,
): Promise<void>;
export async function initializeTabExecution(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  _legacyArg: unknown,
  conversationOverride?: Conversation | null,
): Promise<void>;
export async function initializeTabExecution(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
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
  if (isClosingLifecycleState(tab.lifecycleState)) {
    return;
  }
  const providerId = getTabProviderId(tab, plugin, conversation);
  await ProviderWorkspaceRegistry.ensureInitialized(plugin.providerHost, providerId, 'tab-execution');
  if (isClosingLifecycleState(tab.lifecycleState)) {
    return;
  }
  refreshTabWorkspaceServices(tab, plugin);
  syncTabProviderServices(tab, tab.services, plugin);
  await tab.executionCoordinator.bindConversation(conversation
    ? {
      conversationId: conversation.id,
      providerId,
      resumeSeed: {
        ...(conversation.sessionId ? { providerSessionId: conversation.sessionId } : {}),
        ...(conversation.providerState ? { providerState: conversation.providerState } : {}),
        ...(conversation.resumeAtMessageId
          ? { resumeCheckpoint: conversation.resumeAtMessageId }
          : {}),
      },
    }
    : null);
  if (conversation) {
    await tab.executionCoordinator.prepare();
  }
  if (isClosingLifecycleState(tab.lifecycleState)) return;

  tab.providerId = providerId;
  if (conversation) {
    tab.draftModel = null;
    tab.lifecycleState = 'warm';
  }
}

function isConversationLike(value: unknown): value is Conversation {
  return !!value
    && typeof value === 'object'
    && typeof (value as Conversation).id === 'string'
    && Array.isArray((value as Conversation).messages);
}

function buildContextManagers(
  shell: TabShellBundle,
  contextTray: ComposerContextTray,
  externalContextSelector: TabUIComponents['externalContextSelector'],
  options: TabRuntimeAssemblyOptions,
  onUserModified: () => void,
): Pick<TabUIComponents, 'fileContextManager' | 'imageContextManager'> {
  const { dom } = shell;
  const { plugin } = options;
  const fileContextManager = new FileContextManager(
    plugin.app,
    dom.contextRowEl,
    dom.inputEl,
    {
      getExcludedTags: () => plugin.settings.excludedTags,
      getExternalContexts: () => externalContextSelector.getExternalContexts(),
      onUserChipsChanged: onUserModified,
    },
    dom.inputContainerEl,
    contextTray,
  );
  options.registerCleanup('tab file context manager', () => fileContextManager.destroy());
  fileContextManager.setMcpManager(getProviderMcpManager(getTabProviderId(shell, plugin)));

  const imageContextManager = new ImageContextManager(
    dom.inputContainerEl,
    dom.inputEl,
    { onUserImagesChanged: onUserModified },
    dom.contextRowEl,
    contextTray,
  );
  options.registerCleanup('tab image context manager', () => imageContextManager.destroy());
  return { fileContextManager, imageContextManager };
}

function buildSlashCommandDropdown(
  shell: TabShellBundle,
  providerId: ProviderId,
  options: TabRuntimeAssemblyOptions,
  getHiddenCommands?: () => Set<string>,
  catalogInfo?: ProviderCatalogInfo,
): SlashCommandDropdown {
  const { dom } = shell;
  const dropdown = new SlashCommandDropdown(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onSelect: () => {},
      onHide: () => {},
    },
    {
      providerId,
      hiddenCommands: getHiddenCommands?.() ?? new Set(),
      providerConfig: catalogInfo?.config,
      providerDiscovery: catalogInfo?.discovery,
    }
  );
  options.registerCleanup('tab slash command dropdown', () => dropdown.destroy());
  return dropdown;
}

function buildInstructionComponents(
  shell: TabShellBundle,
  options: TabRuntimeAssemblyOptions,
  runtimeRef: PublishedTabRuntimeRef,
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
        await runtimeRef.requirePublished().controllers.inputController.handleInstructionSubmit(rawInstruction);
      },
      getInputWrapper: () => dom.inputWrapper,
    }
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
            const output = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
            const status = result.exitCode === 0 ? 'completed' : 'error';
            statusPanel.updateBashOutput(id, { status, output, exitCode: result.exitCode });
          },
          getInputWrapper: () => dom.inputWrapper,
        }
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
  shell: TabShellBundle,
  services: TabServices,
  options: TabRuntimeAssemblyOptions,
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
      runtimeRef.requirePublished().ui.slashCommandDropdown.clearProviderCatalog?.();
    },
    restoreDraft: ({ providerId, model }) => {
      const tab = runtimeRef.requirePublished();
      shell.draftModel = model;
      shell.providerId = providerId;
      syncTabProviderServices(shell, services, plugin);
      syncSlashCommandDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
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
      // For blank tabs, update draft model and derive provider
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

        syncSlashCommandDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
        onUserModified();
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
        // Re-render options (provider may have changed reasoning controls)
        tab.ui.modelSelector.renderOptions();
        tab.ui.modeSelector.renderOptions();
        applyProviderUIGating(tab, plugin);
        return;
      }

      // For bound tabs, reject cross-provider model changes
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
      const normalizedModel = normalizeProviderModelSelection(boundProvider, plugin.settings, model) ?? model;
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

      // Recalculate context usage percentage for the new model's context window
      const currentUsage = tab.state.usage;
      if (currentUsage) {
        const newContextWindow = uiConfig.getContextWindowSize(
          normalizedModel,
          providerSettings.customContextLimits,
          providerSettings,
        );
        tab.state.usage = recalculateUsageForModel(currentUsage, normalizedModel, newContextWindow);
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
      dom.inputWrapper.toggleClass(
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

function buildTabUI(
  shell: TabShellBundle,
  services: TabServices,
  options: TabRuntimeAssemblyOptions,
  runtimeRef: PublishedTabRuntimeRef,
): TabUIComponents {
  const { dom } = shell;
  const { plugin } = options;
  const onUserModified = (): void => commitProvisionalTab(runtimeRef.requirePublished());
  const contextTray = new ComposerContextTray(dom.contextRowEl, {
    onDidChange: () => {
      autoResizeTextarea(dom.inputEl);
      runtimeRef.current()?.renderer.scrollToBottomIfNeeded();
    },
  });
  options.registerCleanup('tab composer context tray', () => contextTray.destroy());

  const toolbar = buildInputToolbar(shell, services, options, runtimeRef, onUserModified);
  const contextManagers = buildContextManagers(
    shell,
    contextTray,
    toolbar.externalContextSelector,
    options,
    onUserModified,
  );
  const catalogInfo = shell.providerCatalogResolver();
  const slashCommandDropdown = buildSlashCommandDropdown(
    shell,
    getTabProviderId(shell, plugin),
    options,
    () => getTabHiddenCommands(shell, plugin),
    catalogInfo,
  );
  const instructionComponents = buildInstructionComponents(shell, options, runtimeRef);
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
    mcpServerSelector: toolbar.mcpServerSelector,
    permissionToggle: toolbar.permissionToggle,
    serviceTierToggle: toolbar.serviceTierToggle,
    slashCommandDropdown,
    ...instructionComponents,
    contextUsageMeter: toolbar.contextUsageMeter,
    navigationSidebar,
  };

  ui.mcpServerSelector.setMcpManager(getProviderMcpManager(getTabProviderId(shell, plugin)));
  ui.mcpServerSelector.setOnChange(onUserModified);
  ui.fileContextManager.setOnMcpMentionChange((servers) => {
    ui.mcpServerSelector.addMentionedServers(servers);
  });
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

export interface ForkContext {
  messages: ChatMessage[];
  providerId?: ProviderId;
  sourceConversationId: string | null;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  sourceSelectedModel?: string;
  resumeAt: string;
  sourceTitle?: string;
  /** 1-based index used for fork title suffix (counts only canonical user messages). */
  forkAtUserMessage?: number;
  currentNote?: string;
}

function deepCloneMessages(messages: ChatMessage[]): ChatMessage[] {
  if (typeof structuredClone === 'function') {
    return structuredClone(messages);
  }
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function isClosingLifecycleState(state: AssembledTabRuntime['lifecycleState']): boolean {
  return state === 'closing';
}

export function commitProvisionalTab(tab: AssembledTabRuntime): void {
  tab.session.claimUserOwnership();
  if (tab.lifecycleState === 'provisional') {
    tab.lifecycleState = 'cold';
  }
}

interface ForkSource {
  providerId?: ProviderId;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  sourceSelectedModel?: string;
  sourceTitle?: string;
  currentNote?: string;
}

/**
 * Resolves session ID and conversation metadata needed for forking.
 * Prefers the live service session ID; falls back to persisted conversation metadata.
 * Shows a notice and returns null when no session can be resolved.
 */
async function resolveForkSource(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  assistantCheckpointId: string,
): Promise<ForkSource | null> {
  const conversation = tab.conversationId
    ? plugin.getConversationSync(tab.conversationId)
    : null;

  const fallback = async (): Promise<string | null> => ProviderRegistry
    .getConversationHistoryService(conversation?.providerId ?? tab.providerId)
    .resolveSessionIdForConversation(conversation);
  const coordinatedSource = tab.executionCoordinator
    ? await tab.executionCoordinator.resolveForkSource(assistantCheckpointId, fallback)
    : null;
  const sourceSessionId = coordinatedSource?.sessionId ?? await fallback();

  if (!sourceSessionId) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoSession') }));
    return null;
  }

  const providerId = getTabProviderId(tab, plugin, conversation);

  return {
    providerId,
    sourceSessionId,
    sourceProviderState: conversation?.providerState,
    sourceSelectedModel: conversation
      ? resolveConversationModel(plugin.settings, providerId, conversation).model
      : getTabSelectedModel(tab, plugin) ?? undefined,
    sourceTitle: conversation?.title,
    currentNote: conversation?.currentNote,
  };
}

async function handleForkRequest(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  userMessageId: string,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean,
): Promise<void> {
  const { state } = tab;
  const sourceConversationId = tab.conversationId;

  if (!getTabCapabilities(tab, plugin).supportsFork) {
    new Notice('Fork is not supported by this provider.');
    return;
  }

  if (state.isStreaming) {
    new Notice(t('chat.fork.unavailableStreaming'));
    return;
  }
  if (state.isRewinding) {
    new Notice(t('chat.rewind.inProgress'));
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

  const source = await resolveForkSource(tab, plugin, rewindCtx.prevAssistantUuid);
  if (
    !source
    || !isRuntimeLive(tab)
    || tab.conversationId !== sourceConversationId
  ) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs.slice(0, userIdx)),
    providerId: source.providerId,
    sourceConversationId,
    sourceSessionId: source.sourceSessionId,
    sourceProviderState: source.sourceProviderState,
    sourceSelectedModel: source.sourceSelectedModel,
    resumeAt: rewindCtx.prevAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: msgs.slice(0, userIdx + 1).filter(isCanonicalUserMessage).length,
    currentNote: source.currentNote,
  });
}

async function handleForkAll(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean,
): Promise<void> {
  const { state } = tab;
  const sourceConversationId = tab.conversationId;

  if (!getTabCapabilities(tab, plugin).supportsFork) {
    new Notice('Fork is not supported by this provider.');
    return;
  }

  if (state.isStreaming) {
    new Notice(t('chat.fork.unavailableStreaming'));
    return;
  }
  if (state.isRewinding) {
    new Notice(t('chat.rewind.inProgress'));
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

  const source = await resolveForkSource(tab, plugin, lastAssistantUuid);
  if (
    !source
    || !isRuntimeLive(tab)
    || tab.conversationId !== sourceConversationId
  ) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs),
    providerId: source.providerId,
    sourceConversationId,
    sourceSessionId: source.sourceSessionId,
    sourceProviderState: source.sourceProviderState,
    sourceSelectedModel: source.sourceSelectedModel,
    resumeAt: lastAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: msgs.filter(isCanonicalUserMessage).length + 1,
    currentNote: source.currentNote,
  });
}

function buildTabControllers(
  shell: TabShellBundle,
  services: TabServices,
  ui: TabUIComponents,
  options: TabRuntimeAssemblyOptions,
  runtimeRef: PublishedTabRuntimeRef,
): TabControllerBundle {
  const { component, forkRequestCallback, isRuntimeLive, openConversation, plugin } = options;
  const viewHost = component as Partial<TabManagerViewHost>;
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
  );
  options.registerCleanup('tab editor selection controller', () => selectionController.stop());

  const browserSelectionController = new BrowserSelectionController(
    plugin.app,
    ui.contextTray,
    dom.inputEl,
    undefined,
    () => commitProvisionalTab(runtimeRef.requirePublished()),
  );
  options.registerCleanup('tab browser selection controller', () => browserSelectionController.stop());

  const canvasSelectionController = new CanvasSelectionController(
    plugin.app,
    ui.contextTray,
    dom.inputEl,
    undefined,
    () => commitProvisionalTab(runtimeRef.requirePublished()),
  );
  options.registerCleanup('tab canvas selection controller', () => canvasSelectionController.stop());

  const streamController = new StreamController({
    plugin,
    state,
    renderer,
    subagentManager: services.subagentManager,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    updateQueueIndicator: () => runtimeRef.requirePublished().controllers.inputController.updateQueueIndicator(),
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
      getHistoryDropdown: () => null, // Tab doesn't have its own history dropdown
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: (el) => { dom.welcomeEl = el; },
      getMessagesEl: () => dom.messagesEl,
      getInputEl: () => dom.inputEl,
      restoreMessageToComposer: message => (
        runtimeRef.requirePublished().controllers.inputController.restoreRewoundMessageToComposer(message)
      ),
      getFileContextManager: () => ui.fileContextManager,
      getImageContextManager: () => ui.imageContextManager,
      getMcpServerSelector: () => ui.mcpServerSelector,
      getExternalContextSelector: () => ui.externalContextSelector,
      clearQueuedMessage: () => runtimeRef.requirePublished().controllers.inputController.clearQueuedMessage(),
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
        syncSlashCommandDropdownForProvider(
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
        tab.lifecycleState = 'cold';
        tab.draftModel = nextModel?.model ?? null;
        tab.conversationId = null;
        tab.providerId = nextModel?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
        if (tab.providerId !== previousProviderId) {
          syncTabProviderServices(tab, services, plugin);
        }
        refreshTabProviderUI(tab, plugin);
        applyProviderUIGating(tab, plugin);
        syncSlashCommandDropdownForProvider(tab, plugin, shell.providerCatalogResolver);
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
    }
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
    getImageContextManager: () => ui.imageContextManager,
    getMcpServerSelector: () => ui.mcpServerSelector,
    getExternalContextSelector: () => ui.externalContextSelector,
    getInstructionModeManager: () => ui.instructionModeManager,
    getInstructionRefineService: () => services.instructionRefineService,
    getTitleGenerationService: () => services.titleGenerationService,
    getStatusPanel: () => ui.statusPanel,
    generateId: generateMessageId,
    resetInputHeight: () => {
      autoResizeTextarea(dom.inputEl);
    },
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
    restorePrePlanPermissionModeIfNeeded: async () => {
      const tab = runtimeRef.requirePublished();
      if (getTabPermissionMode(tab, plugin) === 'plan') {
        const restoreMode = tab.state.prePlanPermissionMode ?? 'normal';
        try {
          await updatePlanModeUI(tab, plugin, restoreMode);
        } finally {
          if (getTabPermissionMode(tab, plugin) !== 'plan') {
            tab.state.prePlanPermissionMode = null;
          }
        }
      }
    },
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
      if (ui.slashCommandDropdown.isVisible()) return true;
      if (ui.fileContextManager.isMentionDropdownVisible()) return true;
      return false;
    },
  });
  options.registerCleanup('tab navigation controller', () => navigationController.dispose());
  navigationController.initialize();

  const controllers: TabControllers = {
    selectionController,
    browserSelectionController,
    canvasSelectionController,
    conversationController,
    streamController,
    inputController,
    navigationController,
  };
  return { controllers, renderer };
}

function buildTabInputBindings(
  shell: TabShellBundle,
  ui: TabUIComponents,
  controllers: TabControllers,
  options: TabRuntimeAssemblyOptions,
  runtimeRef: PublishedTabRuntimeRef,
): TabInputBindings {
  const { dom, state } = shell;
  const { plugin } = options;

  let wasBangBashActive = ui.bangBashModeManager?.isActive() ?? false;
  const syncBangBashSuppression = (): void => {
    const isActive = ui.bangBashModeManager?.isActive() ?? false;
    if (isActive === wasBangBashActive) return;
    wasBangBashActive = isActive;

    ui.slashCommandDropdown.setEnabled(!isActive);
    if (isActive) {
      ui.fileContextManager.hideMentionDropdown();
    }
  };

  const keydownHandler = (e: KeyboardEvent) => {
    const tab = runtimeRef.requirePublished();
    if (ui.bangBashModeManager?.isActive()) {
      ui.bangBashModeManager.handleKeydown(e);
      syncBangBashSuppression();
      return;
    }

    if (getTabCapabilities(tab, plugin).supportsInstructionMode && ui.instructionModeManager.handleTriggerKey(e)) {
      return;
    }

    if (ui.bangBashModeManager?.handleTriggerKey(e)) {
      syncBangBashSuppression();
      return;
    }

    if (getTabCapabilities(tab, plugin).supportsInstructionMode && ui.instructionModeManager.handleKeydown(e)) {
      return;
    }

    if (sendTabInputMessageFromExplicitEnterShortcut(tab, e)) {
      return;
    }

    if (controllers.inputController.handleResumeKeydown(e)) {
      return;
    }

    if (ui.slashCommandDropdown.handleKeydown(e)) {
      return;
    }

    if (ui.fileContextManager.handleMentionKeydown(e)) {
      return;
    }

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Escape' && !e.isComposing && state.isStreaming) {
      e.preventDefault();
      controllers.inputController.cancelStreaming();
      return;
    }

    if (sendTabInputMessageFromEnterKey(tab, plugin.settings, e)) {
      return;
    }
  };
  dom.inputEl.addEventListener('keydown', keydownHandler);
  options.registerCleanup(
    'tab input keydown binding',
    () => dom.inputEl.removeEventListener('keydown', keydownHandler),
  );

  const inputHandler = () => {
    commitProvisionalTab(runtimeRef.requirePublished());
    if (!ui.bangBashModeManager?.isActive()) {
      ui.fileContextManager.handleInputChange();
    }
    ui.instructionModeManager.handleInputChange();
    ui.bangBashModeManager?.handleInputChange();
    syncBangBashSuppression();
    autoResizeTextarea(dom.inputEl);
  };
  dom.inputEl.addEventListener('input', inputHandler);
  options.registerCleanup(
    'tab input change binding',
    () => dom.inputEl.removeEventListener('input', inputHandler),
  );

  // Scroll listener for auto-scroll control (tracks position always, not just during streaming)
  const SCROLL_THRESHOLD = 20; // pixels from bottom to consider "at bottom"
  const RE_ENABLE_DELAY = 150; // ms to wait before re-enabling auto-scroll
  let reEnableTimeout: number | null = null;

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      if (reEnableTimeout) {
        window.clearTimeout(reEnableTimeout);
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
        window.clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
    } else if (!state.autoScrollEnabled) {
      // Debounce re-enabling to avoid bounce during scroll animation
      if (!reEnableTimeout) {
        reEnableTimeout = window.setTimeout(() => {
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
  options.registerCleanup('tab message scroll binding', () => {
    dom.messagesEl.removeEventListener('scroll', scrollHandler);
    if (reEnableTimeout) window.clearTimeout(reEnableTimeout);
  });
  return { installed: true };
}

/**
 * Activates a tab (shows it and starts services).
 */
export function activateTab(tab: AssembledTabRuntime): void {
  tab.dom.contentEl.removeClass('claudian-hidden');
  tab.controllers.streamController.setTabActive(true);
  tab.controllers.selectionController.start();
  tab.controllers.browserSelectionController.start();
  tab.controllers.canvasSelectionController.start();
  // Refresh navigation sidebar visibility (dimensions now available after display)
  tab.ui.navigationSidebar.updateVisibility();
}

/**
 * Deactivates a tab (hides it and stops services).
 */
export function deactivateTab(tab: AssembledTabRuntime): void {
  tab.controllers.streamController.setTabActive(false);
  tab.dom.contentEl.addClass('claudian-hidden');
  tab.controllers.selectionController.stop();
  tab.controllers.browserSelectionController.stop();
  tab.controllers.canvasSelectionController.stop();
}

export class TabRuntimeTeardownError extends Error {
  readonly cleanupFailures: readonly TabRuntimeCleanupFailure[];

  constructor(cleanupFailures: readonly TabRuntimeCleanupFailure[]) {
    const resources = cleanupFailures.map(failure => failure.resource).join(', ');
    super(`Tab runtime teardown failed for: ${resources}`, {
      cause: cleanupFailures[0]?.error,
    });
    this.name = 'TabRuntimeTeardownError';
    this.cleanupFailures = cleanupFailures;
  }
}

export interface TabShutdownDrainResult {
  readonly cancelledActiveTurn: boolean;
  readonly cleanupFailures: readonly TabRuntimeCleanupFailure[];
}

async function captureTeardownFailure(
  failures: TabRuntimeCleanupFailure[],
  resource: string,
  cleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push({ error, resource });
  }
}

/**
 * Stops new tab background work, cancels the active turn, and waits until
 * conversation-binding work is stable enough for the final view snapshot.
 */
export async function drainTabForShutdownSnapshot(
  tab: AssembledTabRuntime,
): Promise<TabShutdownDrainResult> {
  const existingDrain = tabShutdownDrainPromises.get(tab);
  if (existingDrain) return existingDrain;

  const drain = drainTabForShutdownSnapshotOnce(tab);
  tabShutdownDrainPromises.set(tab, drain);
  return drain;
}

async function drainTabForShutdownSnapshotOnce(
  tab: AssembledTabRuntime,
): Promise<TabShutdownDrainResult> {
  tab.session.pauseIntentAdmission();
  tab.session.pauseBackgroundWork();
  const cleanupFailures: TabRuntimeCleanupFailure[] = [];

  await captureTeardownFailure(
    cleanupFailures,
    'tab pending provider interaction',
    () => tab.controllers.inputController.dismissPendingApproval(),
  );
  const activeTurn = tab.session.activeTurn;
  const cancelledActiveTurn = activeTurn !== null;
  if (activeTurn) {
    tab.state.cancelRequested = true;
    tab.state.bumpStreamGeneration();
    await captureTeardownFailure(
      cleanupFailures,
      'tab active execution cancellation',
      () => tab.executionCoordinator.cancel(),
    );
    await activeTurn.catch(() => undefined);
  }
  await captureTeardownFailure(
    cleanupFailures,
    'tab background work',
    () => tab.session.awaitBackgroundWork(),
  );

  return { cancelledActiveTurn, cleanupFailures };
}

/**
 * Cleans up a tab and releases all resources.
 * Made async to ensure proper cleanup ordering.
 */
export async function destroyTab(tab: AssembledTabRuntime): Promise<void> {
  const existingDestruction = tabDestructionPromises.get(tab);
  if (existingDestruction) {
    await existingDestruction;
    return;
  }

  const destruction = destroyTabOnce(tab);
  tabDestructionPromises.set(tab, destruction);
  await destruction;
}

async function destroyTabOnce(tab: AssembledTabRuntime): Promise<void> {
  tab.lifecycleState = 'closing';
  const drainResult = await drainTabForShutdownSnapshot(tab);
  const cleanupFailures = [...drainResult.cleanupFailures];
  const { cancelledActiveTurn } = drainResult;

  await captureTeardownFailure(cleanupFailures, 'tab subagent activity', () => {
    tab.services.subagentManager.orphanAllActive();
  });
  if (tab.state.currentConversationId) {
    try {
      await tab.controllers.conversationController.save(cancelledActiveTurn);
    } catch {
      new Notice('Background task state could not be saved before closing the tab.');
    }
  }
  await captureTeardownFailure(
    cleanupFailures,
    'tab resume dropdown',
    () => tab.controllers.inputController.destroyResumeDropdown(),
  );
  const resourceOwner = tabRuntimeResourceOwners.get(tab);
  if (resourceOwner) {
    cleanupFailures.push(...await resourceOwner.dispose());
  } else {
    cleanupFailures.push({
      error: new Error('Assembled tab runtime has no registered resource owner'),
      resource: 'tab runtime resource owner',
    });
  }

  if (cleanupFailures.length > 0) {
    throw new TabRuntimeTeardownError(cleanupFailures);
  }
}

/**
 * Gets the display title for a tab.
 * Uses synchronous access since we only need the title, not messages.
 */
export function getTabTitle(tab: AssembledTabRuntime, plugin: FeatureHost): string {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.title) {
      return conversation.title;
    }
  }
  return 'New Chat';
}

function canAcceptTabBackgroundWork(tab: AssembledTabRuntime): boolean {
  return tab.lifecycleState !== 'closing'
    && !tab.state.isCreatingConversation
    && !tab.state.isSwitchingConversation;
}

function enqueueTabBackgroundWork(
  tab: AssembledTabRuntime,
  work: () => Promise<void>,
): Promise<void> | null {
  if (!canAcceptTabBackgroundWork(tab)) return null;
  return tab.session.enqueueBackgroundWork(work);
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Renders an auto-triggered turn (e.g., agent response to task-notification)
 * that arrives after the main handler has completed.
 */
function isVisibleAutoTurnChunk(chunk: StreamChunk, hiddenToolIds: Set<string>): boolean {
  switch (chunk.type) {
    case 'text':
      return chunk.content.trim().length > 0;
    case 'thinking':
    case 'citations':
    case 'notice':
    case 'error':
    case 'tool_output':
    case 'context_compacted':
    case 'subagent_tool_use':
    case 'subagent_tool_result':
      return true;
    case 'tool_use':
      return chunk.name !== TOOL_AGENT_OUTPUT;
    case 'tool_result':
      return !hiddenToolIds.has(chunk.id);
    default:
      return false;
  }
}

function hasVisibleAutoTurnMessageContent(msg: ChatMessage): boolean {
  if (msg.content.trim().length > 0) return true;
  if (msg.toolCalls && msg.toolCalls.length > 0) return true;
  return msg.contentBlocks?.some(block =>
    block.type !== 'text' || block.content.trim().length > 0
  ) ?? false;
}

async function renderAutoTriggeredTurn(
  tab: AssembledTabRuntime,
  result: BackgroundTurnRenderResult,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent() || !tab.dom.contentEl.isConnected) {
    return false;
  }

  const { chunks, metadata } = result;
  if (chunks.length === 0) return false;

  const hiddenToolIds = new Set(
    chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool_use' }> =>
        chunk.type === 'tool_use' && chunk.name === TOOL_AGENT_OUTPUT
      )
      .map(chunk => chunk.id)
  );
  const hasVisibleContent = chunks.some(chunk => isVisibleAutoTurnChunk(chunk, hiddenToolIds));

  const assistantMsg: ChatMessage = {
    id: metadata.assistantMessageId ?? generateMessageId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [],
    contentBlocks: [],
    ...(metadata.assistantMessageId && { assistantMessageId: metadata.assistantMessageId }),
  };

  const previousContentEl = tab.state.currentContentEl;
  const previousTextEl = tab.state.currentTextEl;
  const previousTextContent = tab.state.currentTextContent;
  const previousThinkingState = tab.state.currentThinkingState;

  if (hasVisibleContent) {
    tab.state.addMessage(assistantMsg);
    const msgEl = tab.renderer.addMessage(assistantMsg);
    const contentEl = msgEl?.querySelector<HTMLElement>('.claudian-message-content');
    if (contentEl) {
      if (!previousContentEl) {
        tab.state.toolCallElements.clear();
      }
      tab.state.currentContentEl = contentEl;
      tab.state.currentTextEl = null;
      tab.state.currentTextContent = '';
      tab.state.currentThinkingState = null;
    }
  }

  try {
    for (const chunk of chunks) {
      if (!isCurrent()) return false;
      await tab.controllers.streamController.handleStreamChunk(chunk, assistantMsg);
      if (!isCurrent()) return false;
    }

    if (
      isCurrent()
      && hasVisibleContent
      && !hasVisibleAutoTurnMessageContent(assistantMsg)
    ) {
      const placeholder = '(background task completed)';
      assistantMsg.content = placeholder;
      await tab.controllers.streamController.appendText(placeholder);
    }

    if (isCurrent() && hasVisibleContent) {
      await tab.controllers.streamController.finalizeCurrentThinkingBlock(assistantMsg);
      if (!isCurrent()) return false;
      await tab.controllers.streamController.finalizeCurrentTextBlock(assistantMsg);
      if (!isCurrent()) return false;
    }
  } finally {
    if (hasVisibleContent) {
      tab.controllers.streamController.hideThinkingIndicator();
      tab.services.subagentManager.resetStreamingState();
      tab.state.currentContentEl = previousContentEl;
      tab.state.currentTextEl = previousTextEl;
      tab.state.currentTextContent = previousTextContent;
      tab.state.currentThinkingState = previousThinkingState;
      tab.renderer.scrollToBottom();
    }
  }
  return hasVisibleContent;
}

export async function updatePlanModeUI(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  mode: string,
  options: { syncExecution?: boolean } = {},
): Promise<void> {
  const providerId = getTabProviderId(tab, plugin);
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const previousMode = getTabPermissionMode(tab, plugin);
  try {
    await plugin.mutateSettings((settings) => {
      const snapshot = getWritableTabSettingsSnapshot(tab, plugin, settings);
      if (uiConfig.applyPermissionMode) {
        uiConfig.applyPermissionMode(mode, snapshot);
      } else {
        snapshot.permissionMode = mode;
      }
      ProviderSettingsCoordinator.commitProviderSettingsSnapshot(
        settings,
        providerId,
        snapshot,
      );
    });
    if (options.syncExecution && tab.conversationId !== null) {
      try {
        await tab.executionCoordinator.setMode(getTabPermissionMode(tab, plugin));
      } catch (error) {
        await plugin.mutateSettings((settings) => {
          const snapshot = getWritableTabSettingsSnapshot(tab, plugin, settings);
          if (uiConfig.applyPermissionMode) {
            uiConfig.applyPermissionMode(previousMode, snapshot);
          } else {
            snapshot.permissionMode = previousMode;
          }
          ProviderSettingsCoordinator.commitProviderSettingsSnapshot(
            settings,
            providerId,
            snapshot,
          );
        });
        throw error;
      }
    }
  } finally {
    const activeMode = getTabPermissionMode(tab, plugin);
    tab.ui.permissionToggle.updateDisplay();
    tab.dom.inputWrapper.toggleClass(
      'claudian-input-plan-mode',
      activeMode === 'plan' && getTabCapabilities(tab, plugin).supportsPlanMode,
    );
  }
}
