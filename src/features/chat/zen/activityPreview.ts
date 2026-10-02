import type { ChatMessage, ToolCallInfo } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { formatWorkDuration, getFinalResponseText } from '../rendering/ResponseLayout';
import type { ChatState } from '../state/ChatState';
import type { ChatActivity } from '../state/types';

export type ZenActivityTone = 'idle' | 'working' | 'action-required' | 'error';

export interface ZenActivityPreview {
  readonly text: string;
  readonly tone: ZenActivityTone;
  /** Set when the line describes a tool call, so the tool's icon can lead it. */
  readonly toolName?: string;
}

interface PreviewLine {
  readonly text: string;
  readonly toolName?: string;
}

type ActivitySource = Pick<ChatState, 'activity' | 'isStreaming' | 'lastMessage' | 'requiresAction' | 'waitingStatus'>;

const MAX_PREVIEW_LENGTH = 240;
// Only the head of a streamed block is scanned, so long responses stay O(1) per frame.
const MAX_SCAN_LENGTH = 4000;

/** Projects the first line of the latest live activity into one bounded plain-text line. */
export function formatActivityPreview(source: ActivitySource): ZenActivityPreview {
  if (source.requiresAction) {
    return { text: t('chat.zen.actionRequired'), tone: 'action-required' };
  }

  const activity = source.activity;
  if (activity?.kind === 'error') {
    return { text: t('chat.zen.error', { message: toPreviewText(activity.message) }), tone: 'error' };
  }

  const lastMessage = source.lastMessage;
  if (!source.isStreaming && lastMessage?.role === 'assistant' && lastMessage.isInterrupt) {
    return { text: t('chat.zen.interrupted'), tone: 'idle' };
  }
  if (!source.isStreaming && lastMessage?.role === 'assistant' && lastMessage.durationSeconds !== undefined) {
    return { text: describeFinishedTurn(lastMessage, lastMessage.durationSeconds, activity), tone: 'idle' };
  }

  // Mirror the main chat's waiting indicator; a running tool line stands in for its tool card.
  if (source.isStreaming && source.waitingStatus
    && !(activity?.kind === 'tool' && activity.tool.status === 'running')) {
    return { text: source.waitingStatus, tone: 'working' };
  }

  const line = activity
    ? describeActivity(activity)
    : describeMessage(lastMessage);
  const tone = source.isStreaming ? 'working' : 'idle';
  if (!line.text) return { text: source.isStreaming ? t('chat.zen.working') : '', tone };
  return line.toolName ? { text: line.text, tone, toolName: line.toolName } : { text: line.text, tone };
}

/** Mirrors the transcript's "Worked for" label, then the first line of the final answer. */
function describeFinishedTurn(message: ChatMessage, durationSeconds: number, activity: ChatActivity | null): string {
  const duration = formatWorkDuration(durationSeconds);
  // The final text block joins the message only after finalization; until then it is the latest activity.
  const result = activity
    ? (activity.kind === 'text' ? firstNonEmptyLine(activity.text) : '')
    : firstNonEmptyLine(getFinalResponseText(message));
  return result
    ? t('chat.zen.workedForResult', { duration, result })
    : t('chat.zen.workedFor', { duration });
}

function describeActivity(activity: Exclude<ChatActivity, { kind: 'error' }>): PreviewLine {
  switch (activity.kind) {
    case 'user':
      return { text: toPreviewText(activity.text) };
    case 'text':
      return { text: firstNonEmptyLine(activity.text) };
    case 'thinking':
      return { text: t('chat.zen.thinking') };
    case 'tool':
      return describeTool(activity.tool);
  }
}

function describeMessage(message: ChatMessage | null): PreviewLine {
  if (!message) return { text: '' };
  if (message.role === 'user') return { text: toPreviewText(message.displayContent ?? message.content) };

  const blocks = message.contentBlocks ?? [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === 'text') {
      const line = firstNonEmptyLine(block.content);
      if (line) return { text: line };
    } else if (block.type === 'tool_use') {
      const tool = message.toolCalls?.find(candidate => candidate.id === block.toolId);
      if (tool) return describeTool(tool);
    }
  }
  return { text: firstNonEmptyLine(message.content) };
}

function describeTool(tool: ToolCallInfo): PreviewLine {
  const name = toPreviewText(tool.name);
  return { text: t(TOOL_STATUS_KEYS[tool.status], { tool: name }), toolName: tool.name };
}

const TOOL_STATUS_KEYS = {
  running: 'chat.zen.toolRunning',
  completed: 'chat.zen.toolCompleted',
  error: 'chat.zen.toolFailed',
  blocked: 'chat.zen.toolBlocked',
} as const satisfies Record<ToolCallInfo['status'], string>;

function firstNonEmptyLine(text: string): string {
  const head = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  for (const rawLine of head.split('\n')) {
    const line = toPreviewText(rawLine.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ''));
    if (line) return line;
  }
  return '';
}

function toPreviewText(text: string): string {
  const head = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  const collapsed = head.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_PREVIEW_LENGTH
    ? `${collapsed.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
    : collapsed;
}
