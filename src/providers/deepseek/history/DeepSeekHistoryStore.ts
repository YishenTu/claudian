import type { ChatMessage, SubagentInfo, ToolCallInfo } from '@/core/types';

import { DeepSeekOutput, type DeepSeekOutputEvent, deepseekText } from '../normalization/DeepSeekOutput';
import { DeepSeekSubagents } from '../normalization/DeepSeekSubagents';
import { type DeepSeekReader,isRecord } from '../remote/DeepSeekRemoteClient';
import { encodeDeepSeekCheckpoint } from '../types';
import { materializeDeepSeekToolImages, readDeepSeekImages } from './DeepSeekImages';
import { type DeepSeekRecord, readDeepSeekJournal, readDeepSeekProjection } from './DeepSeekJournal';

export async function loadDeepSeekHistory(client: DeepSeekReader, sessionId: string, throughSeq: number): Promise<ChatMessage[]> {
  const records: DeepSeekRecord[] = [];
  for await (const page of readDeepSeekJournal(client, sessionId, throughSeq)) records.unshift(...page);
  const messages: ChatMessage[] = [];
  let assistant: ChatMessage | undefined;
  let turnStart = 0;
  let output: DeepSeekOutput | undefined;
  let automatic = true;
  const pendingNotices: Array<{ type: 'task_notification'; content: string }> = [];
  const tools = new Map<string, ToolCallInfo>();
  const ensureAssistant = (record: DeepSeekRecord): ChatMessage => {
    if (!assistant) {
      assistant = { id: `deepseek:${sessionId}:assistant:${record.seq}`, role: 'assistant', content: '', timestamp: record.time,
        contentBlocks: pendingNotices.splice(0), toolCalls: [], ...(automatic ? { isAutomaticResponse: true } : {}),
      };
      messages.push(assistant);
    }
    return assistant;
  };
  for (const record of records) {
    // Replacement copies change model context; the native chat retains append-origin history.
    if (record.surfaceOp !== undefined && record.surfaceOp !== 'append') continue;
    // Failed attempts are native diagnostics, not committed assistant messages.
    if (record.type === 'assistant/attempt') continue;
    if (record.type === 'turn/start') {
      assistant = undefined; automatic = true; turnStart = record.time; pendingNotices.length = 0;
      output = new DeepSeekOutput(event => applyOutput(ensureAssistant(record), tools, event));
      continue;
    }
    if (record.type === 'user/message') {
      const source = isRecord(record.data.source) ? record.data.source : {};
      if (source.kind === 'user') {
        automatic = false;
        const images = await readDeepSeekImages(client, sessionId, record.data.content);
        messages.push({ id: `deepseek:${sessionId}:user:${record.seq}`, role: 'user', timestamp: record.time,
          content: deepseekText(record.data.content), userMessageId: typeof record.data.id === 'string' ? record.data.id : undefined,
          ...(images.length ? { images } : {}),
        });
      } else if (source.kind === 'tool-jobs' || source.kind === 'subagent-settled') {
        // A native turn may consume pending notices before its queued user input.
        // Keep them for the reply so hydration matches live requested-turn attribution.
        (assistant?.contentBlocks ?? pendingNotices).push({ type: 'task_notification', content: deepseekText(record.data.content) });
      }
      continue;
    }
    if (record.type === 'turn/end') {
      if (pendingNotices.length) ensureAssistant(record);
      if (assistant) {
        assistant.assistantMessageId = encodeDeepSeekCheckpoint(record.seq);
        assistant.completedAt = record.time;
        assistant.turnStats = { outputTokens: output?.outputTokens ?? 0, durationMs: Math.max(0, record.time - turnStart) };
      }
      output = undefined; assistant = undefined;
      continue;
    }
    if (record.type.startsWith('assistant/') || record.type.startsWith('tool/') || record.type === 'compaction/end' || record.type === 'request/context') {
      output ??= new DeepSeekOutput(event => applyOutput(ensureAssistant(record), tools, event));
      output.record(await materializeDeepSeekToolImages(client, sessionId, record));
    }
  }
  if (pendingNotices.length && records.length) ensureAssistant(records.at(-1)!);
  await hydrateChildren(client, sessionId, records, messages);
  return messages;
}

function applyOutput(message: ChatMessage, tools: Map<string, ToolCallInfo>, event: DeepSeekOutputEvent): void {
  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    const type = event.type === 'text_delta' ? 'text' : 'thinking';
    const last = message.contentBlocks!.at(-1);
    if (last?.type === type) last.content += event.text;
    else message.contentBlocks!.push({ type, content: event.text });
    if (type === 'text') message.content += event.text;
  } else if (event.type === 'tool_started') {
    const tool: ToolCallInfo = { id: event.toolCallId, name: event.name, input: { ...event.input }, status: 'running', providerPayload: event.providerPayload };
    tools.set(tool.id, tool); message.toolCalls!.push(tool); message.contentBlocks!.push({ type: 'tool_use', toolId: tool.id });
  } else if (event.type === 'tool_completed' || event.type === 'tool_output') {
    const tool = tools.get(event.toolCallId);
    if (tool) {
      if (event.type === 'tool_completed') { tool.status = event.isError ? 'error' : 'completed'; tool.result = event.content; }
      if (event.resultDetails?.scriptToolCalls) tool.scriptToolCalls = event.resultDetails.scriptToolCalls;
      if (event.resultDetails?.resultFormat) tool.resultFormat = event.resultDetails.resultFormat;
      if (event.resultDetails?.resultImages) tool.resultImages = event.resultDetails.resultImages;
    }

  } else if (event.type === 'context_compacted') {
    message.contentBlocks!.push({ type: 'context_compacted' });
  }
}


async function hydrateChildren(client: DeepSeekReader, root: string, records: DeepSeekRecord[], messages: ChatMessage[]): Promise<void> {
  const snapshots = new Map<string, SubagentInfo>();
  const tracker = new DeepSeekSubagents(info => snapshots.set(info.id, info));
  const queue = [{ id: root, records, depth: 0 }];
  const seen = new Set([root]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const event of parent.records) tracker.parent(event as unknown as Record<string, unknown>);
    if (parent.depth >= 3) continue;
    for (const event of parent.records) {
      const { childId, mode } = event.data;
      if (event.type !== 'subagent/catalog' || typeof childId !== 'string' || seen.has(childId) || (mode !== 'continuable' && mode !== 'one-shot')) continue;
      seen.add(childId);
      try {
        const projection = await readDeepSeekProjection(client, childId);
        const childRecords: DeepSeekRecord[] = [];
        for await (const page of readDeepSeekJournal(client, childId, projection.asOfSeq, { kind: 'subagent', childSessionId: childId, parentSessionId: parent.id, mode })) childRecords.unshift(...page);
        const materialized = [];
        for (const event of childRecords) materialized.push({ event: await materializeDeepSeekToolImages(client, childId, event) });
        tracker.child(childId, { type: 'snapshot', records: materialized, cursor: projection.asOfSeq });
        queue.push({ id: childId, records: childRecords, depth: parent.depth + 1 });
      } catch {
        // Missing or unreadable child history does not make the parent's transcript unreadable.
      }
    }
  }
  const attach = (tools: ToolCallInfo[], depth: number): void => {
    if (depth > 3) return;
    for (const tool of tools) {
      const info = snapshots.get(tool.id);
      if (!info) continue;
      tool.subagent = info;
      attach(info.toolCalls, depth + 1);
    }
  };
  for (const message of messages) attach(message.toolCalls ?? [], 0);
}
