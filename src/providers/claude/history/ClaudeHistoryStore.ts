import * as fs from 'fs/promises';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { ClaudeTaskToolNormalizer } from '../normalization/ClaudeTaskToolNormalizer';
import { ClaudeTaskResultInterpreter } from '../runtime/ClaudeTaskResultInterpreter';
import { isClaudeSubagentToolName } from '../subagentToolNames';
import { ClaudeTurnStats } from './ClaudeTurnStats';
import { buildAsyncSubagentInfo } from './sdkAsyncSubagent';
import { filterActiveBranch } from './sdkBranchFilter';
import type { SDKNativeMessage, SDKSessionLoadResult, SDKSessionReadResult } from './sdkHistoryTypes';
import {
  collectAsyncSubagentResults,
  collectStructuredPatchResults,
  collectToolResults,
  hydrateStructuredToolResults,
  isCanonicalSDKUserMessage,
  isSystemInjectedMessage,
  mergeAssistantMessage,
  parseSDKMessageToChat,
  parseTaskNotification,
} from './sdkMessageParsing';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  getSDKSessionPath,
  locateSDKSession,
  locateSDKSessions,
  readSDKSession,
  readSDKSessionFile,
} from './sdkSessionPaths';
import {
  isValidAgentId,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
} from './sdkSubagentSidecar';

export { recoverSDKSessionIdByTime } from './ClaudeSessionRecovery';
export {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
  locateSDKSession,
  locateSDKSessions,
};

/**
 * Opening a conversation without a stored model reads its transcript for the model and then
 * hydrates the same transcript. A model read hands its parse to the next message load of the
 * unchanged file instead of parsing it twice. Entries are taken once, so the load may mutate
 * them; unopened entries expire so bulk model recovery does not retain transcripts.
 */
const PENDING_READ_TTL_MS = 30_000;
const MAX_PENDING_READS = 4;
const pendingModelReads = new Map<string, {
  fingerprint: string;
  read: SDKSessionReadResult;
  expiryTimer: number;
}>();

function resolveSessionPath(
  vaultPath: string,
  sessionId: string,
  sessionPath: string | undefined,
  pathContext: ProviderHistoryPathContext | undefined,
): string | null {
  if (sessionPath) return sessionPath;
  try {
    return getSDKSessionPath(vaultPath, sessionId, pathContext);
  } catch {
    return null;
  }
}

async function getSessionFingerprint(sessionPath: string): Promise<string | null> {
  try {
    const { mtimeMs, size } = await fs.stat(sessionPath);
    return `${mtimeMs}:${size}`;
  } catch {
    return null;
  }
}

function deletePendingModelRead(sessionPath: string): void {
  const entry = pendingModelReads.get(sessionPath);
  if (entry) window.clearTimeout(entry.expiryTimer);
  pendingModelReads.delete(sessionPath);
}

async function readSessionEntries(
  vaultPath: string,
  sessionId: string,
  sessionPath: string | undefined,
  pathContext: ProviderHistoryPathContext | undefined,
): Promise<SDKSessionReadResult> {
  return sessionPath
    ? readSDKSessionFile(sessionPath)
    : readSDKSession(vaultPath, sessionId, pathContext);
}

async function takePendingModelRead(sessionPath: string | null): Promise<SDKSessionReadResult | null> {
  const entry = sessionPath ? pendingModelReads.get(sessionPath) : undefined;
  if (!sessionPath || !entry) return null;
  deletePendingModelRead(sessionPath);
  return await getSessionFingerprint(sessionPath) === entry.fingerprint ? entry.read : null;
}

