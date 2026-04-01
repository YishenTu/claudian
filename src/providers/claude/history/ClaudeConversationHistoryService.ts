import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import { isSubagentToolName, TOOL_TASK } from '../../../core/tools/toolNames';
import type {
  AsyncSubagentStatus,
  ChatMessage,
  Conversation,
  ForkSource,
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import { type ClaudeProviderState, getClaudeState } from '../types/providerState';
import {
  deleteSDKSession,
  loadSDKSessionMessages,
  loadSubagentToolCalls,
  sdkSessionExists,
} from './ClaudeHistoryStore';

function chooseRicherResult(sdkResult?: string, cachedResult?: string): string | undefined {
  const sdkText = typeof sdkResult === 'string' ? sdkResult.trim() : '';
  const cachedText = typeof cachedResult === 'string' ? cachedResult.trim() : '';

  if (sdkText.length === 0 && cachedText.length === 0) return undefined;
  if (sdkText.length === 0) return cachedResult;
  if (cachedText.length === 0) return sdkResult;

  return sdkText.length >= cachedText.length ? sdkResult : cachedResult;
}

function chooseRicherToolCalls(
  sdkToolCalls: ToolCallInfo[] = [],
  cachedToolCalls: ToolCallInfo[] = [],
): ToolCallInfo[] {
  if (sdkToolCalls.length >= cachedToolCalls.length) {
    return sdkToolCalls;
  }

  return cachedToolCalls;
}

function normalizeAsyncStatus(
  subagent: SubagentInfo | undefined,
  modeOverride?: SubagentInfo['mode'],
): AsyncSubagentStatus | undefined {
  if (!subagent) return undefined;

  const mode = modeOverride ?? subagent.mode;
  if (mode === 'sync') return undefined;
  if (mode === 'async') return subagent.asyncStatus ?? subagent.status;
  return subagent.asyncStatus;
}

function isTerminalAsyncStatus(status: AsyncSubagentStatus | undefined): boolean {
  return status === 'completed' || status === 'error' || status === 'orphaned';
}

function mergeSubagentInfo(
  taskToolCall: ToolCallInfo,
  cachedSubagent: SubagentInfo,
): SubagentInfo {
  const sdkSubagent = taskToolCall.subagent;
  const cachedAsyncStatus = normalizeAsyncStatus(cachedSubagent);
  if (!sdkSubagent) {
    return {
      ...cachedSubagent,
      asyncStatus: cachedAsyncStatus,
      result: chooseRicherResult(taskToolCall.result, cachedSubagent.result),
    };
  }

  const sdkAsyncStatus = normalizeAsyncStatus(sdkSubagent);
  const sdkIsTerminal = isTerminalAsyncStatus(sdkAsyncStatus);
  const cachedIsTerminal = isTerminalAsyncStatus(cachedAsyncStatus);
  const sdkResult = taskToolCall.result ?? sdkSubagent.result;

  const preferred = (!sdkIsTerminal && cachedIsTerminal) ? cachedSubagent : sdkSubagent;

  const mergedMode = sdkSubagent.mode
    ?? cachedSubagent.mode
    ?? (taskToolCall.input?.run_in_background === true ? 'async' : undefined);
  const fallbackResult = chooseRicherResult(sdkResult, cachedSubagent.result);
  const mergedResult = preferred === cachedSubagent
    ? (cachedSubagent.result ?? fallbackResult)
    : fallbackResult;
  const mergedAsyncStatus = normalizeAsyncStatus(preferred, mergedMode);

  return {
    ...cachedSubagent,
    ...sdkSubagent,
    description: sdkSubagent.description || cachedSubagent.description,
    prompt: sdkSubagent.prompt || cachedSubagent.prompt,
    mode: mergedMode,
    status: preferred.status,
    asyncStatus: mergedAsyncStatus,
    result: mergedResult,
    toolCalls: chooseRicherToolCalls(sdkSubagent.toolCalls, cachedSubagent.toolCalls),
    agentId: sdkSubagent.agentId || cachedSubagent.agentId,
    outputToolId: sdkSubagent.outputToolId || cachedSubagent.outputToolId,
    startedAt: sdkSubagent.startedAt ?? cachedSubagent.startedAt,
    completedAt: sdkSubagent.completedAt ?? cachedSubagent.completedAt,
    isExpanded: sdkSubagent.isExpanded ?? cachedSubagent.isExpanded,
  };
}

function ensureTaskToolCall(
  msg: ChatMessage,
  subagentId: string,
  subagent: SubagentInfo,
): ToolCallInfo {
  msg.toolCalls = msg.toolCalls || [];
  let taskToolCall = msg.toolCalls.find(
    tc => tc.id === subagentId && isSubagentToolName(tc.name),
  );

  if (!taskToolCall) {
    taskToolCall = {
      id: subagentId,
      name: TOOL_TASK,
      input: {
        description: subagent.description,
        prompt: subagent.prompt || '',
        ...(subagent.mode === 'async' ? { run_in_background: true } : {}),
      },
      status: subagent.status,
      result: subagent.result,
      isExpanded: false,
      subagent,
    };
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  if (!taskToolCall.input.description) {
    taskToolCall.input.description = subagent.description;
  }
  if (!taskToolCall.input.prompt) {
    taskToolCall.input.prompt = subagent.prompt || '';
  }
  if (subagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  const mergedSubagent = mergeSubagentInfo(taskToolCall, subagent);
  taskToolCall.status = mergedSubagent.status;
  if (mergedSubagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  if (mergedSubagent.result !== undefined) {
    taskToolCall.result = mergedSubagent.result;
  }
  taskToolCall.subagent = mergedSubagent;
  return taskToolCall;
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const result: ChatMessage[] = [];

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }

  return result;
}

async function enrichAsyncSubagentToolCalls(
  subagentData: Record<string, SubagentInfo>,
  vaultPath: string,
  sessionIds: string[],
): Promise<void> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) return;

  const loaderCache = new Map<string, ReturnType<typeof loadSubagentToolCalls>>();

  for (const subagent of Object.values(subagentData)) {
    if (subagent.mode !== 'async') continue;
    if (!subagent.agentId) continue;
    if ((subagent.toolCalls?.length ?? 0) > 0) continue;

    for (const sessionId of uniqueSessionIds) {
      const cacheKey = `${sessionId}:${subagent.agentId}`;

      let loader = loaderCache.get(cacheKey);
      if (!loader) {
        loader = loadSubagentToolCalls(vaultPath, sessionId, subagent.agentId);
        loaderCache.set(cacheKey, loader);
      }

      const recoveredToolCalls = await loader;
      if (recoveredToolCalls.length === 0) continue;

      subagent.toolCalls = recoveredToolCalls.map(toolCall => ({
        ...toolCall,
        input: { ...toolCall.input },
      }));
      break;
    }
  }
}

function applySubagentData(
  messages: ChatMessage[],
  subagentData: Record<string, SubagentInfo>,
): void {
  const attachedSubagentIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    for (const [subagentId, subagent] of Object.entries(subagentData)) {
      const hasSubagentBlock = msg.contentBlocks?.some(
        block => (block.type === 'subagent' && block.subagentId === subagentId)
          || (block.type === 'tool_use' && block.toolId === subagentId),
      );
      const hasTaskToolCall = msg.toolCalls?.some(tc => tc.id === subagentId) ?? false;

      if (!hasSubagentBlock && !hasTaskToolCall) continue;
      ensureTaskToolCall(msg, subagentId, subagent);

      if (!msg.contentBlocks) {
        msg.contentBlocks = [];
      }

      let hasNormalizedSubagentBlock = false;
      for (let i = 0; i < msg.contentBlocks.length; i++) {
        const block = msg.contentBlocks[i];
        if (block.type === 'tool_use' && block.toolId === subagentId) {
          msg.contentBlocks[i] = {
            type: 'subagent',
            subagentId,
            mode: subagent.mode,
          };
          hasNormalizedSubagentBlock = true;
        } else if (block.type === 'subagent' && block.subagentId === subagentId && !block.mode) {
          block.mode = subagent.mode;
          hasNormalizedSubagentBlock = true;
        } else if (block.type === 'subagent' && block.subagentId === subagentId) {
          hasNormalizedSubagentBlock = true;
        }
      }

      if (!hasNormalizedSubagentBlock && hasTaskToolCall) {
        msg.contentBlocks.push({
          type: 'subagent',
          subagentId,
          mode: subagent.mode,
        });
      }

      attachedSubagentIds.add(subagentId);
    }
  }

  for (const [subagentId, subagent] of Object.entries(subagentData)) {
    if (attachedSubagentIds.has(subagentId)) continue;

    let anchor = [...messages].reverse().find((msg): msg is ChatMessage => msg.role === 'assistant');
    if (!anchor) {
      anchor = {
        id: `subagent-recovery-${subagentId}`,
        role: 'assistant',
        content: '',
        timestamp: subagent.completedAt ?? subagent.startedAt ?? Date.now(),
        contentBlocks: [],
      };
      messages.push(anchor);
    }

    ensureTaskToolCall(anchor, subagentId, subagent);

    anchor.contentBlocks = anchor.contentBlocks || [];
    const hasSubagentBlock = anchor.contentBlocks.some(
      block => block.type === 'subagent' && block.subagentId === subagentId,
    );
    if (!hasSubagentBlock) {
      anchor.contentBlocks.push({
        type: 'subagent',
        subagentId,
        mode: subagent.mode,
      });
    }
  }
}

