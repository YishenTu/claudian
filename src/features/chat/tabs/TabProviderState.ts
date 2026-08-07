import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import { normalizeProviderCommandDiscoveryItems } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '../../../core/providers/commands/ProviderCommandDiscoveryStore';
import {
  findProviderModelOption,
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
  resolveConversationModel,
} from '../../../core/providers/conversationModel';
import { getEnabledProviderForModel } from '../../../core/providers/modelRouting';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCapabilities,
  ProviderChatUIConfig,
  ProviderId,
  ProviderUIOption,
} from '../../../core/providers/types';
import type { ClaudianSettings, Conversation } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';
import { toggleServiceTier } from '../actions/toggleServiceTier';
import { getTabProviderId } from './providerResolution';
import { isClosingLifecycleState } from './TabLifecycle';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  ProviderCatalogResolver,
  TabProviderContext,
  TabServices,
} from './types';

export type TabProviderSettings = Record<string, unknown> & {
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  serviceTier: string;
  permissionMode: string;
  customContextLimits?: Record<string, number>;
};

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

export function getTabCapabilities(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): ProviderCapabilities {
  const providerId = getTabProviderId(tab, plugin, conversation);
  return ProviderRegistry.getCapabilities(providerId);
}

export function getTabChatUIConfig(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): ProviderChatUIConfig {
  return ProviderRegistry.getChatUIConfig(getTabProviderId(tab, plugin, conversation));
}

export function getTabSettingsSnapshot(
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

export function getWritableTabSettingsSnapshot(
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

export function getTabConversation(
  tab: TabProviderContext,
  plugin: FeatureHost,
): Conversation | null {
  return tab.conversationId ? plugin.getConversationSync(tab.conversationId) : null;
}

export function getTabSelectedModel(
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

export function getTabPermissionMode(
  tab: TabProviderContext,
  plugin: FeatureHost,
): string {
  const permissionMode = getTabSettingsSnapshot(tab, plugin).permissionMode;
  return typeof permissionMode === 'string' && permissionMode
    ? permissionMode
    : 'normal';
}

export function getTabHiddenCommands(
  tab: TabProviderContext,
  plugin: FeatureHost,
  conversation?: Conversation | null,
): Set<string> {
  return getHiddenProviderCommandSet(
    plugin.settings,
    getTabProviderId(tab, plugin, conversation),
  );
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

export function getProviderMcpManager(providerId: ProviderId) {
  return ProviderWorkspaceRegistry.getMcpServerManager(providerId);
}

export function syncSlashCommandDropdownForProvider(
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

export function invalidateTabProviderCommands(
  tab: AssembledTabRuntime,
  getProviderCatalogConfig?: ProviderCatalogResolver,
): void {
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.() ?? null;
  catalogInfo?.discovery.invalidate();
}

export async function updateTabProviderSettings(
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

export async function updateTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  serviceTier: string,
): Promise<void> {
  await updateTabProviderSettings(tab, plugin, (settings) => {
    settings.serviceTier = serviceTier;
  });
  tab.ui.serviceTierToggle.updateDisplay();
}

export async function toggleTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
): Promise<boolean> {
  return await toggleServiceTier({
    getUIConfig: () => getTabChatUIConfig(tab, plugin),
    getSettings: () => getTabSettingsSnapshot(tab, plugin),
    onServiceTierChange: serviceTier => updateTabServiceTier(tab, plugin, serviceTier),
  });
}

export function refreshTabProviderUI(tab: AssembledTabRuntime, plugin: FeatureHost): void {
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

export function applyProviderUIGating(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
): void {
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

export function refreshTabWorkspaceServices(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
): void {
  const providerId = getTabProviderId(tab, plugin);
  tab.ui.mcpServerSelector.setMcpManager(getProviderMcpManager(providerId));
  syncSlashCommandDropdownForProvider(tab, plugin);
  applyProviderUIGating(tab, plugin);
}

export function syncTabProviderServices(
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
    ProviderRegistry.getTaskResultInterpreter(tab.providerId),
  );
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

export function onProviderAvailabilityChanged(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
): boolean {
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

export function createConversationExecutionBinding(conversation: Conversation) {
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
    ? createConversationExecutionBinding(conversation)
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

export async function restorePrePlanMode(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
): Promise<void> {
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
