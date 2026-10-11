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
import type { TabId, TabLifecycleState } from '@/features/chat/tabs/ChatTab';

/**
 * A tab's persisted identity: what a view restores before any runtime exists. A restored tab
 * holds it directly. Once assembled, `TabSession` owns the tab's ID, lifecycle and label, while
 * the attached session owns its conversation, provider and draft model.
 */
export interface TabIdentity {
  id: TabId;
  conversationId: string | null;
  draftModel: string | null;
  providerId: ProviderId | null;
  lifecycleState: TabLifecycleState;
  /** The user's name for the tab; it stays with the tab, not the conversation it shows. */
  label?: string;
}

/** A blank tab's provider and draft model. */
export interface BlankTabSelection {
  providerId: ProviderId | null;
  draftModel: string | null;
}

/** Generates a unique tab ID. */
export function generateTabId(): TabId {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Selects an identity without constructing a tab's UI, controllers, or provider resources. */
export function createTabIdentity(
  settings: ClaudianSettings,
  conversation: Conversation | null | undefined,
  options: {
    tabId: string;
    draftModel?: string | null;
    providerId?: ProviderId | null;
    lifecycleState?: TabLifecycleState;
    label?: string;
  },
): TabIdentity {
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
    ...(options.label ? { label: options.label } : {}),
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

/**
 * The available draft model and provider a blank tab should switch to after availability
 * changes; null for bound tabs or when the current selection stands.
 */
export function resolveBlankTabReselection(
  tab: Readonly<TabIdentity>,
  plugin: ChatFeatureHost,
): BlankTabSelection | null {
  if (tab.conversationId !== null) return null;

  const settingsSnapshot = plugin.settings as unknown as Record<string, unknown>;
  const enabledProviderIds = ProviderRegistry.getEnabledProviderIds(settingsSnapshot);
  let providerId = tab.providerId;
  let draftModel = tab.draftModel;

  if (tab.draftModel) {
    const availableDraftModel = tab.providerId && enabledProviderIds.includes(tab.providerId)
      ? findProviderModelOption(tab.providerId, tab.draftModel, settingsSnapshot)
      : null;
    if (availableDraftModel) draftModel = availableDraftModel;
  } else {
    const fallback = resolveBlankTabFallback(
      settingsSnapshot,
      enabledProviderIds,
      tab.providerId,
    );
    if (fallback) {
      draftModel = fallback.model;
      providerId = fallback.providerId;
    }
  }

  return draftModel !== tab.draftModel || providerId !== tab.providerId
    ? { providerId, draftModel }
    : null;
}
