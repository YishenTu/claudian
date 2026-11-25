import { isSessionTool } from '@/core/tools/toolNames';
import { t } from '@/i18n/i18n';

import type { StreamChunk } from '../../../core/types';
import { getPiCustomMessageDisplayText } from './piCustomMessageNormalization';
import {
  extractPiToolResultText,
  extractPiToolTextContent,
  getPiToolId,
  getPiToolName,
  normalizePiToolInput,
  normalizePiToolResultDetails,
} from './piToolNormalization';

export interface PiEventNormalizationState {
  /**
   * Tool calls shown so far, with the input last emitted. A call streamed in a reply runs only if the reply
   * completes; `settled` marks one its failed reply ended unrun.
   */
  emittedTools: Map<string, { input: string; phase: 'streamed' | 'executing' | 'settled' }>;
  /** Latest native partial-result snapshot per running tool. */
  toolOutputs: Map<string, string>;
  /** Running tools whose snapshot stopped extending the text already streamed. */
  divergedToolOutputIds: Set<string>;
  /** Complete arguments of calls a running tool made, by calling tool and nested call ID. */
  nestedToolArguments: Map<string, Map<string, unknown>>;
}

export function createPiEventNormalizationState(): PiEventNormalizationState {
  return {
    divergedToolOutputIds: new Set<string>(),
    emittedTools: new Map(),
    nestedToolArguments: new Map<string, Map<string, unknown>>(),
    toolOutputs: new Map<string, string>(),
  };
}

export function normalizePiRPCEvent(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
): StreamChunk[] {
  switch (event.type) {
    case 'agent_start':
      return [];
    case 'message_update':
      return normalizeMessageUpdate(event, state);
    case 'toolcall_end':
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state, 'executing');
    // Calls a tool makes while it runs (codemode scripts) never reach the model;
    // the calling tool's result summarizes them, as session history does.
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      return typeof event.parentToolCallId === 'string'
        ? recordNestedToolCall(event, event.parentToolCallId, state)
        : normalizeToolExecution(event, state);
    case 'message_start':
      return normalizeCustomMessage(event);
    case 'message_end':
    case 'turn_end':
      return normalizeTerminalError(event);
    case 'compaction_end': {
      if (event.aborted === true) return [];
      const errorMessage = getString(event.errorMessage);
      return errorMessage
        ? [{ type: 'notice', content: errorMessage, level: 'warning' }]
        : [{ type: 'context_compacted' }];
    }
    case 'compaction_start':
      // A manual compaction is the user's own request; automatic ones can take minutes.
      return event.reason === 'threshold' || event.reason === 'overflow'
        ? [{ type: 'notice', content: t('chat.pi.compacting'), level: 'info' }]
        : [];
    case 'auto_retry_start':
      return [{ type: 'notice', content: formatPiRetryNotice(event), level: 'warning' }];
    case 'auto_retry_end':
      // A failed final attempt reaches the transcript through its terminal error.
      return event.success === false ? [] : [{ type: 'notice', content: t('chat.pi.retryFinished'), level: 'info' }];
    case 'extension_error':
      return [{ type: 'notice', content: getString(event.error) ?? 'Pi extension error.', level: 'warning' }];
    default:
      return [];
  }
}

function formatPiRetryNotice(event: Record<string, unknown>): string {
  const attempt = event.attempt;
  const maxAttempts = event.maxAttempts;
  if (typeof attempt !== 'number' || typeof maxAttempts !== 'number') return t('chat.pi.retryingUnknownAttempt');
  const reason = getString(event.errorMessage);
  const notice = t('chat.pi.retrying', { attempt, maxAttempts });
  return reason ? `${notice} ${reason}` : notice;
}

/** Keeps nested call arguments for the calling tool's summary; nested calls emit no chunks. */
function recordNestedToolCall(
  event: Record<string, unknown>,
  parentId: string,
  state: PiEventNormalizationState,
): StreamChunk[] {
  const id = getPiToolId(event);
  if (event.type === 'tool_execution_start' && id && event.args !== undefined) {
    const calls = state.nestedToolArguments.get(parentId) ?? new Map<string, unknown>();
    calls.set(id, event.args);
    state.nestedToolArguments.set(parentId, calls);
  }
  return [];
}

