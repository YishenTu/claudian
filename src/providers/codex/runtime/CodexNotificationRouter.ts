import * as path from 'path';

import type { CitationGroup, StreamChunk, UsageInfo } from '../../../core/types';
import { extractCodexUserVisibleText, joinCodexUserTextParts } from '../codexUserText';
import {
  normalizeCodexMemoryCitation,
  stripCodexMemoryCitationMarkup,
} from '../normalization/CodexMemoryCitation';
import {
  appendCodexCommandOutput,
  decodeCodexExecEnvelopeCalls,
  extractCodexExecCellId,
  isCodexToolOutputError,
  normalizeCodexToolCall,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
  readCodexExecCellIdArgument,
  stringifyCodexToolOutput,
} from '../normalization/codexToolNormalization';
import type {
  AgentMessageDeltaNotification,
  AgentMessageItem,
  CollabAgentToolCallItem,
  CommandExecutionItem,
  ContextCompactionItem,
  DynamicToolCallItem,
  ErrorNotification,
  FileChangeItem,
  FileChangePatchUpdatedNotification,
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
  UserInput,
  UserMessageItem,
  WebSearchItem,
} from './codexAppServerTypes';

type ChunkEmitter = (chunk: StreamChunk) => void;
type TurnMetadataListener = (update: {
  assistantMessageId?: string;
  planCompleted?: boolean;
}) => void;

interface RawToolResult {
  content: string;
  isError: boolean;
}

interface WrappedWaitCall {
  commandCallId: string;
  cellId: string;
}

interface PendingWrappedWaitCall {
  callId: string;
  cellId: string;
  item: Record<string, unknown>;
  rawArguments: Record<string, unknown>;
}

interface RawCommandProjection {
  callId: string;
  visibleId: string;
  command: string;
  workingDirectory?: string;
  rawOwnsCompletion: boolean;
}

interface CanonicalCommandProjection {
  itemId: string;
  commands: string[];
  workingDirectory?: string;
}

