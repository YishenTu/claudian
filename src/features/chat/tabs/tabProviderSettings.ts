import {
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
  resolveConversationModel,
} from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities, ProviderChatUIConfig, ProviderUIOption } from '@/core/providers/types';
import type { ClaudianSettings, Conversation, ConversationSummary } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { type ChatSettings, getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { getTabProviderId, requireTabProviderId } from '@/features/chat/tabs/providerResolution';
import type { AssembledTabRuntime, TabProviderContext } from '@/features/chat/tabs/types';

/** Presentation only: an unresolved tab owns no provider or execution capabilities. */
const UNRESOLVED_TAB_CAPABILITIES: ProviderCapabilities = {
  providerId: '',
  supportsNativeHistory: false,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: false,
  reasoningControl: 'none',
};

const UNRESOLVED_TAB_UI: ProviderChatUIConfig = {
  getModelOptions: () => [],
  ownsModel: () => false,
  supportsReasoningEffort: () => false,
  getReasoningOptions: () => [],
  getDefaultReasoningValue: () => 'off',
  isDefaultModel: () => false,
  applyModelDefaults: () => {},
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
};

export type TabSettingsSnapshot = Record<string, unknown> & {
  model: string;
  effortLevel: string;
  serviceTier: string;
  permissionMode: string;
  customContextLimits?: Record<string, number>;
};

export function getBlankTabModelOptions(
  settings: Record<string, unknown>,
): ProviderUIOption[] {
  return ProviderRegistry.getBlankTabProviderIds(settings).flatMap((providerId) => {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerIcon = uiConfig.getProviderIcon?.() ?? undefined;
    const group = ProviderRegistry.getProviderDisplayName(providerId);

    return uiConfig.getModelOptions(settings)
      .map(model => ({ ...model, group, providerIcon, providerId }));
  });
}

export function getTabCapabilities(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  conversation?: Conversation | null,
): ProviderCapabilities {
  const providerId = getTabProviderId(tab, plugin, conversation);
  if (!providerId) return UNRESOLVED_TAB_CAPABILITIES;
  if (conversation === undefined && tab.conversationId) {
    const summary = plugin.getConversationSummary(tab.conversationId);
    if (summary?.capabilities) return summary.capabilities;
  }
  return ProviderRegistry.getCapabilities(providerId, conversation?.providerState);
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
  conversation: ConversationSummary | null = tab.conversationId ? plugin.getConversationSummary(tab.conversationId) : null,
): TabSettingsSnapshot & ChatSettings {
  const settings = plugin.getCommittedSettings();
  const providerId = conversation?.providerId ?? tab.providerId;
  if (!providerId) return { ...settings, model: tab.draftModel ?? '', reasoning: null };
  const snapshot = {
    ...getChatSettingsSnapshot(settings, providerId, getTabSelectedModel(tab, plugin, settings, conversation)),
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
    snapshot.effortLevel = reasoning;
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
  const committed = await updateTabProviderSettings(tab, plugin, snapshot => {
    snapshot.effortLevel = reasoning;
    uiConfig.applyReasoningSelection?.(model, reasoning, snapshot);
  });
  if (committed) tab.session.reasoningSelections.set(`${providerId}:${model}`, reasoning);
}

export function getTabSelectedModel(
  tab: TabProviderContext,
  plugin: ChatFeatureHost,
  settings: Readonly<ClaudianSettings> = plugin.settings,
  conversation: ConversationSummary | null = tab.conversationId ? plugin.getConversationSummary(tab.conversationId) : null,
): string | null {
  const providerId = conversation?.providerId ?? tab.providerId;
  if (!providerId) return tab.draftModel;
  if (tab.conversationId === null) {
    return normalizeProviderModelSelection(providerId, settings, tab.draftModel)
      ?? tab.draftModel
      ?? null;
  }

  if (conversation) {
    return resolveConversationModel(settings, providerId, conversation).model;
  }

  return null;
}

export async function updateTabProviderSettings(
  tab: TabProviderContext & Pick<AssembledTabRuntime, 'session'>,
  plugin: ChatFeatureHost,
  update: (settings: TabSettingsSnapshot) => void,
): Promise<TabSettingsSnapshot | null> {
  const providerId = requireTabProviderId(tab, plugin);
  const conversationId = tab.conversationId;
  const revision = tab.session.identityRevision;
  const model = getTabSelectedModel(tab, plugin);
  let snapshot: TabSettingsSnapshot | null = null;
  await plugin.mutateSettings((settings) => {
    if (tab.lifecycleState === 'closing' || tab.session.identityRevision !== revision
      || tab.conversationId !== conversationId
      || getTabProviderId(tab, plugin) !== providerId
      || getTabSelectedModel(tab, plugin) !== model) return;
    const before = getProviderSettingsSnapshotWithModel(settings, providerId, model);
    snapshot = structuredClone(before);
    update(snapshot);
    ProviderSettingsCoordinator.commitProviderSettingsChange(settings, providerId, before, snapshot);
  });
  return snapshot;
}
