import { TOOL_AGENT_OUTPUT } from '../../../core/tools/toolNames';
import type { ChatMessage, StreamChunk } from '../../../core/types';
import type { StreamController } from '../controllers/StreamController';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { MessageRenderer } from './MessageRenderer';

interface BackgroundTurnRenderHost {
  readonly state: ChatState;
  readonly renderer: MessageRenderer;
  readonly stream: StreamController;
  readonly subagents: SubagentManager;
  isConnected(): boolean;
  createMessageId(): string;
}

interface BackgroundTurnRenderResult {
  chunks: StreamChunk[];
  metadata: { assistantMessageId?: string };
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

/** Render a settled native background turn; the caller owns storage and execution lifetime. */
export async function renderAutoTriggeredTurn(
  host: BackgroundTurnRenderHost,
  result: BackgroundTurnRenderResult,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent() || !host.isConnected()) {
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
    id: metadata.assistantMessageId ?? host.createMessageId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    completedAt: Date.now(),
    toolCalls: [],
    contentBlocks: [],
    ...(metadata.assistantMessageId && { assistantMessageId: metadata.assistantMessageId }),
  };

  const previousContentEl = host.state.currentContentEl;
  const previousTextEl = host.state.currentTextEl;
  const previousTextContent = host.state.currentTextContent;
  const previousThinkingState = host.state.currentThinkingState;

  if (hasVisibleContent) {
    host.state.addMessage(assistantMessage);
    const messageEl = host.renderer.addMessage(assistantMessage);
    const contentEl = messageEl?.querySelector<HTMLElement>('.claudian-message-content');
    if (contentEl) {
      if (!previousContentEl) {
        host.state.toolCallElements.clear();
      }
      host.state.currentContentEl = contentEl;
      host.state.currentTextEl = null;
      host.state.currentTextContent = '';
      host.state.currentThinkingState = null;
    }
  }

  try {
    for (const chunk of chunks) {
      if (!isCurrent()) return false;
      await host.stream.handleStreamChunk(chunk, assistantMessage);
      if (!isCurrent()) return false;
    }

    if (
      isCurrent()
      && hasVisibleContent
      && !hasVisibleAutoTurnMessageContent(assistantMessage)
    ) {
      const placeholder = '(background task completed)';
      assistantMessage.content = placeholder;
      await host.stream.appendText(placeholder);
    }

    if (isCurrent() && hasVisibleContent) {
      await host.stream.finalizeCurrentThinkingBlock(assistantMessage);
      if (!isCurrent()) return false;
      await host.stream.finalizeCurrentTextBlock(assistantMessage);
      if (!isCurrent()) return false;
      host.renderer.finalizeResponse(assistantMessage, [assistantMessage]);
    }
  } finally {
    if (hasVisibleContent) {
      host.stream.hideThinkingIndicator();
      host.subagents.resetStreamingState();
      host.state.currentContentEl = previousContentEl;
      host.state.currentTextEl = previousTextEl;
      host.state.currentTextContent = previousTextContent;
      host.state.currentThinkingState = previousThinkingState;
      host.renderer.scrollToBottom();
    }
  }
  return hasVisibleContent;
}
