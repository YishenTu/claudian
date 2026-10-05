import { Notice } from 'obsidian';

import type {
  ProviderSessionEvent,
} from '@/core/execution';
import type { ChatMessage, SubagentInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ChatExecutionEventContext } from '@/features/chat/execution/ChatExecutionCoordinator';
import { updateTabPermissionMode } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { BackgroundResponses } from '@/features/chat/turns/BackgroundResponses';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';

const backgroundResponses = new WeakMap<AssembledTabRuntime, BackgroundResponses>();

function getBackgroundResponses(tab: AssembledTabRuntime): BackgroundResponses {
  let responses = backgroundResponses.get(tab);
  if (!responses) {
    responses = new BackgroundResponses({
      state: tab.state, renderer: tab.renderer, stream: tab.controllers.streamController,
      isConnected: () => tab.dom.contentEl.isConnected, createMessageId: createTabMessageId,
    });
    backgroundResponses.set(tab, responses);
  }
  return responses;
}

async function handleTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  if (event.type === 'task_notification' && event.scope.kind === 'session') {
    renderSessionTaskNotification({
      state: tab.state, renderer: tab.renderer,
      isConnected: () => tab.dom.contentEl.isConnected, createMessageId: createTabMessageId,
    }, event.content, event.afterRequestedEvent, event.afterBackgroundEvent);
    return;
  }
  if (event.type === 'permission_mode_changed') {
    await updateTabPermissionMode(tab, plugin, event.permissionMode);
    if (!isCurrent()) return;
    return;
  }
  if (event.type === 'subagent_updated') {
    await tab.controllers.conversationController.save(true);
    return;
  }
  if (event.type === 'async_subagent_completed') {
    const providerSessionId = event.providerSessionId
      ?? tab.executionCoordinator.snapshot?.providerSessionId;
    if (!providerSessionId) return;
    const applied = await tab.controllers.streamController.subagents.handleAsyncSubagentCompletion({
      type: 'async_subagent_completion',
      providerSessionId,
      taskId: event.subagentId,
      status: event.status,
      ...(event.result !== undefined ? { result: event.result } : {}),
    });
    if (applied && isCurrent()) {
      const reportReviewableSettlement = tab.captureReviewableSettlement?.(event.status);
      try {
        await tab.controllers.conversationController.save(true);
      } finally {
        if (isCurrent()) reportReviewableSettlement?.();
      }
    }
    return;
  }
  if (event.type === 'session_error') {
    new Notice(event.message);
    return;
  }
  const hasVisibleOutput = await getBackgroundResponses(tab).handle(context.bindingId, event, isCurrent);
  if (hasVisibleOutput !== undefined && isCurrent()) {
    const reportReviewableSettlement = hasVisibleOutput ? tab.captureReviewableSettlement?.('completed') : null;
    try {
      await tab.controllers.conversationController.save(true);
    } finally {
      if (isCurrent()) reportReviewableSettlement?.();
    }
  }
}

export function enqueueTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
): Promise<void> | undefined {
  const coordinator = tab.executionCoordinator;
  const isCurrent = () => (
    tab.executionCoordinator === coordinator
    && coordinator.isEventContextCurrent(context)
  );
  if (!isCurrent()) {
    backgroundResponses.get(tab)?.discard(context.bindingId);
    return undefined;
  }

  if (!canAcceptTabBackgroundWork(tab)) {
    backgroundResponses.get(tab)?.discard(context.bindingId);
    return undefined;
  }
  if (event.type === 'prompt_suggestion') {
    // Transient composer presentation never enters transcript rendering or persistence. A queued
    // turn can start after deactivation discarded, so arrival into a hidden tab is dropped here.
    if (!tab.dom.contentEl.hasClass('claudian-hidden')) {
      tab.ui.promptSuggestion.receive(event.originatingTurnId, event.suggestion);
    }
    return undefined;
  }
  // Display-only progress must not wait behind queued background rendering.
  if (event.type === 'subagent_updated') {
    const previousStatus = findSubagentStatus(tab.state.messages, event.subagent.id);
    if (!tab.controllers.streamController.subagents.handleSubagentUpdate(event.subagent)) return undefined;
    // Lifecycle transitions persist in order below; same-status progress shares one trailing save.
    if (previousStatus === event.subagent.status) {
      return tab.controllers.conversationController.scheduleProgressSave(() => enqueueTabBackgroundWork(tab, async () => {
        if (!isCurrent()) return;
        await tab.controllers.conversationController.save(true);
      }));
    }
  }
  if (event.type === 'subagent_progress') {
    tab.controllers.streamController.subagents.handleSubagentProgress(event.progress);
    return undefined;
  }
  if (event.type === 'background_turn_started') {
    tab.ui.promptSuggestion.discard();
    getBackgroundResponses(tab).reserve(context.bindingId, event.scope.turnId);
  }
  const pending = enqueueTabBackgroundWork(tab, async () => {
    if (!isCurrent()) {
      backgroundResponses.get(tab)?.discard(context.bindingId);
      return;
    }
    await handleTabSessionEvent(tab, plugin, event, context, isCurrent);
  }, event.type === 'task_notification' && event.scope.kind === 'session');
  if (!pending) {
    backgroundResponses.get(tab)?.discard(context.bindingId);
  }
  return pending ?? undefined;
}

function findSubagentStatus(
  messages: readonly ChatMessage[],
  id: string,
): SubagentInfo['status'] | undefined {
  for (const message of messages) {
    const tool = message.toolCalls?.find(candidate => candidate.id === id);
    if (tool) return tool.subagent?.status;
  }
  return undefined;
}

function canAcceptTabBackgroundWork(tab: AssembledTabRuntime): boolean {
  return tab.lifecycleState !== 'closing'
    && !tab.state.isResettingToNewChat
    && !tab.state.isSwitchingConversation;
}

export function enqueueTabBackgroundWork(
  tab: AssembledTabRuntime,
  work: () => Promise<void>,
  independent = false,
): Promise<void> | null {
  if (!canAcceptTabBackgroundWork(tab)) return null;
  return tab.session.enqueueBackgroundWork(work, independent);
}

export function createTabMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
