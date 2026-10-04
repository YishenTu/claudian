import { Notice } from 'obsidian';

import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { chooseForkTarget } from '@/features/chat/tabs/ForkTargetModal';
import { getVaultPath } from '@/utils/path';

import { resolveConversationModel } from '../../../core/providers/conversationModel';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import {
  type ChatMessage,
  isCanonicalUserMessage,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type { ChatFeatureHost } from '../ChatFeatureHost';
import { getTabProviderId } from './providerResolution';
import {
  getTabCapabilities,
  getTabSelectedModel,
} from './TabProviderState';
import type { AssembledTabRuntime, TabId } from './types';

export interface ForkContext {
  messages: ChatMessage[];
  providerId?: ProviderId;
  forkMode?: ProviderCapabilities['forkMode'];
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
  return deepClone(messages);
}

export type ForkSourceUnavailableReason =
  | 'unsupported-provider'
  | 'streaming'
  | 'rewinding'
  | 'no-messages'
  | 'not-latest-reply'
  | 'no-checkpoint'
  | 'no-session'
  | 'stale-binding';

export type ForkSourceCapture =
  | { readonly ok: true; readonly context: ForkContext }
  | { readonly ok: false; readonly reason: ForkSourceUnavailableReason };

async function resolveForkSource(
  tab: AssembledTabRuntime,
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

  const providerId = getTabProviderId(tab, plugin, conversation);
  if (!providerId) return null;

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

/**
 * Captures the source binding at the conversation's latest completed assistant
 * checkpoint and revalidates it across every await. Callers own their own user
 * messaging; this never creates a conversation or provider session.
 */
export async function captureLatestCompletedForkSource(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean,
): Promise<ForkSourceCapture> {
  const { state } = tab;
  const sourceConversationId = tab.conversationId;

  if (!getTabCapabilities(tab, plugin).supportsFork) {
    return { ok: false, reason: 'unsupported-provider' };
  }
  if (state.isStreaming) return { ok: false, reason: 'streaming' };
  if (state.isRewinding) return { ok: false, reason: 'rewinding' };

  const msgs = state.messages;
  if (msgs.length === 0) return { ok: false, reason: 'no-messages' };
  const forkMode = getTabCapabilities(tab, plugin).forkMode;
  if (forkMode === 'full-session' && msgs.at(-1)?.role !== 'assistant') {
    return { ok: false, reason: 'not-latest-reply' };
  }

  let lastAssistantUuid: string | undefined;
  for (let index = msgs.length - 1; index >= 0; index -= 1) {
    if (msgs[index].role === 'assistant' && msgs[index].assistantMessageId) {
      lastAssistantUuid = msgs[index].assistantMessageId;
      break;
    }
  }
  if (!lastAssistantUuid) return { ok: false, reason: 'no-checkpoint' };

  const source = await resolveForkSource(tab, plugin, lastAssistantUuid);
  if (!source) return { ok: false, reason: 'no-session' };
  if (!isRuntimeLive(tab) || tab.conversationId !== sourceConversationId
    || (forkMode === 'full-session' && (state.isStreaming || state.messages.at(-1)?.assistantMessageId !== lastAssistantUuid))) {
    return { ok: false, reason: 'stale-binding' };
  }

  return {
    context: {
      forkMode,
      forkAtUserMessage: msgs.filter(isCanonicalUserMessage).length + 1,
      linkedContentPath: source.linkedContentPath,
      messages: deepCloneMessages(msgs),
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

export async function handleForkRequest(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  assistantMessageId: string,
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
  const assistantIdx = msgs.findIndex(message => message.id === assistantMessageId && message.role === 'assistant');
  if (assistantIdx === -1) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorMessageNotFound') }));
    return;
  }

  if (getTabCapabilities(tab, plugin).forkMode === 'full-session' && assistantIdx !== msgs.length - 1) {
    new Notice('This provider can fork only from the latest reply.');
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
  if (
    !isRuntimeLive(tab)
    || tab.conversationId !== sourceConversationId
    || (getTabCapabilities(tab, plugin).forkMode === 'full-session'
      && (state.isStreaming || state.messages.at(-1)?.assistantMessageId !== checkpoint))
  ) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs.slice(0, assistantIdx + 1)),
    providerId: source.providerId,
    forkMode: getTabCapabilities(tab, plugin).forkMode,
    sourceConversationId,
    sourceSessionId: source.sourceSessionId,
    sourceProviderState: source.sourceProviderState,
    sourceSelectedModel: source.sourceSelectedModel,
    resumeAt: checkpoint,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: msgs.slice(0, assistantIdx + 1).filter(isCanonicalUserMessage).length + 1,
    linkedContentPath: source.linkedContentPath,
  });
}

export async function handleForkAll(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean,
): Promise<void> {
  const capture = await captureLatestCompletedForkSource(tab, plugin, isRuntimeLive);
  if (!capture.ok) {
    const notice = resolveForkAllUnavailableNotice(capture.reason);
    if (notice) new Notice(notice);
    return;
  }

  await forkRequestCallback(capture.context);
}

function resolveForkAllUnavailableNotice(
  reason: ForkSourceUnavailableReason,
): string | null {
  switch (reason) {
    case 'unsupported-provider':
      return 'Fork is not supported by this provider.';
    case 'streaming':
      return t('chat.fork.unavailableStreaming');
    case 'rewinding':
      return t('chat.rewind.inProgress');
    case 'no-messages':
      return t('chat.fork.commandNoMessages');
    case 'not-latest-reply':
      return 'This provider can fork only from the latest reply.';
    case 'no-checkpoint':
      return t('chat.fork.commandNoAssistantUuid');
    case 'no-session':
      return t('chat.fork.failed', { error: t('chat.fork.errorNoSession') });
    case 'stale-binding':
      return null;
  }
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

// ============================================
// Fork targets (manager side)
// ============================================

/** Manager-owned tab operations that receive a fork; liveness is revalidated after every await. */
export interface ForkTargetHost {
  readonly plugin: ChatFeatureHost;
  createTab(conversationId: string): Promise<AssembledTabRuntime | null>;
  discardTab(tabId: TabId): Promise<boolean>;
  getTab(tabId: TabId): AssembledTabRuntime | null;
  isDestroyed(): boolean;
  isTabAlive(tab: AssembledTabRuntime): boolean;
  isTabStateMutable(tab: AssembledTabRuntime): boolean;
  shouldForkToNewTab(): boolean;
}

type ForkSourceLease = {
  readonly latestMessageId?: string | null;
  readonly conversationId: string | null;
  readonly tab: AssembledTabRuntime;
};

function captureForkSourceLease(
  context: ForkContext,
  sourceTab: AssembledTabRuntime,
): ForkSourceLease {
  return {
    conversationId: context.sourceConversationId,
    latestMessageId: context.forkMode === 'full-session' ? context.messages.at(-1)?.id ?? null : undefined,
    tab: sourceTab,
  };
}

function isForkSourceCurrent(host: ForkTargetHost, sourceLease: ForkSourceLease | null): boolean {
  return !host.isDestroyed()
    && (!sourceLease || (
      host.isTabAlive(sourceLease.tab)
      && sourceLease.tab.conversationId === sourceLease.conversationId
      && (sourceLease.latestMessageId === undefined || (
        !sourceLease.tab.state.isStreaming
        && sourceLease.tab.state.messages.at(-1)?.id === sourceLease.latestMessageId
      ))
    ));
}

async function deleteForkConversation(host: ForkTargetHost, conversationId: string): Promise<void> {
  await host.plugin.deleteConversation(conversationId).catch(() => {});
}

/** Routes a runtime fork request to the chosen target bound to its captured source tab. */
export async function openForkTarget(
  host: ForkTargetHost,
  sourceTab: AssembledTabRuntime,
  context: ForkContext,
): Promise<void> {
  const sourceLease = captureForkSourceLease(context, sourceTab);
  if (!isForkSourceCurrent(host, sourceLease)) return;

  const shouldForkToNewTab = host.shouldForkToNewTab();
  const target = shouldForkToNewTab
    ? 'new-tab'
    : await chooseForkTarget(host.plugin.app);
  if (!target || !isForkSourceCurrent(host, sourceLease)) return;

  if (target === 'new-tab') {
    const tab = await forkToNewTab(host, context, sourceTab);
    if (!tab) return;
    if (!shouldForkToNewTab) {
      new Notice(t('chat.fork.notice'));
    }
  } else {
    const success = await forkInCurrentTab(host, context, sourceTab);
    if (!success) {
      new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
      return;
    }
    new Notice(t('chat.fork.noticeCurrentTab'));
  }
}

export async function forkToNewTab(
  host: ForkTargetHost,
  context: ForkContext,
  sourceTab: AssembledTabRuntime | null,
): Promise<AssembledTabRuntime | null> {
  const sourceLease = sourceTab ? captureForkSourceLease(context, sourceTab) : null;
  if (!isForkSourceCurrent(host, sourceLease)) return null;
  const conversationId = await createForkConversation(host, context, sourceLease);
  if (!conversationId) return null;
  if (!isForkSourceCurrent(host, sourceLease)) {
    await deleteForkConversation(host, conversationId);
    return null;
  }
  let tab: AssembledTabRuntime | null = null;
  try {
    tab = await host.createTab(conversationId);
    if (!tab) {
      await deleteForkConversation(host, conversationId);
      return null;
    }
    if (!isForkSourceCurrent(host, sourceLease)) {
      if (
        host.getTab(tab.id) === tab
        && tab.session.userOwnershipRevision !== 0
      ) {
        return tab;
      }
      const removed = await host.discardTab(tab.id);
      if (!removed || host.getTab(tab.id) === tab) {
        return tab;
      }
      await deleteForkConversation(host, conversationId);
      return null;
    }
    return tab;
  } catch (error) {
    if (!tab || host.getTab(tab.id) !== tab) {
      await deleteForkConversation(host, conversationId);
    }
    throw error;
  }
}

export async function forkInCurrentTab(
  host: ForkTargetHost,
  context: ForkContext,
  sourceTab: AssembledTabRuntime | null,
): Promise<boolean> {
  if (!sourceTab) return false;

  const sourceLease = captureForkSourceLease(context, sourceTab);
  if (!isForkSourceCurrent(host, sourceLease)) return false;
  const conversationId = await createForkConversation(host, context, sourceLease);
  if (!conversationId) return false;
  if (!isForkSourceCurrent(host, sourceLease)) {
    await deleteForkConversation(host, conversationId);
    return false;
  }
  try {
    await sourceTab.controllers.conversationController.switchTo(conversationId);
  } catch (error) {
    await deleteForkConversation(host, conversationId);
    throw error;
  }
  if (
    !host.isTabStateMutable(sourceTab)
    || sourceTab.conversationId !== conversationId
  ) {
    await deleteForkConversation(host, conversationId);
    return false;
  }
  return true;
}

async function createForkConversation(
  host: ForkTargetHost,
  context: ForkContext,
  sourceLease: ForkSourceLease | null,
): Promise<string | null> {
  const { plugin } = host;
  const conversation = await plugin.createConversation({
    providerId: context.providerId,
    ...(context.sourceSelectedModel ? { selectedModel: context.sourceSelectedModel } : {}),
    ...(context.linkedContentPath ? { linkedContentPath: context.linkedContentPath } : {}),
  });

  if (!isForkSourceCurrent(host, sourceLease)) {
    await deleteForkConversation(host, conversation.id);
    return null;
  }

  const title = context.sourceTitle
    ? buildForkTitle(plugin, context.sourceTitle, context.forkAtUserMessage)
    : undefined;

  try {
    const vaultPath = getVaultPath(plugin.app);
    const forkProviderState = await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .buildForkProviderState(
        context.sourceSessionId,
        context.resumeAt,
        context.sourceProviderState,
        vaultPath,
        {
          environment: {
            ...process.env,
            ...getRuntimeEnvironmentVariables(plugin.settings, conversation.providerId),
          },
          hostPlatform: process.platform,
          settings: plugin.settings,
          vaultPath,
        },
      );
    if (!isForkSourceCurrent(host, sourceLease)) {
      await deleteForkConversation(host, conversation.id);
      return null;
    }
    await plugin.updateConversation(conversation.id, {
      messages: context.messages,
      providerState: forkProviderState,
      ...(title && { title }),
    });
    if (!isForkSourceCurrent(host, sourceLease)) {
      await deleteForkConversation(host, conversation.id);
      return null;
    }
  } catch (error) {
    await deleteForkConversation(host, conversation.id);
    throw error;
  }

  return conversation.id;
}

function buildForkTitle(
  plugin: ChatFeatureHost,
  sourceTitle: string,
  forkAtUserMessage?: number,
): string {
  const MAX_TITLE_LENGTH = 50;
  const forkSuffix = forkAtUserMessage ? ` (#${forkAtUserMessage})` : '';
  const forkPrefix = 'Fork: ';
  const maxSourceLength = MAX_TITLE_LENGTH - forkPrefix.length - forkSuffix.length;
  const truncatedSource = sourceTitle.length > maxSourceLength
    ? sourceTitle.slice(0, maxSourceLength - 1) + '…'
    : sourceTitle;
  let title = forkPrefix + truncatedSource + forkSuffix;

  const existingTitles = new Set(plugin.getConversationList().map(c => c.title));
  if (existingTitles.has(title)) {
    let n = 2;
    while (existingTitles.has(`${title} ${n}`)) n++;
    title = `${title} ${n}`;
  }

  return title;
}
