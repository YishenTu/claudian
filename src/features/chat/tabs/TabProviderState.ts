import { createCatalogCommandDiscoveryStore } from '../../../core/providers/commands/catalogCommandDiscovery';
import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import {
  findProviderModelOption,
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
  resolveConversationModel,
  resolveProviderDefaultModel,
} from '../../../core/providers/conversationModel';
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
import { t } from '../../../i18n/i18n';
import { toggleServiceTier } from '../actions/toggleServiceTier';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import { type ChatSettings, getChatSettingsSnapshot } from '../ChatSettings';
import { projectContextUsageDisplay } from '../utils/usageInfo';
import { getTabProviderId, requireTabProviderId } from './providerResolution';
import { isClosingLifecycleState } from './TabLifecycle';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  ProviderCatalogResolver,
  TabProviderContext,
  TabServices,
} from './types';
import { UNRESOLVED_TAB_CAPABILITIES, UNRESOLVED_TAB_UI } from './UnresolvedTabUI';

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
  plugin: ChatFeatureHost,
  conversation?: Conversation | null,
): ProviderCapabilities {
  const providerId = getTabProviderId(tab, plugin, conversation);
  return providerId ? ProviderRegistry.getCapabilities(providerId) : UNRESOLVED_TAB_CAPABILITIES;
}

export function getTabChatUIConfig(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  conversation?: Conversation | null,
): ProviderChatUIConfig {
  const providerId = getTabProviderId(tab, plugin, conversation);
  return providerId ? ProviderRegistry.getChatUIConfig(providerId) : UNRESOLVED_TAB_UI;
}

export function getTabSettingsSnapshot(
  tab: TabProviderContext & Pick<AssembledTabRuntime, 'session'>,
  plugin: ChatFeatureHost,
): TabProviderSettings & ChatSettings {
  const settings = plugin.getCommittedSettings();
  const providerId = getTabProviderId(tab, plugin);
  if (!providerId) return { ...settings, model: tab.draftModel ?? '', reasoning: null };
  const snapshot = {
    ...getChatSettingsSnapshot(settings, providerId, getTabSelectedModel(tab, plugin, settings)),
  };
  if (snapshot.reasoning !== null) {
    const key = `${providerId}:${snapshot.model}`;
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const selected = tab.session.reasoningSelections.get(key) ?? snapshot.reasoning;
    const reasoning = uiConfig.getReasoningOptions(snapshot.model, snapshot)
      .some(option => option.value === selected)
      ? selected
      : uiConfig.getDefaultReasoningValue(snapshot.model, snapshot);
    tab.session.reasoningSelections.set(key, reasoning);
    snapshot.reasoning = reasoning;
    if (uiConfig.isAdaptiveReasoningModel(snapshot.model, snapshot)) {
      snapshot.effortLevel = reasoning;
    } else {
      snapshot.thinkingBudget = reasoning;
    }
  }
  return snapshot;
}

export async function updateTabReasoning(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  reasoning: string,
): Promise<void> {
  const providerId = requireTabProviderId(tab, plugin);
  const model = getTabSettingsSnapshot(tab, plugin).model;
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  await plugin.mutateSettings((settings) => {
    const snapshot = getProviderSettingsSnapshotWithModel(settings, providerId, model);
    if (uiConfig.isAdaptiveReasoningModel(model, snapshot)) {
      snapshot.effortLevel = reasoning;
    } else {
      snapshot.thinkingBudget = reasoning;
    }
    uiConfig.applyReasoningSelection?.(model, reasoning, snapshot);
    ProviderSettingsCoordinator.commitProviderSettingsSnapshot(settings, providerId, snapshot);
  });
  tab.session.reasoningSelections.set(`${providerId}:${model}`, reasoning);
}

