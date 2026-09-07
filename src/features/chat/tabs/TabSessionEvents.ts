import { Notice } from 'obsidian';

import type {
  ProviderBackgroundOutputEvent,
  ProviderSessionEvent,
} from '../../../core/execution';
import { TOOL_AGENT_OUTPUT } from '../../../core/tools/toolNames';
import type { ChatMessage, StreamChunk } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';
import {
  providerOutputEventToStreamChunk,
} from '../controllers/StreamController';
import type { ChatExecutionEventContext } from '../execution/ChatExecutionCoordinator';
import { updatePlanModeUI } from './TabProviderState';
import type { AssembledTabRuntime } from './types';

interface BackgroundTurnRenderResult {
  chunks: StreamChunk[];
  metadata: {
    assistantMessageId?: string;
  };
}

const backgroundTurnBuffers = new WeakMap<
  AssembledTabRuntime,
  Map<string, Map<string, ProviderBackgroundOutputEvent[]>>
>();

function normalizeProviderMode(mode: string): string {
  if (mode === 'bypassPermissions' || mode === 'yolo') return 'yolo';
  if (mode === 'plan') return 'plan';
  return 'normal';
}

async function handleTabSessionEvent(
  tab: AssembledTabRuntime,
  plugin: FeatureHost,
  event: ProviderSessionEvent,
  context: ChatExecutionEventContext,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  if (event.type === 'mode_changed') {
    await updatePlanModeUI(tab, plugin, normalizeProviderMode(event.mode));
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
    turns.set(event.scope.turnId, []);
    return;
  }
  if (event.type === 'background_turn_completed') {
    const hasBufferedTurn = turns.has(event.scope.turnId);
    const events = turns.get(event.scope.turnId) ?? [];
    turns.delete(event.scope.turnId);
    deleteBackgroundTurnBuffersIfEmpty(tab, context.bindingId, turns);
    if (!hasBufferedTurn) return;
    const chunks = events
      .map(providerOutputEventToStreamChunk)
      .filter((chunk): chunk is StreamChunk => chunk !== null);
    const hasVisibleOutput = await renderAutoTriggeredTurn(tab, {
      chunks,
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
  turns.get(event.scope.turnId)?.push(event as ProviderBackgroundOutputEvent);
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

  const pending = enqueueTabBackgroundWork(tab, async () => {
    if (!isCurrent()) {
      discardBackgroundTurnBuffers(tab, context.bindingId);
      return;
    }
    await handleTabSessionEvent(tab, plugin, event, context, isCurrent);
  });
  if (!pending) {
    discardBackgroundTurnBuffers(tab, context.bindingId);
  }
  return pending ?? undefined;
}

function getBackgroundTurnBuffers(
  tab: AssembledTabRuntime,
  bindingId: string,
): Map<string, ProviderBackgroundOutputEvent[]> {
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
  turns: Map<string, ProviderBackgroundOutputEvent[]>,
): void {
  if (turns.size > 0) return;
  const bindings = backgroundTurnBuffers.get(tab);
  bindings?.delete(bindingId);
  if (bindings?.size === 0) backgroundTurnBuffers.delete(tab);
}

function discardBackgroundTurnBuffers(tab: AssembledTabRuntime, bindingId: string): void {
  const bindings = backgroundTurnBuffers.get(tab);
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
): Promise<void> | null {
  if (!canAcceptTabBackgroundWork(tab)) return null;
  return tab.session.enqueueBackgroundWork(work);
}

export function createTabMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function isVisibleAutoTurnChunk(chunk: StreamChunk, hiddenToolIds: Set<string>): boolean {
  switch (chunk.type) {
    case 'text':
      return chunk.content.trim().length > 0;
    case 'thinking':
    case 'citations':
    case 'notice':
    case 'error':
    case 'tool_output':
    case 'context_compacted':
    case 'subagent_tool_use':
    case 'subagent_tool_result':
      return true;
    case 'tool_use':
      return chunk.name !== TOOL_AGENT_OUTPUT;
    case 'tool_result':
      return !hiddenToolIds.has(chunk.id);
    default:
      return false;
  }
}

function hasVisibleAutoTurnMessageContent(message: ChatMessage): boolean {
  if (message.content.trim().length > 0) return true;
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  return message.contentBlocks?.some(block =>
    block.type !== 'text' || block.content.trim().length > 0
  ) ?? false;
}

async function renderAutoTriggeredTurn(
  tab: AssembledTabRuntime,
  result: BackgroundTurnRenderResult,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent() || !tab.dom.contentEl.isConnected) {
    return false;
  }

  const { chunks, metadata } = result;
  if (chunks.length === 0) return false;

  const hiddenToolIds = new Set(
    chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool_use' }> =>
        chunk.type === 'tool_use' && chunk.name === TOOL_AGENT_OUTPUT
      )
      .map(chunk => chunk.id),
  );
  const hasVisibleContent = chunks.some(chunk => isVisibleAutoTurnChunk(chunk, hiddenToolIds));

  const assistantMessage: ChatMessage = {
    id: metadata.assistantMessageId ?? createTabMessageId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [],
    contentBlocks: [],
    ...(metadata.assistantMessageId && { assistantMessageId: metadata.assistantMessageId }),
  };

  const previousContentEl = tab.state.currentContentEl;
  const previousTextEl = tab.state.currentTextEl;
  const previousTextContent = tab.state.currentTextContent;
  const previousThinkingState = tab.state.currentThinkingState;

  if (hasVisibleContent) {
    tab.state.addMessage(assistantMessage);
    const messageEl = tab.renderer.addMessage(assistantMessage);
    const contentEl = messageEl?.querySelector<HTMLElement>('.claudian-message-content');
    if (contentEl) {
      if (!previousContentEl) {
        tab.state.toolCallElements.clear();
      }
      tab.state.currentContentEl = contentEl;
      tab.state.currentTextEl = null;
      tab.state.currentTextContent = '';
      tab.state.currentThinkingState = null;
    }
  }

  try {
    for (const chunk of chunks) {
      if (!isCurrent()) return false;
      await tab.controllers.streamController.handleStreamChunk(chunk, assistantMessage);
      if (!isCurrent()) return false;
    }

    if (
      isCurrent()
      && hasVisibleContent
      && !hasVisibleAutoTurnMessageContent(assistantMessage)
    ) {
      const placeholder = '(background task completed)';
      assistantMessage.content = placeholder;
      await tab.controllers.streamController.appendText(placeholder);
    }

    if (isCurrent() && hasVisibleContent) {
      await tab.controllers.streamController.finalizeCurrentThinkingBlock(assistantMessage);
      if (!isCurrent()) return false;
      await tab.controllers.streamController.finalizeCurrentTextBlock(assistantMessage);
      if (!isCurrent()) return false;
    }
  } finally {
    if (hasVisibleContent) {
      tab.controllers.streamController.hideThinkingIndicator();
      tab.services.subagentManager.resetStreamingState();
      tab.state.currentContentEl = previousContentEl;
      tab.state.currentTextEl = previousTextEl;
      tab.state.currentTextContent = previousTextContent;
      tab.state.currentThinkingState = previousThinkingState;
      tab.renderer.scrollToBottom();
    }
  }
  return hasVisibleContent;
}
