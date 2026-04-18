import type { ChatTurnMetadata } from '../../../core/runtime/types';
import type { StreamChunk, UsageInfo } from '../../../core/types';

type ChunkEmitter = (chunk: StreamChunk) => void;
type TurnMetadataListener = (update: Partial<ChatTurnMetadata>) => void;

export interface OpencodeCommand {
  name: string;
  description: string;
}

export type CommandsUpdateListener = (commands: OpencodeCommand[]) => void;

type SessionUpdate = {
  sessionUpdate: string;
  [key: string]: unknown;
};

export class OpencodeNotificationRouter {
  private isPlanTurn = false;
  private planUpdateCounter = 0;
  private sawPlanDelta = false;
  private currentSessionId: string | null = null;
  private messageId: string | null = null;
  private commandsListener: CommandsUpdateListener | null = null;

  constructor(
    private readonly emit: ChunkEmitter,
    private readonly onTurnMetadata?: TurnMetadataListener,
  ) {}

  setCommandsListener(listener: CommandsUpdateListener | null): void {
    this.commandsListener = listener;
  }

  beginTurn(sessionId: string, isPlanTurn: boolean): void {
    this.isPlanTurn = isPlanTurn;
    this.sawPlanDelta = false;
    this.currentSessionId = sessionId;
    this.messageId = null;
  }

  endTurn(): void {
    this.isPlanTurn = false;
    this.sawPlanDelta = false;
    this.currentSessionId = null;
    this.messageId = null;
  }