function normalizeToolExecution(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
): StreamChunk[] {
  switch (event.type) {
    case 'tool_execution_start':
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state, 'executing');
    case 'tool_execution_update':
      return normalizeToolOutput(event, state);
    default:
      return normalizeToolResult(event, state);
  }
}

/** Extension messages (`pi.sendMessage`) enter the conversation as role `custom`. */
function normalizeCustomMessage(event: Record<string, unknown>): StreamChunk[] {
  const message = getNestedRecord(event, 'message');
  if (message?.role !== 'custom') return [];
  const content = getPiCustomMessageDisplayText(message);
  return content ? [{ type: 'task_notification', content }] : [];
}

/** A custom message that renders, so it opens a notification boundary in the transcript. */
export function isPiDisplayedCustomMessageStart(event: Record<string, unknown>): boolean {
  return event.type === 'message_start' && normalizeCustomMessage(event).length > 0;
}

export function getPiTerminalErrorMessage(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_end' && event.type !== 'turn_end') {
    return null;
  }

  const terminalEvent = getNestedRecord(event, 'assistantMessageEvent')
    ?? getNestedRecord(event, 'assistant_message_event')
    ?? getNestedRecord(event, 'message')
    ?? event;
  const records = terminalEvent === event ? [event] : [terminalEvent, event];
  const stopReason = getStringField(records, ['stopReason', 'stop_reason']);
  if (stopReason?.toLowerCase() !== 'error') {
    return null;
  }

  return getStringField(records, ['errorMessage', 'error_message', 'error', 'message'])
    ?? getNestedStringField(records, 'error', ['message'])
    ?? 'Pi turn failed.';
}

function normalizeMessageUpdate(event: Record<string, unknown>, state: PiEventNormalizationState): StreamChunk[] {
  const assistantEvent = getNestedRecord(event, 'assistantMessageEvent')
    ?? getNestedRecord(event, 'assistant_message_event')
    ?? event;
  // A streamed call shows from its start; its arguments arrive complete at its end.
  if (assistantEvent.type === 'toolcall_start') return normalizeToolUse(assistantEvent, state, 'streamed');
  if (assistantEvent.type === 'toolcall_end') {
    const toolCall = getNestedRecord(assistantEvent, 'toolCall');
    return toolCall ? normalizeToolUse(toolCall, state, 'streamed') : [];
  }
  const textDelta = getString(assistantEvent.text_delta)
    ?? getString(assistantEvent.textDelta)
    ?? (
      assistantEvent.type === 'text_delta'
        ? getString(assistantEvent.delta)
        : null
    );
  if (textDelta) {
    return [{ type: 'text', content: textDelta }];
  }

  const thinkingDelta = getString(assistantEvent.thinking_delta)
    ?? getString(assistantEvent.thinkingDelta)
    ?? (
      assistantEvent.type === 'thinking_delta'
        ? getString(assistantEvent.delta)
        : null
    );
  if (thinkingDelta) {
    return [{ type: 'thinking', content: thinkingDelta }];
  }

  return [];
}

function normalizeTerminalError(event: Record<string, unknown>): StreamChunk[] {
  const message = getPiTerminalErrorMessage(event);
  return message ? [{ type: 'error', content: message }] : [];
}

/**
 * Pi runs no call of a reply that ends in an error or abort, so its streamed cards end failed. Callers apply
 * this to every message_end, including the terminal errors they report themselves.
 */