export function getWritableTabSettingsSnapshot(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  settings: ClaudianSettings = plugin.settings,
): TabProviderSettings {
  return getProviderSettingsSnapshotWithModel(
    settings,
    requireTabProviderId(tab, plugin),
    getTabSelectedModel(tab, plugin),
  );
}

export function getTabConversation(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
): Conversation | null {
  return tab.conversationId ? plugin.getConversationSync(tab.conversationId) : null;
}

export function getTabSelectedModel(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  settings: Readonly<ClaudianSettings> = plugin.settings,
): string | null {
  const providerId = getTabProviderId(tab, plugin);
  if (!providerId) return tab.draftModel;
  if (tab.conversationId === null) {
    return normalizeProviderModelSelection(providerId, settings, tab.draftModel)
      ?? tab.draftModel
      ?? null;
  }

  const conversation = getTabConversation(tab, plugin);
  if (conversation) {
    return resolveConversationModel(settings, providerId, conversation).model;
  }

  return null;
}

export function getTabHiddenCommands(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  conversation?: Conversation | null,
): Set<string> {
  const providerId = getTabProviderId(tab, plugin, conversation);
  return providerId ? getHiddenProviderCommandSet(plugin.settings, providerId) : new Set();
}

function getRegistryProviderCatalogInfo(providerId: ProviderId): ProviderCatalogInfo {
  const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
  if (!catalog) {
    return null;
  }

  return {
    config: catalog.getDropdownConfig(),
    discovery: createCatalogCommandDiscoveryStore(catalog),
  };
}

export function syncComposerDropdownForProvider(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  getProviderCatalogConfig?: ProviderCatalogResolver,
  conversation?: Conversation | null,
): void {
  const dropdown = tab.ui.composerDropdown;
  if (!dropdown) {
    return;
  }

  const providerId = getTabProviderId(tab, plugin, conversation);
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.()
    ?? (providerId ? getRegistryProviderCatalogInfo(providerId) : null);

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
  plugin: ChatFeatureHost,
  update: (settings: TabProviderSettings) => void,
): Promise<TabProviderSettings> {
  const providerId = requireTabProviderId(tab, plugin);
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
  plugin: ChatFeatureHost,
  serviceTier: string,
): Promise<void> {
  await updateTabProviderSettings(tab, plugin, (settings) => {
    settings.serviceTier = serviceTier;
  });
  tab.ui.serviceTierToggle.updateDisplay();
}

export async function toggleTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): Promise<boolean> {
  return await toggleServiceTier({
    getUIConfig: () => getTabChatUIConfig(tab, plugin),
    getSettings: () => getTabSettingsSnapshot(tab, plugin),
    onServiceTierChange: serviceTier => updateTabServiceTier(tab, plugin, serviceTier),
  });
}

export function refreshTabProviderUI(tab: AssembledTabRuntime): void {
  tab.ui.modelSelector.updateDisplay();
  tab.ui.modelSelector.renderOptions();
  tab.ui.modeSelector.updateDisplay();
  tab.ui.modeSelector.renderOptions();
  tab.ui.thinkingBudgetSelector.updateDisplay();
  tab.ui.permissionToggle.updateDisplay();
  tab.ui.serviceTierToggle.updateDisplay();
}

export function applyProviderUIGating(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): void {
  const capabilities = getTabCapabilities(tab, plugin);
  const uiConfig = getTabChatUIConfig(tab, plugin);
  const hasPermissionToggle = Boolean(uiConfig.getPermissionModeToggle?.());

  tab.ui.permissionToggle.setVisible(hasPermissionToggle);

  tab.ui.imageContextManager.setEnabled(capabilities.supportsImageAttachments);
  refreshTabContextUsage(tab, plugin);
}

/** Renders the tab's raw usage through the shared reported-window/custom-limit projection. */
export function refreshTabContextUsage(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): void {
  const settings = getTabSettingsSnapshot(tab, plugin);
  tab.ui.contextUsageMeter.update(projectContextUsageDisplay(tab.state.usage, {
    providerId: getTabProviderId(tab, plugin),
    model: settings.model,
    customContextLimits: settings.customContextLimits,
    normalizeCustomContextLimitModel: getTabChatUIConfig(tab, plugin).normalizeCustomContextLimitModel,
  }));
}

