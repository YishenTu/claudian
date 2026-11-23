import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { isRecord } from '../http/OpencodeHTTPClient';
import { type OpencodeSubagentReport, readOpencodeSubagentReport } from '../normalization/opencodeSyntheticReports';
import { opencodeTaskResultInterpreter } from '../runtime/OpencodeTaskResultInterpreter';

/** A native session's mapped messages with the rows they came from, whose idle reports mapping drops. */
export interface OpencodeHistorySession {
  readonly messages: ChatMessage[];
  readonly rows: readonly Record<string, unknown>[];
}

const MAX_CHILD_DEPTH = 3;

/**
 * V2 keeps each subagent's work in its own native session. Hydration reads those
 * sessions so reloaded cards show the child's tools; an unreadable child keeps the plain card.
 */
export async function hydrateOpencodeSubagents(
  session: OpencodeHistorySession,
  readChildSession: (sessionId: string) => Promise<OpencodeHistorySession>,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_CHILD_DEPTH) return;
  // Follow-ups can reuse a child session, so spawns are grouped by it in parent order.
  const spawnsBySession = new Map<string, Array<{ spawn: ToolCallInfo; messageId: string }>>();
  for (const message of session.messages) {
    for (const spawn of message.toolCalls ?? []) {
      if (spawn.name !== TOOL_SUBAGENT) continue;
      const sessionId = getChildSessionId(spawn);
      if (!sessionId) continue;
      spawnsBySession.set(sessionId, [...spawnsBySession.get(sessionId) ?? [], { spawn, messageId: message.id }]);
    }
  }
  await Promise.all([...spawnsBySession].map(async ([sessionId, spawns]) => {
    let child: OpencodeHistorySession;
    try {
      child = await readChildSession(sessionId);
    } catch {
      return;
    }
    await hydrateOpencodeSubagents(child, readChildSession, depth + 1);
    const turns = assignChildTurns(spawns.map(({ spawn }) => spawn), splitChildTurns(child.messages));
    const settled = spawns.map(({ messageId }) => findSpawnReport(session.rows, messageId, sessionId));
    const rounds = turns.map((turn, index) => turn && findTurnAnswer(child.rows, turn[0]?.role === 'user' ? turn[0].id : undefined, settled[index]?.at));
    spawns.forEach(({ spawn }, index) => {
      const turn = turns[index];
      if (!turn) return;
      const report = settled[index];
      const round = rounds[index];
      // A terminal report's body is OpenCode's answer, or failure, for the latest round it settles,
      // which every spawn joined into that round shares; spawns an earlier round answered keep theirs.
      const described = report && report.report.state !== 'running' && !settled.some((later, other) => (
        report.rowId !== undefined && later?.rowId === report.rowId && (rounds[other]?.turn ?? -1) > (round?.turn ?? -1)
      ));
      spawn.subagent = buildSubagentInfo(spawn, sessionId, turn, report?.report, described ? report.report.body || round?.answer : round?.answer);
    });
  }));
}

/**
 * The idle report that settles this spawn: the first terminal one after it, else the latest interim
 * one while the child's own work runs. A later follow-up's reports cannot reopen an earlier spawn, and
 * a spawn without any report keeps its launch outcome, since its server may have stopped.
 */
function findSpawnReport(rows: readonly Record<string, unknown>[], messageId: string, childId: string): SettledReport | undefined {
  let interim: SettledReport | undefined;
  for (const row of rows.slice(rows.findIndex(row => row.id === messageId) + 1)) {
    const report = row.type === 'synthetic' ? readOpencodeSubagentReport(row) : null;
    if (report?.childId !== childId) continue;
    const settled = { report, rowId: typeof row.id === 'string' ? row.id : undefined, at: rowCreatedAt(row) };
    if (report.state !== 'running') return settled;
    interim = settled;
  }
  return interim;
}

interface SettledReport { readonly report: OpencodeSubagentReport; readonly rowId: string | undefined; readonly at: number | undefined }