interface DeferredRawExecCall {
  callId: string;
  item: Record<string, unknown>;
  rawArguments: Record<string, unknown>;
  expectedCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    comparisonInput?: Record<string, unknown>;
    claimed: boolean;
    canonicalItemId?: string;
    canonicalCompleted?: boolean;
  }>;
  hasRawOutput?: boolean;
  rawOutput?: unknown;
}

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
  private isPlanTurn = false;
  private sawPlanDelta = false;
  private startedUserMessageIds = new Set<string>();
  private startedAgentMessageIds = new Set<string>();
  private agentMessageDeltaIds = new Set<string>();
  private emittedMemoryCitationIds = new Set<string>();
  private emittedMemoryCitationKeys = new Set<string>();
  private streamedAssistantTurnText = '';
  private currentAssistantSegmentId: string | undefined;
  private currentAssistantSegmentText = '';
  private seenRawCallIds = new Set<string>();
  private pendingRawOutputItemsByCallId = new Map<string, Record<string, unknown>>();
  private rawStartedCallIds = new Set<string>();
  private startedCanonicalToolItemIds = new Set<string>();
  private completedCanonicalToolItemIds = new Set<string>();
  private rawToolNamesByCallId = new Map<string, string>();
  private rawToolInputsByCallId = new Map<string, Record<string, unknown>>();
  private rawToolOutputsByCallId = new Map<string, RawToolResult>();
  private handledRawOutputCallIds = new Set<string>();
  private inFlightRawFunctionCallIds = new Set<string>();
  private immediateRawOutputCallIds = new Set<string>();
  private emittedImmediateToolResultIds = new Set<string>();
  private wrappedCommandCallIdsByCellId = new Map<string, string>();
  private wrappedCommandOutputByCallId = new Map<string, string>();
  private wrappedWaitCallsByCallId = new Map<string, WrappedWaitCall>();
  private pendingWrappedWaitCallsByCallId = new Map<string, PendingWrappedWaitCall>();
  private canonicalCommandOutputByItemId = new Map<string, string>();
  private pendingCanonicalToolOutputByItemId = new Map<string, string[]>();
  private canonicalPrefilledRawCommandCallIds = new Set<string>();
  // Raw tool calls and canonical command items describe the same work with unrelated IDs.
  // A uniquely correlated command keeps whichever projection started first as the visible row.
  private unmatchedRawCommands: RawCommandProjection[] = [];
  private unmatchedCanonicalCommands: CanonicalCommandProjection[] = [];
  private rawCommandByCanonicalId = new Map<string, RawCommandProjection>();
  // Non-Bash Code Mode exec calls are transport envelopes. Canonical items own their
  // semantic lifecycles; the envelope remains available as a lossless raw-only fallback.
  private deferredRawExecCalls = new Map<string, DeferredRawExecCall>();
  private projectedCanonicalItemIds = new Set<string>();
  private activeCanonicalToolProjections = new Map<string, CanonicalToolProjection>();
  private deferredOwnedCanonicalItemIds = new Set<string>();
  private ignoredLateRawOutputCallIds = new Set<string>();
  private suppressedRawCallIds = new Set<string>();
  private fileChangeInputsById = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly emit: ChunkEmitter,
    private readonly onTurnMetadata?: TurnMetadataListener,
    private readonly workingDirectory?: string,
  ) {}

  private resetAssistantTextTracking(): void {
    this.streamedAssistantTurnText = '';
    this.resetAssistantSegmentText();
  }

  private resetAssistantSegmentText(): void {
    this.currentAssistantSegmentId = undefined;
    this.currentAssistantSegmentText = '';
  }

  private beginAssistantSegment(itemId: string): void {
    if (this.currentAssistantSegmentId === itemId) {
      return;
    }

    this.currentAssistantSegmentId = itemId;
    this.currentAssistantSegmentText = '';
  }

  private claimAssistantSegment(itemId?: string): void {
    if (!itemId) {
      return;
    }

    if (this.currentAssistantSegmentId && this.currentAssistantSegmentId !== itemId) {
      this.beginAssistantSegment(itemId);
      return;
    }

    if (!this.currentAssistantSegmentId) {
      this.currentAssistantSegmentId = itemId;
    }
  }

  private appendAssistantText(text: string, itemId?: string): void {
    if (!text) {
      return;
    }

    this.claimAssistantSegment(itemId);

    this.currentAssistantSegmentText += text;
    this.streamedAssistantTurnText += text;
  }

  beginTurn(params: { isPlanTurn: boolean }): void {
    this.isPlanTurn = params.isPlanTurn;
    this.sawPlanDelta = false;
    this.startedUserMessageIds.clear();
    this.startedAgentMessageIds.clear();
    this.agentMessageDeltaIds.clear();
    this.emittedMemoryCitationIds.clear();
    this.emittedMemoryCitationKeys.clear();
    this.resetAssistantTextTracking();
    this.seenRawCallIds.clear();
    this.pendingRawOutputItemsByCallId.clear();
    this.rawStartedCallIds.clear();
    this.startedCanonicalToolItemIds.clear();
    this.completedCanonicalToolItemIds.clear();
    this.rawToolNamesByCallId.clear();
    this.rawToolInputsByCallId.clear();
    this.rawToolOutputsByCallId.clear();
    this.handledRawOutputCallIds.clear();
    this.inFlightRawFunctionCallIds.clear();
    this.immediateRawOutputCallIds.clear();
    this.emittedImmediateToolResultIds.clear();
    this.wrappedCommandCallIdsByCellId.clear();
    this.wrappedCommandOutputByCallId.clear();
    this.wrappedWaitCallsByCallId.clear();
    this.pendingWrappedWaitCallsByCallId.clear();
    this.canonicalCommandOutputByItemId.clear();
    this.pendingCanonicalToolOutputByItemId.clear();
    this.canonicalPrefilledRawCommandCallIds.clear();
    this.unmatchedRawCommands.length = 0;
    this.unmatchedCanonicalCommands.length = 0;
    this.rawCommandByCanonicalId.clear();
    this.deferredRawExecCalls.clear();
    this.projectedCanonicalItemIds.clear();
    this.activeCanonicalToolProjections.clear();
    this.deferredOwnedCanonicalItemIds.clear();
    this.ignoredLateRawOutputCallIds.clear();
    this.suppressedRawCallIds.clear();
    this.fileChangeInputsById.clear();
  }

  endTurn(): void {
    this.isPlanTurn = false;
    this.sawPlanDelta = false;
    this.startedUserMessageIds.clear();
    this.startedAgentMessageIds.clear();
    this.agentMessageDeltaIds.clear();
    this.emittedMemoryCitationIds.clear();
    this.emittedMemoryCitationKeys.clear();
    this.resetAssistantTextTracking();
    this.seenRawCallIds.clear();
    this.pendingRawOutputItemsByCallId.clear();
    this.rawStartedCallIds.clear();
    this.startedCanonicalToolItemIds.clear();
    this.completedCanonicalToolItemIds.clear();
    this.rawToolNamesByCallId.clear();
    this.rawToolInputsByCallId.clear();
    this.rawToolOutputsByCallId.clear();
    this.handledRawOutputCallIds.clear();
    this.inFlightRawFunctionCallIds.clear();
    this.immediateRawOutputCallIds.clear();
    this.emittedImmediateToolResultIds.clear();
    this.wrappedCommandCallIdsByCellId.clear();
    this.wrappedCommandOutputByCallId.clear();
    this.wrappedWaitCallsByCallId.clear();
    this.pendingWrappedWaitCallsByCallId.clear();
    this.canonicalCommandOutputByItemId.clear();
    this.pendingCanonicalToolOutputByItemId.clear();
    this.canonicalPrefilledRawCommandCallIds.clear();
    this.unmatchedRawCommands.length = 0;
    this.unmatchedCanonicalCommands.length = 0;
    this.rawCommandByCanonicalId.clear();
    this.deferredRawExecCalls.clear();
    this.projectedCanonicalItemIds.clear();
    this.activeCanonicalToolProjections.clear();
    this.deferredOwnedCanonicalItemIds.clear();
    this.ignoredLateRawOutputCallIds.clear();
    this.suppressedRawCallIds.clear();
    this.fileChangeInputsById.clear();
  }

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
        this.onOutputDelta(params as { itemId: string; delta: string }, true);
        break;
      case 'item/fileChange/outputDelta':
        this.onOutputDelta(params as { itemId: string; delta: string }, false);
        break;
      case 'item/fileChange/patchUpdated':
        this.onFileChangePatchUpdated(params as FileChangePatchUpdatedNotification);
        break;
      case 'rawResponseItem/completed':
        this.onRawResponseItemCompleted(params);
        break;
      case 'event_msg':
        this.onEventMsg(params);
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
    this.agentMessageDeltaIds.add(params.itemId);
    this.appendAssistantText(params.delta, params.itemId);
    this.emit({ type: 'text', content: params.delta });
  }

  private onReasoningSummaryDelta(params: ReasoningSummaryTextDeltaNotification): void {
    this.emit({ type: 'thinking', content: params.delta });
  }

  private onReasoningTextDelta(params: ReasoningTextDeltaNotification): void {
    this.emit({ type: 'thinking', content: params.delta });
  }

  private onPlanDelta(params: PlanDeltaNotification): void {
    this.sawPlanDelta = true;
    this.emit({ type: 'text', content: params.delta });
  }

  private onItemStarted(params: ItemStartedNotification): void {
    const item = params.item;
    const itemId = getItemId(item);
    const deferredOwned = this.claimDeferredRawExecFromItem(item, false);
    if (item.type === 'commandExecution' && !deferredOwned) {
      if (this.claimPendingRawCommand(item)) {
        this.activeCanonicalToolProjections.delete(item.id);
        this.flushPendingCanonicalToolOutput(item.id);
        return;
      }
    }
    if (itemId && this.rawStartedCallIds.has(itemId)) {
      this.flushPendingCanonicalToolOutput(itemId);
      return;
    }
    if (itemId && isCanonicalToolItem(item)) {
      if (this.startedCanonicalToolItemIds.has(itemId)) {
        return;
      }
      this.startedCanonicalToolItemIds.add(itemId);
    }

    switch (item.type) {
      case 'userMessage':
        this.emitUserMessageBoundary(item);
        break;

      case 'agentMessage':
        this.emitAgentMessageBoundary(item);
        break;

      case 'reasoning':
        break;

      case 'commandExecution':
        this.emitToolUseFromCommand(item);
        if (!deferredOwned) {
          this.unmatchedCanonicalCommands.push({
            itemId: item.id,
            commands: readCanonicalCommandCandidates(item),
            workingDirectory: normalizeWorkingDirectory(item.cwd, this.workingDirectory),
          });
        }
        break;

      case 'fileChange':
        this.emitToolUseFromFileChange(item);
        break;

      case 'imageView':
        this.emitToolUseFromImageView(item);
        break;

      case 'webSearch':
        this.emitToolUseFromWebSearch(item);
        break;

      case 'collabAgentToolCall':
        this.emitToolUseFromCollabAgent(item);
        break;

      case 'mcpToolCall':
        this.emitToolUseFromMcp(item);
        break;

      case 'dynamicToolCall':
        this.emitToolUseFromDynamic(item);
        break;

      default:
        break;
    }
    if (itemId && isCanonicalToolItem(item)) {
      this.flushPendingCanonicalToolOutput(itemId);
    }
  }

  private onItemCompleted(params: ItemCompletedNotification): void {
    const item = params.item;
    const itemId = getItemId(item);
    if (itemId && isCanonicalToolItem(item)) {
      if (this.completedCanonicalToolItemIds.has(itemId)) {
        return;
      }
      this.completedCanonicalToolItemIds.add(itemId);
      this.inFlightRawFunctionCallIds.delete(itemId);
    }
    const deferredOwned = this.claimDeferredRawExecFromItem(item, true);
    if (itemId && deferredOwned) {
      this.markDeferredCanonicalCompleted(itemId);
    }
    const rawResult = item.type !== 'commandExecution' && itemId
      ? this.consumeRawToolOutput(itemId)
      : undefined;
    const hadCanonicalToolUse = itemId
      ? this.startedCanonicalToolItemIds.has(itemId)
      : false;
    const completedCommandRawProjection = item.type === 'commandExecution' && !deferredOwned
      ? this.rawCommandByCanonicalId.get(item.id) ?? this.claimPendingRawCommand(item)
      : undefined;
    if (item.type === 'commandExecution') {
      if (!this.startedCanonicalToolItemIds.has(item.id) && !completedCommandRawProjection) {
        this.startedCanonicalToolItemIds.add(item.id);
        this.emitToolUseFromCommand(item);
      } else if (completedCommandRawProjection) {
        this.startedCanonicalToolItemIds.add(item.id);
      }
    } else {
      this.ensureCanonicalToolUseFromCompletion(item);
    }
    if (itemId && isCanonicalToolItem(item)) {
      this.flushPendingCanonicalToolOutput(itemId);
    }

    switch (item.type) {
      case 'userMessage':
        if (!this.startedUserMessageIds.has(item.id)) {
          this.emitUserMessageBoundary(item);
        }
        break;

      case 'agentMessage':
        this.completeAgentMessage(item);
        break;

      case 'commandExecution':
        this.completeCommand(item, false, completedCommandRawProjection);
        break;

      case 'fileChange':
        if (hadCanonicalToolUse) {
          this.emitToolUseFromFileChange(item);
        }
        this.emitToolResultFromFileChange(item);
        break;

      case 'imageView':
        this.emitToolResultFromImageView(item);
        break;

      case 'webSearch':
        this.emitToolResultFromWebSearch(item);
        break;

      case 'collabAgentToolCall':
        this.emitToolResultFromCollabAgent(item);
        break;

      case 'mcpToolCall':
        this.emitToolResultFromMcp(item);
        break;

      case 'dynamicToolCall':
        this.emitToolResultFromDynamic(item);
        break;

      case 'contextCompaction':
        this.emitContextCompactionBoundary(item);
        break;

      default:
        if (itemId && rawResult) {
          this.emit({ type: 'tool_result', id: itemId, ...rawResult });
        }
        break;
    }

    if (
      itemId
      && item.type !== 'commandExecution'
      && this.rawStartedCallIds.has(itemId)
      && !rawResult
    ) {
      this.ignoredLateRawOutputCallIds.add(itemId);
    }
  }

  private onRawResponseItemCompleted(params: unknown): void {
    const item = asRecord(asRecord(params)?.item);
    const itemType = typeof item?.type === 'string' ? item.type : undefined;
    if (!item || !itemType) {
      return;
    }

    switch (itemType) {
      case 'function_call':
        this.handleRawFunctionCall(item);
        this.replayPendingRawToolOutput(item);
        break;

      case 'custom_tool_call':
        this.handleRawCustomToolCall(item);
        this.replayPendingRawToolOutput(item);
        break;

      case 'function_call_output':
      case 'custom_tool_call_output':
        this.handleRawToolOutput(item);
        break;

      case 'agentMessage':
      case 'message':
        this.emitMissingRawAgentMessageText(item);
        break;

      default:
        break;
    }
  }

  private onEventMsg(params: unknown): void {
    const payload = asRecord(params);
    if (!payload) {
      return;
    }

    const payloadType = typeof payload.type === 'string' ? payload.type : undefined;
    if (payloadType !== 'agent_message') {
      return;
    }

    const text = stripCodexMemoryCitationMarkup(
      firstString(payload.text, payload.message),
    );
    this.emitMissingAssistantTurnText(text);
    this.emitMemoryCitation(
      payload.memory_citation ?? payload.memoryCitation,
    );
  }

  private handleRawFunctionCall(item: Record<string, unknown>): void {
    const rawName = firstString(item.name, item.type);
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }
    if (this.seenRawCallIds.has(callId)) {
      return;
    }
    this.seenRawCallIds.add(callId);
    if (this.completedCanonicalToolItemIds.has(callId)) {
      this.ignoredLateRawOutputCallIds.add(callId);
      return;
    }
    const rawArguments = parseRawArguments(item);
    if (rawName === 'wait') {
      const cellId = readCodexExecCellIdArgument(rawArguments);
      const commandCallId = cellId
        ? this.wrappedCommandCallIdsByCellId.get(cellId)
        : undefined;
      if (cellId && commandCallId) {
        this.wrappedWaitCallsByCallId.set(callId, { commandCallId, cellId });
        return;
      }
      if (cellId) {
        this.pendingWrappedWaitCallsByCallId.set(callId, {
          callId,
          cellId,
          item,
          rawArguments,
        });
        return;
      }
    }

    if (rawName === 'write_stdin' && isSilentWriteStdinInput(rawArguments)) {
      this.suppressedRawCallIds.add(callId);
      return;
    }

    this.inFlightRawFunctionCallIds.add(callId);
    this.emitRawToolUse(callId, rawName, item, rawArguments);
  }

  private handleRawCustomToolCall(item: Record<string, unknown>): void {
    const rawName = firstString(item.name, item.type);
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }
    if (this.seenRawCallIds.has(callId)) {
      return;
    }
    this.seenRawCallIds.add(callId);
    if (this.completedCanonicalToolItemIds.has(callId)) {
      this.ignoredLateRawOutputCallIds.add(callId);
      return;
    }

    const rawArguments = parseRawArguments(item);
    if (rawName === 'apply_patch') {
      const input = normalizeCodexToolInput(rawName, rawArguments);
      this.rememberFileChangeInput(callId, input);
      this.deferredRawExecCalls.set(callId, {
        callId,
        item,
        rawArguments,
        expectedCalls: [{ name: 'apply_patch', input, claimed: false }],
      });
      this.claimActiveCanonicalProjections();
      return;
    }

    if (rawName === 'exec') {
      const expectedCalls = decodeCodexExecEnvelopeCalls(rawArguments);
      const isSingleCommand = expectedCalls?.length === 1
        && expectedCalls[0]?.name === 'Bash';
      if (!isSingleCommand) {
        this.deferredRawExecCalls.set(callId, {
          callId,
          item,
          rawArguments,
          expectedCalls: (expectedCalls ?? []).map((call) => {
            const semanticCall = projectRawSemanticToolCall(
              call.name,
              call.input,
              call.rawName,
              call.rawInput,
              this.workingDirectory,
            );
            return { ...semanticCall, claimed: false };
          }),
        });
        this.claimActiveCanonicalProjections();
        return;
      }
    }

    // Raw custom output is terminal unless a canonical dynamic-tool completion also arrives.
    this.immediateRawOutputCallIds.add(callId);
    this.emitRawToolUse(callId, rawName, item, rawArguments);
  }

  private emitRawToolUse(
    callId: string,
    rawName: string,
    item: Record<string, unknown>,
    rawArguments?: Record<string, unknown>,
    fromCanonicalProjection = false,
  ): void {
    const toolArguments = rawArguments ?? parseRawArguments(item);
    const normalized = normalizeCodexToolCall(
      rawName,
      toolArguments,
    );

    if (this.rawStartedCallIds.has(callId)) {
      this.rawToolNamesByCallId.set(callId, normalized.name);
      this.rawToolInputsByCallId.set(callId, normalized.input);
      return;
    }

    this.rawStartedCallIds.add(callId);
    this.rawToolNamesByCallId.set(callId, normalized.name);
    this.rawToolInputsByCallId.set(callId, normalized.input);
    if (
      normalized.name !== 'Bash'
      && !fromCanonicalProjection
      && this.startedCanonicalToolItemIds.has(callId)
    ) {
      return;
    }
    const command = normalized.name === 'Bash'
      ? firstString(normalized.input.command)
      : '';
    if (command) {
      const workingDirectory = this.readRawCommandWorkingDirectory(rawName, toolArguments);
      const canonicalCommand = this.takeUniqueCanonicalCommand(command, workingDirectory);
      const projection: RawCommandProjection = {
        callId,
        visibleId: canonicalCommand?.itemId ?? callId,
        command,
        workingDirectory,
        rawOwnsCompletion: this.immediateRawOutputCallIds.has(callId),
      };
      if (canonicalCommand) {
        this.rawCommandByCanonicalId.set(canonicalCommand.itemId, projection);
        this.activeCanonicalToolProjections.delete(canonicalCommand.itemId);
        const streamedOutput = this.canonicalCommandOutputByItemId.get(canonicalCommand.itemId);
        this.canonicalCommandOutputByItemId.delete(canonicalCommand.itemId);
        if (streamedOutput && projection.rawOwnsCompletion) {
          this.wrappedCommandOutputByCallId.set(callId, streamedOutput);
          this.canonicalPrefilledRawCommandCallIds.add(callId);
        }
      } else {
        this.unmatchedRawCommands.push(projection);
      }

      if (canonicalCommand) {
        return;
      }
    }

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: callId,
      name: normalized.name,
      input: normalized.input,
    });
  }

  private handleRawToolOutput(item: Record<string, unknown>): void {
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }
    if (
      !this.seenRawCallIds.has(callId)
      && !this.rawStartedCallIds.has(callId)
      && !this.deferredRawExecCalls.has(callId)
    ) {
      this.pendingRawOutputItemsByCallId.set(callId, item);
      return;
    }
    if (this.pendingWrappedWaitCallsByCallId.has(callId)) {
      this.pendingRawOutputItemsByCallId.set(callId, item);
      return;
    }
    if (this.handledRawOutputCallIds.has(callId)) {
      return;
    }
    this.handledRawOutputCallIds.add(callId);
    this.inFlightRawFunctionCallIds.delete(callId);

    const wrappedWaitCall = this.wrappedWaitCallsByCallId.get(callId);
    if (wrappedWaitCall) {
      this.wrappedWaitCallsByCallId.delete(callId);
      this.handleWrappedWaitOutput(wrappedWaitCall, item.output);
      return;
    }

    if (this.suppressedRawCallIds.delete(callId)) {
      return;
    }

    if (this.ignoredLateRawOutputCallIds.has(callId)) {
      return;
    }

    if (this.emittedImmediateToolResultIds.has(callId)) {
      return;
    }

    const deferredExec = this.deferredRawExecCalls.get(callId);
    if (deferredExec) {
      if (deferredExec.expectedCalls.length > 0) {
        deferredExec.hasRawOutput = true;
        deferredExec.rawOutput = item.output;
        if (deferredExec.expectedCalls.every(call => (
          call.claimed && call.canonicalCompleted
        ))) {
          this.deferredRawExecCalls.delete(callId);
        }
        return;
      }

      this.deferredRawExecCalls.delete(callId);

      this.immediateRawOutputCallIds.add(callId);
      this.emitRawToolUse(
        callId,
        'exec',
        deferredExec.item,
        deferredExec.rawArguments,
      );
    }

    const normalizedName = this.rawToolNamesByCallId.get(callId);
    if (!normalizedName) {
      return;
    }

    const rawOutput = item.output;
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const content = normalizeRawToolOutput(
      normalizedName,
      rawOutput,
      this.rawToolInputsByCallId.get(callId),
    );
    const result = {
      content,
      isError: isCodexToolOutputError(rawOutputText),
    };

    if (this.immediateRawOutputCallIds.delete(callId)) {
      const execCellId = normalizedName === 'Bash'
        ? extractCodexExecCellId(rawOutputText)
        : undefined;
      if (execCellId) {
        this.wrappedCommandCallIdsByCellId.set(execCellId, callId);
        this.appendWrappedCommandOutput(callId, content);
        this.bindPendingWrappedWaitCalls(execCellId, callId);
        return;
      }

      this.wrappedCommandOutputByCallId.delete(callId);
      this.canonicalPrefilledRawCommandCallIds.delete(callId);
      if (!this.emittedImmediateToolResultIds.has(callId)) {
        this.emittedImmediateToolResultIds.add(callId);
        this.emit({
          type: 'tool_result',
          id: this.visibleRawCallId(callId),
          ...result,
        });
      }
      return;
    }

    this.rawToolOutputsByCallId.set(callId, result);
  }

  private replayPendingRawToolOutput(item: Record<string, unknown>): void {
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }
    const pendingOutput = this.pendingRawOutputItemsByCallId.get(callId);
    if (!pendingOutput) {
      return;
    }
    this.pendingRawOutputItemsByCallId.delete(callId);
    this.handleRawToolOutput(pendingOutput);
  }

  private handleWrappedWaitOutput(waitCall: WrappedWaitCall, rawOutput: unknown): void {
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const content = normalizeRawToolOutput(
      'Bash',
      rawOutput,
      this.rawToolInputsByCallId.get(waitCall.commandCallId),
    );
    const nextCellId = extractCodexExecCellId(rawOutputText);

    if (nextCellId) {
      this.wrappedCommandCallIdsByCellId.delete(waitCall.cellId);
      this.wrappedCommandCallIdsByCellId.set(nextCellId, waitCall.commandCallId);
      this.appendWrappedCommandOutput(waitCall.commandCallId, content);
      return;
    }

    const previousOutput = this.wrappedCommandOutputByCallId.get(waitCall.commandCallId);
    const completeOutput = appendCodexCommandOutput(previousOutput, content);
    this.wrappedCommandOutputByCallId.delete(waitCall.commandCallId);
    this.canonicalPrefilledRawCommandCallIds.delete(waitCall.commandCallId);
    this.wrappedCommandCallIdsByCellId.delete(waitCall.cellId);
    this.emittedImmediateToolResultIds.add(waitCall.commandCallId);
    this.emit({
      type: 'tool_result',
      id: this.visibleRawCallId(waitCall.commandCallId),
      content: completeOutput,
      isError: isCodexToolOutputError(rawOutputText),
    });
  }

  private bindPendingWrappedWaitCalls(cellId: string, commandCallId: string): void {
    for (const [waitCallId, waitCall] of this.pendingWrappedWaitCallsByCallId) {
      if (waitCall.cellId !== cellId) {
        continue;
      }
      this.pendingWrappedWaitCallsByCallId.delete(waitCallId);
      this.wrappedWaitCallsByCallId.set(waitCallId, { commandCallId, cellId });
      const pendingOutput = this.pendingRawOutputItemsByCallId.get(waitCallId);
      if (pendingOutput) {
        this.pendingRawOutputItemsByCallId.delete(waitCallId);
        this.handleRawToolOutput(pendingOutput);
      }
    }
  }

  private appendWrappedCommandOutput(callId: string, content: string): void {
    if (!content) return;

    const previousOutput = this.wrappedCommandOutputByCallId.get(callId);
    const completeOutput = this.canonicalPrefilledRawCommandCallIds.delete(callId)
      ? mergeOverlappingCommandOutput(previousOutput, content)
      : appendCodexCommandOutput(previousOutput, content);
    const delta = completeOutput.slice(previousOutput?.length ?? 0);
    this.wrappedCommandOutputByCallId.set(callId, completeOutput);
    if (delta) {
      this.emit({ type: 'tool_output', id: this.visibleRawCallId(callId), content: delta });
    }
  }

  private emitMissingRawAgentMessageText(item: Record<string, unknown>): void {
    const rawText = item.type === 'message'
      ? readAssistantMessageText(item)
      : firstString(item.text, item.message);
    const text = stripCodexMemoryCitationMarkup(rawText);
    this.emitMissingAssistantSegmentText(text);
  }

  private emitMissingAssistantSegmentText(text: string, itemId?: string): void {
    this.claimAssistantSegment(itemId);
    const missingText = normalizeAgentMessageCompletionText(
      text,
      this.currentAssistantSegmentText,
    );
    if (text) {
      this.currentAssistantSegmentText = text;
    }
    if (!missingText) {
      return;
    }

    this.streamedAssistantTurnText += missingText;
    this.emit({ type: 'text', content: missingText });
  }

  private emitMissingAssistantTurnText(text: string): void {
    const missingText = normalizeAgentMessageCompletionText(
      text,
      this.streamedAssistantTurnText,
    );
    if (!missingText) {
      return;
    }

    this.streamedAssistantTurnText += missingText;
    this.currentAssistantSegmentText += missingText;
    this.emit({ type: 'text', content: missingText });
  }

  private consumeRawToolOutput(callId: string): RawToolResult | undefined {
    const result = this.rawToolOutputsByCallId.get(callId);
    this.rawToolOutputsByCallId.delete(callId);
    return result;
  }

  private flushPendingRawToolOutputs(): void {
    for (const [callId, result] of this.rawToolOutputsByCallId) {
      this.emit({ type: 'tool_result', id: this.visibleRawCallId(callId), ...result });
    }
    this.rawToolOutputsByCallId.clear();
  }

  private flushDeferredRawExecCalls(terminalError = false): void {
    for (const deferredExec of this.deferredRawExecCalls.values()) {
      if (this.emitDeferredRawExecFallback(
        deferredExec,
        deferredExec.rawOutput,
        true,
        terminalError,
      )) {
        continue;
      }
      this.emitRawToolUse(
        deferredExec.callId,
        'exec',
        deferredExec.item,
        deferredExec.rawArguments,
      );
      this.emit({
        type: 'tool_result',
        id: deferredExec.callId,
        content: '',
        isError: terminalError,
      });
    }
    this.deferredRawExecCalls.clear();
  }

  private flushPendingWrappedWaitCalls(terminalError: boolean): void {
    for (const [callId, waitCall] of this.pendingWrappedWaitCallsByCallId) {
      this.pendingWrappedWaitCallsByCallId.delete(callId);
      this.emitRawToolUse(callId, 'wait', waitCall.item, waitCall.rawArguments);
      const pendingOutput = this.pendingRawOutputItemsByCallId.get(callId);
      if (pendingOutput) {
        this.pendingRawOutputItemsByCallId.delete(callId);
        this.handleRawToolOutput(pendingOutput);
      } else {
        this.emittedImmediateToolResultIds.add(callId);
        this.emit({ type: 'tool_result', id: callId, content: '', isError: terminalError });
      }
    }
  }

  private flushInFlightRawTools(isError: boolean): void {
    const yieldedCommandCallIds = new Set(this.wrappedCommandCallIdsByCellId.values());
    for (const callId of yieldedCommandCallIds) {
      if (this.emittedImmediateToolResultIds.has(callId)) {
        continue;
      }
      this.emittedImmediateToolResultIds.add(callId);
      this.emit({
        type: 'tool_result',
        id: this.visibleRawCallId(callId),
        content: this.wrappedCommandOutputByCallId.get(callId) ?? '',
        isError,
      });
    }
    for (const callId of this.immediateRawOutputCallIds) {
      if (this.emittedImmediateToolResultIds.has(callId)) {
        continue;
      }
      this.emittedImmediateToolResultIds.add(callId);
      this.emit({
        type: 'tool_result',
        id: this.visibleRawCallId(callId),
        content: '',
        isError,
      });
    }
    for (const callId of this.inFlightRawFunctionCallIds) {
      if (this.emittedImmediateToolResultIds.has(callId)) {
        continue;
      }
      this.emittedImmediateToolResultIds.add(callId);
      this.emit({
        type: 'tool_result',
        id: this.visibleRawCallId(callId),
        content: '',
        isError,
      });
    }
    this.wrappedCommandCallIdsByCellId.clear();
    this.wrappedCommandOutputByCallId.clear();
    this.wrappedWaitCallsByCallId.clear();
    this.pendingWrappedWaitCallsByCallId.clear();
    this.inFlightRawFunctionCallIds.clear();
    this.immediateRawOutputCallIds.clear();
  }

  private emitDeferredRawExecFallback(
    deferredExec: DeferredRawExecCall,
    rawOutput?: unknown,
    emitResult = false,
    terminalError = false,
  ): boolean {
    if (deferredExec.expectedCalls.length === 0) {
      return false;
    }

    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    deferredExec.expectedCalls.forEach((call, index) => {
      if (call.claimed) {
        if (!call.canonicalCompleted && call.canonicalItemId) {
          this.completedCanonicalToolItemIds.add(call.canonicalItemId);
          this.emit({
            type: 'tool_result',
            id: call.canonicalItemId,
            content: normalizeRawToolOutput(call.name, rawOutput, call.input),
            isError: isCodexToolOutputError(rawOutputText)
              || (terminalError && !deferredExec.hasRawOutput),
          });
          call.canonicalCompleted = true;
        }
        return;
      }
      const fallbackId = deferredExec.expectedCalls.length === 1
        ? deferredExec.callId
        : `${deferredExec.callId}:${index + 1}`;
      this.resetAssistantSegmentText();
      this.emit({
        type: 'tool_use',
        id: fallbackId,
        name: call.name,
        input: call.input,
      });
      if (emitResult) {
        this.emit({
          type: 'tool_result',
          id: fallbackId,
          content: normalizeRawToolOutput(call.name, rawOutput, call.input),
          isError: isCodexToolOutputError(rawOutputText)
            || (terminalError && !deferredExec.hasRawOutput),
        });
      }
    });
    return true;
  }

  private claimDeferredRawExecFromItem(
    item: ItemStartedNotification['item'],
    completed: boolean,
  ): boolean {
    const projection = item.type === 'fileChange'
      ? {
          itemId: item.id,
          name: 'apply_patch',
          input: this.rememberFileChangeInput(
            item.id,
            buildFileChangeInput(item.changes ?? []),
          ),
        }
      : buildCanonicalToolProjection(item, this.workingDirectory);
    if (!projection) {
      return false;
    }
    const claimed = this.registerCanonicalToolProjection(projection, completed);
    if (claimed) {
      this.deferredOwnedCanonicalItemIds.add(projection.itemId);
    }
    return claimed || this.deferredOwnedCanonicalItemIds.has(projection.itemId);
  }

  private registerCanonicalToolProjection(
    projection: CanonicalToolProjection,
    completed = false,
  ): boolean {
    if (this.projectedCanonicalItemIds.has(projection.itemId)) {
      if (!this.activeCanonicalToolProjections.has(projection.itemId)) {
        return false;
      }
      if (this.claimDeferredRawExec(
        projection.name,
        projection.input,
        projection.comparisonInput,
        projection.itemId,
        completed,
      )) {
        this.activeCanonicalToolProjections.delete(projection.itemId);
        return true;
      } else {
        this.activeCanonicalToolProjections.set(projection.itemId, projection);
      }
      return false;
    }
    this.projectedCanonicalItemIds.add(projection.itemId);
    const claimed = this.claimDeferredRawExec(
      projection.name,
      projection.input,
      projection.comparisonInput,
      projection.itemId,
      completed,
    );
    if (!claimed) {
      this.activeCanonicalToolProjections.set(projection.itemId, projection);
    }
    return claimed;
  }

  private claimActiveCanonicalProjections(): void {
    for (const [itemId, projection] of this.activeCanonicalToolProjections) {
      if (this.claimDeferredRawExec(
        projection.name,
        projection.input,
        projection.comparisonInput,
        itemId,
        this.completedCanonicalToolItemIds.has(itemId),
        this.completedCanonicalToolItemIds.has(itemId),
      )) {
        this.activeCanonicalToolProjections.delete(itemId);
        this.deferredOwnedCanonicalItemIds.add(itemId);
        const unmatchedCommandIndex = this.unmatchedCanonicalCommands
          .findIndex(command => command.itemId === itemId);
        if (unmatchedCommandIndex !== -1) {
          this.unmatchedCanonicalCommands.splice(unmatchedCommandIndex, 1);
        }
      }
    }
  }

  private claimDeferredRawExec(
    name: string,
    input: Record<string, unknown>,
    comparisonInput = input,
    canonicalItemId?: string,
    canonicalCompleted = false,
    requireSameId = false,
  ): boolean {
    const projectedName = semanticToolName(name);
    const availableCalls = [...this.deferredRawExecCalls.values()].flatMap(deferredExec => (
      deferredExec.expectedCalls
        .filter(call => !call.claimed && call.name === projectedName)
        .map(expectedCall => ({ deferredExec, expectedCall }))
    ));
    const sameIdCalls = canonicalItemId
      ? availableCalls.filter(({ deferredExec }) => deferredExec.callId === canonicalItemId)
      : [];
    const compatibleCalls = (
      sameIdCalls.length > 0
        ? sameIdCalls
        : requireSameId
          ? []
          : availableCalls
    )
      .filter(({ expectedCall }) => toolInputsCompatible(
        projectedName,
        expectedCall.comparisonInput ?? expectedCall.input,
        comparisonInput,
        this.workingDirectory,
      ));
    const match = sameIdCalls.length === 1
      ? sameIdCalls[0]
      : compatibleCalls.length === 1
        ? compatibleCalls[0]
        : undefined;
    if (!match) {
      return false;
    }

    const { deferredExec, expectedCall } = match;
    expectedCall.claimed = true;
    expectedCall.canonicalItemId = canonicalItemId;
    expectedCall.canonicalCompleted = canonicalCompleted;
    if (
      deferredExec.hasRawOutput
      && deferredExec.expectedCalls.every(call => (
        call.claimed && call.canonicalCompleted
      ))
    ) {
      this.deferredRawExecCalls.delete(deferredExec.callId);
    }
    return true;
  }

  private markDeferredCanonicalCompleted(itemId: string): void {
    for (const deferredExec of this.deferredRawExecCalls.values()) {
      const claimedCall = deferredExec.expectedCalls.find(call => (
        call.canonicalItemId === itemId
      ));
      if (claimedCall) {
        claimedCall.canonicalCompleted = true;
        if (
          deferredExec.hasRawOutput
          && deferredExec.expectedCalls.every(call => (
            call.claimed && call.canonicalCompleted
          ))
        ) {
          this.deferredRawExecCalls.delete(deferredExec.callId);
        }
        return;
      }
    }
  }

  // -- commandExecution -------------------------------------------------------

  private claimPendingRawCommand(item: CommandExecutionItem): RawCommandProjection | undefined {
    const rawAction = readCanonicalCommand(item);
    const workingDirectory = normalizeWorkingDirectory(item.cwd, this.workingDirectory);
    let index = this.unmatchedRawCommands.findIndex(command => command.callId === item.id);
    if (index === -1) {
      const matchingIndexes = this.unmatchedRawCommands
        .map((command, candidateIndex) => ({ command, candidateIndex }))
        .filter(({ command }) => (
          (command.command === rawAction || command.command === item.command)
          && command.workingDirectory === workingDirectory
        ));
      if (matchingIndexes.length === 1) {
        index = matchingIndexes[0]?.candidateIndex ?? -1;
      }
    }
    if (index === -1) {
      return undefined;
    }

    const [command] = this.unmatchedRawCommands.splice(index, 1);
    if (!command) {
      return undefined;
    }
    this.rawCommandByCanonicalId.set(item.id, command);
    return command;
  }

  private takeUniqueCanonicalCommand(
    command: string,
    workingDirectory?: string,
  ): CanonicalCommandProjection | undefined {
    const matches = this.unmatchedCanonicalCommands
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => (
        candidate.commands.includes(command)
        && candidate.workingDirectory === workingDirectory
      ));
    if (matches.length !== 1) {
      return undefined;
    }

    const match = matches[0];
    if (!match) {
      return undefined;
    }
    this.unmatchedCanonicalCommands.splice(match.index, 1);
    return match.candidate;
  }

  private readRawCommandWorkingDirectory(
    rawName: string,
    rawArguments: Record<string, unknown>,
  ): string | undefined {
    let commandInput = rawArguments;
    if (rawName === 'exec') {
      const calls = decodeCodexExecEnvelopeCalls(rawArguments);
      const commandCall = calls?.length === 1 && calls[0]?.name === 'Bash'
        ? calls[0]
        : undefined;
      commandInput = commandCall?.rawInput ?? {};
    }

    const rawWorkingDirectory = firstString(
      commandInput.workdir,
      commandInput.cwd,
      commandInput.workingDirectory,
    );
    if (rawWorkingDirectory) {
      return this.workingDirectory
        ? path.resolve(this.workingDirectory, rawWorkingDirectory)
        : normalizeWorkingDirectory(rawWorkingDirectory);
    }
    return normalizeWorkingDirectory(this.workingDirectory);
  }

  private visibleRawCallId(callId: string): string {
    for (const projection of this.rawCommandByCanonicalId.values()) {
      if (projection.callId === callId) {
        return projection.visibleId;
      }
    }
    return callId;
  }

  private completeCommand(
    item: CommandExecutionItem,
    allowRawCorrelation = true,
    resolvedRawCommand?: RawCommandProjection,
  ): void {
    const rawCommand = resolvedRawCommand
      ?? this.rawCommandByCanonicalId.get(item.id)
      ?? (allowRawCorrelation ? this.claimPendingRawCommand(item) : undefined);
    const unmatchedCanonicalIndex = this.unmatchedCanonicalCommands
      .findIndex(command => command.itemId === item.id);
    if (unmatchedCanonicalIndex !== -1) {
      this.unmatchedCanonicalCommands.splice(unmatchedCanonicalIndex, 1);
    }
    if (rawCommand?.rawOwnsCompletion) {
      return;
    }

    const resultId = rawCommand?.visibleId ?? item.id;
    const rawResult = rawCommand
      ? this.consumeRawToolOutput(rawCommand.callId)
      : this.consumeRawToolOutput(item.id);
    this.emitToolResultFromCommand(item, rawResult, resultId);
    this.canonicalCommandOutputByItemId.delete(item.id);
    if (rawCommand) {
      this.wrappedCommandOutputByCallId.delete(rawCommand.callId);
      this.canonicalPrefilledRawCommandCallIds.delete(rawCommand.callId);
    }
    if (rawCommand) {
      this.ignoredLateRawOutputCallIds.add(rawCommand.callId);
    }
  }

  private emitToolUseFromCommand(item: CommandExecutionItem): void {
    const rawAction = item.commandActions?.[0]?.command ?? item.command;
    const normalizedName = normalizeCodexToolName('command_execution');
    const input = normalizeCodexToolInput('command_execution', { command: rawAction });

    this.resetAssistantSegmentText();
    this.emit({ type: 'tool_use', id: item.id, name: normalizedName, input });
  }

  private emitToolResultFromCommand(
    item: CommandExecutionItem,
    rawResult?: RawToolResult,
    resultId = item.id,
  ): void {
    const normalizedName = normalizeCodexToolName('command_execution');
    const output = item.aggregatedOutput ?? '';
    const content = rawResult?.content ?? normalizeCodexToolResult(normalizedName, output);
    const isError = item.exitCode !== null
      ? item.exitCode !== 0
      : rawResult?.isError ?? isCodexToolOutputError(output);

    this.emit({ type: 'tool_result', id: resultId, content, isError });
  }

  // -- fileChange -------------------------------------------------------------

  private emitToolUseFromFileChange(item: FileChangeItem): void {
    const input = this.rememberFileChangeInput(
      item.id,
      buildFileChangeInput(item.changes ?? []),
    );

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: normalizeCodexToolName('file_change'),
      input,
    });
  }

  private emitToolResultFromFileChange(item: FileChangeItem): void {
    const input = this.rememberFileChangeInput(
      item.id,
      buildFileChangeInput(item.changes ?? []),
    );
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const paths = changes
      .map(change => formatFileChangeSummary(change))
      .filter(Boolean)
      .join(', ');
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: paths || 'File change completed',
      isError: item.status === 'failed' || item.status === 'declined',
    });
  }

  private onFileChangePatchUpdated(params: FileChangePatchUpdatedNotification): void {
    const itemId = firstString(params.itemId);
    if (!itemId) {
      return;
    }

    const input = this.rememberFileChangeInput(
      itemId,
      buildFileChangeInput(params.changes ?? []),
    );
    const claimed = this.registerCanonicalToolProjection(
      { itemId, name: 'apply_patch', input },
      false,
    );
    if (claimed) {
      this.deferredOwnedCanonicalItemIds.add(itemId);
    }
    this.startedCanonicalToolItemIds.add(itemId);

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: itemId,
      name: normalizeCodexToolName('file_change'),
      input,
    });
    this.flushPendingCanonicalToolOutput(itemId);
  }

  private rememberFileChangeInput(
    itemId: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const previous = this.fileChangeInputsById.get(itemId);
    const merged = mergeApplyPatchInputs(previous, input);
    this.fileChangeInputsById.set(itemId, merged);
    return merged;
  }

  // -- imageView --------------------------------------------------------------

  private emitToolUseFromImageView(item: ImageViewItem): void {
    this.resetAssistantSegmentText();
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

    this.resetAssistantSegmentText();
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
    this.resetAssistantSegmentText();
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
    this.resetAssistantSegmentText();
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

  // -- dynamicToolCall --------------------------------------------------------

  private emitToolUseFromDynamic(item: DynamicToolCallItem): void {
    this.emitRawToolUse(
      item.id,
      item.tool,
      {},
      asRecord(item.arguments) ?? {},
      true,
    );
  }

  private ensureCanonicalToolUseFromCompletion(
    item: ItemCompletedNotification['item'],
  ): void {
    const itemId = getItemId(item);
    if (
      !itemId
      || !isCanonicalToolItem(item)
      || this.startedCanonicalToolItemIds.has(itemId)
    ) {
      return;
    }
    this.startedCanonicalToolItemIds.add(itemId);
    if (this.rawStartedCallIds.has(itemId)) {
      return;
    }

    switch (item.type) {
      case 'fileChange':
        this.emitToolUseFromFileChange(item);
        break;
      case 'imageView':
        this.emitToolUseFromImageView(item);
        break;
      case 'webSearch':
        this.emitToolUseFromWebSearch(item);
        break;
      case 'collabAgentToolCall':
        this.emitToolUseFromCollabAgent(item);
        break;
      case 'mcpToolCall':
        this.emitToolUseFromMcp(item);
        break;
      case 'dynamicToolCall':
        this.emitToolUseFromDynamic(item);
        break;
      default:
        break;
    }
  }

  private emitToolResultFromDynamic(item: DynamicToolCallItem): void {
    if (this.emittedImmediateToolResultIds.has(item.id)) return;
    this.emittedImmediateToolResultIds.add(item.id);

    const content = (item.contentItems ?? [])
      .map(contentItem => contentItem.type === 'inputText'
        ? contentItem.text
        : contentItem.imageUrl)
      .filter(Boolean)
      .join('\n');
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: content || (item.success === false ? 'Failed' : 'Completed'),
      isError: item.success === false || item.status === 'failed',
    });
  }

  private emitContextCompactionBoundary(_item: ContextCompactionItem): void {
    this.emit({ type: 'context_compacted' });
  }

  private emitUserMessageBoundary(item: UserMessageItem): void {
    if (this.startedUserMessageIds.has(item.id)) {
      return;
    }

    const rawContent = this.extractUserMessageText(item.content);
    const visibleContent = extractCodexUserVisibleText(rawContent);
    this.startedUserMessageIds.add(item.id);

    if (visibleContent === null && rawContent.trim()) {
      return;
    }

    this.emit({
      type: 'user_message_start',
      itemId: item.id,
      content: visibleContent ?? rawContent,
    });
  }

  private emitAgentMessageBoundary(item: AgentMessageItem): void {
    if (this.startedAgentMessageIds.has(item.id)) {
      return;
    }

    this.startedAgentMessageIds.add(item.id);
    this.claimAssistantSegment(item.id);
    this.emit({ type: 'assistant_message_start', itemId: item.id });
  }

  private completeAgentMessage(item: AgentMessageItem): void {
    if (!this.startedAgentMessageIds.has(item.id)) {
      this.emitAgentMessageBoundary(item);
    }

    const visibleText = stripCodexMemoryCitationMarkup(item.text);
    if (!this.agentMessageDeltaIds.has(item.id) && visibleText) {
      this.emitMissingAssistantSegmentText(visibleText, item.id);
    }

    this.emitMemoryCitation(item.memoryCitation, item.id);
  }

  private emitMemoryCitation(value: unknown, itemId?: string): void {
    if (itemId && this.emittedMemoryCitationIds.has(itemId)) {
      return;
    }
    const citations = normalizeCodexMemoryCitation(value);
    if (!citations) {
      return;
    }

    if (itemId) {
      this.emittedMemoryCitationIds.add(itemId);
    }
    const citationKey = buildMemoryCitationKey(citations);
    if (this.emittedMemoryCitationKeys.has(citationKey)) {
      return;
    }

    this.emittedMemoryCitationKeys.add(citationKey);
    this.emit({ type: 'citations', citations });
  }

  private extractUserMessageText(content: UserInput[]): string {
    return joinCodexUserTextParts(
      content.map((part) => (part.type === 'text' ? part.text : '')),
      '\n\n',
    );
  }

  // -- turn/plan/updated (update_plan) ----------------------------------------

  private onPlanUpdated(params: TurnPlanUpdatedNotification): void {
    this.planUpdateCounter += 1;
    const syntheticId = `plan-update-${params.turnId ?? 'turn'}-${this.planUpdateCounter}`;
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

    const projectionInput = {
      todos,
      ...(params.explanation ? { explanation: params.explanation } : {}),
    };
    this.claimDeferredRawExec(
      'TodoWrite',
      projectionInput,
      projectionInput,
      syntheticId,
      true,
    );

    this.resetAssistantSegmentText();
    this.emit({ type: 'tool_use', id: syntheticId, name: 'TodoWrite', input: { todos } });
    this.emit({ type: 'tool_result', id: syntheticId, content: 'Plan updated', isError: false });
  }

  // -- outputDelta (commandExecution + fileChange) ----------------------------

  private onOutputDelta(
    params: { itemId: string; delta: string },
    isCommandOutput: boolean,
  ): void {
    const rawCommand = this.rawCommandByCanonicalId.get(params.itemId);
    if (rawCommand?.rawOwnsCompletion) {
      return;
    }
    if (isCommandOutput) {
      const previousOutput = this.canonicalCommandOutputByItemId.get(params.itemId) ?? '';
      this.canonicalCommandOutputByItemId.set(params.itemId, previousOutput + params.delta);
    }
    const lifecycleStarted = this.startedCanonicalToolItemIds.has(params.itemId)
      || this.rawStartedCallIds.has(params.itemId)
      || rawCommand !== undefined;
    if (!lifecycleStarted) {
      const pendingOutput = this.pendingCanonicalToolOutputByItemId.get(params.itemId) ?? [];
      pendingOutput.push(params.delta);
      this.pendingCanonicalToolOutputByItemId.set(params.itemId, pendingOutput);
      return;
    }
    this.emit({
      type: 'tool_output',
      id: rawCommand?.visibleId ?? params.itemId,
      content: params.delta,
    });
  }

  private flushPendingCanonicalToolOutput(itemId: string): void {
    const pendingOutput = this.pendingCanonicalToolOutputByItemId.get(itemId);
    if (!pendingOutput) {
      return;
    }
    this.pendingCanonicalToolOutputByItemId.delete(itemId);
    const rawCommand = this.rawCommandByCanonicalId.get(itemId);
    if (rawCommand?.rawOwnsCompletion) {
      return;
    }
    for (const content of pendingOutput) {
      this.emit({
        type: 'tool_output',
        id: rawCommand?.visibleId ?? itemId,
        content,
      });
    }
  }

  // -- tokenUsage / turnCompleted / error -------------------------------------

  private onTokenUsageUpdated(params: TokenUsageUpdatedNotification): void {
    const last = params.tokenUsage.last;
    const contextTokens = last.inputTokens;
    const contextWindow = params.tokenUsage.modelContextWindow;

    const usage: UsageInfo = {
      inputTokens: last.inputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: last.cachedInputTokens,
      contextWindow,
      contextWindowIsAuthoritative: contextWindow > 0,
      contextTokens,
      percentage: contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100))) : 0,
    };

    this.emit({ type: 'usage', usage, sessionId: params.threadId });
  }

  private onTurnCompleted(params: TurnCompletedNotification): void {
    const turn = params.turn;

    if (turn.status === 'completed') {
      this.onTurnMetadata?.({
        assistantMessageId: turn.id,
        ...(this.isPlanTurn && this.sawPlanDelta ? { planCompleted: true } : {}),
      });
    }

    const terminalError = turn.status === 'failed';
    this.flushDeferredRawExecCalls(terminalError);
    this.flushPendingWrappedWaitCalls(terminalError);
    this.flushPendingRawToolOutputs();
    this.flushInFlightRawTools(terminalError);
    if (turn.status === 'failed' && turn.error) {
      this.emit({ type: 'error', content: turn.error.message });
    } else {
      this.emit({ type: 'done' });
    }
  }

  private onError(params: ErrorNotification): void {
    if (params.willRetry) return;
    this.flushDeferredRawExecCalls(true);
    this.flushPendingWrappedWaitCalls(true);
    this.flushPendingRawToolOutputs();
    this.flushInFlightRawTools(true);
    this.emit({ type: 'error', content: params.error.message });
  }
}

