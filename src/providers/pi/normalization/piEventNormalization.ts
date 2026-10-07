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
  emittedToolIds: Set<string>;
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
    emittedToolIds: new Set<string>(),
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
      return normalizeMessageUpdate(event);
    case 'toolcall_end':
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state);
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
    case 'compaction_end':
      return [{ type: 'context_compacted' }];
    case 'auto_retry_start':
      return [{ type: 'notice', content: 'Pi is retrying the turn.', level: 'warning' }];
    case 'auto_retry_end':
      return [{ type: 'notice', content: 'Pi retry finished.', level: 'info' }];
    case 'extension_error':
      return [{ type: 'notice', content: getString(event.error) ?? 'Pi extension error.', level: 'warning' }];
    default:
      return [];
  }
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
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state);
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

function normalizeMessageUpdate(event: Record<string, unknown>): StreamChunk[] {
  const assistantEvent = getNestedRecord(event, 'assistantMessageEvent')
    ?? getNestedRecord(event, 'assistant_message_event')
    ?? event;
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

function normalizeToolUse(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
): StreamChunk[] {
  const id = getPiToolId(event);
  if (!id || state.emittedToolIds.has(id)) {
    return [];
  }

  state.emittedToolIds.add(id);
  const name = getPiToolName(event);
  return [{
    type: 'tool_use',
    id,
    input: normalizePiToolInput(event.input ?? event.arguments ?? event.args, name),
    name,
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

  const content = extractPiToolResultText(getPiToolName(event), event.result ?? event.output ?? event.content)
    || state.toolOutputs.get(id)
    || '';
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
