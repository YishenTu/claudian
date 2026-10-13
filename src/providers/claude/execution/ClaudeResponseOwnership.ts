import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderToolPolicy } from '@/core/execution';

import type { ClaudeExecutionEventChannel, ClaudeNormalizedExecutionEvent } from './ClaudeExecutionEventNormalizer';

export interface ClaudeToolCallOwner {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly toolPolicy: ProviderToolPolicy | undefined;
}

/** Input admission and native response progress have independent lifetimes. */
export class ClaudeResponseOwnership {
  private readonly ownerListeners = new Set<(toolId: string, owner: ClaudeToolCallOwner | undefined) => void>();
  private echoedChannel: ClaudeExecutionEventChannel | null = null;
  private readonly streams = new Map<string, ClaudeExecutionEventChannel>();
  private readonly messages = new Map<string, ClaudeExecutionEventChannel>();
  private readonly tools = new Map<string, {
    channel: ClaudeExecutionEventChannel | undefined;
    owner?: ClaudeToolCallOwner;
    pending: boolean;
    main: boolean;
  }>();
  // Pending main-scope tools per channel; hasPending runs for every SDK message.
  private readonly pendingMainTools: Record<ClaudeExecutionEventChannel, number> = {
    requested: 0,
    background: 0,
  };

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
      || this.pendingMainTools[channel] > 0;
  }

  toolChannel(toolId: string): ClaudeExecutionEventChannel | undefined {
    return this.tools.get(toolId)?.channel;
  }

  toolOwner(toolId: string): ClaudeToolCallOwner | undefined {
    return this.tools.get(toolId)?.owner;
  }

  waitForToolOwner(toolId: string, signal: AbortSignal): Promise<ClaudeToolCallOwner | undefined> {
    if (signal.aborted || this.tools.has(toolId)) return Promise.resolve(this.toolOwner(toolId));
    // SDK control requests can overtake its async output iterator. Correlate by
    // native ID only; never substitute whichever run happens to be active.
    return new Promise(resolve => {
      const finish = (owner?: ClaudeToolCallOwner) => {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.ownerListeners.delete(observe);
        resolve(owner);
      };
      const abort = () => finish();
      const observe = (id: string, owner: ClaudeToolCallOwner | undefined) => {
        if (id === toolId) finish(owner);
      };
      const timer = window.setTimeout(() => finish(), 5_000);
      this.ownerListeners.add(observe);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  clear(): void {
    this.reset('requested');
    this.reset('background');
    this.tools.clear();
  }

  resolve(message: SDKMessage, requested: boolean, inputIds?: readonly string[]): ClaudeExecutionEventChannel {
    const fallback = this.current(requested);
    if (message.type === 'result' && getClaudeInputMatch(message, inputIds) === false) return 'background';
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
      const inputMatch = getClaudeInputMatch(message, inputIds);
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
    getOwner?: () => ClaudeToolCallOwner | undefined,
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
      const existing = 'toolCallId' in event ? this.tools.get(event.toolCallId) : undefined;
      if (event.type === 'tool_started' && !existing?.channel) {
        const main = event.toolScope.kind === 'main';
        const parent = event.parentToolCallId;
        const owner = existing ? existing.owner : parent ? this.toolOwner(parent) : getOwner?.();
        this.tools.set(event.toolCallId, { channel, pending: true, main, owner });
        for (const listener of this.ownerListeners) listener(event.toolCallId, owner);
        if (main) this.pendingMainTools[channel] += 1;
      } else if (event.type === 'tool_completed') {
        const tool = this.tools.get(event.toolCallId);
        if (tool?.pending && tool.main && tool.channel) this.pendingMainTools[tool.channel] -= 1;
        if (tool) tool.pending = false;
      }
    }
  }

  reset(channel: ClaudeExecutionEventChannel): void {
    if (this.echoedChannel === channel) this.echoedChannel = null;
    for (const [key, owner] of this.streams) if (owner === channel) this.streams.delete(key);
    for (const [key, owner] of this.messages) if (owner === channel) this.messages.delete(key);
    // Retain lifetime identity after output settlement: late native calls must
    // keep the original (now revoked) run, even when another run is active.
    for (const tool of this.tools.values()) {
      if (tool.channel !== channel) continue;
      tool.channel = undefined;
      tool.pending = false;
    }
    this.pendingMainTools[channel] = 0;
  }
}

/** Undefined preserves compatibility with producers that omit consumption echoes. */
export function getClaudeInputMatch(message: SDKMessage, inputIds?: readonly string[]): boolean | undefined {
  if (!inputIds?.length || (message.type !== 'assistant' && message.type !== 'stream_event' && message.type !== 'result')) {
    return undefined;
  }
  if (!message.user_message_uuid && !message.user_message_uuids?.length) {
    // Synthetic turns need not echo a UUID. The queue count still establishes
    // that this session's outstanding user send has not been consumed.
    if (message.type === 'result' && 'queued_turn_count' in message && (message.queued_turn_count ?? 0) > 0) return false;
    return undefined;
  }
  return inputIds.some(id => message.user_message_uuid === id || message.user_message_uuids?.includes(id) === true);
}
