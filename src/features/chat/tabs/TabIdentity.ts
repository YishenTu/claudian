import { resolveNewConversationModel } from '../../../core/providers/conversationModel';
import { getProviderForModel } from '../../../core/providers/modelRouting';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID } from '../../../core/providers/types';
import type { ClaudianSettings, Conversation } from '../../../core/types';
import type { TabSessionState } from './TabSession';

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
    lifecycleState: options.lifecycleState ?? 'cold',
    draftModel,
    providerId: initialProviderId,
    conversationId: conversation?.id ?? null,
  };
}
