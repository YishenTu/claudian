import { Notice } from 'obsidian';

import { resolveConversationModel } from '../../../core/providers/conversationModel';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../../core/providers/types';
import {
  type ChatMessage,
  isCanonicalUserMessage,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type { FeatureHost } from '../../FeatureHost';
import { findRewindContext } from '../rewind';
import { getTabProviderId } from './providerResolution';
import {
  getTabCapabilities,
  getTabSelectedModel,
} from './TabProviderState';
import type { AssembledTabRuntime } from './types';

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
  linkedContentPath?: string;
}

interface ForkSource {
  providerId?: ProviderId;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  sourceSelectedModel?: string;
  sourceTitle?: string;
  linkedContentPath?: string;
}

function deepCloneMessages(messages: ChatMessage[]): ChatMessage[] {
  if (typeof structuredClone === 'function') {
    return structuredClone(messages);
  }
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

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
  const coordinatedSource = await tab.executionCoordinator.resolveForkSource(
    assistantCheckpointId,
    fallback,
  );
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
    linkedContentPath: conversation?.linkedContentPath,
  };
}

export async function handleForkRequest(
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
  const userIdx = msgs.findIndex(message => message.id === userMessageId);
  if (userIdx === -1) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorMessageNotFound') }));
    return;
  }

  if (!msgs[userIdx].userMessageId) {
    new Notice(t('chat.fork.unavailableNoUuid'));
    return;
  }

  const rewindContext = findRewindContext(msgs, userIdx);
  if (!rewindContext.hasResponse || !rewindContext.prevAssistantUuid) {
    new Notice(t('chat.fork.unavailableNoResponse'));
    return;
  }

  const source = await resolveForkSource(tab, plugin, rewindContext.prevAssistantUuid);
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
    resumeAt: rewindContext.prevAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: msgs.slice(0, userIdx + 1).filter(isCanonicalUserMessage).length,
    linkedContentPath: source.linkedContentPath,
  });
}

export async function handleForkAll(
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
  for (let index = msgs.length - 1; index >= 0; index -= 1) {
    if (msgs[index].role === 'assistant' && msgs[index].assistantMessageId) {
      lastAssistantUuid = msgs[index].assistantMessageId;
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
    linkedContentPath: source.linkedContentPath,
  });
}