function buildPersistedSubagentData(messages: ChatMessage[]): Record<string, SubagentInfo> {
  const result: Record<string, SubagentInfo> = {};

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;

    for (const toolCall of msg.toolCalls) {
      if (!isSubagentToolName(toolCall.name) || !toolCall.subagent) continue;
      result[toolCall.subagent.id] = toolCall.subagent;
    }
  }

  return result;
}

function sanitizeProviderState(
  providerState: ClaudeProviderState,
): Record<string, unknown> | undefined {
  const sanitizedEntries = Object.entries(providerState).filter(([, value]) => value !== undefined);
  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

export class ClaudeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationIds = new Set<string>();

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getClaudeState(conversation.providerState);
    return !!state.forkSource
      && !state.providerSessionId
      && !conversation.sessionId;
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getClaudeState(conversation.providerState);
    return state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  buildForkProviderState(sourceSessionId: string, resumeAt: string): Record<string, unknown> {
    const state: ClaudeProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt } satisfies ForkSource,
    };
    return state as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const providerState: ClaudeProviderState = {
      ...getClaudeState(conversation.providerState),
    };

    const subagentData = buildPersistedSubagentData(conversation.messages);
    if (Object.keys(subagentData).length > 0) {
      providerState.subagentData = subagentData;
    } else {
      delete providerState.subagentData;
    }

    return sanitizeProviderState(providerState);
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    if (!vaultPath || this.hydratedConversationIds.has(conversation.id)) {
      return;
    }

    const state = getClaudeState(conversation.providerState);
    const isPendingFork = this.isPendingForkConversation(conversation);
    const allSessionIds: string[] = isPendingFork
      ? [state.forkSource!.sessionId]
      : [
          ...(state.previousProviderSessionIds || []),
          state.providerSessionId ?? conversation.sessionId,
        ].filter((id): id is string => !!id);

    if (allSessionIds.length === 0) {
      return;
    }

    const allSdkMessages: ChatMessage[] = [];
    let missingSessionCount = 0;
    let errorCount = 0;
    let successCount = 0;

    const currentSessionId = isPendingFork
      ? state.forkSource!.sessionId
      : (state.providerSessionId ?? conversation.sessionId);

    for (const sessionId of allSessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) {
        missingSessionCount++;
        continue;
      }

      const isCurrentSession = sessionId === currentSessionId;
      const truncateAt = isCurrentSession
        ? (isPendingFork ? state.forkSource!.resumeAt : conversation.resumeAtMessageId)
        : undefined;
      const result = await loadSDKSessionMessages(vaultPath, sessionId, truncateAt);

      if (result.error) {
        errorCount++;
        continue;
      }

      successCount++;
      allSdkMessages.push(...result.messages);
    }

    const allSessionsMissing = missingSessionCount === allSessionIds.length;
    const hasLoadErrors = errorCount > 0 && successCount === 0 && !allSessionsMissing;
    if (hasLoadErrors) {
      return;
    }

    const filteredSdkMessages = allSdkMessages.filter(msg => !msg.isRebuiltContext);

    const merged = dedupeMessages([
      ...conversation.messages,
      ...filteredSdkMessages,
    ]).sort((a, b) => a.timestamp - b.timestamp);

    if (state.subagentData) {
      await enrichAsyncSubagentToolCalls(
        state.subagentData,
        vaultPath,
        allSessionIds,
      );
      applySubagentData(merged, state.subagentData);
    }

    conversation.messages = merged;
    this.hydratedConversationIds.add(conversation.id);
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const state = getClaudeState(conversation.providerState);
    const sessionId = state.providerSessionId ?? conversation.sessionId;
    if (!vaultPath || !sessionId) {
      return;
    }

    await deleteSDKSession(vaultPath, sessionId);
  }
}