export async function loadSDKSessionMessages(
  vaultPath: string,
  sessionId: string,
  resumeAtMessageId?: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
): Promise<SDKSessionLoadResult> {
  const result = await takePendingModelRead(resolveSessionPath(vaultPath, sessionId, sessionPath, pathContext))
    ?? await readSessionEntries(vaultPath, sessionId, sessionPath, pathContext);

  if (result.error) {
    return { messages: [], skippedLines: result.skippedLines, error: result.error };
  }

  const filteredEntries = filterActiveBranch(result.messages.filter(entry => !entry.isSidechain), resumeAtMessageId);

  const toolResults = collectToolResults(filteredEntries);
  const toolUseResults = collectStructuredPatchResults(filteredEntries);
  const asyncSubagentResults = collectAsyncSubagentResults(filteredEntries);
  const nativeTurnDurations = collectNativeTurnDurations(result.messages);

  const chatMessages: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;
  let turnStartedAt: number | undefined;
  let lastAssistantAt: number | undefined;
  let requestedResponsePending = false;
  let turnStats = new ClaudeTurnStats();
  const taskToolNormalizer = new ClaudeTaskToolNormalizer();

  const flushPendingAssistant = (includeDuration: boolean): void => {
    if (pendingAssistant) {
      const nativeDuration = pendingAssistant.assistantMessageId
        ? nativeTurnDurations.get(pendingAssistant.assistantMessageId)
        : undefined;
      const inferredDuration = turnStartedAt !== undefined && lastAssistantAt !== undefined
        && lastAssistantAt >= turnStartedAt
        ? Math.floor((lastAssistantAt - turnStartedAt) / 1_000)
        : undefined;
      if (includeDuration) {
        if (!pendingAssistant.isAutomaticResponse) {
          pendingAssistant.durationSeconds = nativeDuration !== undefined ? Math.floor(nativeDuration / 1000) : inferredDuration;
        }
        pendingAssistant.completedAt = lastAssistantAt;
        pendingAssistant.turnStats = turnStats.finish(turnStartedAt, lastAssistantAt);
      }
      chatMessages.push(pendingAssistant);
    }
    pendingAssistant = null;
    lastAssistantAt = undefined;
    turnStartedAt = undefined;
    requestedResponsePending = false;
    turnStats = new ClaudeTurnStats();
  };

  // Preserve task notification boundaries without ending an unfinished requested response.
  for (const sdkMsg of filteredEntries) {
    const notification = parseTaskNotification(sdkMsg);
    if (notification !== null) {
      if (pendingAssistant && requestedResponsePending) {
        pendingAssistant.contentBlocks?.push({ type: 'task_notification', content: notification });
        continue;
      }
      const requestedStartedAt: number | undefined = pendingAssistant ? undefined : turnStartedAt;
      flushPendingAssistant(true);
      turnStartedAt = requestedStartedAt;
      requestedResponsePending = requestedStartedAt !== undefined;
      pendingAssistant = {
        id: sdkMsg.uuid ?? `task-notification-${chatMessages.length}`,
        role: 'assistant',
        isAutomaticResponse: requestedStartedAt === undefined,
        content: '',
        timestamp: parseNativeTimestamp(sdkMsg.timestamp) ?? 0,
        contentBlocks: [{ type: 'task_notification', content: notification }],
      };
      continue;
    }
    if (isSystemInjectedMessage(sdkMsg)) continue;

    // Skip synthetic assistant messages (e.g., "No response requested." after /compact)
    if (sdkMsg.type === 'assistant' && sdkMsg.message?.model === '<synthetic>') continue;

    const chatMsg = parseSDKMessageToChat(sdkMsg, toolResults);
    if (!chatMsg) continue;
    normalizeTaskToolCalls(chatMsg, taskToolNormalizer, toolUseResults);

    if (chatMsg.role === 'assistant') {
      // context_compacted must not merge with previous assistant (it's a standalone separator)
      const isCompactBoundary = chatMsg.contentBlocks?.some(b => b.type === 'context_compacted');
      if (isCompactBoundary) {
        flushPendingAssistant(true);
        chatMessages.push(chatMsg);
      } else {
        if (pendingAssistant) {
          mergeAssistantMessage(pendingAssistant, chatMsg);
        } else {
          pendingAssistant = chatMsg;
        }
        turnStats.add(sdkMsg);
        lastAssistantAt = parseNativeTimestamp(sdkMsg.timestamp);
        requestedResponsePending = turnStartedAt !== undefined
          && sdkMsg.message?.stop_reason === 'tool_use';
      }
    } else {
      flushPendingAssistant(!chatMsg.isInterrupt);
      if (isCanonicalSDKUserMessage(sdkMsg)) {
        turnStartedAt = parseNativeTimestamp(sdkMsg.timestamp);
      }
      chatMessages.push(chatMsg);
    }
  }

  flushPendingAssistant(true);

  const taskResults = new ClaudeTaskResultInterpreter();
  for (const message of chatMessages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (!isClaudeSubagentToolName(toolCall.name) || toolCall.input.run_in_background === true
        || toolCall.result === undefined) continue;
      const metadata = toolUseResults.get(toolCall.id);
      const payload = metadata === undefined ? undefined : { rawOutput: metadata };
      const mode = taskResults.describeTask(toolCall.input).mode
        ?? taskResults.interpretLaunch(toolCall.result, toolCall.status === 'error', payload).mode;
      if (mode === 'async') continue;
      const result = taskResults.interpretResult(toolCall.result, toolCall.status === 'error',
        { mode: 'sync' }, payload);
      toolCall.result = result.result;
    }
  }
  hydrateStructuredToolResults(chatMessages, toolUseResults);

  // Build SubagentInfo for async Agent tool calls from toolUseResult + queue-operation data
  if (toolUseResults.size > 0 || asyncSubagentResults.size > 0) {
    const sidecarLoads: Array<{ subagent: SubagentInfo; promise: Promise<ToolCallInfo[]> }> = [];

    for (const msg of chatMessages) {
      if (msg.role !== 'assistant' || !msg.toolCalls) continue;
      for (const toolCall of msg.toolCalls) {
        if (!isClaudeSubagentToolName(toolCall.name)) continue;
        if (toolCall.subagent) continue;
        if (toolCall.input?.run_in_background !== true) continue;

        const toolUseResult = toolUseResults.get(toolCall.id);
        const subagent = buildAsyncSubagentInfo(
          toolCall,
          toolUseResult,
          asyncSubagentResults
        );
        if (subagent) {
          toolCall.subagent = subagent;
          if (subagent.result !== undefined) {
            toolCall.result = subagent.result;
          }
          toolCall.status = subagent.status;

          // Load tool calls from subagent sidecar JSONL in parallel
          if (subagent.agentId && isValidAgentId(subagent.agentId)) {
            const promise = loadSubagentToolCalls(
              vaultPath,
              sessionId,
              subagent.agentId,
              sessionPath,
              pathContext,
            );
            sidecarLoads.push({ subagent, promise });
          }
        }
      }
    }

    // Hydrate subagent tool calls from sidecar files
    if (sidecarLoads.length > 0) {
      const results = await Promise.all(sidecarLoads.map(s => s.promise));
      for (let i = 0; i < sidecarLoads.length; i++) {
        const toolCalls = results[i];
        if (toolCalls.length > 0) {
          sidecarLoads[i].subagent.toolCalls = toolCalls;
        }
      }
    }
  }

  // Notification timestamps record enqueue time, not consumption. Pin their
  // transcript boundaries while retaining timestamp ordering (e.g. /compact)
  // within each intervening section.
  let sectionStart = 0;
  for (let index = 0; index <= chatMessages.length; index++) {
    if (index < chatMessages.length
      && !chatMessages[index].contentBlocks?.some(block => block.type === 'task_notification')) continue;
    const section = chatMessages.slice(sectionStart, index).sort((a, b) => a.timestamp - b.timestamp);
    for (let offset = 0; offset < section.length; offset++) chatMessages[sectionStart + offset] = section[offset];
    sectionStart = index + 1;
  }

  return { messages: chatMessages, skippedLines: result.skippedLines };
}