interface CanonicalToolProjection {
  itemId: string;
  name: string;
  input: Record<string, unknown>;
  comparisonInput?: Record<string, unknown>;
}

function buildCanonicalToolProjection(
  item: ItemStartedNotification['item'],
  workingDirectory?: string,
): CanonicalToolProjection | null {
  switch (item.type) {
    case 'commandExecution': {
      const input = normalizeCodexToolInput('command_execution', {
        command: readCanonicalCommand(item),
      });
      return {
        itemId: item.id,
        name: 'Bash',
        input,
        comparisonInput: {
          ...input,
          workingDirectory: resolveToolWorkingDirectory(item.cwd, workingDirectory),
        },
      };
    }

    case 'fileChange':
      return {
        itemId: item.id,
        name: 'apply_patch',
        input: buildFileChangeInput(item.changes ?? []),
      };

    case 'imageView':
      return {
        itemId: item.id,
        name: 'Read',
        input: normalizeCodexToolInput('view_image', { path: item.path }),
      };

    case 'webSearch':
      return {
        itemId: item.id,
        name: 'WebSearch',
        input: normalizeCodexToolInput('web_search', {
          query: item.query ?? '',
          queries: item.queries ?? [],
          url: item.url ?? '',
          pattern: item.pattern ?? '',
          action: item.action ?? {},
        }),
      };

    case 'collabAgentToolCall':
      return {
        itemId: item.id,
        name: COLLAB_AGENT_TOOL_MAP[item.tool] ?? item.tool,
        input: item.arguments ?? {},
      };

    case 'mcpToolCall':
      return {
        itemId: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments ?? {},
      };

    case 'dynamicToolCall': {
      const normalized = normalizeCodexToolCall(
        item.tool,
        asRecord(item.arguments) ?? {},
      );
      return { itemId: item.id, ...normalized };
    }

    default:
      return null;
  }
}

