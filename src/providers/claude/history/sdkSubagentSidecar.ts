import { existsSync, readdirSync, readFileSync } from 'fs';
import * as path from 'path';

import { forEachJSONLLine } from '@/utils/jsonlFile';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type { ToolCallInfo } from '../../../core/types';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  isPathSafeId,
  isValidSessionId,
} from './ClaudeHistoryPathResolver';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import { hydrateStructuredToolResult } from './sdkMessageParsing';
import { createSubagentFinalResultCollector } from './subagentJSONL';

export function isValidAgentId(agentId: string): boolean {
  return isPathSafeId(agentId);
}

type SubagentToolEvent =
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError: boolean;
      toolUseResult: unknown;
      timestamp: number;
    };

function isWithinRun(entry: unknown, runWindow: SubagentRunWindow): boolean {
  const raw = (entry as { timestamp?: unknown } | null)?.timestamp;
  const timestamp = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return timestamp >= runWindow.startedAt && timestamp <= runWindow.endedAt;
}

function parseTimestampMs(raw: unknown): number {
  if (typeof raw !== 'string') {
    return Date.now();
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function parseSubagentEvents(entry: unknown): SubagentToolEvent[] {
  if (!entry || typeof entry !== 'object') {
    return [];
  }

  const record = entry as SDKNativeMessage;
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const timestamp = parseTimestampMs(record.timestamp);
  const events: SubagentToolEvent[] = [];

  for (const blockRaw of content) {
    if (!blockRaw || typeof blockRaw !== 'object') {
      continue;
    }

    const block = blockRaw as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };

    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        continue;
      }

      events.push({
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {},
        timestamp,
      });
      continue;
    }

    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string') {
        continue;
      }

      events.push({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: extractToolResultContent(block.content),
        isError: block.is_error === true,
        toolUseResult: record.toolUseResult,
        timestamp,
      });
    }
  }

  return events;
}

function buildToolCallsFromSubagentEvents(events: SubagentToolEvent[]): ToolCallInfo[] {
  const toolsById = new Map<
    string,
    {
      toolCall: ToolCallInfo;
      toolUseResult?: unknown;
      hasToolUse: boolean;
      hasToolResult: boolean;
      timestamp: number;
    }
  >();

  for (const event of events) {
    const existing = toolsById.get(event.toolUseId);

    if (event.type === 'tool_use') {
      if (!existing) {
        toolsById.set(event.toolUseId, {
          toolCall: {
            id: event.toolUseId,
            name: event.toolName,
            input: { ...event.toolInput },
            status: 'running',
            isExpanded: false,
          },
          hasToolUse: true,
          hasToolResult: false,
          timestamp: event.timestamp,
        });
      } else {
        existing.toolCall.name = event.toolName;
        existing.toolCall.input = { ...event.toolInput };
        existing.hasToolUse = true;
        existing.timestamp = event.timestamp;
      }
      continue;
    }

    if (!existing) {
      toolsById.set(event.toolUseId, {
        toolCall: {
          id: event.toolUseId,
          name: 'Unknown',
          input: {},
          status: event.isError ? 'error' : 'completed',
          result: event.content,
          isExpanded: false,
        },
        toolUseResult: event.toolUseResult,
        hasToolUse: false,
        hasToolResult: true,
        timestamp: event.timestamp,
      });
      continue;
    }

    existing.toolCall.status = event.isError ? 'error' : 'completed';
    existing.toolCall.result = event.content;
    existing.toolUseResult = event.toolUseResult;
    existing.hasToolResult = true;
  }

  return Array.from(toolsById.values())
    .filter(entry => entry.hasToolUse)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(entry => {
      hydrateStructuredToolResult(entry.toolCall, entry.toolUseResult);
      return entry.toolCall;
    });
}

