import {
  getProviderSettingsSnapshotWithModel,
  normalizeProviderModelSelection,
  resolveConversationModel,
} from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities, ProviderChatUIConfig } from '@/core/providers/types';
import type { ClaudianSettings, Conversation, ConversationSummary } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { type ChatSettings, getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import type { SessionIdentity } from '@/features/chat/sessions/ChatSessionRuntime';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { getSessionProviderId, requireSessionProviderId } from '@/features/chat/sessions/sessionProvider';

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

export type SessionSettingsSnapshot = Record<string, unknown> & {
  model: string;
  effortLevel: string;
  serviceTier: string;
  permissionMode: string;
  customContextLimits?: Record<string, number>;
};

export function getSessionCapabilities(
  tab: Readonly<SessionIdentity>,
  plugin: ChatFeatureHost,
  conversation?: Conversation | null,
): ProviderCapabilities {
  const providerId = getSessionProviderId(tab, plugin, conversation);
  if (!providerId) return UNRESOLVED_TAB_CAPABILITIES;
  if (conversation === undefined && tab.conversationId) {
    const summary = plugin.getConversationSummary(tab.conversationId);
    if (summary?.capabilities) return summary.capabilities;
  }
  return ProviderRegistry.getCapabilities(providerId, conversation?.providerState);
}

export function getSessionChatUIConfig(
  tab: Readonly<SessionIdentity>,
  plugin: ChatFeatureHost,
  conversation?: Conversation | null,
): ProviderChatUIConfig {
  const providerId = getSessionProviderId(tab, plugin, conversation);
  return providerId ? ProviderRegistry.getChatUIConfig(providerId) : UNRESOLVED_TAB_UI;
}

export function getSessionSettingsSnapshot(
  tab: Readonly<SessionIdentity> & Pick<ChatSessionRuntime, 'reasoningSelections' | 'providerSelections' | 'identityRevision' | 'admitsConversationOperations'>,
  plugin: ChatFeatureHost,
  conversation: ConversationSummary | null = tab.conversationId ? plugin.getConversationSummary(tab.conversationId) : null,
): SessionSettingsSnapshot & ChatSettings {
  const settings = plugin.getCommittedSettings();
  const providerId = conversation?.providerId ?? tab.providerId;
  if (!providerId) return { ...settings, model: tab.draftModel ?? '', reasoning: null };
  const snapshot = {
    ...getChatSettingsSnapshot(settings, providerId, getSessionSelectedModel(tab, plugin, settings, conversation)),
  };
  let selections = tab.providerSelections.get(providerId);
  if (!selections) {
    selections = { permissionMode: snapshot.permissionMode, serviceTier: snapshot.serviceTier };
    tab.providerSelections.set(providerId, selections);
  }
  Object.assign(snapshot, selections);
  if (snapshot.reasoning !== null) {
    const key = reasoningSelectionKey(providerId, snapshot.model);
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const selected = tab.reasoningSelections.get(key) ?? snapshot.reasoning;
    const reasoning = uiConfig.getReasoningOptions(snapshot.model, snapshot)
      .some(option => option.value === selected)
      ? selected
      : uiConfig.getDefaultReasoningValue(snapshot.model, snapshot);
    tab.reasoningSelections.set(key, reasoning);
    snapshot.reasoning = reasoning;
    snapshot.effortLevel = reasoning;
  }
  return snapshot;
}

export async function updateSessionReasoning(
  tab: ChatSessionRuntime,
  plugin: ChatFeatureHost,
  reasoning: string,
): Promise<void> {
  const providerId = requireSessionProviderId(tab, plugin);
  const model = getSessionSettingsSnapshot(tab, plugin).model;
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const committed = await updateSessionProviderSettings(tab, plugin, snapshot => {
    snapshot.effortLevel = reasoning;
    uiConfig.applyReasoningSelection?.(model, reasoning, snapshot);
  });
  if (committed) tab.reasoningSelections.set(reasoningSelectionKey(providerId, model), reasoning);
}

/** Captures a compare-and-set against the session's authoritative reasoning selection. */
export function prepareSessionReasoningSelection(
  tab: ChatSessionRuntime,
  providerId: string,
  model: string,
  reasoning: string,
): { isCurrent(): boolean; commit(): void } {
  const key = reasoningSelectionKey(providerId, model);
  const previous = tab.reasoningSelections.get(key);
  return {
    isCurrent: () => tab.reasoningSelections.get(key) === previous,
    commit: () => { tab.reasoningSelections.set(key, reasoning); },
  };
}

function reasoningSelectionKey(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

export function getSessionSelectedModel(
  tab: Readonly<SessionIdentity>,
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

/** `update` must be a pure projection: it applies the same intent to the saved settings and to this session's view. */
export async function updateSessionProviderSettings(
  tab: Readonly<SessionIdentity> & Pick<ChatSessionRuntime, 'reasoningSelections' | 'providerSelections' | 'identityRevision' | 'admitsConversationOperations'>,
  plugin: ChatFeatureHost,
  update: (settings: SessionSettingsSnapshot) => void,
): Promise<SessionSettingsSnapshot | null> {
  const providerId = requireSessionProviderId(tab, plugin);
  const conversationId = tab.conversationId;
  const revision = tab.identityRevision;
  const model = getSessionSelectedModel(tab, plugin);
  let snapshot: SessionSettingsSnapshot | null = null;
  await plugin.mutateSettings((settings) => {
    if (!tab.admitsConversationOperations || tab.identityRevision !== revision
      || tab.conversationId !== conversationId
      || getSessionProviderId(tab, plugin) !== providerId
      || getSessionSelectedModel(tab, plugin) !== model) return;
    const before = getProviderSettingsSnapshotWithModel(settings, providerId, model);
    // The saved preference receives only what this update writes; untouched session selections stay local.
    const saved = structuredClone(before);
    update(saved);
    ProviderSettingsCoordinator.commitProviderSettingsChange(settings, providerId, before, saved);
    const selected: SessionSettingsSnapshot = { ...structuredClone(before), ...tab.providerSelections.get(providerId) };
    update(selected);
    snapshot = selected;
  });
  if (snapshot) {
    const selected: SessionSettingsSnapshot = snapshot;
    tab.providerSelections.set(providerId, { permissionMode: selected.permissionMode, serviceTier: selected.serviceTier });
  }
  return snapshot;
}
