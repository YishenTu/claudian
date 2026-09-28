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
  // Follow-ups can reuse a child session, so spawns are grouped by it in parent order.
  const spawnsBySession = new Map<string, ToolCallInfo[]>();
  for (const spawn of messages.flatMap(message => message.toolCalls ?? [])) {
    if (spawn.name !== TOOL_SUBAGENT) continue;
    const sessionId = getChildSessionId(spawn);
    if (!sessionId) continue;
    spawnsBySession.set(sessionId, [...spawnsBySession.get(sessionId) ?? [], spawn]);
  }
  await Promise.all([...spawnsBySession].map(async ([sessionId, spawns]) => {
    let child: ChatMessage[];
    try {
      child = await readChildMessages(sessionId);
    } catch {
      return;
    }
    await hydrateOpencodeV2Subagents(child, readChildMessages, depth + 1);
    const turns = assignChildTurns(spawns, splitChildTurns(child));
    spawns.forEach((spawn, index) => {
      const turn = turns[index];
      if (turn) spawn.subagent = buildSubagentInfo(spawn, sessionId, turn);
    });
  }));
}

/** Each task sent to a child session starts a turn at its user prompt. */
function splitChildTurns(child: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  for (const message of child) {
    if (message.role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns;
}

/**
 * Pairs spawns with child turns in order, preferring a turn whose prompt matches the
 * spawn's. A spawn with no remaining turn keeps the plain card rather than borrowing another task's.
 */
function assignChildTurns(spawns: ToolCallInfo[], turns: ChatMessage[][]): Array<ChatMessage[] | undefined> {
  let next = 0;
  return spawns.map((spawn) => {
    const prompt = opencodeTaskResultInterpreter.describeTask(spawn.input).prompt?.trim();
    const matched = prompt ? turns.findIndex((turn, index) => index >= next && turn[0]?.role === 'user' && turn[0].content.trim() === prompt) : -1;
    const index = matched >= 0 ? matched : next;
    if (index >= turns.length) return undefined;
    next = index + 1;
    return turns[index];
  });
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
