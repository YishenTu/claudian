import { Notice } from 'obsidian';

import type {
  ProviderBackgroundOutputEvent,
  ProviderSessionEvent,
} from '../../../core/execution';
import type { FeatureHost } from '../../FeatureHost';
import type { ChatExecutionEventContext } from '../execution/ChatExecutionCoordinator';
import { type BackgroundTurnRenderTarget, discardBackgroundTurn, renderAutoTriggeredTurn, renderSessionTaskNotification, reserveBackgroundTurn } from '../rendering/BackgroundTurnRenderer';
import { updateTabPermissionMode } from './TabProviderState';
import type { AssembledTabRuntime } from './types';

interface BackgroundTurnBuffer {
  events: ProviderBackgroundOutputEvent[];
  target?: BackgroundTurnRenderTarget;
}

const backgroundTurnBuffers = new WeakMap<
  AssembledTabRuntime,
  Map<string, Map<string, BackgroundTurnBuffer>>
>();

async function handleTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
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
  if (event.type === 'async_subagent_completed') {
    const providerSessionId = event.providerSessionId
      ?? tab.executionCoordinator.snapshot?.providerSessionId;
    if (!providerSessionId) return;
    const applied = await tab.controllers.streamController.handleAsyncSubagentCompletion({
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
  if (event.scope.kind !== 'background') return;

  const turns = getBackgroundTurnBuffers(tab, context.bindingId);
  if (event.type === 'background_turn_started') {
    return;
  }
  if (event.type === 'background_turn_completed') {
    const hasBufferedTurn = turns.has(event.scope.turnId);
    const buffer = turns.get(event.scope.turnId);
    const events = buffer?.events ?? [];
    turns.delete(event.scope.turnId);
    deleteBackgroundTurnBuffersIfEmpty(tab, context.bindingId, turns);
    if (!hasBufferedTurn) return;
    const hasVisibleOutput = await renderAutoTriggeredTurn({
      state: tab.state,
      renderer: tab.renderer,
      stream: tab.controllers.streamController,
      isConnected: () => tab.dom.contentEl.isConnected,
      createMessageId: createTabMessageId,
    }, {
      events,
      target: buffer?.target,
      metadata: {
        ...(event.nativeAssistantId
          ? { assistantMessageId: event.nativeAssistantId }
          : {}),
      },
    }, isCurrent);
    if (isCurrent()) {
      const reportReviewableSettlement = hasVisibleOutput
        ? tab.captureReviewableSettlement?.('completed')
        : null;
      try {
        await tab.controllers.conversationController.save(true);
      } finally {
        if (isCurrent()) reportReviewableSettlement?.();
      }
    }
    return;
  }
  turns.get(event.scope.turnId)?.events.push(event as ProviderBackgroundOutputEvent);
}

export function enqueueTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
): Promise<void> | undefined {
  const coordinator = tab.executionCoordinator;
  const isCurrent = () => (
    tab.executionCoordinator === coordinator
    && coordinator.isEventContextCurrent(context)
  );
  if (!isCurrent()) {
    discardBackgroundTurnBuffers(tab, context.bindingId);
    return undefined;
  }

  if (!canAcceptTabBackgroundWork(tab)) {
    discardBackgroundTurnBuffers(tab, context.bindingId);
    return undefined;
  }
  if (event.type === 'background_turn_started') {
    getBackgroundTurnBuffers(tab, context.bindingId).set(event.scope.turnId, {
      events: [],
      target: tab.dom.contentEl.isConnected ? reserveBackgroundTurn({
        state: tab.state, renderer: tab.renderer, createMessageId: createTabMessageId,
      }) : undefined,
    });
  }
  const pending = enqueueTabBackgroundWork(tab, async () => {
    if (!isCurrent()) {
      discardBackgroundTurnBuffers(tab, context.bindingId);
      return;
    }
    await handleTabSessionEvent(tab, plugin, event, context, isCurrent);
  }, event.type === 'task_notification' && event.scope.kind === 'session');
  if (!pending) {
    discardBackgroundTurnBuffers(tab, context.bindingId);
  }
  return pending ?? undefined;
}

function getBackgroundTurnBuffers(
  tab: AssembledTabRuntime,
  bindingId: string,
): Map<string, BackgroundTurnBuffer> {
  let bindings = backgroundTurnBuffers.get(tab);
  if (!bindings) {
    bindings = new Map();
    backgroundTurnBuffers.set(tab, bindings);
  }
  let turns = bindings.get(bindingId);
  if (!turns) {
    turns = new Map();
    bindings.set(bindingId, turns);
  }
  return turns;
}

function deleteBackgroundTurnBuffersIfEmpty(
  tab: AssembledTabRuntime,
  bindingId: string,
  turns: Map<string, BackgroundTurnBuffer>,
): void {
  if (turns.size > 0) return;
  const bindings = backgroundTurnBuffers.get(tab);
  bindings?.delete(bindingId);
  if (bindings?.size === 0) backgroundTurnBuffers.delete(tab);
}

function discardBackgroundTurnBuffers(tab: AssembledTabRuntime, bindingId: string): void {
  const bindings = backgroundTurnBuffers.get(tab);
  for (const buffer of bindings?.get(bindingId)?.values() ?? []) {
    if (buffer.target) discardBackgroundTurn(tab.state, buffer.target);
  }
  bindings?.delete(bindingId);
  if (bindings?.size === 0) backgroundTurnBuffers.delete(tab);
}

function canAcceptTabBackgroundWork(tab: AssembledTabRuntime): boolean {
  return tab.lifecycleState !== 'closing'
    && !tab.state.isCreatingConversation
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