export function refreshTabWorkspaceServices(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): void {
  syncComposerDropdownForProvider(tab, plugin);
  applyProviderUIGating(tab, plugin);
}

export function syncTabProviderServices(
  tab: TabProviderContext,
  services: TabServices,
): void {
  if (!tab.providerId) return;
  services.subagentManager.setTaskResultInterpreter(
    ProviderRegistry.getTaskResultInterpreter(tab.providerId),
  );
}

function resolveBlankTabFallback(
  settings: Record<string, unknown>,
  enabledProviderIds: ProviderId[],
  preferredProviderId: ProviderId | null,
): { model: string; providerId: ProviderId } | null {
  const providerIds = [
    ...(preferredProviderId && enabledProviderIds.includes(preferredProviderId) ? [preferredProviderId] : []),
    ...ProviderRegistry.getBlankTabProviderIds(settings)
      .filter(providerId => providerId !== preferredProviderId),
  ];

  for (const providerId of providerIds) {
    const model = resolveProviderDefaultModel(providerId, settings);
    if (model) return { model, providerId };
  }

  return null;
}

export function reconcileBlankTabIdentity(tab: TabProviderContext, plugin: ChatFeatureHost): boolean {
  if (tab.conversationId !== null) return false;

  const settingsSnapshot = plugin.settings as unknown as Record<string, unknown>;
  const enabledProviderIds = ProviderRegistry.getEnabledProviderIds(settingsSnapshot);
  const previousDraftModel = tab.draftModel;
  const previousProviderId = tab.providerId;
  let nextProviderId = tab.providerId;

  if (tab.draftModel) {
    const availableDraftModel = tab.providerId && enabledProviderIds.includes(tab.providerId)
      ? findProviderModelOption(tab.providerId, tab.draftModel, settingsSnapshot)
      : null;
    if (availableDraftModel) tab.draftModel = availableDraftModel;
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

  return tab.draftModel !== previousDraftModel || tab.providerId !== previousProviderId;
}

export function onProviderAvailabilityChanged(tab: AssembledTabRuntime, plugin: ChatFeatureHost): boolean {
  if (tab.conversationId !== null) return false;
  const changed = reconcileBlankTabIdentity(tab, plugin);
  syncTabProviderServices(tab, tab.services);
  syncComposerDropdownForProvider(tab, plugin);
  invalidateTabProviderCommands(tab);
  refreshTabProviderUI(tab);
  applyProviderUIGating(tab, plugin);
  return changed;
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
  plugin: ChatFeatureHost,
  conversationOverride?: Conversation | null,
): Promise<void>;
export async function initializeTabExecution(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  _legacyArg: unknown,
  conversationOverride?: Conversation | null,
): Promise<void>;
export async function initializeTabExecution(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
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
  if (!providerId) throw new Error(t('chat.selectAvailableModel'));
  await ProviderWorkspaceRegistry.ensureInitialized(plugin.providerHost, providerId, 'tab-execution');
  if (isClosingLifecycleState(tab.lifecycleState)) {
    return;
  }
  refreshTabWorkspaceServices(tab, plugin);
  syncTabProviderServices(tab, tab.services);
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

export async function updateTabPermissionMode(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  mode: string,
): Promise<void> {
  const uiConfig = getTabChatUIConfig(tab, plugin);
  try {
    await updateTabProviderSettings(tab, plugin, (settings) => {
      if (uiConfig.applyPermissionMode) {
        uiConfig.applyPermissionMode(mode, settings);
      } else {
        settings.permissionMode = mode;
      }
    });
  } finally {
    tab.ui.permissionToggle.updateDisplay();
  }
}
