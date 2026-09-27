import * as fs from 'node:fs/promises';

import type { ChatMessage, SubagentInfo } from '../../../core/types';
import { findCodexSessionFileAsync, parseCodexSessionContent } from './CodexHistoryStore';

/** One history hydration, bounded by the parent's observed completion; never polls. */
export async function hydrateCodexSubagentHistory(
  messages: ChatMessage[], roots: string[], deadline: number,
): Promise<void> {
  for (const tool of messages.flatMap(message => message.toolCalls ?? [])) {
    const info = tool.subagent;
    if (info?.lifecycleSource !== 'session' || !info.agentId || !info.completedAt) continue;
    for (const root of roots) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const file = await findCodexSessionFileAsync(info.agentId, root, remaining);
      if (!file) continue;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      try {
        const content = await fs.readFile(file, { encoding: 'utf8', signal: controller.signal });
        tool.subagent = readCodexChildDetails(content, info);
        break;
      } catch {
        // The parent lifecycle remains usable if a child was removed or is unavailable.
      } finally { window.clearTimeout(timeout); }
    }
  }
}

function readCodexChildDetails(content: string, info: SubagentInfo): SubagentInfo {
  let ownMetadataRead = false;
  let createdAt = -Infinity;
  let turnLines: string[] = [];
  let nickname: string | undefined;
  let role: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let result: string | undefined;
  for (const line of content.split('\n')) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const record = asRecord(value);
    const payload = asRecord(record?.payload);
    if (!record || !payload) continue;
    if (record.type === 'session_meta' && !ownMetadataRead) {
      if (payload.id !== info.agentId) return info;
      ownMetadataRead = true;
      createdAt = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
      const spawn = asRecord(asRecord(asRecord(payload.source)?.subagent)?.thread_spawn);
      if (typeof spawn?.agent_nickname === 'string') nickname = spawn.agent_nickname;
      if (typeof spawn?.agent_role === 'string') role = spawn.agent_role;
    }
    const timestamp = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
    if (!Number.isFinite(timestamp) || timestamp > info.completedAt! || timestamp < createdAt) continue;
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      if (typeof payload.effort === 'string') effort = payload.effort;
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      result = undefined;
      turnLines = [];
    }
    turnLines.push(line);
    if (record.type === 'response_item' && payload.type === 'message'
      && payload.role === 'assistant' && payload.phase === 'final_answer' && Array.isArray(payload.content)) {
      result = payload.content.filter((part: { type?: string; text?: unknown }) => part.type === 'output_text' && typeof part.text === 'string')
        .map((part: { text: string }) => part.text).join('\n');
    }
    if (record.type === 'event_msg' && payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
      result = payload.last_agent_message;
    }
  }
  const label = nickname ?? info.description;
  const details = [role, model, effort].filter(Boolean);
  const toolCalls = parseCodexSessionContent(turnLines.join('\n')).flatMap(message => message.toolCalls ?? []);
  return { ...info, toolCalls, description: details.length ? `${label} (${details.join(', ')})` : label, ...(result ? { result } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