export function settlePiUnrunStreamedTools(event: Record<string, unknown>, state: PiEventNormalizationState): StreamChunk[] {
  const message = getNestedRecord(event, 'message');
  if (message?.role !== 'assistant' || (message.stopReason !== 'error' && message.stopReason !== 'aborted')) return [];
  // A stopped reply is an interruption, not a failure to explain; history shows no abort text either.
  const content = message.stopReason === 'error' ? getString(message.errorMessage) ?? '' : '';
  const chunks: StreamChunk[] = [];
  for (const [id, tool] of state.emittedTools) {
    if (tool.phase !== 'streamed') continue;
    tool.phase = 'settled';
    chunks.push({ type: 'tool_result', id, content, isError: true });
  }
  return chunks;
}

function normalizeToolUse(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
  phase: 'streamed' | 'executing',
): StreamChunk[] {
  const id = getPiToolId(event);
  if (!id) {
    return [];
  }

  const name = getPiToolName(event);
  const input = normalizePiToolInput(event.input ?? event.arguments ?? event.args, name);
  const emitted = state.emittedTools.get(id);
  const serialized = JSON.stringify(input);
  if (emitted) {
    if (emitted.phase === 'streamed') emitted.phase = phase;
    // Repeated starts of a call add nothing unless they carry other arguments than already shown.
    if (emitted.input === serialized || Object.keys(input).length === 0) return [];
    emitted.input = serialized;
  } else {
    state.emittedTools.set(id, { input: serialized, phase });
  }
  return [{
    type: 'tool_use',
    id,
    input,
    name,
    ...(isSessionTool(name) ? { providerPayload: { rawName: name } } : {}),
  }];
}

function normalizeToolOutput(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
): StreamChunk[] {
  const id = getPiToolId(event);
  if (!id) {
    return [];
  }

  const content = getToolOutputDelta(id, event.partialResult ?? event.output ?? event.result ?? event.content, state);
  // Script tools report the calls they make as they run.
  const resultDetails = normalizePiToolResultDetails(getPiToolName(event), event.partialResult, state.nestedToolArguments.get(id));
  return content || resultDetails
    ? [{ type: 'tool_output', id, content, ...(resultDetails ? { resultDetails } : {}) }]
    : [];
}

function getToolOutputDelta(id: string, snapshot: unknown, state: PiEventNormalizationState): string {
  const content = extractPiToolTextContent(snapshot);
  if (!content) {
    return '';
  }

  // Pi's partialResult is the tool's latest snapshot (native bash sends its
  // rolling output tail), but tool_output chunks are appended by consumers.
  // Stream only suffix growth. Once a snapshot stops extending the streamed
  // text (window shift, reset, or replacement), the neutral contract cannot
  // replace it, so live output stops until tool_result supplies the final text.
  const previous = state.toolOutputs.get(id) ?? '';
  state.toolOutputs.set(id, content);
  if (state.divergedToolOutputIds.has(id)) {
    return '';
  }
  if (!content.startsWith(previous)) {
    state.divergedToolOutputIds.add(id);
    return '';
  }
  return content.slice(previous.length);
}

function normalizeToolResult(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
): StreamChunk[] {
  const id = getPiToolId(event);
  if (!id) {
    return [];
  }

  const result = event.result ?? event.output ?? event.content;
  const content = result === undefined
    ? state.toolOutputs.get(id) ?? ''
    : extractPiToolResultText(getPiToolName(event), result);
  state.toolOutputs.delete(id);
  state.divergedToolOutputIds.delete(id);
  const resultDetails = normalizePiToolResultDetails(getPiToolName(event), event.result, state.nestedToolArguments.get(id));
  state.nestedToolArguments.delete(id);
  return [{
    type: 'tool_result',
    content,
    id,
    isError: event.isError === true || event.error === true || event.success === false,
    ...(resultDetails ? { resultDetails } : {}),
  }];
}

function getNestedRecord(
  event: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = event[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getStringField(
  records: Array<Record<string, unknown>>,
  keys: string[],
): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = getString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function getNestedStringField(
  records: Array<Record<string, unknown>>,
  parentKey: string,
  keys: string[],
): string | null {
  for (const record of records) {
    const nested = getNestedRecord(record, parentKey);
    if (!nested) {
      continue;
    }
    const value = getStringField([nested], keys);
    if (value) {
      return value;
    }
  }
  return null;
}
