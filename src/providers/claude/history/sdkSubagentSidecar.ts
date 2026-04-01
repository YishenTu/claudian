import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { ToolCallInfo } from '../../../core/types';
import { extractFinalResultFromSubagentJsonl } from '../../../utils/subagentJsonl';
import { extractToolResultContent } from '../sdk/toolResultContent';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  isPathSafeId,
  isValidSessionId,
} from './sdkSessionPaths';

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
      timestamp: number;
    };

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
        hasToolUse: false,
        hasToolResult: true,
        timestamp: event.timestamp,
      });
      continue;
    }

    existing.toolCall.status = event.isError ? 'error' : 'completed';
    existing.toolCall.result = event.content;
    existing.hasToolResult = true;
  }

  return Array.from(toolsById.values())
    .filter(entry => entry.hasToolUse)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(entry => entry.toolCall);
}

function getSubagentSidecarPath(
  vaultPath: string,
  sessionId: string,
  agentId: string,
): string | null {
  if (!isValidSessionId(sessionId) || !isValidAgentId(agentId)) {
    return null;
  }

  const encodedVault = encodeVaultPathForSDK(vaultPath);
  return path.join(
    getSDKProjectsPath(),
    encodedVault,
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`,
  );
}

export async function loadSubagentToolCalls(
  vaultPath: string,
  sessionId: string,
  agentId: string,
): Promise<ToolCallInfo[]> {
  const subagentFilePath = getSubagentSidecarPath(vaultPath, sessionId, agentId);
  if (!subagentFilePath) {
    return [];
  }

  try {
    if (!existsSync(subagentFilePath)) {
      return [];
    }

    const content = await fs.readFile(subagentFilePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const events: SubagentToolEvent[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }

      for (const event of parseSubagentEvents(raw)) {
        const key = `${event.type}:${event.toolUseId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        events.push(event);
      }
    }

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
): Promise<string | null> {
  const subagentFilePath = getSubagentSidecarPath(vaultPath, sessionId, agentId);
  if (!subagentFilePath) {
    return null;
  }

  try {
    if (!existsSync(subagentFilePath)) {
      return null;
    }

    const content = await fs.readFile(subagentFilePath, 'utf-8');
    return extractFinalResultFromSubagentJsonl(content);
  } catch {
    return null;
  }
}
