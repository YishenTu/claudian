import * as path from 'path';

import { normalizeWebSearchResults } from '@/core/tools/toolResultDetails';
import type { ToolResultDetails, UsageInfo } from '@/core/types';
import {
  CODEX_WEB_SEARCH_RESULT,
  isCodexFailedToolStatus,
  isCodexToolOutputError,
  normalizeCodexMCPToolInput,
  normalizeCodexMCPToolName,
  normalizeCodexMCPToolState,
  normalizeCodexToolCall,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  normalizeCodexWebSearchInput,
  stringifyCodexToolOutput,
} from '@/providers/codex/normalization/codexToolNormalization';
import type {
  CollabAgentToolCallItem,
  CommandExecutionItem,
  DynamicToolCallItem,
  FileChangeItem,
  ImageViewItem,
  ItemStartedNotification,
  MCPToolCallItem,
  TokenUsageUpdatedNotification,
  TurnPlanUpdatedNotification,
  WebSearchItem,
} from '@/providers/codex/runtime/codexAppServerTypes';

import { asRecord, firstString } from './codexNotificationValues';
import type { RawToolResult } from './CodexToolLedger';

/** Pure projections from app-server items to visible tool calls and results. */

export interface CodexToolUseProjection {
  name: string;
  input: Record<string, unknown>;
}

export interface CodexToolResultProjection {
  content: string;
  isError: boolean;
}

/** A canonical item's request, compared with requests decoded from raw script calls. */
export interface CanonicalToolProjection extends CodexToolUseProjection {
  itemId: string;
  comparisonInput?: Record<string, unknown>;
}

type CanonicalToolItem = ItemStartedNotification['item'];

const COLLAB_AGENT_TOOL_MAP: Record<string, string> = {
  spawnAgent: 'spawn_agent',
  wait: 'wait',
  sendInput: 'send_input',
  resumeAgent: 'resume_agent',
  closeAgent: 'close_agent',
  sendMessage: 'send_message',
  followupTask: 'followup_task',
  interruptAgent: 'interrupt_agent',
  listAgents: 'list_agents',
};

export function isCanonicalToolItem(item: CanonicalToolItem): boolean {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'imageView'
    || item.type === 'webSearch'
    || item.type === 'collabAgentToolCall'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall';
}

/** File changes are excluded: their input accumulates across patch updates. */
export function buildCanonicalToolProjection(
  item: CanonicalToolItem,
  workingDirectory?: string,
): CanonicalToolProjection | null {
  switch (item.type) {
    case 'commandExecution': {
      const { name, input } = projectCommandToolUse(item);
      return {
        itemId: item.id,
        name,
        input,
        comparisonInput: {
          ...input,
          workingDirectory: resolveToolWorkingDirectory(item.cwd, workingDirectory),
        },
      };
    }

    case 'imageView':
      return { itemId: item.id, ...projectImageViewToolUse(item) };

    case 'webSearch':
      return { itemId: item.id, name: 'WebSearch', input: normalizeCodexWebSearchInput(item) };

    case 'collabAgentToolCall':
      return {
        itemId: item.id,
        name: collabAgentToolName(item),
        input: getCollabAgentInput(item),
      };

    case 'mcpToolCall':
      return { itemId: item.id, ...projectMCPToolUse(item) };

    case 'dynamicToolCall':
      return { itemId: item.id, ...normalizeCodexToolCall(
        item.namespace ? `${item.namespace}__${item.tool}` : item.tool,
        asRecord(item.arguments) ?? {},
      ) };

    default:
      return null;
  }
}

// -- commandExecution ---------------------------------------------------------

export function readCanonicalCommand(item: CommandExecutionItem): string {
  return item.commandActions?.[0]?.command ?? item.command;
}

export function readCanonicalCommandCandidates(item: CommandExecutionItem): string[] {
  return [...new Set([
    readCanonicalCommand(item),
    item.command,
  ].filter(Boolean))];
}

export function projectCommandToolUse(item: CommandExecutionItem): CodexToolUseProjection {
  return {
    name: normalizeCodexToolName('command_execution'),
    input: normalizeCodexToolInput('command_execution', { command: readCanonicalCommand(item) }),
  };
}

export function projectCommandToolResult(
  item: CommandExecutionItem,
  rawResult?: RawToolResult,
): CodexToolResultProjection {
  const output = item.aggregatedOutput ?? '';
  return {
    content: rawResult?.content ?? normalizeCodexToolResult(normalizeCodexToolName('command_execution'), output),
    isError: item.exitCode !== null
      ? item.exitCode !== 0
      : rawResult?.isError ?? isCodexToolOutputError(output),
  };
}

