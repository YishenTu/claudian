import * as fs from 'fs/promises';

import type { ChatMessage, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { settleInterruptedTurn } from '../../../core/types';
import type { ClaudeConfigDirContext } from '../config/ClaudeConfigDir';
import { getClaudeExecutionTarget } from '../config/ClaudeConfigDir';
import { mapClaudeHistoryToolPaths } from '../normalization/claudePaths';
import { ClaudeTaskToolNormalizer } from '../normalization/ClaudeTaskToolNormalizer';
import { ClaudeTaskResultInterpreter } from '../runtime/ClaudeTaskResultInterpreter';
import { isClaudeSubagentToolName } from '../subagentToolNames';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  getSDKSessionPath,
  locateSDKSession,
  locateSDKSessions,
  readSDKSession,
  readSDKSessionFile,
} from './ClaudeHistoryPathResolver';
import { ClaudeTurnStats } from './ClaudeTurnStats';
import { buildAsyncSubagentInfo } from './sdkAsyncSubagent';
import { filterActiveBranch, type SDKCheckpointPolicy } from './sdkBranchFilter';
import type { SDKNativeMessage, SDKSessionLoadResult, SDKSessionReadResult } from './sdkHistoryTypes';
import {
  collectAsyncSubagentResults,
  collectStructuredPatchResults,
  collectToolResults,
  getSDKUserMessageTimestamp,
  hydrateStructuredToolResults,
  isCanonicalSDKUserMessage,
  isQueuedPromptAttachment,
  isStopHookFeedback,
  isSystemInjectedMessage,
  mergeAssistantMessage,
  parseSDKMessageToChat,
  parseTaskNotification,
} from './sdkMessageParsing';
import {
  hasSubagentSidecar,
  isValidAgentId,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
  readSubagentToolUseIndex,
  type SubagentRunWindow,
} from './sdkSubagentSidecar';

