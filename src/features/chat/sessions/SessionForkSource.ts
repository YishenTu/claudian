import { Notice } from 'obsidian';

import { resolveConversationModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';
import {
  type ChatMessage,
  isCanonicalUserMessage,
} from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ForkContext, ForkSourceCapture } from '@/features/chat/conversation/forkSourceTypes';
import type { ChatSessionRuntime, SessionIdentity } from '@/features/chat/sessions/ChatSessionRuntime';
import { getSessionProviderId } from '@/features/chat/sessions/sessionProvider';
import { getSessionCapabilities, getSessionSelectedModel } from '@/features/chat/sessions/sessionSettings';
import type { ChatState } from '@/features/chat/state/ChatState';
import { t } from '@/i18n/i18n';

export interface ForkSourceOwner extends SessionIdentity {
  readonly state: Pick<ChatState, 'isStreaming' | 'isRewinding' | 'messages'>;
  readonly executionCoordinator: ChatSessionRuntime['executionCoordinator'];
}

/** A fork source whose main turn owner identifies where its settled history ends. */
export interface LiveForkSourceOwner extends ForkSourceOwner {
  settledTranscriptEnd(messages: readonly ChatMessage[]): number | null;
}

interface ForkSource {
  providerId?: ProviderId;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  sourceSelectedModel?: string;
  sourceTitle?: string;
  linkedContentPath?: string;
  projectId?: string;
}

/** Returns the provider-owned id of the transcript's latest completed assistant checkpoint. */
function findLatestAssistantCheckpoint(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const assistantMessageId = messages[index].role === 'assistant' ? messages[index].assistantMessageId : undefined;
    if (assistantMessageId) return assistantMessageId;
  }
  return null;
}

function deepCloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return deepClone(messages);
}

async function resolveForkSource(
  tab: ForkSourceOwner,
  plugin: ChatFeatureHost,
  assistantCheckpointId: string,
): Promise<ForkSource | null> {
  const conversation = tab.conversationId
    ? plugin.getConversationSync(tab.conversationId)
    : null;

  if (!tab.providerId && !conversation?.providerId) return null;
  const fallback = async (): Promise<string | null> => ProviderRegistry
    .getConversationHistoryService(conversation?.providerId ?? tab.providerId!)
    .resolveSessionIdForConversation(conversation);
  const coordinatedSource = await tab.executionCoordinator.resolveForkSource(
    assistantCheckpointId,
    fallback,
  );
  const sourceSessionId = coordinatedSource?.sessionId ?? await fallback();

  if (!sourceSessionId) {
    return null;
  }

  const providerId = getSessionProviderId(tab, plugin, conversation);
  if (!providerId) return null;

  return {
    providerId,
    sourceSessionId,
    sourceProviderState: conversation?.providerState,
    sourceSelectedModel: conversation
      ? resolveConversationModel(plugin.settings, providerId, conversation).model
      : getSessionSelectedModel(tab, plugin) ?? undefined,
    sourceTitle: conversation?.title,
    linkedContentPath: conversation?.linkedContentPath,
    projectId: conversation?.projectId,
  };
}

/**
 * Captures the source binding at the conversation's latest completed assistant
 * checkpoint and revalidates it across every await. While a main turn runs, a
 * checkpoint fork captures only the history before that turn. Callers own their
 * own user messaging; this never creates a conversation or provider session.
 */
export async function captureLatestCompletedForkSource<T extends LiveForkSourceOwner>(
  tab: T,
  plugin: ChatFeatureHost,
  isRuntimeLive: (tab: T) => boolean,
): Promise<ForkSourceCapture> {
  const { state } = tab;
  const sourceConversationId = tab.conversationId;

  if (!getSessionCapabilities(tab, plugin).supportsFork) {
    return { ok: false, reason: 'unsupported-provider' };
  }
  if (state.isRewinding) return { ok: false, reason: 'rewinding' };

  const capabilities = getSessionCapabilities(tab, plugin);
  let msgs = state.messages;
  if (state.isStreaming) {
    if (capabilities.supportsForkDuringTurn === false) return { ok: false, reason: 'streaming' };
    // The running reply can carry its native id before it completes, so only earlier history is settled.
    const settledEnd = tab.settledTranscriptEnd(msgs);
    if (settledEnd === null) return { ok: false, reason: 'streaming' };
    msgs = msgs.slice(0, settledEnd);
  }
  if (msgs.length === 0) return { ok: false, reason: 'no-messages' };

  const lastAssistantUuid = findLatestAssistantCheckpoint(msgs);
  if (!lastAssistantUuid) return { ok: false, reason: 'no-checkpoint' };
  // Fixed before any await: the source keeps streaming and may settle during preparation.
  const messages = deepCloneMessages(msgs);

  const source = await resolveForkSource(tab, plugin, lastAssistantUuid);
  if (!source) return { ok: false, reason: 'no-session' };
  if (!isRuntimeLive(tab) || tab.conversationId !== sourceConversationId) {
    return { ok: false, reason: 'stale-binding' };
  }

  return {
    context: {
      forkAtUserMessage: msgs.filter(isCanonicalUserMessage).length + 1,
      linkedContentPath: source.linkedContentPath,
      messages,
      projectId: source.projectId,
      providerId: source.providerId,
      resumeAt: lastAssistantUuid,
      sourceConversationId,
      sourceProviderState: source.sourceProviderState
        ? deepClone(source.sourceProviderState)
        : undefined,
      sourceSelectedModel: source.sourceSelectedModel,
      sourceSessionId: source.sourceSessionId,
      sourceTitle: source.sourceTitle,
    },
    ok: true,
  };
}

export async function handleForkRequest<T extends ForkSourceOwner>(
  tab: T,
  plugin: ChatFeatureHost,
  assistantMessageId: string,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
  isRuntimeLive: (tab: T) => boolean,
): Promise<void> {
  const { state } = tab;
  const sourceConversationId = tab.conversationId;

  if (!getSessionCapabilities(tab, plugin).supportsFork) {
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
  const assistantIdx = msgs.findIndex(message => message.id === assistantMessageId && message.role === 'assistant');
  if (assistantIdx === -1) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorMessageNotFound') }));
    return;
  }

  const checkpoint = msgs[assistantIdx].assistantMessageId;
  if (!checkpoint) {
    new Notice(t('chat.fork.unavailableNoUuid'));
    return;
  }

  const source = await resolveForkSource(tab, plugin, checkpoint);
  if (!source) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoSession') }));
    return;
  }
  if (!isRuntimeLive(tab) || tab.conversationId !== sourceConversationId) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs.slice(0, assistantIdx + 1)),
    providerId: source.providerId,
    sourceConversationId,
    sourceSessionId: source.sourceSessionId,
    sourceProviderState: source.sourceProviderState,
    sourceSelectedModel: source.sourceSelectedModel,
    resumeAt: checkpoint,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: msgs.slice(0, assistantIdx + 1).filter(isCanonicalUserMessage).length + 1,
    linkedContentPath: source.linkedContentPath,
    projectId: source.projectId,
  });
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
