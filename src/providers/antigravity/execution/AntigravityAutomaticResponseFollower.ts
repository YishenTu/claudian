import { type FSWatcher, watch } from 'node:fs';
import path from 'node:path';

import type { ProviderBackgroundOutputEvent, WithoutEventScope } from '@/core/execution';
import type { ChatMessage, ToolResultDetails } from '@/core/types';
import { readFileRevision } from '@/utils/fileRevision';

import { resolveAntigravityTranscriptPaths } from '../history/AntigravityHistoryPaths';
import {
  type AntigravityAutomaticResponse,
  hasAntigravityOutstandingSubagents,
  readAntigravityAutomaticResponses,
  readAntigravityTranscript,
  readAntigravityTurnBoundary,
} from '../history/AntigravityHistoryStore';

/** Coalesces the bursts of change events one transcript write produces. */
const RESCAN_DELAY_MS = 200;
/** Used only where the transcript directory cannot be watched. */
const POLL_INTERVAL_MS = 5_000;
/**
 * A subagent that needs approval outside Auto or YOLO never reports (agy does not relay its request over ACP), so
 * following ends after this long without a transcript change and the session may be released again.
 */
const QUIET_LIMIT_MS = 30 * 60_000;

export interface AntigravityAutomaticResponseFollowerOptions {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly publish: (message: ChatMessage) => void;
}

/** A live turn streams its own output over ACP; between turns only the transcript records agy's work. */
type FollowerPhase =
  | { readonly kind: 'turn' }
  | { readonly kind: 'between-turns' }
  | { readonly kind: 'following'; readonly stopWatching: () => void; quietTimer: number };

/**
 * agy answers a subagent's report on its own after `end_turn` and writes that reply only to its transcript. While a
 * subagent is out between turns, this follows the transcript and publishes each such reply once it has ended.
 */
export class AntigravityAutomaticResponseFollower {
  #phase: FollowerPhase = { kind: 'turn' };
  /**
   * The last step each live turn had recorded when its prompt settled, keyed by its user request's step index. agy
   * records steps before streaming them, so later steps were never streamed. Each turn keeps its first boundary.
   */
  readonly #turnBoundaries = new Map<number, number>();
  readonly #published = new Set<string>();
  /** Set by a live subagent launch; cleared once a scan finds every subagent reported and every reply finished. */
  #expectingWork = false;
  /**
   * The user request of the first turn recorded since agy's process started. Subagents die with their process, so
   * only those created from this request on can still report.
   */
  #processFirstRequest: number | undefined;
  /** Counts ended processes, so a read that began under an earlier process affects only the boundary it recorded. */
  #processGeneration = 0;
  /** A settled prompt whose boundary the next scan records. */
  #unrecordedTurn = false;
  #scan: Promise<void> | null = null;
  #rescanRequested = false;
  #rescanTimer: number | undefined;
  #disposed = false;