function getSubagentsDirectory(
  vaultPath: string,
  sessionId: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
): string | null {
  if (!isValidSessionId(sessionId)) {
    return null;
  }

  const projectPath = sessionPath
    ? path.dirname(sessionPath)
    : path.join(getSDKProjectsPath(pathContext), encodeVaultPathForSDK(vaultPath));
  return path.join(projectPath, sessionId, 'subagents');
}

function getSubagentSidecarPath(
  vaultPath: string,
  sessionId: string,
  agentId: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
): string | null {
  if (!isValidAgentId(agentId)) {
    return null;
  }
  const directory = getSubagentsDirectory(vaultPath, sessionId, sessionPath, pathContext);
  return directory ? path.join(directory, `agent-${agentId}.jsonl`) : null;
}

/** Whether Claude's native sidecar holds this subagent's transcript. */
export function hasSubagentSidecar(
  vaultPath: string,
  sessionId: string,
  agentId: string,
  pathContext?: ProviderHistoryPathContext,
): boolean {
  try {
    const subagentFilePath = getSubagentSidecarPath(vaultPath, sessionId, agentId, undefined, pathContext);
    return subagentFilePath !== null && existsSync(subagentFilePath);
  } catch {
    return false;
  }
}

/** Maps spawning tool call ids to agent ids from the `agent-<id>.meta.json` files beside sidecars. */
export function readSubagentToolUseIndex(
  vaultPath: string,
  sessionId: string,
  pathContext?: ProviderHistoryPathContext,
): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const directory = getSubagentsDirectory(vaultPath, sessionId, undefined, pathContext);
    if (!directory || !existsSync(directory)) return index;
    for (const name of readdirSync(directory)) {
      const agentId = /^agent-(.+)\.meta\.json$/.exec(name)?.[1];
      if (!agentId || !isValidAgentId(agentId) || !existsSync(path.join(directory, `agent-${agentId}.jsonl`))) continue;
      try {
        const toolUseId = (JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as { toolUseId?: unknown }).toolUseId;
        if (typeof toolUseId === 'string') index.set(toolUseId, agentId);
      } catch {
        // An unreadable entry leaves that subagent's stored copy in place.
      }
    }
  } catch {
    // Unavailable history keeps every stored copy.
  }
  return index;
}

/** Bounds of one invocation; a reused agent appends later runs to the same sidecar. */
export interface SubagentRunWindow {
  startedAt: number;
  endedAt: number;
}

export async function loadSubagentToolCalls(
  vaultPath: string,
  sessionId: string,
  agentId: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
  runWindow?: SubagentRunWindow,
): Promise<ToolCallInfo[]> {
  const subagentFilePath = getSubagentSidecarPath(
    vaultPath,
    sessionId,
    agentId,
    sessionPath,
    pathContext,
  );
  if (!subagentFilePath) {
    return [];
  }

  try {
    if (!existsSync(subagentFilePath)) {
      return [];
    }

    const events: SubagentToolEvent[] = [];
    const seen = new Set<string>();

    await forEachJSONLLine(subagentFilePath, line => {
      if (!line.trim()) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }

      // Untimed rows cannot be placed in a run, so a bounded replay omits them.
      if (runWindow && !isWithinRun(raw, runWindow)) return;
      for (const event of parseSubagentEvents(raw)) {
        const key = `${event.type}:${event.toolUseId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        events.push(event);
      }
    });

    if (events.length === 0) {
      return [];
    }

    return buildToolCallsFromSubagentEvents(events);
  } catch {
    return [];
  }
}

export async function loadSubagentFinalResult(
  vaultPath: string,
  sessionId: string,
  agentId: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
): Promise<string | null> {
  const subagentFilePath = getSubagentSidecarPath(
    vaultPath,
    sessionId,
    agentId,
    sessionPath,
    pathContext,
  );
  if (!subagentFilePath) {
    return null;
  }

  try {
    if (!existsSync(subagentFilePath)) {
      return null;
    }

    const collector = createSubagentFinalResultCollector();
    await forEachJSONLLine(subagentFilePath, collector.addLine);
    return collector.result();
  } catch {
    return null;
  }
}
