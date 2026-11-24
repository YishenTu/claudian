import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { isRecord } from '../http/OpencodeHTTPClient';
import { type OpencodeSubagentReport, readOpencodeSubagentReport } from '../normalization/opencodeSyntheticReports';
import { normalizeOpencodeToolName } from '../normalization/opencodeToolNormalization';
import { opencodeTaskResultInterpreter } from '../runtime/OpencodeTaskResultInterpreter';
import { classifyOpencodeLaunch, OpencodeChildLedger } from '../subagents/OpencodeChildLedger';
import type { OpencodeChildEntry } from '../subagents/OpencodeSpawnSettlement';

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
  const spawnsBySession = new Map<string, LocatedSpawn[]>();
  for (const located of locateSpawns(session)) {
    const sessionId = getChildSessionId(located.spawn);
    if (!sessionId) continue;
    spawnsBySession.set(sessionId, [...spawnsBySession.get(sessionId) ?? [], located]);
  }
  await Promise.all([...spawnsBySession].map(async ([sessionId, spawns]) => {
    let child: OpencodeHistorySession;
    try {
      child = await readChildSession(sessionId);
    } catch {
      return;
    }
    await hydrateOpencodeSubagents(child, readChildSession, depth + 1);
    const ledger = replayChild(session.rows, sessionId, spawns, child.rows);
    const turns = splitChildTurns(child.messages);
    for (const { spawn, key } of spawns) {
      const promptId = ledger.promptId(key);
      // A child cancelled before it took the prompt has no turn, but its spawn still settles.
      const turn = turns.find(candidate => candidate[0]?.role === 'user' && candidate[0].id === promptId) ?? [];
      spawn.subagent = buildSubagentInfo(spawn, sessionId, turn, ledger, key);
    }
  }));
}

/**
 * A spawn with the native row that holds it. Its key matches the kernel's, by that row and tool call,
 * since models can reuse a tool call ID across messages; its tool part's times say when it started
 * and when its launch ended.
 */
interface LocatedSpawn {
  readonly spawn: ToolCallInfo;
  readonly key: string;
  readonly row: number;
  readonly started: number | undefined;
  readonly launched: number | undefined;
}

/**
 * Mapping can merge consecutive assistant rows into one message, so each spawn takes the next row
 * holding its subagent call from its message's first row on; a model can reuse an ID across tools.
 */
function locateSpawns(session: OpencodeHistorySession): LocatedSpawn[] {
  const { rows } = session;
  const claimed = new Set<string>();
  const located: LocatedSpawn[] = [];
  for (const message of session.messages) {
    const spawns = message.toolCalls?.filter(tool => tool.name === TOOL_SUBAGENT) ?? [];
    const start = spawns.length > 0 ? rows.findIndex(row => row.id === message.id) : -1;
    for (const spawn of spawns) {
      if (start < 0) continue;
      const index = rows.findIndex((row, candidate) => candidate >= start && !claimed.has(`${candidate}:${spawn.id}`) && isSpawnPart(toolPart(row, spawn.id)));
      if (index < 0) continue;
      claimed.add(`${index}:${spawn.id}`);
      const time = toolPart(rows[index], spawn.id)?.time;
      const started = readTime(time, 'created') ?? readTime(rows[index].time, 'created');
      located.push({ spawn, key: `${String(rows[index].id)}:${spawn.id}`, row: index, started, launched: readTime(time, 'completed') ?? started });
    }
  }
  return located;
}

interface TimedEntry { readonly entry: OpencodeChildEntry; readonly at: number | undefined }

