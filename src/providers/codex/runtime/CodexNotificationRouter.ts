import type { StreamChunk, UsageInfo } from '../../../core/types';
import {
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
} from '../normalization/codexToolNormalization';
import type {
  AgentMessageDeltaNotification,
  CollabAgentToolCallItem,
  CommandExecutionItem,
  ContextCompactionItem,
  ErrorNotification,
  FileChangeItem,
  ImageViewItem,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpToolCallItem,
  PlanDeltaNotification,
  ReasoningSummaryTextDeltaNotification,
  ReasoningTextDeltaNotification,
  TokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  WebSearchItem,
} from './codexAppServerTypes';

type ChunkEmitter = (chunk: StreamChunk) => void;

const COLLAB_AGENT_TOOL_MAP: Record<string, string> = {
  spawnAgent: 'spawn_agent',
  wait: 'wait',
  sendInput: 'send_input',
  resumeAgent: 'resume_agent',
  closeAgent: 'close_agent',
};

export class CodexNotificationRouter {
  private seenWebSearchIds = new Set<string>();
  private planUpdateCounter = 0;

  constructor(private readonly emit: ChunkEmitter) {}

  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'item/agentMessage/delta':
        this.onAgentMessageDelta(params as AgentMessageDeltaNotification);
        break;
      case 'item/started':
        this.onItemStarted(params as ItemStartedNotification);
        break;
      case 'item/completed':
        this.onItemCompleted(params as ItemCompletedNotification);
        break;
      case 'item/reasoning/summaryTextDelta':
        this.onReasoningSummaryDelta(params as ReasoningSummaryTextDeltaNotification);
        break;
      case 'item/reasoning/textDelta':
        this.onReasoningTextDelta(params as ReasoningTextDeltaNotification);
        break;
      case 'item/reasoning/summaryPartAdded':
        break;
      case 'item/plan/delta':
        this.onPlanDelta(params as PlanDeltaNotification);
        break;
      case 'item/commandExecution/outputDelta':
        this.onCommandOutputDelta(params as { itemId: string; delta: string });
        break;
      case 'item/fileChange/outputDelta':
        this.onFileChangeOutputDelta(params as { itemId: string; delta: string });
        break;
      case 'thread/tokenUsage/updated':
        this.onTokenUsageUpdated(params as TokenUsageUpdatedNotification);
        break;
      case 'turn/plan/updated':
        this.onPlanUpdated(params as TurnPlanUpdatedNotification);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params as TurnCompletedNotification);
        break;
      case 'error':
        this.onError(params as ErrorNotification);
        break;
      default:
        break;
    }
  }

  private onAgentMessageDelta(params: AgentMessageDeltaNotification): void {
    this.emit({ type: 'text', content: params.delta });
  }

  private onReasoningSummaryDelta(params: ReasoningSummaryTextDeltaNotification): void {
    this.emit({ type: 'thinking', content: params.delta });
  }

  private onReasoningTextDelta(params: ReasoningTextDeltaNotification): void {
    this.emit({ type: 'thinking', content: params.delta });
  }

  private onPlanDelta(params: PlanDeltaNotification): void {
    this.emit({ type: 'text', content: params.delta });
  }

  private onItemStarted(params: ItemStartedNotification): void {
    const item = params.item;

    switch (item.type) {
      case 'reasoning':
        break;

      case 'commandExecution':
        this.emitToolUseFromCommand(item as CommandExecutionItem);
        break;

      case 'fileChange':
        this.emitToolUseFromFileChange(item as FileChangeItem);
        break;

      case 'imageView':
        this.emitToolUseFromImageView(item as ImageViewItem);
        break;

      case 'webSearch':
        this.emitToolUseFromWebSearch(item as WebSearchItem);
        break;

      case 'collabAgentToolCall':
        this.emitToolUseFromCollabAgent(item as CollabAgentToolCallItem);
        break;

      case 'mcpToolCall':
        this.emitToolUseFromMcp(item as McpToolCallItem);
        break;

      case 'contextCompaction':
        this.emitContextCompactionBoundary(item as ContextCompactionItem);
        break;

      default:
        break;
    }
  }

  private onItemCompleted(params: ItemCompletedNotification): void {
    const item = params.item;

    switch (item.type) {
      case 'commandExecution':
        this.emitToolResultFromCommand(item as CommandExecutionItem);
        break;

      case 'fileChange':
        this.emitToolResultFromFileChange(item as FileChangeItem);
        break;

      case 'imageView':
        this.emitToolResultFromImageView(item as ImageViewItem);
        break;

      case 'webSearch':
        this.emitToolResultFromWebSearch(item as WebSearchItem);
        break;

      case 'collabAgentToolCall':
        this.emitToolResultFromCollabAgent(item as CollabAgentToolCallItem);
        break;

      case 'mcpToolCall':
        this.emitToolResultFromMcp(item as McpToolCallItem);
        break;

      default:
        break;
    }
  }

  // -- commandExecution -------------------------------------------------------

  private emitToolUseFromCommand(item: CommandExecutionItem): void {
    const rawAction = item.commandActions?.[0]?.command ?? item.command;
    const normalizedName = normalizeCodexToolName('command_execution');
    const input = normalizeCodexToolInput('command_execution', { command: rawAction });

    this.emit({ type: 'tool_use', id: item.id, name: normalizedName, input });
  }

  private emitToolResultFromCommand(item: CommandExecutionItem): void {
    const output = item.aggregatedOutput ?? '';
    const normalizedName = normalizeCodexToolName('command_execution');
    const content = normalizeCodexToolResult(normalizedName, output);
    const isError = item.exitCode !== null && item.exitCode !== 0;

    this.emit({ type: 'tool_result', id: item.id, content, isError });
  }

  // -- fileChange -------------------------------------------------------------

  private emitToolUseFromFileChange(item: FileChangeItem): void {
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: normalizeCodexToolName('file_change'),
      input: { changes: item.changes ?? [] },
    });
  }

  private emitToolResultFromFileChange(item: FileChangeItem): void {
    const paths = (item.changes ?? []).map(c => c.path).join(', ');
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: paths || 'File change completed',
      isError: false,
    });
  }

  // -- imageView --------------------------------------------------------------

  private emitToolUseFromImageView(item: ImageViewItem): void {
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: normalizeCodexToolName('view_image'),
      input: normalizeCodexToolInput('view_image', { path: item.path }),
    });
  }

  private emitToolResultFromImageView(item: ImageViewItem): void {
    this.emit({ type: 'tool_result', id: item.id, content: item.path, isError: false });
  }

  // -- webSearch --------------------------------------------------------------

  private emitToolUseFromWebSearch(item: WebSearchItem): void {
    if (this.seenWebSearchIds.has(item.id)) return;
    this.seenWebSearchIds.add(item.id);

    this.emit({
      type: 'tool_use',
      id: item.id,
      name: 'WebSearch',
      input: normalizeCodexToolInput('web_search', {
        query: item.query ?? '',
        queries: item.queries ?? [],
        url: item.url ?? '',
        pattern: item.pattern ?? '',
        action: item.action ?? {},
      }),
    });
  }

  private emitToolResultFromWebSearch(item: WebSearchItem): void {
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: 'Search complete',
      isError: item.status === 'failed' || item.status === 'error',
    });
  }

  // -- collabAgentToolCall ----------------------------------------------------

  private emitToolUseFromCollabAgent(item: CollabAgentToolCallItem): void {
    const toolName = COLLAB_AGENT_TOOL_MAP[item.tool] ?? item.tool;
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: toolName,
      input: item.arguments ?? {},
    });
  }

  private emitToolResultFromCollabAgent(item: CollabAgentToolCallItem): void {
    const resultText = item.result && typeof item.result === 'object'
      ? JSON.stringify(item.result)
      : item.status === 'completed' ? 'Completed' : item.status ?? 'Done';

    this.emit({
      type: 'tool_result',
      id: item.id,
      content: resultText,
      isError: item.status === 'failed' || item.status === 'error',
    });
  }

  // -- mcpToolCall ------------------------------------------------------------

  private emitToolUseFromMcp(item: McpToolCallItem): void {
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: `mcp__${item.server}__${item.tool}`,
      input: item.arguments ?? {},
    });
  }

  private emitToolResultFromMcp(item: McpToolCallItem): void {
    let content = '';
    if (item.error) {
      content = item.error;
    } else if (item.result?.content) {
      content = item.result.content
        .map(c => c.text ?? '')
        .filter(Boolean)
        .join('\n');
    }
    if (!content) {
      content = item.status === 'completed' ? 'Completed' : 'Failed';
    }

    this.emit({
      type: 'tool_result',
      id: item.id,
      content,
      isError: item.status === 'failed' || item.status === 'error',
    });
  }

  private emitContextCompactionBoundary(_item: ContextCompactionItem): void {
    this.emit({ type: 'compact_boundary' });
  }

  // -- turn/plan/updated (update_plan) ----------------------------------------

  private onPlanUpdated(params: TurnPlanUpdatedNotification): void {
    this.planUpdateCounter += 1;
    const syntheticId = `plan-update-${params.turnId ?? this.planUpdateCounter}`;
    const PLAN_STATUS_MAP: Record<string, string> = {
      inProgress: 'in_progress',
      in_progress: 'in_progress',
    };

    const todos = params.plan.map(item => ({
      id: '',
      content: item.step,
      activeForm: item.step,
      status: PLAN_STATUS_MAP[item.status] ?? item.status,
    }));

    this.emit({ type: 'tool_use', id: syntheticId, name: 'TodoWrite', input: { todos } });
    this.emit({ type: 'tool_result', id: syntheticId, content: 'Plan updated', isError: false });
  }

  // -- commandExecution/outputDelta & fileChange/outputDelta ------------------

  private onCommandOutputDelta(params: { itemId: string; delta: string }): void {
    this.emit({ type: 'tool_output', id: params.itemId, content: params.delta });
  }

  private onFileChangeOutputDelta(params: { itemId: string; delta: string }): void {
    this.emit({ type: 'tool_output', id: params.itemId, content: params.delta });
  }

  // -- tokenUsage / turnCompleted / error -------------------------------------

  private onTokenUsageUpdated(params: TokenUsageUpdatedNotification): void {
    const total = params.tokenUsage.total;
    const contextTokens = total.inputTokens + total.cachedInputTokens;
    const contextWindow = params.tokenUsage.modelContextWindow;

    const usage: UsageInfo = {
      inputTokens: total.inputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: total.cachedInputTokens,
      contextWindow,
      contextWindowIsAuthoritative: contextWindow > 0,
      contextTokens,
      percentage: contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100))) : 0,
    };

    this.emit({ type: 'usage', usage, sessionId: params.threadId });
  }

  private onTurnCompleted(params: TurnCompletedNotification): void {
    const turn = params.turn;

    if (turn.status === 'failed' && turn.error) {
      this.emit({ type: 'error', content: turn.error.message });
    }

    this.emit({ type: 'done' });
  }

  private onError(params: ErrorNotification): void {
    if (params.willRetry) return;
    this.emit({ type: 'error', content: params.error.message });
  }
}