function readCanonicalCommand(item: CommandExecutionItem): string {
  return item.commandActions?.[0]?.command ?? item.command;
}

function readCanonicalCommandCandidates(item: CommandExecutionItem): string[] {
  return [...new Set([
    readCanonicalCommand(item),
    item.command,
  ].filter(Boolean))];
}

function normalizeWorkingDirectory(
  workingDirectory: string | undefined,
  baseDirectory?: string,
): string | undefined {
  return workingDirectory
    ? path.resolve(baseDirectory ?? '', workingDirectory)
    : undefined;
}

function resolveToolWorkingDirectory(
  workingDirectory: string | undefined,
  baseDirectory?: string,
): string | undefined {
  return workingDirectory
    ? normalizeWorkingDirectory(workingDirectory, baseDirectory)
    : normalizeWorkingDirectory(baseDirectory);
}

function semanticToolName(name: string): string {
  switch (name) {
    case 'web__run':
      return 'WebSearch';
    case 'wait_agent':
      return 'wait';
    default:
      return name;
  }
}

function projectRawSemanticToolCall(
  name: string,
  input: Record<string, unknown>,
  rawName?: string,
  rawInput?: Record<string, unknown>,
  workingDirectory?: string,
): {
  name: string;
  input: Record<string, unknown>;
  comparisonInput?: Record<string, unknown>;
} {
  if (name === 'web__run') {
    return {
      name: 'WebSearch',
      input: normalizeWebRunInput(input),
    };
  }
  if (rawName === 'update_plan') {
    const explanation = firstString(rawInput?.explanation);
    return {
      name: 'TodoWrite',
      input: {
        ...input,
        ...(explanation ? { explanation } : {}),
      },
    };
  }
  if (name === 'Bash') {
    return {
      name,
      input,
      comparisonInput: {
        ...input,
        workingDirectory: resolveToolWorkingDirectory(
          firstString(
            rawInput?.workdir,
            rawInput?.cwd,
            rawInput?.workingDirectory,
          ),
          workingDirectory,
        ),
      },
    };
  }
  return { name: semanticToolName(name), input };
}