/** Child prompts and assistant text parts, as the kernel records them live. */
function readChildEntries(rows: readonly Record<string, unknown>[]): TimedEntry[] {
  return rows.flatMap((row): TimedEntry[] => {
    const at = readTime(row.time, 'created');
    if (row.type === 'user' && typeof row.id === 'string') return [{ entry: { kind: 'prompt', id: row.id, text: typeof row.text === 'string' ? row.text : '' }, at }];
    if (row.type !== 'assistant' || typeof row.id !== 'string' || !Array.isArray(row.content)) return [];
    const messageId = row.id;
    return row.content.filter(isRecord).flatMap(part => (
      part.type === 'text' && typeof part.text === 'string' ? [{ entry: { kind: 'text' as const, messageId, text: part.text }, at }] : []
    ));
  });
}

/** A native fact the kernel sees live about one child, at the time it saw it, from the spawner's row. */
type ReplayEvent = { readonly at: number | undefined; readonly row: number } & (
  | { readonly kind: 'spawn' | 'launch'; readonly located: LocatedSpawn }
  | { readonly kind: 'report'; readonly report: OpencodeSubagentReport }
);

/**
 * Feeds the child's ledger the native facts the kernel sees live, in the order it sees them: each
 * spawn when its tool call starts and how its launch ended when it finishes, and each idle report
 * when OpenCode queues it, after the child's entries up to then. A report queued while the spawner
 * is mid-step is stored after a follow-up that launched meanwhile, so row order alone would let it
 * settle that follow-up.
 */
function replayChild(
  rows: readonly Record<string, unknown>[],
  childId: string,
  spawns: readonly LocatedSpawn[],
  childRows: readonly Record<string, unknown>[],
): OpencodeChildLedger {
  const ledger = new OpencodeChildLedger();
  const entries = readChildEntries(childRows);
  const idles = childRows.flatMap(row => row.type === 'idle' ? readTime(row.time, 'created') ?? [] : []).sort((a, b) => a - b);
  const events: ReplayEvent[] = spawns.flatMap((located): ReplayEvent[] => [
    { kind: 'spawn', at: located.started, row: located.row, located },
    ...(located.spawn.status === 'running' ? [] : [{ kind: 'launch' as const, at: located.launched, row: located.row, located }]),
  ]);
  rows.forEach((row, index) => {
    const report = row.type === 'synthetic' ? readOpencodeSubagentReport(row) : null;
    if (report?.childId === childId) events.push({ kind: 'report', at: queuedAt(row, idles, spawns), row: index, report });
  });
  let fed = 0;
  const feedUntil = (at: number | undefined) => {
    while (fed < entries.length && (at === undefined || entries[fed].at === undefined || entries[fed].at! <= at)) ledger.record(entries[fed++].entry);
  };
  for (const event of orderReplay(events)) {
    if (event.kind === 'report') {
      feedUntil(event.at);
      ledger.report(event.report);
      continue;
    }
    const { spawn, key } = event.located;
    if (event.kind === 'spawn') ledger.spawn(key, spawn.id, opencodeTaskResultInterpreter.describeTask(spawn.input).prompt);
    else ledger.launch(key, classifyOpencodeLaunch(spawn.status === 'error' || spawn.status === 'blocked', spawn.result, spawn.providerPayload, spawn.input));
  }
  feedUntil(undefined);
  return ledger;
}

/**
 * Orders events by time, keeping row order for ties and for events without a time, which take the
 * time of the event before them.
 */
function orderReplay(events: readonly ReplayEvent[]): ReplayEvent[] {
  let last = -Infinity;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.row - b.event.row || a.index - b.index)
    .map(({ event }, index) => ({ event, index, at: last = event.at ?? last }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ event }) => event);
}

/**
 * When OpenCode queued a stored report, which its delivery trails while the spawner is mid-step.
 * OpenCode queues it as the child goes idle, and mints its ID either at the spawn it answers, then
 * queues it at the child's first idle up to delivery, or as it queues after an interim report, just
 * after the child's idle with no spawn since. A report without a native ID counts as queued at delivery.
 */
