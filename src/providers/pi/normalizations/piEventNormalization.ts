import type { StreamChunk } from '../../../core/types';
import {
  extractPiToolTextContent,
  getPiToolId,
  getPiToolName,
  normalizePiToolInput,
} from './piToolNormalization';

export interface PiEventNormalizationState {
  emittedToolIds: Set<string>;
  toolOutputs: Map<string, string>;
}

export function createPiEventNormalizationState(): PiEventNormalizationState {
  return {
    emittedToolIds: new Set<string>(),
    toolOutputs: new Map<string, string>(),
  };
}

export function normalizePiRpcEvent(
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
    case 'tool_execution_start':
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state);
    case 'tool_execution_update':
      return normalizeToolOutput(event, state);
    case 'tool_execution_end':
      return normalizeToolResult(event, state);
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

export function getPiTerminalErrorMessage(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_end' && event.type !== 'turn_end') {
    return null;
  }

  const terminalEvent = getNestedRecord(event, 'assistantMessageEvent')
    ?? getNestedRecord(event, 'assistant_message_event')
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

  const content = extractPiToolTextContent(event.partialResult ?? event.output ?? event.result ?? event.content);
  if (!content) {
    return [];
  }

  state.toolOutputs.set(id, content);
  return [{ type: 'tool_output', id, content }];
}

function normalizeToolResult(
  event: Record<string, unknown>,
  state: PiEventNormalizationState,
): StreamChunk[] {
  const id = getPiToolId(event);
  if (!id) {
    return [];
  }

  const content = extractPiToolTextContent(event.result ?? event.output ?? event.content)
    || state.toolOutputs.get(id)
    || '';
  const toolUseResult = getNestedRecord(event, 'result');
  return [{
    type: 'tool_result',
    content,
    id,
    isError: event.isError === true || event.error === true || event.success === false,
    ...(toolUseResult ? { toolUseResult } : {}),
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