function parseNativeTimestamp(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function collectNativeTurnDurations(
  entries: SDKNativeMessage[],
): Map<string, number> {
  const durations = new Map<string, number>();
  const entriesByUuid = new Map<string, SDKNativeMessage>();
  for (const entry of entries) {
    if (entry.uuid && !entriesByUuid.has(entry.uuid)) {
      entriesByUuid.set(entry.uuid, entry);
    }
  }

  for (const entry of entries) {
    if (
      entry.type !== 'system'
      || entry.subtype !== 'turn_duration'
      || typeof entry.parentUuid !== 'string'
      || typeof entry.durationMs !== 'number'
      || !Number.isFinite(entry.durationMs)
      || entry.durationMs < 0
    ) {
      continue;
    }
    const assistantUuid = resolveTurnDurationAssistantUuid(
      entry.parentUuid,
      entriesByUuid,
    );
    if (!assistantUuid) continue;

    durations.set(assistantUuid, entry.durationMs);
  }
  return durations;
}

function resolveTurnDurationAssistantUuid(
  parentUuid: string,
  entriesByUuid: ReadonlyMap<string, SDKNativeMessage>,
): string | null {
  const seen = new Set<string>();
  let currentUuid: string | null = parentUuid;

  while (currentUuid && !seen.has(currentUuid)) {
    seen.add(currentUuid);
    const entry = entriesByUuid.get(currentUuid);
    if (!entry) return null;
    if (entry.type === 'assistant') return currentUuid;
    if (entry.type !== 'system') return null;
    currentUuid = typeof entry.parentUuid === 'string'
      ? entry.parentUuid
      : null;
  }

  return null;
}

export function getLastSDKSessionModel(
  entries: SDKNativeMessage[],
  resumeAtMessageId?: string,
): string | null {
  const activeBranch = filterActiveBranch(entries, resumeAtMessageId);
  if (
    resumeAtMessageId
    && !activeBranch.some(entry => entry.uuid === resumeAtMessageId)
  ) {
    return null;
  }

  let model: string | null = null;
  for (const entry of activeBranch) {
    const candidate = entry.type === 'assistant'
      ? entry.message?.model?.trim()
      : '';
    if (candidate && candidate !== '<synthetic>') {
      model = candidate;
    }
  }
  return model;
}

export async function loadSDKSessionModel(
  vaultPath: string,
  sessionId: string,
  resumeAtMessageId?: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
): Promise<string | null> {
  const resolvedPath = resolveSessionPath(vaultPath, sessionId, sessionPath, pathContext);
  const fingerprint = resolvedPath ? await getSessionFingerprint(resolvedPath) : null;
  const result = await readSessionEntries(vaultPath, sessionId, sessionPath, pathContext);
  if (result.error) return null;

  if (resolvedPath && fingerprint) {
    deletePendingModelRead(resolvedPath);
    const expiryTimer = window.setTimeout(() => pendingModelReads.delete(resolvedPath), PENDING_READ_TTL_MS);
    (expiryTimer as unknown as { unref?: () => void }).unref?.();
    pendingModelReads.set(resolvedPath, { fingerprint, read: result, expiryTimer });
    for (const oldest of pendingModelReads.keys()) {
      if (pendingModelReads.size <= MAX_PENDING_READS) break;
      deletePendingModelRead(oldest);
    }
  }
  return getLastSDKSessionModel(result.messages, resumeAtMessageId);
}

function normalizeTaskToolCalls(
  message: ChatMessage,
  normalizer: ClaudeTaskToolNormalizer,
  toolUseResults: Map<string, unknown>,
): void {
  if (message.role !== 'assistant' || !message.toolCalls) return;

  for (const toolCall of message.toolCalls) {
    const normalizedUse = normalizer.normalizeToolUse(
      toolCall.id,
      toolCall.name,
      toolCall.input,
    );
    if (!normalizedUse) continue;

    const rawOutput = toolUseResults.get(toolCall.id);
    const normalizedResult = toolCall.status === 'running'
      ? null
      : normalizer.normalizeToolResult(toolCall.id, rawOutput, {
        fallbackContent: toolCall.result,
        isError: toolCall.status === 'error' || toolCall.status === 'blocked',
      });
    const normalized = normalizedResult ?? normalizedUse;
    toolCall.name = normalized.name;
    toolCall.input = normalized.input;
    toolCall.providerPayload = {
      ...toolCall.providerPayload,
      ...normalized.providerPayload,
    };
  }
}
