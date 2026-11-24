import type { ToolProviderPayload } from '@/core/types';

import type { OpencodeSubagentReport } from '../normalization/opencodeSyntheticReports';
import { opencodeTaskResultInterpreter } from '../runtime/OpencodeTaskResultInterpreter';
import {
  type OpencodeChildEntry,
  type OpencodeSpawnSettlement,
  pairOpencodeSpawns,
  readOpencodeSpawnAnswers,
  settleOpencodeSpawns,
} from './OpencodeSpawnSettlement';

/** How a spawn's own tool call ended. */
export type OpencodeSpawnLaunch = 'background' | 'foreground' | 'failed';

/**
 * A failed spawn never reached its child. A background launch outranks the requested mode, since
 * OpenCode can move a foreground spawn to the background; otherwise the request decides.
 */
export function classifyOpencodeLaunch(
  failed: boolean,
  result: unknown,
  payload: ToolProviderPayload | undefined,
  input: Readonly<Record<string, unknown>>,
): OpencodeSpawnLaunch {
  if (failed) return 'failed';
  const interpreter = opencodeTaskResultInterpreter;
  const launch = interpreter.interpretLaunch(result, false, payload).mode;
  return (launch === 'async' ? launch : interpreter.describeTask(input).mode ?? launch) === 'async' ? 'background' : 'foreground';
}

/**
 * One spawn's lifecycle. A background spawn runs until a terminal idle report settles it; `interim`
 * records that its child already went idle with its own background work continuing.
 */
export type OpencodeSpawnState =
  | { readonly phase: 'launching' }
  | { readonly phase: 'failed' }
  | { readonly phase: 'foreground' }
  | { readonly phase: 'background'; readonly interim: boolean }
  | { readonly phase: 'settled'; readonly settlement: OpencodeSpawnSettlement };

/** `promptId` is fixed when the segment holding the spawn's prompt closes. */
interface SpawnRecord { readonly toolCallId: string; readonly prompt: string | undefined; state: OpencodeSpawnState; promptId?: string }

/**
 * Everything one child session's spawns settle from, fed the same native facts live and on reload:
 * each spawn and how its launch ended, the child's delivered prompts and assistant text, and the idle
 * reports its spawner receives. A terminal report settles every background spawn still running and
 * starts the next segment, so later reports and output cannot change what it settled.
 */
export class OpencodeChildLedger {
  /** Keyed by the spawn's message and tool call, since models can reuse a tool call ID across messages. */
  private readonly spawns = new Map<string, SpawnRecord>();
  /**
   * Spawns since the last terminal report, in order, plus any that report left waiting; pairing with
   * this segment's prompts includes every one.
   */
  private segment: string[] = [];
  private entries: OpencodeChildEntry[] = [];

  spawn(key: string, toolCallId: string, prompt: string | undefined): void {
    if (this.spawns.has(key)) return;
    this.spawns.set(key, { toolCallId, prompt, state: { phase: 'launching' } });
    this.segment.push(key);
  }

  /** Returns whether this launch moved the child into the background. */
  launch(key: string, launch: OpencodeSpawnLaunch): boolean {
    const record = this.spawns.get(key);
    if (record?.state.phase !== 'launching') return false;
    const wasBackground = this.hasBackground;
    record.state = launch === 'background' ? { phase: 'background', interim: false } : { phase: launch };
    return !wasBackground && this.hasBackground;
  }

  record(entry: OpencodeChildEntry): void {
    this.entries.push(entry);
  }

  /**
   * Settles the background spawns of the run a terminal report ends; an interim report settles none.
   * The run covers the spawns whose prompt the child took. One still queued in the child's inbox, as
   * when its run was cancelled first, waits for the run that takes it; when the child took no spawn's
   * prompt, the report covers them all.
   */
  report(report: Pick<OpencodeSubagentReport, 'state' | 'body'>): Array<{ readonly toolCallId: string; readonly settlement: OpencodeSpawnSettlement }> {
    const running = this.segment.filter(id => this.spawns.get(id)?.state.phase === 'background');
    const prompts = this.pairedPrompts(running);
    const taken = running.filter((_, index) => prompts[index] !== undefined);
    const members = taken.length > 0 ? taken : running;
    if (members.length === 0) return [];
    const settled = settleOpencodeSpawns(this.pairedPrompts(members), this.entries, report);
    if (!settled) {
      for (const id of members) this.spawns.get(id)!.state = { phase: 'background', interim: true };
      return [];
    }
    members.forEach((id, index) => { this.spawns.get(id)!.state = { phase: 'settled', settlement: settled[index] }; });
    const paired = this.pairedPrompts(this.segment);
    this.segment.forEach((id, index) => { this.spawns.get(id)!.promptId ??= paired[index]; });
    this.segment = this.segment.filter(id => ['launching', 'background'].includes(this.spawns.get(id)!.state.phase));
    this.entries = [];
    return members.map((key, index) => ({ toolCallId: this.spawns.get(key)!.toolCallId, settlement: settled[index] }));
  }

  state(key: string): OpencodeSpawnState | undefined {
    return this.spawns.get(key)?.state;
  }

  /** The child prompt a spawn delivered, which starts its turn in the child session. */
  promptId(key: string): string | undefined {
    return this.spawns.get(key)?.promptId ?? (this.segment.includes(key) ? this.pairedPrompts([key])[0] : undefined);
  }

  /** A background spawn's own answer so far, for one no report settled, as when its server stopped. */
  answer(key: string): string | undefined {
    return readOpencodeSpawnAnswers(this.pairedPrompts([key]), this.entries)[0];
  }

  /** Whether a background spawn still waits for a terminal report. */
  get hasBackground(): boolean {
    return [...this.spawns.values()].some(record => record.state.phase === 'background');
  }

  private pairedPrompts(ids: readonly string[]): Array<string | undefined> {
    const paired = pairOpencodeSpawns(this.segment.map(id => {
      const record = this.spawns.get(id);
      return { prompt: record?.prompt, failed: record?.state.phase === 'failed' };
    }), this.entries);
    return ids.map(id => paired[this.segment.indexOf(id)]);
  }
}