function normalizeWebRunInput(input: Record<string, unknown>): Record<string, unknown> {
  const regularQueries: unknown[] = Array.isArray(input.search_query)
    ? input.search_query as unknown[]
    : [];
  const imageQueries: unknown[] = Array.isArray(input.image_query)
    ? input.image_query as unknown[]
    : [];
  const searchQueries = [...regularQueries, ...imageQueries];
  const queries = searchQueries
    .map(query => firstString(asRecord(query)?.q))
    .filter(Boolean);
  if (queries.length > 0) {
    return {
      actionType: 'search',
      query: queries[0],
      ...(queries.length > 1 ? { queries } : {}),
    };
  }

  const openRequest = asRecord(Array.isArray(input.open) ? input.open[0] : undefined);
  const openUrl = firstString(openRequest?.ref_id, openRequest?.url);
  if (openUrl) {
    return { actionType: 'open_page', url: openUrl };
  }

  const findRequest = asRecord(Array.isArray(input.find) ? input.find[0] : undefined);
  const findUrl = firstString(findRequest?.ref_id, findRequest?.url);
  const pattern = firstString(findRequest?.pattern);
  if (findUrl && pattern) {
    return { actionType: 'find_in_page', url: findUrl, pattern };
  }
  return input;
}

function toolInputsCompatible(
  name: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  workingDirectory?: string,
): boolean {
  if (name === 'apply_patch') {
    const expectedChanges = extractRawPatchChanges(expected.patch, workingDirectory);
    const actualChanges = extractCanonicalFileChanges(actual.changes, workingDirectory);
    if (expectedChanges.length > 0 || actualChanges.length > 0) {
      if (expectedChanges.some(change => change.kind === 'update' && !change.hasContext)) {
        return false;
      }
      return stableValueKey(expectedChanges) === stableValueKey(actualChanges);
    }
  }

  if (name === 'WebSearch') {
    return stableValueKey(normalizeComparedWebInput(expected))
      === stableValueKey(normalizeComparedWebInput(actual));
  }

  return stableValueKey(expected) === stableValueKey(actual);
}

