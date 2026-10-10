import type { ProviderSubagentLifecycleAdapter } from '@/core/providers/types';
import { resolveToolDiffData } from '@/core/tools/toolDiff';
import { isWriteEditTool, TOOL_SPAWN_AGENT } from '@/core/tools/toolNames';
import type { SubagentInfo, ToolCallInfo } from '@/core/types';

import { isRecord } from '../remote/DeepSeekRemoteClient';
import { DeepSeekOutput, type DeepSeekOutputEvent, deepseekText } from './DeepSeekOutput';

interface Child {
  info: SubagentInfo;
  lastSeq: number;
  output?: DeepSeekOutput;
}

/** Presentation only. The native observer remains the sole authority for owned work. */
export class DeepSeekSubagents {
  private readonly calls = new Map<string, ToolCallInfo>();
  private readonly children = new Map<string, Child>();
  private readonly parents = new Map<string, string>();

  constructor(private readonly publish: (info: SubagentInfo) => void) {}

  clear(): void { this.calls.clear(); this.children.clear(); this.parents.clear(); }

  parent(event: Record<string, unknown>): void {
    if (!isRecord(event.data)) return;
    const data = event.data;
    const callId = event.type === 'tool/ptc-dispatch-start' ? data.subCallId : data.callId;
    const result = event.type === 'tool/ptc-dispatch' ? { toolCallId: data.subCallId, content: data.content, isError: data.isError } : data.message;
    if ((event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') && typeof callId === 'string' && (data.name === 'subagent' || data.name === 'subagent_fork')) {
      let input: unknown = data.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
      this.calls.set(callId, { id: callId, name: TOOL_SPAWN_AGENT, input: isRecord(input) ? input : {}, status: 'running' });
    } else if ((event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') && isRecord(result) && typeof result.toolCallId === 'string') {
      const call = this.calls.get(result.toolCallId);
      if (!call) return;
      call.result = deepseekText(result.content);
      call.status = result.isError === true ? 'error' : 'completed';
      const id = childId(call.result);
      if (id) this.bind(id, call);
    } else if (event.type === 'subagent/catalog' && typeof data.childId === 'string' && typeof data.label === 'string') {
      // Foreground one-shot results have no child ID. Bind only an unambiguous native creation label.
      const matches = [...this.calls.values()].filter(call => call.status === 'running' && call.input.description === data.label && ![...this.parents.values()].includes(call.id));
      if (matches.length === 1) this.bind(data.childId, matches[0]);
    }
  }

  child(id: string, frame: Record<string, unknown>): void {
    let child = this.children.get(id);
    if (!child) {
      child = { lastSeq: -1, info: { id, agentId: id, lifecycleSource: 'session', description: 'DeepSeek subagent', mode: 'async', status: 'running', isExpanded: false, toolCalls: [] } };
      this.children.set(id, child);
    }
    const records = frame.type === 'snapshot' && Array.isArray(frame.records)
      ? frame.records.filter(isRecord).map(record => record.event).filter(isRecord)
      : frame.type === 'event' && isRecord(frame.event) ? [frame.event] : [];
    for (const event of records) {
      if (typeof event.seq !== 'number' || event.seq <= child.lastSeq || !isRecord(event.data)) continue;
      child.lastSeq = event.seq;
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;
      if (event.type === 'turn/start') {
        child.info = { ...child.info, status: 'running', result: '', toolCalls: [], startedAt: typeof event.time === 'number' ? event.time : undefined, completedAt: undefined };
        child.output = new DeepSeekOutput(output => this.output(id, child, output));
      } else if (event.type === 'turn/end') {
        const reason = isRecord(event.data.reason) ? event.data.reason.kind : undefined;
        child.info = { ...child.info, status: reason === 'completed' ? 'completed' : 'error', completedAt: typeof event.time === 'number' ? event.time : undefined };
      } else if (event.type !== 'assistant/attempt') child.output?.record(event);
      this.parent(event);
    }
    if (frame.type === 'assistant-stream') child.output?.frame(frame.frame);
    if (frame.type === 'snapshot' && frame.assistantStream !== undefined) child.output?.baseline(frame.assistantStream);
    this.emit(id);
  }

  private bind(id: string, call: ToolCallInfo): void {
    this.parents.set(id, call.id);
    this.emit(id);
  }

  private output(id: string, child: Child, event: DeepSeekOutputEvent): void {
    if (event.type === 'text_delta') child.info.result = (child.info.result ?? '') + event.text;
    if (event.type === 'tool_started') child.info.toolCalls.push({ id: event.toolCallId, name: event.name, input: { ...event.input }, status: 'running' });
    if (event.type === 'tool_completed' || event.type === 'tool_output') {
      const tool = child.info.toolCalls.find(tool => tool.id === event.toolCallId);
      if (tool) {
        const { diff, ...details } = event.resultDetails ?? {};
        if (event.type === 'tool_completed') {
          tool.result = event.content; tool.status = event.isError ? 'error' : 'completed';
          if (isWriteEditTool(tool.name)) tool.diffData = resolveToolDiffData(diff, tool);
        }
        Object.assign(tool, details);
      }
    }
    this.emit(id);
  }

  private emit(id: string): void {
    const child = this.children.get(id);
    const callId = this.parents.get(id);
    const call = callId ? this.calls.get(callId) : undefined;
    if (!child || !call) return;
    this.publish({ ...structuredClone(child.info), id: call.id,
      description: typeof call.input.description === 'string' ? call.input.description : child.info.description,
      prompt: typeof call.input.prompt === 'string' ? call.input.prompt : undefined,
      mode: call.input.run_in_background === false ? 'sync' : 'async',
    });
  }
}

function childId(result?: string): string | undefined { return /^started subagent (\S+)\s*$/.exec(result ?? '')?.[1]; }

export const deepseekSubagentAdapter: ProviderSubagentLifecycleAdapter = {
  protocol: 'lifecycle', isSpawnTool: name => name === TOOL_SPAWN_AGENT,
  isHiddenTool: () => false, isToolCallFullyOwned: () => false, isWaitTool: () => false, isCloseTool: () => false,
  resolveSpawnToolIds: () => [], extractWaitResult: () => ({ statuses: {}, timedOut: false }),
  extractSpawnResult: raw => ({ agentId: childId(raw) }),
  buildSubagentInfo: call => call.subagent ?? ({ id: call.id, agentId: childId(call.result),
    description: typeof call.input.description === 'string' ? call.input.description : 'DeepSeek subagent',
    prompt: typeof call.input.prompt === 'string' ? call.input.prompt : undefined,
    status: call.status === 'error' ? 'error' : call.status === 'running' || childId(call.result) ? 'running' : 'completed',
    result: childId(call.result) ? undefined : call.result, mode: call.input.run_in_background === false ? 'sync' : 'async',
    isExpanded: false, toolCalls: [],
  }),
};