  constructor(private readonly options: AntigravityAutomaticResponseFollowerOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** agy's process, and with it the subagent, must outlive idle release while a reply may still come. */
  get isFollowing(): boolean {
    return this.#phase.kind === 'following';
  }

  /** A live turn launched a subagent, whose report agy may answer after the turn. */
  subagentLaunched(): void {
    this.#expectingWork = true;
  }

  /** agy's process ended, and every subagent it was running with it. */
  processEnded(): void {
    this.#processGeneration += 1;
    this.#processFirstRequest = undefined;
    this.#giveUp();
  }

  turnStarted(): void {
    this.#stopFollowing();
    this.#phase = { kind: 'turn' };
  }

  /** `prompted` is false for a run that ended before agy received its prompt; it bounds no turn. */
  turnEnded(prompted: boolean): void {
    if (this.#disposed) return;
    this.#stopFollowing();
    this.#phase = { kind: 'between-turns' };
    // Ordinary turns leave nothing for agy to answer later, so their transcript is not read.
    if (!this.#expectingWork) return;
    if (prompted) this.#unrecordedTurn = true;
    // Watch before reading so a write during the first read is not missed.
    this.#startFollowing();
    this.#requestScan();
  }

  /** Settles once no transcript read is left running. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopFollowing();
    this.#phase = { kind: 'turn' };
    await this.#scan;
  }

  #startFollowing(): void {
    const stopWatching = this.#watch();
    this.#phase = { kind: 'following', quietTimer: window.setTimeout(() => this.#giveUp(), QUIET_LIMIT_MS), stopWatching };
  }

  #stopFollowing(): void {
    window.clearTimeout(this.#rescanTimer);
    this.#rescanTimer = undefined;
    const phase = this.#phase;
    if (phase.kind !== 'following') return;
    window.clearTimeout(phase.quietTimer);
    phase.stopWatching();
    this.#phase = { kind: 'between-turns' };
  }

  #giveUp(): void {
    this.#expectingWork = false;
    this.#stopFollowing();
  }

  #onTranscriptChange(): void {
    const phase = this.#phase;
    if (phase.kind !== 'following') return;
    window.clearTimeout(phase.quietTimer);
    phase.quietTimer = window.setTimeout(() => this.#giveUp(), QUIET_LIMIT_MS);
    window.clearTimeout(this.#rescanTimer);
    this.#rescanTimer = window.setTimeout(() => this.#requestScan(), RESCAN_DELAY_MS);
  }

  #requestScan(): void {
    if (this.#disposed) return;
    if (this.#scan) {
      this.#rescanRequested = true;
      return;
    }
    this.#scan = this.#runScan().catch(() => undefined).finally(() => {
      this.#scan = null;
      if (!this.#rescanRequested) return;
      this.#rescanRequested = false;
      this.#requestScan();
    });
  }

  async #runScan(): Promise<void> {
    // Taken before reading: a turn that ends during this read is recorded by the rescan that reads after it.
    const recordsTurn = this.#unrecordedTurn;
    const generation = this.#processGeneration;
    this.#unrecordedTurn = false;
    const transcript = await readAntigravityTranscript(this.options.storeRoot, this.options.sessionId);
    if (this.#disposed || !transcript) return;
    if (recordsTurn) {
      // agy flushes a turn's steps before settling its prompt, so the latest request is the turn that just ended.
      const boundary = readAntigravityTurnBoundary(transcript);
      if (boundary && !this.#turnBoundaries.has(boundary.userInput)) {
        this.#turnBoundaries.set(boundary.userInput, boundary.lastStep);
      }
      if (boundary && generation === this.#processGeneration) this.#processFirstRequest ??= boundary.userInput;
    }
    // Following belongs to the current process; its own rescan follows a read begun under an earlier one.
    if (generation !== this.#processGeneration || this.#phase.kind !== 'following') return;
    let unfinished = false;
    for (const response of readAntigravityAutomaticResponses(transcript, this.options.sessionId)) {
      if (!this.#isUnstreamed(response) || this.#published.has(response.message.id)) continue;
      if (!response.complete) {
        unfinished = true;
        continue;
      }
      this.#published.add(response.message.id);
      this.options.publish(response.message);
    }
    if (unfinished) return;
    if (this.#processFirstRequest !== undefined && hasAntigravityOutstandingSubagents(transcript, this.#processFirstRequest)) return;
    this.#expectingWork = false;
    this.#stopFollowing();
  }

  /** Started after the last step its live turn had recorded when that turn's prompt settled. */
  #isUnstreamed(response: AntigravityAutomaticResponse): boolean {
    const boundary = response.afterUserInput === undefined ? undefined : this.#turnBoundaries.get(response.afterUserInput);
    return boundary !== undefined && response.startStep > boundary;
  }

  #watch(): () => void {
    const onChange = () => this.#onTranscriptChange();
    const [transcriptPath] = resolveAntigravityTranscriptPaths(this.options.storeRoot, this.options.sessionId);
    let watcher: FSWatcher | null = null;
    let poll: number | undefined;
    // Only a changed file counts, so an unchanged transcript still reaches the quiet limit.
    let revision: string | null | undefined;
    const pollOnce = () => void readFileRevision(transcriptPath).then(next => {
      if (next === revision) return;
      revision = next;
      onChange();
    });
    const startPolling = () => { poll ??= window.setInterval(pollOnce, POLL_INTERVAL_MS); };
    try {
      // The directory survives agy replacing the file.
      watcher = watch(path.dirname(transcriptPath), onChange);
      watcher.on('error', () => {
        watcher?.close();
        startPolling();
      });
    } catch {
      startPolling();
    }
    return () => {
      watcher?.close();
      window.clearInterval(poll);
    };
  }
}

/** One automatic response as the background output a live turn would have streamed. */
export function buildAntigravityAutomaticResponseEvents(
  message: ChatMessage,
): Array<WithoutEventScope<ProviderBackgroundOutputEvent>> {
  const events: Array<WithoutEventScope<ProviderBackgroundOutputEvent>> = [];
  const calls = new Map((message.toolCalls ?? []).map(call => [call.id, call]));
  for (const block of message.contentBlocks ?? []) {
    switch (block.type) {
      case 'task_notification':
        events.push({ content: block.content, type: 'task_notification' });
        break;
      case 'text':
        events.push({ text: block.content, type: 'text_delta' });
        break;
      case 'thinking':
        events.push({ text: block.content, type: 'thinking_delta' });
        break;
      case 'context_compacted':
        events.push({ type: 'context_compacted' });
        break;
      case 'tool_use': {
        const call = calls.get(block.toolId);
        if (!call) break;
        const identity = { toolCallId: call.id, toolScope: { kind: 'main' as const } };
        events.push({ ...identity, input: call.input, name: call.name, providerPayload: call.providerPayload, type: 'tool_started' });
        if (call.status === 'running') break;
        const details: ToolResultDetails = {
          ...(call.resultFormat ? { resultFormat: call.resultFormat } : {}),
          ...(call.resolvedAnswers ? { resolvedAnswers: call.resolvedAnswers } : {}),
        };
        events.push({
          ...identity,
          content: call.result,
          isError: call.status === 'error',
          ...(Object.keys(details).length > 0 ? { resultDetails: details } : {}),
          type: 'tool_completed',
        });
        break;
      }
      default:
        break;
    }
  }
  return events;
}