  handleSessionUpdate(notification: { sessionId: string; update: SessionUpdate }): void {
    const { update } = notification;

    if (update.sessionUpdate !== 'agent_message_chunk' && 
        update.sessionUpdate !== 'agent_thought_chunk' &&
        update.sessionUpdate !== 'available_commands_update') {
      console.log('[OpenCode] Session update:', JSON.stringify(update, null, 2));
    }

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onAgentMessageChunk(update as unknown as AgentMessageChunkUpdate);
        break;

      case 'agent_thought_chunk':
        this.onAgentThoughtChunk(update as unknown as AgentThoughtChunkUpdate);
        break;

      case 'user_message_chunk':
        // Don't emit user message chunks - they are for internal tracking
        break;

      case 'tool_call':
        this.onToolCall(update as unknown as ToolCallUpdate);
        break;

      case 'tool_call_update':
        this.onToolCallUpdate(update as unknown as ToolCallUpdateNotification);
        break;

      case 'usage_update':
        this.onUsageUpdate(update as unknown as UsageUpdateNotification);
        break;

      case 'plan':
        this.onPlanUpdate(update as unknown as PlanUpdateNotification);
        break;

      case 'available_commands_update':
        this.onAvailableCommandsUpdate(update as unknown as AvailableCommandsUpdate);
        break;

      case 'config_option_update':
        break;

      case 'current_mode_update':
        break;

      default:
        console.log('[OpenCode] Unknown update type:', update.sessionUpdate);
        break;
    }
  }

  private onAgentMessageChunk(update: AgentMessageChunkUpdate): void {
    if (update.messageId) {
      this.messageId = update.messageId;
    }
    const content = update.content as { type: string; text: string } | undefined;
    if (content?.type === 'text' && content.text) {
      const text = content.text.trim();
      if (text.match(/^(Thought for \d+s|[*].*for \d+s)$/)) {
        return;
      }
      this.emit({ type: 'text', content: content.text });
    }
  }

  private onAgentThoughtChunk(update: AgentThoughtChunkUpdate): void {
    const content = update.content as { type: string; text: string } | undefined;
    if (content?.type === 'text' && content.text) {
      const text = content.text;
      if (text.match(/^(Thought for \d+s|[*].*for \d+s)$/)) {
        return;
      }
      this.emit({ type: 'thinking', content: text });
    }
  }

  private onUserMessageChunk(update: UserMessageChunkUpdate): void {
    const content = update.content as { type: string; text: string } | undefined;
    if (content?.type === 'text' && content.text) {
      this.emit({ type: 'user_message_start', itemId: update.messageId ?? '', content: content.text });
    }
  }

  private onToolCall(update: ToolCallUpdate): void {
    const toolKind = this.mapToolKind(update.kind);

    this.emit({
      type: 'tool_use',
      id: update.toolCallId,
      name: toolKind,
      input: update.rawInput ?? {},
    });
  }

  private onToolCallUpdate(update: ToolCallUpdateNotification): void {
    const toolKind = this.mapToolKind(update.kind);
    const { toolCallId, status } = update;

    switch (status) {
      case 'pending':
        this.emit({
          type: 'tool_use',
          id: toolCallId,
          name: toolKind,
          input: update.rawInput ?? {},
        });
        break;

      case 'in_progress':
        if (update.content && update.content.length > 0) {
          const textContent = this.extractTextContent(update.content);
          if (textContent) {
            this.emit({ type: 'tool_output', id: toolCallId, content: textContent });
          }
        }
        break;

      case 'completed': {
        const textContent = update.content ? this.extractTextContent(update.content) : undefined;
        const rawOutput = update.rawOutput;
        const output = rawOutput?.output ?? textContent ?? '';
        const isError = !!rawOutput?.error;

        this.emit({ type: 'tool_result', id: toolCallId, content: output, isError });
        break;
      }

      case 'failed': {
        const errorContent = update.rawOutput?.error ?? 'Tool execution failed';
        this.emit({ type: 'tool_result', id: toolCallId, content: errorContent, isError: true });
        break;
      }
    }
  }

  private onUsageUpdate(update: UsageUpdateNotification): void {
    const { used = 0, size } = update;
    const usage: UsageInfo = {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextWindow: size ?? 200000,
      contextWindowIsAuthoritative: true,
      contextTokens: used,
      percentage: size && used ? Math.min(100, Math.max(0, Math.round((used / size) * 100))) : 0,
    };

    this.emit({ type: 'usage', usage });
  }

  private onPlanUpdate(update: PlanUpdateNotification): void {
    this.sawPlanDelta = true;
    const entries = update.entries ?? [];

    const todos = entries.map((entry, index) => ({
      id: `plan-${index}`,
      content: entry.content ?? '',
      activeForm: '',
      status: entry.status ?? 'in_progress',
    }));

    if (todos.length > 0) {
      this.emit({
        type: 'tool_use',
        id: 'plan-tool',
        name: 'TodoWrite',
        input: { todos },
      });
      this.emit({ type: 'tool_result', id: 'plan-tool', content: 'Plan updated', isError: false });
    }
  }

  private mapToolKind(kind: string | undefined): string {
    switch (kind?.toLowerCase()) {
      case 'execute':
        return 'Bash';
      case 'edit':
        return 'Edit';
      case 'read':
        return 'Read';
      case 'search':
        return 'Search';
      case 'fetch':
        return 'WebFetch';
      case 'other':
      default:
        return 'Tool';
    }
  }

  private extractTextContent(content: Array<{ type: string; content: { type: string; text: string } }>): string | undefined {
    return content
      .filter(c => c.type === 'content')
      .map(c => (c.content as { type: string; text: string })?.text ?? '')
      .filter(Boolean)
      .join('\n');
  }

  private onAvailableCommandsUpdate(update: AvailableCommandsUpdate): void {
    if (this.commandsListener && update.availableCommands) {
      this.commandsListener(update.availableCommands);
    }
  }
}

interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  messageId?: string;
  content: { type: string; text: string };
}

interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  messageId?: string;
  content: { type: string; text: string };
}

interface UserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  messageId?: string;
  content: { type: string; text: string };
}

interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
}

interface ToolCallUpdateNotification {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: Array<{ type: string; content: { type: string; text: string } }>;
  rawInput?: Record<string, unknown>;
  rawOutput?: {
    output?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  };
}

interface UsageUpdateNotification {
  sessionUpdate: 'usage_update';
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
}

interface PlanUpdateNotification {
  sessionUpdate: 'plan';
  entries?: Array<{
    content?: string;
    status?: string;
    priority?: string;
  }>;
}

interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: OpencodeCommand[];
}