function normalizeComparedWebInput(input: Record<string, unknown>): Record<string, unknown> {
  const actionType = firstString(input.actionType);
  const normalizedActionType = actionType === 'openPage'
    ? 'open_page'
    : actionType === 'findInPage'
      ? 'find_in_page'
      : actionType;
  const normalized: Record<string, unknown> = {
    ...input,
    ...(normalizedActionType ? { actionType: normalizedActionType } : {}),
  };
  if (normalizedActionType === 'open_page' || normalizedActionType === 'find_in_page') {
    delete normalized.query;
    delete normalized.queries;
  } else if (
    Array.isArray(normalized.queries)
    && normalized.queries.length === 1
    && normalized.queries[0] === normalized.query
  ) {
    delete normalized.queries;
  }
  return normalized;
}

interface ComparedFileChange {
  path: string;
  kind: string;
  movePath?: string;
  lines: string[];
  hasContext: boolean;
}

function extractRawPatchChanges(
  value: unknown,
  workingDirectory?: string,
): ComparedFileChange[] {
  if (typeof value !== 'string') {
    return [];
  }
  const changes: ComparedFileChange[] = [];
  let current: ComparedFileChange | undefined;
  for (const line of value.split('\n')) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (match?.[1] && match[2]) {
      if (current) {
        changes.push(current);
      }
      current = {
        path: normalizeComparedFilePath(match[2], workingDirectory),
        kind: normalizeComparedChangeKind(match[1]),
        lines: [],
        hasContext: false,
      };
      continue;
    }
    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (current && moveMatch?.[1]) {
      current.movePath = normalizeComparedFilePath(moveMatch[1], workingDirectory);
      continue;
    }
    if (!current || line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = extractRawPatchHunkAnchor(line);
      if (anchor) {
        current.lines.push(`@${anchor}`);
        current.hasContext = true;
      }
    } else if (line.startsWith('+') || line.startsWith('-')) {
      current.lines.push(line);
    } else if (line.startsWith(' ')) {
      current.lines.push(line);
      current.hasContext = true;
    }
  }
  if (current) {
    changes.push(current);
  }
  return changes.sort(compareFileChanges);
}

