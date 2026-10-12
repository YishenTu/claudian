import { Notice } from 'obsidian';

import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ForkContext } from '@/features/chat/conversation/forkSourceTypes';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
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
  /**
   * Shows the session in the wide viewer slot while `isValid` holds through its hydration;
   * resolves to the tab showing it, if any.
   */
  showInViewer(
    conversationId: string,
    sourceTab: AssembledTabRuntime,
    isValid: () => boolean,
  ): Promise<AssembledTabRuntime | null>;
  discardTab(tabId: TabId): Promise<boolean>;
  /** `viewer` when the layout shows forks in its viewer slot, skipping the target prompt. */
  forkTarget(): 'ask' | 'viewer';
  rebind(tab: AssembledTabRuntime, conversationId: string, isCurrent: () => boolean): Promise<AssembledTabRuntime | null>;
}

type ForkSourceLease = {
  readonly latestMessageId?: string | null;
  readonly conversationId: string | null;
  readonly session: ChatSessionRuntime;
  readonly identityRevision: number;
  readonly requestTab: AssembledTabRuntime;
};

function captureForkSourceLease(
  context: ForkContext,
  sourceTab: AssembledTabRuntime,
): ForkSourceLease {
  return {
    conversationId: context.sourceConversationId,
    latestMessageId: context.forkMode === 'full-session' ? context.messages.at(-1)?.id ?? null : undefined,
    session: sourceTab.session.runtime,
    identityRevision: sourceTab.session.runtime.identityRevision,
    requestTab: sourceTab,
  };
}

function isForkSourceCurrent(source: ForkSourceLease): boolean {
  return !source.session.isDisposed
    && source.session.identityRevision === source.identityRevision
    && source.session.conversationId === source.conversationId
    && (source.latestMessageId === undefined || (
      !source.session.turns.isInFlight
      && source.session.peekModel?.state.messages.at(-1)?.id === source.latestMessageId
    ));
}

function isForkRequestCurrent(host: ForkTargetHost, source: ForkSourceLease): boolean {
  return isForkSourceCurrent(source) && host.membership.isTabAlive(source.requestTab);
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
  if (!isForkRequestCurrent(host, sourceLease)) return;

  if (host.forkTarget() === 'viewer') {
    await forkToViewer(host, context, sourceTab);
    return;
  }
  const target = await chooseForkTarget(host.plugin.app);
  if (!target || !isForkRequestCurrent(host, sourceLease)) return;

  if (target === 'new-tab') {
    const tab = await forkToNewTab(host, context, sourceTab);
    if (!tab) return;
    new Notice(t('chat.fork.notice'));
  } else {
    const success = await forkInCurrentTab(host, context, sourceTab);
    if (!success) {
      new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
      return;
    }
    new Notice(t('chat.fork.noticeCurrentTab'));
  }
}

/** Shows the fork in the viewer slot; showing it may replace the source preview, which is intended. */
async function forkToViewer(
  host: ForkTargetHost,
  context: ForkContext,
  sourceTab: AssembledTabRuntime,
): Promise<void> {
  const sourceLease = captureForkSourceLease(context, sourceTab);
  if (!isForkRequestCurrent(host, sourceLease)) return;
  const conversationId = await createForkConversation(host, context, sourceLease);
  if (!conversationId) return;
  if (!isForkRequestCurrent(host, sourceLease)) {
    await deleteForkConversation(host, conversationId);
    return;
  }
  let shown: AssembledTabRuntime | null = null;
  try {
    // The source session must stay current until the fork is shown; the source tab itself may
    // be the preview the fork replaces, so its liveness is not part of that check.
    shown = await host.showInViewer(conversationId, sourceTab, () => isForkSourceCurrent(sourceLease));
  } finally {
    if (!shown) await deleteForkConversation(host, conversationId);
  }
}

async function forkToNewTab(
  host: ForkTargetHost,
  context: ForkContext,
  sourceTab: AssembledTabRuntime,
): Promise<AssembledTabRuntime | null> {
  const sourceLease = captureForkSourceLease(context, sourceTab);
  if (!isForkRequestCurrent(host, sourceLease)) return null;
  const conversationId = await createForkConversation(host, context, sourceLease);
  if (!conversationId) return null;
  if (!isForkRequestCurrent(host, sourceLease)) {
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
    if (!isForkRequestCurrent(host, sourceLease)) {
      if (
        host.membership.getTab(tab.id) === tab
        && tab.session.isUserClaimed
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
  if (!isForkRequestCurrent(host, sourceLease)) return false;
  const conversationId = await createForkConversation(host, context, sourceLease);
  if (!conversationId) return false;
  if (!isForkRequestCurrent(host, sourceLease)) {
    await deleteForkConversation(host, conversationId);
    return false;
  }
  try {
    const target = await host.rebind(sourceTab, conversationId, () => isForkRequestCurrent(host, sourceLease));
    if (target?.conversationId === conversationId && host.membership.isTabStateMutable(target)) return true;
  } catch (error) {
    await deleteForkConversation(host, conversationId);
    throw error;
  }
  await deleteForkConversation(host, conversationId);
  return false;
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

  if (!isForkRequestCurrent(host, sourceLease)) {
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
    if (!isForkRequestCurrent(host, sourceLease)) {
      await deleteForkConversation(host, conversation.id);
      return null;
    }
    await plugin.updateConversation(conversation.id, {
      messages: context.messages,
      providerState: forkProviderState,
      ...(title && { title }),
    });
    if (!isForkRequestCurrent(host, sourceLease)) {
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
