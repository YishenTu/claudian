import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { isRecord } from '../http/OpencodeHTTPClient';
import { opencodeTaskResultInterpreter } from '../runtime/OpencodeTaskResultInterpreter';

const MAX_CHILD_DEPTH = 3;

/**
 * V2 keeps each subagent's work in its own native session. Hydration reads those
 * sessions so reloaded cards show the child's tools; an unreadable child keeps the plain card.
 */
export async function hydrateOpencodeV2Subagents(
  messages: ChatMessage[],
  readChildMessages: (sessionId: string) => Promise<ChatMessage[]>,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_CHILD_DEPTH) return;
  const spawns = messages.flatMap(message => message.toolCalls ?? []).filter(tool => tool.name === TOOL_SUBAGENT);
  await Promise.all(spawns.map(async (spawn) => {
    const sessionId = getChildSessionId(spawn);
    if (!sessionId) return;
    let child: ChatMessage[];
    try {
      child = await readChildMessages(sessionId);
    } catch {
      return;
    }
    await hydrateOpencodeV2Subagents(child, readChildMessages, depth + 1);
    spawn.subagent = buildSubagentInfo(spawn, sessionId, child);
  }));
}

function getChildSessionId(spawn: ToolCallInfo): string | null {
  const rawOutput = spawn.providerPayload?.rawOutput;
  const metadata = isRecord(rawOutput) && isRecord(rawOutput.metadata) ? rawOutput.metadata : undefined;
  if (typeof metadata?.sessionID === 'string' && metadata.sessionID) return metadata.sessionID;
  return opencodeTaskResultInterpreter.interpretLaunch(spawn.result, spawn.status === 'error').agentId;
}

function buildSubagentInfo(spawn: ToolCallInfo, sessionId: string, child: ChatMessage[]): SubagentInfo {
  const interpreter = opencodeTaskResultInterpreter;
  const task = interpreter.describeTask(spawn.input);
  const isError = spawn.status === 'error' || spawn.status === 'blocked';
  const mode = task.mode ?? interpreter.interpretLaunch(spawn.result, isError).mode;
  const toolCalls = child.flatMap(message => message.toolCalls ?? []);
  const base = {
    id: spawn.id,
    agentId: sessionId,
    description: task.description ?? 'Subagent task',
    prompt: task.prompt ?? '',
    toolCalls,
    isExpanded: false,
  };
  const outcome = interpreter.interpretResult(spawn.result, isError, { mode, agentId: sessionId });
  const status = spawn.status === 'running' ? 'running' as const : outcome.status;
  if (mode !== 'async') return { ...base, mode: 'sync', status, result: outcome.result };
  // A background launch result only acknowledges the child; its answer lives in the child session.
  const answer = child.filter(message => message.role === 'assistant' && message.content.trim()).at(-1)?.content;
  return { ...base, mode: 'async', status, asyncStatus: status, result: status === 'completed' && answer ? answer : outcome.result };
}