function extractCanonicalFileChanges(
  value: unknown,
  workingDirectory?: string,
): ComparedFileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((change): ComparedFileChange | null => {
      const record = asRecord(change);
      const changePath = normalizeComparedFilePath(
        firstString(record?.path),
        workingDirectory,
      );
      if (!record || !changePath) {
        return null;
      }
      const lines: string[] = [];
      let hasContext = false;
      for (const line of firstString(record.diff).split('\n')) {
        if (line.startsWith('@@')) {
          const anchor = extractCanonicalDiffHunkAnchor(line);
          if (anchor) {
            lines.push(`@${anchor}`);
            hasContext = true;
          }
          continue;
        }
        if (
          line.startsWith('+++ ')
          || line.startsWith('--- ')
        ) {
          continue;
        }
        if (line.startsWith('+') || line.startsWith('-')) {
          lines.push(line);
        } else if (line.startsWith(' ')) {
          lines.push(line);
          hasContext = true;
        }
      }
      const movePath = firstString(record.movePath);
      return {
        path: changePath,
        kind: movePath
          ? 'update'
          : normalizeComparedChangeKind(firstString(record.kind, record.type)),
        ...(movePath
          ? {
              movePath: normalizeComparedFilePath(
                movePath,
                workingDirectory,
              ),
            }
          : {}),
        lines,
        hasContext,
      };
    })
    .filter((change): change is ComparedFileChange => change !== null)
    .sort(compareFileChanges);
}