export function normalizeWorkingDirectory(
  workingDirectory: string | undefined,
  baseDirectory?: string,
): string | undefined {
  return workingDirectory
    ? path.resolve(baseDirectory ?? '', workingDirectory)
    : undefined;
}

export function resolveToolWorkingDirectory(
  workingDirectory: string | undefined,
  baseDirectory?: string,
): string | undefined {
  return workingDirectory
    ? normalizeWorkingDirectory(workingDirectory, baseDirectory)
    : normalizeWorkingDirectory(baseDirectory);
}

// -- raw tool output ----------------------------------------------------------

export function normalizeRawToolOutput(
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

// -- fileChange ---------------------------------------------------------------

export const FILE_CHANGE_TOOL_NAME = normalizeCodexToolName('file_change');

export function buildFileChangeInput(changes: unknown): Record<string, unknown> {
  // Native add/delete `diff` values are whole-file contents, including literal
  // Markdown/diff prefixes. Convert once at the protocol boundary.
  return { changes: normalizeFileChanges(changes).map(change => {
    if ((change.kind !== 'add' && change.kind !== 'delete') || typeof change.diff !== 'string' || !change.diff) {
      return change;
    }
    const prefix = change.kind === 'add' ? '+' : '-';
    const lines = change.diff.replace(/\n$/, '').split('\n');
    const hunk = change.kind === 'add' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
    return { ...change, diff: [hunk, ...lines.map(line => prefix + line)].join('\n') };
  }) };
}

export function projectFileChangeToolResult(
  item: FileChangeItem,
  input: Record<string, unknown>,
): CodexToolResultProjection {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const paths = changes
    .map(change => formatFileChangeSummary(change))
    .filter(Boolean)
    .join(', ');
  return {
    content: paths || 'File change completed',
    isError: item.status === 'failed' || item.status === 'declined',
  };
}

export function mergeApplyPatchInputs(
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
  const changePath = firstString(record?.path);
  if (!record || !changePath) {
    return null;
  }

  const kindInfo = normalizeFileChangeKind(record.kind ?? record.type);
  const diff = firstString(record.diff);
  return {
    ...record,
    path: changePath,
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
  const changePath = firstString(record?.path);
  if (!record || !changePath) {
    return '';
  }

  const kind = firstString(record.kind, record.type) || 'change';
  return `${kind}: ${changePath}`;
}

// -- imageView ----------------------------------------------------------------

export function projectImageViewToolUse(item: ImageViewItem): CodexToolUseProjection {
  return {
    name: normalizeCodexToolName('view_image'),
    input: normalizeCodexToolInput('view_image', { path: item.path }),
  };
}

// -- webSearch ----------------------------------------------------------------

/** Searches whose request is still unknown have none of these fields. */
export function hasWebSearchRequest(input: Record<string, unknown>): boolean {
  return ['query', 'url', 'pattern', 'actions', 'requests'].some(key => key in input);
}

export function projectWebSearchToolResult(item: WebSearchItem): CodexToolResultProjection & {
  resultDetails?: ToolResultDetails;
} {
  const webSearchResults = normalizeWebSearchResults(item.results);
  return {
    content: CODEX_WEB_SEARCH_RESULT,
    isError: isCodexFailedToolStatus(item.status),
    ...(webSearchResults ? { resultDetails: { webSearchResults } } : {}),
  };
}

// -- collabAgentToolCall ------------------------------------------------------

function collabAgentToolName(item: CollabAgentToolCallItem): string {
  return COLLAB_AGENT_TOOL_MAP[item.tool] ?? item.tool;
}

export function projectCollabAgentToolUse(
  item: CollabAgentToolCallItem,
  requestedInput?: Record<string, unknown>,
): CodexToolUseProjection {
  const name = collabAgentToolName(item);
  return {
    name,
    input: normalizeCodexToolInput(name, { ...requestedInput, ...getCollabAgentInput(item) }),
  };
}

export function projectCollabAgentToolResult(
  item: CollabAgentToolCallItem,
  rawResult?: RawToolResult,
): CodexToolResultProjection {
  return {
    content: getCollabAgentResult(item, rawResult),
    isError: Boolean(rawResult?.isError) || item.status === 'failed' || item.status === 'error',
  };
}

function getCollabAgentResult(item: CollabAgentToolCallItem, rawResult?: RawToolResult): string {
  // A failed tool request does not establish a new agent lifecycle state.
  if (rawResult?.isError) return rawResult.content;
  let rawRecord: Record<string, unknown> | null = null;
  if (rawResult?.content) {
    try {
      rawRecord = asRecord(JSON.parse(rawResult.content));
    } catch {
      // Plain-text acknowledgements are retained alongside native state below.
    }
  }
  const itemRecord = asRecord(item.result);
  const result = { ...itemRecord, ...rawRecord };
  // Raw answers can be richer than the native snapshot. Fill missing agents
  // from native state without discarding acknowledgement or identity fields.
  const statuses = { ...item.agentsStates, ...asRecord(itemRecord?.status), ...asRecord(rawRecord?.status) };
  if (Object.keys(statuses).length) result.status = statuses;
  if (item.tool === 'spawnAgent' && item.receiverThreadIds?.length === 1 && !result.agent_id) {
    result.agent_id = item.receiverThreadIds[0];
  }
  const text = rawResult ? (rawRecord ? undefined : rawResult.content)
    : typeof item.result === 'string' ? item.result : undefined;
  if (Object.keys(result).length) {
    if (text) result.output = text;
    return JSON.stringify(result);
  }
  return text ?? rawResult?.content ?? (item.result !== undefined ? JSON.stringify(item.result)
    : item.status === 'completed' ? 'Completed' : item.status ?? 'Done');
}

function getCollabAgentInput(item: CollabAgentToolCallItem): Record<string, unknown> {
  return {
    ...(item.prompt != null ? { message: item.prompt } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.reasoningEffort ? { reasoning_effort: item.reasoningEffort } : {}),
    ...(item.tool !== 'spawnAgent' && item.receiverThreadIds?.length
      ? { ids: item.receiverThreadIds } : {}),
    ...item.arguments,
  };
}

// -- mcpToolCall --------------------------------------------------------------

export function projectMCPToolUse(item: MCPToolCallItem): CodexToolUseProjection {
  return {
    name: normalizeCodexMCPToolName(item.server, item.tool),
    input: normalizeCodexMCPToolInput(item.arguments),
  };
}

export function projectMCPToolResult(item: MCPToolCallItem): CodexToolResultProjection {
  const state = normalizeCodexMCPToolState(item.status, item.result, item.error);
  return {
    // A completion without a terminal status or output did not report success.
    content: state.result ?? 'Failed',
    isError: state.isError,
  };
}

// -- dynamicToolCall ----------------------------------------------------------

export function projectDynamicToolResult(item: DynamicToolCallItem): CodexToolResultProjection {
  const content = (item.contentItems ?? [])
    .map(contentItem => contentItem.type === 'inputText'
      ? contentItem.text
      : contentItem.imageUrl)
    .filter(Boolean)
    .join('\n');
  return {
    content: content || (item.success === false ? 'Failed' : 'Completed'),
    isError: item.success === false || item.status === 'failed',
  };
}

// -- turn/plan/updated (update_plan) ------------------------------------------

const PLAN_STATUS_MAP: Record<string, string> = {
  inProgress: 'in_progress',
  in_progress: 'in_progress',
};

/** Returns the visible TodoWrite input and the request it fulfils, which also carries the explanation. */
export function projectPlanUpdate(params: TurnPlanUpdatedNotification): {
  input: Record<string, unknown>;
  requestInput: Record<string, unknown>;
} {
  const todos = params.plan.map(item => ({
    id: '',
    content: item.step,
    activeForm: item.step,
    status: PLAN_STATUS_MAP[item.status] ?? item.status,
  }));
  return {
    input: { todos },
    requestInput: {
      todos,
      ...(params.explanation ? { explanation: params.explanation } : {}),
    },
  };
}

// -- thread/tokenUsage/updated ------------------------------------------------

export function projectTokenUsage(params: TokenUsageUpdatedNotification): UsageInfo {
  const last = params.tokenUsage.last;
  const contextTokens = last.inputTokens;
  const reportedWindow = params.tokenUsage.modelContextWindow;
  const contextWindow = typeof reportedWindow === 'number' && Number.isFinite(reportedWindow) && reportedWindow > 0
    ? reportedWindow
    : 0;

  return {
    inputTokens: last.inputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: last.cachedInputTokens,
    contextWindow,
    contextTokens,
    percentage: contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100))) : 0,
  };
}
