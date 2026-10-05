import { Notice } from 'obsidian';

import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ForkContext } from '@/features/chat/conversation/forkSourceTypes';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import { chooseForkTarget } from '@/features/chat/tabs/forking/ForkTargetModal';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';
import { getVaultPath } from '@/utils/path';

/** Manager-owned tab operations that receive a fork; liveness is revalidated after every await. */
export interface ForkTargetHost {
  readonly plugin: ChatFeatureHost;
  readonly membership: TabMembershipView;
  createTab(conversationId: string): Promise<AssembledTabRuntime | null>;
  discardTab(tabId: TabId): Promise<boolean>;
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

function isForkSourceCurrent(host: ForkTargetHost, sourceLease: ForkSourceLease): boolean {
  return host.membership.isTabAlive(sourceLease.tab)
    && sourceLease.tab.conversationId === sourceLease.conversationId
    && (sourceLease.latestMessageId === undefined || (
      !sourceLease.tab.state.isStreaming
      && sourceLease.tab.state.messages.at(-1)?.id === sourceLease.latestMessageId
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

async function forkToNewTab(
  host: ForkTargetHost,
  context: ForkContext,
  sourceTab: AssembledTabRuntime,
): Promise<AssembledTabRuntime | null> {
  const sourceLease = captureForkSourceLease(context, sourceTab);
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
        host.membership.getTab(tab.id) === tab
        && tab.session.userOwnershipRevision !== 0
      ) {
        return tab;
      }
      const removed = await host.discardTab(tab.id);
      if (!removed || host.membership.getTab(tab.id) === tab) {
        return tab;
      }
      await deleteForkConversation(host, conversationId);
      return null;
    }
    return tab;
  } catch (error) {
    if (!tab || host.membership.getTab(tab.id) !== tab) {
      await deleteForkConversation(host, conversationId);
    }
    throw error;
  }
}

async function forkInCurrentTab(
  host: ForkTargetHost,
  context: ForkContext,
  sourceTab: AssembledTabRuntime,
): Promise<boolean> {
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
    !host.membership.isTabStateMutable(sourceTab)
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
  sourceLease: ForkSourceLease,
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
