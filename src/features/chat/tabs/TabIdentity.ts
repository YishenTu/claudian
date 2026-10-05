import {
  findProviderModelOption,
  resolveNewConversationModel,
  resolveProviderDefaultModel,
} from '@/core/providers/conversationModel';
import { getProviderForModel } from '@/core/providers/modelRouting';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '@/core/providers/types';
import type { ClaudianSettings, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { TabSessionState } from '@/features/chat/tabs/TabSession';
import type { AssembledTabRuntime, TabProviderContext } from '@/features/chat/tabs/types';

/** Generates a unique tab ID. */
export function generateTabId(): TabId {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Select identity without constructing a tab's UI, controllers, or provider resources. */
export function createTabSessionState(
  settings: ClaudianSettings,
  conversation: Conversation | null | undefined,
  options: { tabId: string; draftModel?: string | null; providerId?: TabSessionState['providerId']; lifecycleState?: TabSessionState['lifecycleState'] },
): TabSessionState {
  const isBound = !!conversation?.id;
  const restoredDraftModel = typeof options.draftModel === 'string'
    ? options.draftModel.trim()
    : '';
  const newConversationModel = !isBound && !restoredDraftModel
    ? resolveNewConversationModel(settings)
    : null;
  const draftModel = isBound
    ? null
    : (restoredDraftModel || newConversationModel?.model || null);
  const restoredProviderId = options.providerId === undefined
    ? (restoredDraftModel ? getProviderForModel(restoredDraftModel, settings) : null)
    : options.providerId;
  const initialProviderId = conversation?.providerId
    ?? newConversationModel?.providerId
    ?? (draftModel
      ? restoredProviderId && ProviderRegistry.getRegisteredProviderIds().includes(restoredProviderId)
        ? restoredProviderId : null
      : DEFAULT_CHAT_PROVIDER_ID);
  return {
    id: options.tabId,
    lifecycleState: options.lifecycleState ?? 'open',
    draftModel,
    providerId: initialProviderId,
    conversationId: conversation?.id ?? null,
  };
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

/** Re-selects an available draft model and provider for a blank tab; true when either changed. */
export function reconcileBlankTabIdentity(tab: TabProviderContext & Partial<Pick<AssembledTabRuntime, 'session'>>, plugin: ChatFeatureHost): boolean {
  if (tab.conversationId !== null) return false;

  const settingsSnapshot = plugin.settings as unknown as Record<string, unknown>;
  const enabledProviderIds = ProviderRegistry.getEnabledProviderIds(settingsSnapshot);
  const previousDraftModel = tab.draftModel;
  const previousProviderId = tab.providerId;
  let nextProviderId = tab.providerId;
  let nextModel = tab.draftModel;

  if (tab.draftModel) {
    const availableDraftModel = tab.providerId && enabledProviderIds.includes(tab.providerId)
      ? findProviderModelOption(tab.providerId, tab.draftModel, settingsSnapshot)
      : null;
    if (availableDraftModel) nextModel = availableDraftModel;
  } else {
    const fallback = resolveBlankTabFallback(
      settingsSnapshot,
      enabledProviderIds,
      tab.providerId,
    );
    if (fallback) {
      nextModel = fallback.model;
      nextProviderId = fallback.providerId;
    }
  }

  if (tab.session) tab.session.selectDraft(nextProviderId, nextModel);
  else Object.assign(tab, { providerId: nextProviderId, draftModel: nextModel });

  return tab.draftModel !== previousDraftModel || tab.providerId !== previousProviderId;
}
