import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeExecutionEventChannel, ClaudeNormalizedExecutionEvent } from './ClaudeExecutionEventNormalizer';

/** Input admission and native response progress have independent lifetimes. */
export class ClaudeResponseOwnership {
  private echoedChannel: ClaudeExecutionEventChannel | null = null;
  private readonly streams = new Map<string, ClaudeExecutionEventChannel>();
  private readonly messages = new Map<string, ClaudeExecutionEventChannel>();
  private readonly tools = new Map<string, {
    channel: ClaudeExecutionEventChannel;
    pending: boolean;
    main: boolean;
  }>();

  current(requested: boolean): ClaudeExecutionEventChannel {
    const stream = this.streams.get('main');
    if (stream) return stream;
    if (this.echoedChannel === 'background') return 'background';
    if (this.echoedChannel === 'requested' && requested) return 'requested';
    if (this.hasPending('background')) return 'background';
    return requested ? 'requested' : 'background';
  }

  hasPending(channel: ClaudeExecutionEventChannel): boolean {
    // Async child streams must not hold ownership of the main response.
    return this.streams.get('main') === channel
      || [...this.tools.values()].some(tool => tool.channel === channel && tool.main && tool.pending);
  }

  toolChannel(toolId: string): ClaudeExecutionEventChannel | undefined {
    return this.tools.get(toolId)?.channel;
  }

  resolve(message: SDKMessage, requested: boolean, inputId?: string): ClaudeExecutionEventChannel {
    const fallback = this.current(requested);
    if (message.type === 'result' && getClaudeInputMatch(message, inputId) === false) return 'background';
    if (message.type !== 'assistant' && message.type !== 'stream_event' && message.type !== 'user') {
      if ('tool_use_id' in message && typeof message.tool_use_id === 'string') {
        return this.toolChannel(message.tool_use_id) ?? fallback;
      }
      return fallback;
    }
    const parent = message.parent_tool_use_id;
    if (parent) return this.toolChannel(parent) ?? fallback;
    if (message.type === 'stream_event' || message.type === 'assistant') {
      const existing = message.type === 'assistant'
        ? this.messages.get(message.message.id)
        : message.event.type === 'message_start' ? undefined : this.streams.get('main');
      const inputMatch = getClaudeInputMatch(message, inputId);
      if (inputMatch !== undefined) this.echoedChannel = inputMatch && requested ? 'requested' : 'background';
      // A consumption echo can arrive inside an already-started message. Keep
      // that message intact; the echo governs subsequent uncorrelated output.
      return existing ?? this.echoedChannel ?? fallback;
    }
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const channel = this.toolChannel(block.tool_use_id);
          if (channel) return channel;
        }
      }
    }
    return fallback;
  }

  observe(
    message: SDKMessage,
    channel: ClaudeExecutionEventChannel,
    events: readonly ClaudeNormalizedExecutionEvent[],
  ): void {
    if (message.type === 'stream_event') {
      const key = message.parent_tool_use_id ?? 'main';
      if (message.event.type === 'message_start') {
        this.streams.set(key, channel);
        this.messages.set(message.event.message.id, channel);
      } else if (message.event.type === 'message_stop') {
        this.streams.delete(key);
      }
    }
    if (message.type === 'assistant' && message.message.id) {
      this.messages.set(message.message.id, channel);
    }
    // Observe the whole native batch before considering a transfer. Incremental
    // tool starts and their final snapshots share an ID and must not reopen it.
    for (const normalized of events) {
      if (normalized.type !== 'output') continue;
      const event = normalized.event;
      if (event.type === 'tool_started' && !this.tools.has(event.toolCallId)) {
        this.tools.set(event.toolCallId, { channel, pending: true, main: event.toolScope.kind === 'main' });
      } else if (event.type === 'tool_completed') {
        const tool = this.tools.get(event.toolCallId);
        if (tool) tool.pending = false;
      }
    }
  }

  reset(channel: ClaudeExecutionEventChannel): void {
    if (this.echoedChannel === channel) this.echoedChannel = null;
    for (const [key, owner] of this.streams) if (owner === channel) this.streams.delete(key);
    for (const [key, owner] of this.messages) if (owner === channel) this.messages.delete(key);
    for (const [key, tool] of this.tools) if (tool.channel === channel) this.tools.delete(key);
  }
}

/** Undefined preserves compatibility with producers that omit consumption echoes. */
export function getClaudeInputMatch(message: SDKMessage, inputId?: string): boolean | undefined {
  if (!inputId || (message.type !== 'assistant' && message.type !== 'stream_event' && message.type !== 'result')) {
    return undefined;
  }
  if (!message.user_message_uuid && !message.user_message_uuids?.length) {
    // Synthetic turns need not echo a UUID. The queue count still establishes
    // that this session's outstanding user send has not been consumed.
    if (message.type === 'result' && 'queued_turn_count' in message && (message.queued_turn_count ?? 0) > 0) return false;
    return undefined;
  }
  return message.user_message_uuid === inputId || message.user_message_uuids?.includes(inputId) === true;
}