export { recoverSDKSessionIdByTime } from './ClaudeSessionRecovery';
export {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  hasSubagentSidecar,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
  locateSDKSession,
  locateSDKSessions,
  readSubagentToolUseIndex,
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
  pathContext: ClaudeConfigDirContext | undefined,
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
  pathContext: ClaudeConfigDirContext | undefined,
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
  pathContext?: ClaudeConfigDirContext,
  checkpointPolicy: SDKCheckpointPolicy = 'latest-branch',
): Promise<SDKSessionLoadResult> {
  const result = await takePendingModelRead(resolveSessionPath(vaultPath, sessionId, sessionPath, pathContext))
    ?? await readSessionEntries(vaultPath, sessionId, sessionPath, pathContext);

  if (result.error) {
    return { messages: [], skippedLines: result.skippedLines, error: result.error };
  }

  const filteredEntries = filterActiveBranch(result.messages.filter(entry => !entry.isSidechain), resumeAtMessageId, checkpointPolicy);

  const toolResults = collectToolResults(filteredEntries);
  const toolUseResults = collectStructuredPatchResults(filteredEntries);
  const asyncSubagentResults = collectAsyncSubagentResults(filteredEntries);
  const nativeTurnDurations = collectNativeTurnDurations(result.messages);

  const chatMessages: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;
  let turnStartedAt: number | undefined;
  let lastAssistantAt: number | undefined;
  let requestedResponsePending = false;
  /**
   * The native turn being read. Claude Code (2.1.274+) stamps every user-type record of a
   * turn with its `promptId`: the prompt or the notification that starts it, tool results,
   * Stop-hook and `max_tokens` continuations, compaction summaries and the interrupt marker.
   * Assistant, attachment and compaction records sit among their turn's records. Older
   * transcripts lack it; there a canonical prompt starts the next turn, and a notification
   * one after the running turn ended: a reply stopping for anything but tool use tentatively
   * ends it, further output or a blocking Stop hook's feedback continues it.
   */
  let turnId = 'transcript-start';
  let turnAutomatic = true;
  let nativeTurn = false;
  let legacyTurnEnded = true;
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

  // Resolve over every record, as live turn stats do: the active branch drops the progress
  // records a fold can follow. Parents precede their children in file order.
  const effectiveTimestamps = new Map<string, string | undefined>();
  for (const entry of result.messages) {
    if (entry.isSidechain || !entry.uuid) continue;
    effectiveTimestamps.set(entry.uuid, getSDKUserMessageTimestamp(
      entry, entry.parentUuid ? effectiveTimestamps.get(entry.parentUuid) : undefined,
    ));
  }
  // Preserve task notification boundaries without ending an unfinished requested response.
  for (const entry of filteredEntries) {
    const timestamp = isQueuedPromptAttachment(entry) && entry.uuid && effectiveTimestamps.has(entry.uuid)
      ? effectiveTimestamps.get(entry.uuid) : entry.timestamp;
    const sdkMsg = timestamp === entry.timestamp ? entry : { ...entry, timestamp };
    const notification = parseTaskNotification(sdkMsg);
    if (entry.promptId !== undefined && entry.promptId !== turnId) {
      turnId = entry.promptId;
      turnAutomatic = notification !== null;
      nativeTurn = true;
    } else if (notification !== null && !nativeTurn && legacyTurnEnded) {
      turnId = `notification:${sdkMsg.uuid ?? chatMessages.length}`;
      turnAutomatic = true;
      legacyTurnEnded = false;
    }
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
        turnId,
        content: '',
        timestamp: parseNativeTimestamp(sdkMsg.timestamp) ?? 0,
        contentBlocks: [{ type: 'task_notification', content: notification }],
      };
      continue;
    }
    if (isStopHookFeedback(sdkMsg)) legacyTurnEnded = false;
    if (isSystemInjectedMessage(sdkMsg)) continue;

    // Skip synthetic assistant messages (e.g., "No response requested." after /compact)
    if (sdkMsg.type === 'assistant' && sdkMsg.message?.model === '<synthetic>') continue;

    const chatMsg = parseSDKMessageToChat(sdkMsg, toolResults);
    if (!chatMsg) continue;
    normalizeTaskToolCalls(chatMsg, taskToolNormalizer, toolUseResults);
    if (chatMsg.role === 'assistant' || chatMsg.isInterrupt) chatMsg.turnId = turnId;

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
        const stopReason = sdkMsg.message?.stop_reason;
        legacyTurnEnded = Boolean(stopReason) && stopReason !== 'tool_use';
        lastAssistantAt = parseNativeTimestamp(sdkMsg.timestamp);
        requestedResponsePending = turnStartedAt !== undefined
          && sdkMsg.message?.stop_reason === 'tool_use';
      }
    } else {
      // An interrupted turn displays as one response, whichever splits showed it in parts.
      if (chatMsg.isInterrupt) {
        settleInterruptedTurn([...chatMessages, ...(pendingAssistant ? [pendingAssistant] : [])]
          .filter(message => message.turnId === turnId), turnAutomatic);
      }
      flushPendingAssistant(!chatMsg.isInterrupt);
      const prompt = isCanonicalSDKUserMessage(sdkMsg);
      legacyTurnEnded = !prompt;
      if (prompt) {
        turnStartedAt = parseNativeTimestamp(sdkMsg.timestamp);
        if (sdkMsg.type === 'user' && sdkMsg.promptId === undefined) {
          turnId = `prompt:${sdkMsg.uuid ?? chatMessages.length}`;
          turnAutomatic = false;
          nativeTurn = false;
        }
      }
      chatMessages.push(chatMsg);
    }
  }

  flushPendingAssistant(true);

  const taskResults = new ClaudeTaskResultInterpreter(pathContext);
  // TaskOutput-era transcripts can still refer to Linux temp files. Recover them
  // while the current store's target context is available, before neutral replay.
  if (getClaudeExecutionTarget(pathContext)?.method === 'wsl') {
    for (const message of chatMessages) {
      for (const tool of message.toolCalls ?? []) {
        if (tool.name !== 'TaskOutput' || tool.result === undefined) continue;
        tool.result = taskResults.interpretResult(tool.result, tool.status === 'error', {
          mode: 'async', agentId: taskResults.getOutputTaskId(tool.input) ?? undefined,
        }, { rawOutput: toolUseResults.get(tool.id) }).result;
      }
    }
  }
  const sidecarLoads: Array<{ subagent: SubagentInfo; promise: Promise<ToolCallInfo[]> }> = [];
  const loadSidecarToolCalls = (subagent: SubagentInfo, runWindow?: SubagentRunWindow): void => {
    if (!subagent.agentId || !isValidAgentId(subagent.agentId)) return;
    sidecarLoads.push({
      subagent,
      promise: loadSubagentToolCalls(vaultPath, sessionId, subagent.agentId, sessionPath, pathContext, runWindow),
    });
  };
  const reportLoads: Array<{ subagent: SubagentInfo; toolCall: ToolCallInfo; promise: Promise<string | null> }> = [];
  const toolTimes = collectToolTimes(filteredEntries);
  for (const message of chatMessages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (!isClaudeSubagentToolName(toolCall.name) || toolCall.input.run_in_background === true
        || toolCall.result === undefined) continue;
      const metadata = toolUseResults.get(toolCall.id);
      const payload = metadata === undefined ? undefined : { rawOutput: metadata };
      const mode = taskResults.describeTask(toolCall.input).mode
        ?? taskResults.interpretLaunch(toolCall.result, toolCall.status === 'error', payload).mode;
      if (mode === 'async') continue;
      // Older results identify the agent only in the hand-back text, as live handling accepts.
      const agentId = taskResults.interpretLaunch(toolCall.result, toolCall.status === 'error', payload).agentId;
      const result = taskResults.interpretResult(toolCall.result, toolCall.status === 'error',
        { mode: 'sync' }, payload);
      toolCall.result = result.result;
      if (!toolCall.subagent && agentId) {
        toolCall.subagent = {
          id: toolCall.id,
          description: (toolCall.input.description as string) || 'Subagent task',
          prompt: (toolCall.input.prompt as string) || '',
          mode: 'sync',
          isExpanded: false,
          status: result.status,
          result: result.result,
          toolCalls: [],
          agentId,
        };
        // Continuations and reuse append later runs; replay only this invocation's activity.
        const startedAt = toolTimes.uses.get(toolCall.id);
        const endedAt = toolTimes.results.get(toolCall.id);
        loadSidecarToolCalls(toolCall.subagent, startedAt !== undefined && endedAt !== undefined
          ? { startedAt, endedAt } : undefined);
      }
    }
  }
  hydrateStructuredToolResults(chatMessages, toolUseResults);

  // Build SubagentInfo for async Agent tool calls from toolUseResult + queue-operation data
  if (toolUseResults.size > 0 || asyncSubagentResults.size > 0) {
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
          loadSidecarToolCalls(subagent);
          if (subagent.agentId && isValidAgentId(subagent.agentId)
            && asyncSubagentResults.get(subagent.agentId)?.summaryOnly) {
            reportLoads.push({
              subagent,
              toolCall,
              promise: loadSubagentFinalResult(vaultPath, sessionId, subagent.agentId, sessionPath, pathContext),
            });
          }
        }
      }
    }
  }

  // Hydrate subagent tool calls from sidecar files in parallel
  const sidecarToolCalls = await Promise.all(sidecarLoads.map(load => load.promise));
  sidecarLoads.forEach(({ subagent }, index) => {
    if (sidecarToolCalls[index].length > 0) subagent.toolCalls = sidecarToolCalls[index];
  });
  // A summary-only notice defers to the sidecar's final report, as live completion recovery does.
  const reports = await Promise.all(reportLoads.map(load => load.promise));
  reportLoads.forEach(({ subagent, toolCall }, index) => {
    const report = reports[index]?.trim();
    if (!report) return;
    subagent.result = report;
    toolCall.result = report;
  });

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

  const target = getClaudeExecutionTarget(pathContext);
  for (const message of chatMessages) {
    for (const tool of message.toolCalls ?? []) mapClaudeHistoryToolPaths(tool, target);
  }
  return { messages: chatMessages, skippedLines: result.skippedLines };
}

/** Native timestamps of each tool call and of its result, which bound a sync subagent run. */
function collectToolTimes(entries: SDKNativeMessage[]): { uses: Map<string, number>; results: Map<string, number> } {
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  for (const entry of entries) {
    const timestamp = parseNativeTimestamp(entry.timestamp);
    const content = entry.message?.content;
    if (timestamp === undefined || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) uses.set(block.id, timestamp);
      if (block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, timestamp);
    }
  }
  return { uses, results };
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
  checkpointPolicy: SDKCheckpointPolicy = 'latest-branch',
): string | null {
  const activeBranch = filterActiveBranch(entries, resumeAtMessageId, checkpointPolicy);
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
  pathContext?: ClaudeConfigDirContext,
  checkpointPolicy: SDKCheckpointPolicy = 'latest-branch',
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
  return getLastSDKSessionModel(result.messages, resumeAtMessageId, checkpointPolicy);
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