function queuedAt(row: Record<string, unknown>, idles: readonly number[], spawns: readonly LocatedSpawn[]): number | undefined {
  const delivered = readTime(row.time, 'created');
  const minted = delivered === undefined ? undefined : mintedAt(row.id, delivered);
  if (delivered === undefined || minted === undefined) return delivered;
  const idle = idles.filter(at => at <= minted).at(-1);
  if (idle !== undefined && !spawns.some(({ started }) => started !== undefined && started > idle && started <= minted)) return minted;
  return idles.find(at => at >= minted && at <= delivered) ?? minted;
}

/** OpenCode's ascending message ID holds the low bits of the millisecond it minted the ID. */
const NATIVE_ID = /^msg_([0-9a-f]{12})/;
const ID_TIME_SPAN = 2 ** 36;

/** The latest millisecond at or before `before` that the ID encodes. */
function mintedAt(id: unknown, before: number): number | undefined {
  const match = typeof id === 'string' ? NATIVE_ID.exec(id) : null;
  if (!match) return undefined;
  const encoded = Math.floor(Number.parseInt(match[1], 16) / 0x1000);
  return before - (((before - encoded) % ID_TIME_SPAN) + ID_TIME_SPAN) % ID_TIME_SPAN;
}

function toolPart(row: Record<string, unknown>, toolId: string): Record<string, unknown> | undefined {
  const content: unknown[] = Array.isArray(row.content) ? row.content : [];
  return content.filter(isRecord).find(part => part.id === toolId);
}

function isSpawnPart(part: Record<string, unknown> | undefined): boolean {
  return typeof part?.name === 'string' && normalizeOpencodeToolName(part.name) === TOOL_SUBAGENT;
}

function readTime(time: unknown, field: 'created' | 'completed'): number | undefined {
  return isRecord(time) && typeof time[field] === 'number' ? time[field] : undefined;
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

/** Progress already names the child, so a spawn still running hydrates too. */
function getChildSessionId(spawn: ToolCallInfo): string | null {
  return opencodeTaskResultInterpreter.interpretLaunch(spawn.result, false, spawn.providerPayload).agentId;
}

/** The card projects the spawn's ledger state; until a launch decides, the requested mode stands. */
function buildSubagentInfo(spawn: ToolCallInfo, sessionId: string, turn: ChatMessage[], ledger: OpencodeChildLedger, key: string): SubagentInfo {
  const interpreter = opencodeTaskResultInterpreter;
  const task = interpreter.describeTask(spawn.input);
  const state = ledger.state(key);
  const background = state?.phase === 'background' || state?.phase === 'settled';
  const mode = background ? 'async' : state?.phase === 'foreground' ? 'sync' : task.mode ?? 'sync';
  const base = {
    id: spawn.id,
    agentId: sessionId,
    description: task.description ?? 'Subagent task',
    prompt: task.prompt ?? '',
    toolCalls: turn.flatMap(message => message.toolCalls ?? []),
    isExpanded: false,
  };
  const launched = interpreter.interpretResult(spawn.result, spawn.status === 'error' || spawn.status === 'blocked', { mode, agentId: sessionId });
  if (spawn.status === 'running') return { ...base, mode, status: 'running', ...(mode === 'async' ? { asyncStatus: 'running' as const } : {}), result: launched.result };
  if (mode === 'sync') return { ...base, mode, status: launched.status, result: launched.result };
  // A background launch result only acknowledges the child; its answer lives in the child session.
  if (state?.phase === 'settled') {
    const { status, result } = state.settlement;
    return { ...base, mode, status, asyncStatus: status, result: result || launched.result };
  }
  if (state?.phase === 'background' && state.interim) return { ...base, mode, status: 'running', asyncStatus: 'running', result: launched.result };
  // Unreported, as when the server stopped first, or never launched: the launch outcome stands.
  const answer = state?.phase === 'background' ? ledger.answer(key) : undefined;
  return { ...base, mode, status: launched.status, asyncStatus: launched.status, result: answer || launched.result };
}