function extractRawPatchHunkAnchor(line: string): string {
  return line.slice(2).trim().replace(/\s*@@$/, '').trim();
}

function extractCanonicalDiffHunkAnchor(line: string): string {
  const closingMarker = line.indexOf('@@', 2);
  return closingMarker === -1 ? '' : line.slice(closingMarker + 2).trim();
}

function normalizeComparedChangeKind(kind: string): string {
  switch (kind.toLowerCase()) {
    case 'add':
    case 'create':
      return 'add';
    case 'delete':
    case 'remove':
      return 'delete';
    case 'modify':
    case 'change':
    case 'update':
      return 'update';
    default:
      return kind.toLowerCase();
  }
}

function compareFileChanges(first: ComparedFileChange, second: ComparedFileChange): number {
  return first.path.localeCompare(second.path) || first.kind.localeCompare(second.kind);
}

function normalizeComparedFilePath(filePath: string, workingDirectory?: string): string {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return '';
  }
  return workingDirectory
    ? path.resolve(workingDirectory, trimmedPath)
    : path.normalize(trimmedPath);
}

function stableValueKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValueKey).join(',')}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableValueKey(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function mergeOverlappingCommandOutput(previous: string | undefined, next: string): string {
  if (!previous || !next) {
    return previous || next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.endsWith(next)) {
    return previous;
  }
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return previous + next.slice(overlap);
    }
  }
  return appendCodexCommandOutput(previous, next);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function buildMemoryCitationKey(citations: CitationGroup): string {
  return citations.entries
    .map(entry => [entry.path, entry.lineStart, entry.lineEnd, entry.note].join('\0'))
    .join('\u0001');
}

function getItemId(item: { id?: string } | Record<string, unknown>): string | undefined {
  return typeof item.id === 'string' ? item.id : undefined;
}

function isCanonicalToolItem(item: ItemStartedNotification['item']): boolean {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'imageView'
    || item.type === 'webSearch'
    || item.type === 'collabAgentToolCall'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall';
}

function readRawCallId(item: Record<string, unknown>): string {
  return firstString(item.call_id, item.id);
}

function parseRawArguments(item: Record<string, unknown>): Record<string, unknown> {
  const rawArgs = typeof item.arguments === 'string'
    ? item.arguments
    : typeof item.input === 'string'
      ? item.input
      : undefined;
  return parseCodexArguments(rawArgs);
}

function isSilentWriteStdinInput(input: Record<string, unknown>): boolean {
  return typeof input.chars !== 'string' || input.chars.length === 0;
}

function normalizeRawToolOutput(
  normalizedName: string,
  rawOutput: unknown,
  input?: Record<string, unknown>,
): string {
  if (Array.isArray(rawOutput) && normalizedName === 'Read') {
    const filePath = firstString(input?.file_path, input?.path);
    if (filePath) {
      return filePath;
    }
  }

  return normalizeCodexToolResult(normalizedName, stringifyCodexToolOutput(rawOutput));
}

function buildFileChangeInput(changes: unknown): Record<string, unknown> {
  return { changes: normalizeFileChanges(changes) };
}

function mergeApplyPatchInputs(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) {
    return next;
  }

  const patch = typeof next.patch === 'string'
    ? next.patch
    : typeof previous.patch === 'string'
      ? previous.patch
      : undefined;
  const changes = mergeFileChanges(previous.changes, next.changes);
  return {
    ...previous,
    ...next,
    ...(patch ? { patch } : {}),
    ...(changes.length > 0 ? { changes } : {}),
  };
}

function normalizeFileChanges(changes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(changes)) {
    return [];
  }

  return changes
    .map(normalizeFileChange)
    .filter((change): change is Record<string, unknown> => change !== null);
}

function normalizeFileChange(change: unknown): Record<string, unknown> | null {
  const record = asRecord(change);
  const path = firstString(record?.path);
  if (!record || !path) {
    return null;
  }

  const kindInfo = normalizeFileChangeKind(record.kind ?? record.type);
  const diff = firstString(record.diff);
  return {
    ...record,
    path,
    kind: kindInfo.kind,
    type: kindInfo.kind,
    ...(kindInfo.movePath ? { movePath: kindInfo.movePath } : {}),
    ...(diff ? { diff } : {}),
  };
}

function normalizeFileChangeKind(value: unknown): { kind: string; movePath?: string } {
  if (typeof value === 'string' && value) {
    return { kind: value };
  }

  const record = asRecord(value);
  const kind = firstString(record?.type) || 'change';
  const movePath = firstString(record?.move_path);
  return {
    kind,
    ...(movePath ? { movePath } : {}),
  };
}

function mergeFileChanges(previous: unknown, next: unknown): Record<string, unknown>[] {
  const previousChanges = normalizeFileChanges(previous);
  const nextChanges = normalizeFileChanges(next);
  if (previousChanges.length === 0) return nextChanges;
  if (nextChanges.length === 0) return previousChanges;

  const merged = new Map<string, Record<string, unknown>>();
  for (const change of previousChanges) {
    merged.set(fileChangeKey(change), change);
  }
  for (const change of nextChanges) {
    const key = fileChangeKey(change);
    const previousChange = merged.get(key);
    merged.set(key, previousChange ? mergeFileChange(previousChange, change) : change);
  }
  return [...merged.values()];
}

function mergeFileChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...previous,
    ...next,
    ...(typeof next.diff === 'string'
      ? { diff: next.diff }
      : typeof previous.diff === 'string'
        ? { diff: previous.diff }
        : {}),
  };
}

function fileChangeKey(change: Record<string, unknown>): string {
  return `${firstString(change.path)}\0${firstString(change.movePath)}`;
}

function formatFileChangeSummary(change: unknown): string {
  const record = asRecord(change);
  const path = firstString(record?.path);
  if (!record || !path) {
    return '';
  }

  const kind = firstString(record.kind, record.type) || 'change';
  return `${kind}: ${path}`;
}

function readContentText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((entry) => firstString(asRecord(entry)?.text))
    .join('');
}

function readAssistantMessageText(item: Record<string, unknown>): string {
  if (firstString(item.role) !== 'assistant') {
    return '';
  }

  return readContentText(item.content);
}

function normalizeAgentMessageCompletionText(
  text: string,
  streamedAssistantText: string,
): string {
  if (!text) {
    return '';
  }
  if (!streamedAssistantText) {
    return text;
  }
  if (text.startsWith(streamedAssistantText)) {
    return text.slice(streamedAssistantText.length);
  }
  return text;
}