/**
 * A spawn's own answer is the last native assistant text of its turn before the report that settled
 * it; OpenCode 2.2 can wake a reported child again without another report. Native rows keep the
 * assistant steps that mapping merges. A turn without any answer was joined by the next prompt
 * before answering, so the next turn's answer covers it, as it did live.
 */
function findTurnAnswer(
  rows: readonly Record<string, unknown>[], promptId: string | undefined, before: number | undefined,
): { readonly answer: string | undefined; readonly turn: number } | undefined {
  const start = rows.findIndex(row => row.type === 'user' && row.id === promptId);
  if (start < 0) return undefined;
  // `turn` is the row index of the prompt whose turn answered, so spawns sharing a round compare equal.
  let turn = start;
  let answered = false;
  let answer: string | undefined;
  for (const [offset, row] of rows.slice(start + 1).entries()) {
    if (row.type === 'user') {
      const at = rowCreatedAt(row);
      if (answered || (before !== undefined && at !== undefined && at > before)) break;
      turn = start + 1 + offset;
      continue;
    }
    const text = row.type === 'assistant' && Array.isArray(row.content)
      ? row.content.filter(isRecord).flatMap(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim() ? [part.text] : []).join('\n')
      : '';
    if (!text) continue;
    answered = true;
    const at = rowCreatedAt(row);
    if (before === undefined || at === undefined || at <= before) answer = text;
  }
  return { answer, turn };
}

function rowCreatedAt(row: Record<string, unknown>): number | undefined {
  return isRecord(row.time) && typeof row.time.created === 'number' ? row.time.created : undefined;
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
    const matched = prompt ? turns.findIndex((turn, index) => index >= next && turn[0]?.role === 'user' && childPrompt(turn[0].content) === prompt) : -1;
    const index = matched >= 0 ? matched : next;
    if (index >= turns.length) return undefined;
    next = index + 1;
    return turns[index];
  });
}

/** OpenCode prefixes a child's first prompt with its subagent preamble. */
const CHILD_PREAMBLE = 'You are a subagent spawned by another session.\n';

function childPrompt(content: string): string {
  const prompt = content.trim();
  return prompt.startsWith(CHILD_PREAMBLE) ? prompt.slice(CHILD_PREAMBLE.length).trim() : prompt;
}

function getChildSessionId(spawn: ToolCallInfo): string | null {
  const rawOutput = spawn.providerPayload?.rawOutput;
  const metadata = isRecord(rawOutput) && isRecord(rawOutput.metadata) ? rawOutput.metadata : undefined;
  if (typeof metadata?.sessionID === 'string' && metadata.sessionID) return metadata.sessionID;
  return opencodeTaskResultInterpreter.interpretLaunch(spawn.result, spawn.status === 'error').agentId;
}

function buildSubagentInfo(
  spawn: ToolCallInfo, sessionId: string, child: ChatMessage[], report: OpencodeSubagentReport | undefined, answer: string | undefined,
): SubagentInfo {
  const interpreter = opencodeTaskResultInterpreter;
  const task = interpreter.describeTask(spawn.input);
  const isError = spawn.status === 'error' || spawn.status === 'blocked';
  // OpenCode can move a foreground spawn to the background, so a background launch outranks the input.
  const launchMode = interpreter.interpretLaunch(spawn.result, isError).mode;
  const mode = launchMode === 'async' ? 'async' : task.mode ?? launchMode;
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
  if (mode !== 'async') {
    return { ...base, mode: 'sync', status: spawn.status === 'running' ? 'running' : outcome.status, result: outcome.result };
  }
  const reported = report?.state === 'running' ? 'running' as const : report && report.state !== 'completed' ? 'error' as const : undefined;
  const status = spawn.status === 'running' ? 'running' as const : reported ?? outcome.status;
  // A failure report carries its cause; otherwise the answer lives in the child session, since a
  // background launch result only acknowledges the child.
  const result = reported === 'error' ? answer || outcome.result : status === 'completed' && answer ? answer : outcome.result;
  return { ...base, mode: 'async', status, asyncStatus: status, result };
}
