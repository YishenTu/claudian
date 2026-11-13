import { type FSWatcher, watch } from 'node:fs';
import path from 'node:path';

import type { ProviderBackgroundOutputEvent, WithoutEventScope } from '@/core/execution';
import type { ChatMessage, ToolResultDetails } from '@/core/types';

import { resolveAntigravityTranscriptPaths } from '../history/AntigravityHistoryPaths';
import {
  type AntigravityAutomaticResponse,
  hasAntigravityOutstandingSubagents,
  readAntigravityAutomaticResponses,
  readAntigravityLatestUserInput,
  readAntigravityTranscript,
} from '../history/AntigravityHistoryStore';

/** Coalesces the bursts of change events one transcript write produces. */
const RESCAN_DELAY_MS = 200;
/** Used only where the transcript directory cannot be watched. */
const POLL_INTERVAL_MS = 5_000;

export interface AntigravityAutomaticResponseFollowerOptions {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly publish: (message: ChatMessage) => void;
}

/** A live turn streams its own output over ACP; between turns only the transcript records agy's work. */
type FollowerPhase =
  | { readonly kind: 'turn' }
  | { readonly kind: 'between-turns'; stopWatching: (() => void) | null };

/**
 * agy answers a subagent's report on its own after `end_turn` and writes that reply only to its transcript. While a
 * subagent is out between turns, this follows the transcript and publishes each such reply once it has ended.
 */
export class AntigravityAutomaticResponseFollower {
  #phase: FollowerPhase = { kind: 'turn' };
  /** When each live turn ended, keyed by its user request's step index; replies agy started later never streamed. */
  readonly #turnEnds = new Map<number, number>();
  readonly #published = new Set<string>();
  /** Set by a live subagent launch; cleared once a scan finds every subagent reported and every reply finished. */
  #expectingWork = false;
  /** A turn end not yet matched to its user request (the next scan reads the request's step index). */
  #unmatchedTurnEnd: number | null = null;
  #scan: Promise<void> | null = null;
  #rescanRequested = false;
  #rescanTimer: number | undefined;
  #disposed = false;

  constructor(private readonly options: AntigravityAutomaticResponseFollowerOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** A live turn launched a subagent, whose report agy may answer after the turn. */
  subagentLaunched(): void {
    this.#expectingWork = true;
  }

  turnStarted(): void {
    this.#leaveBetweenTurns();
    this.#phase = { kind: 'turn' };
  }

  turnEnded(endedAt = Date.now()): void {
    if (this.#disposed) return;
    this.#leaveBetweenTurns();
    this.#phase = { kind: 'between-turns', stopWatching: null };
    // Ordinary turns leave nothing for agy to answer later, so their transcript is not read.
    if (!this.#expectingWork) return;
    this.#unmatchedTurnEnd = endedAt;
    this.#requestScan();
  }

  /** Settles once no transcript read is left running. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#leaveBetweenTurns();
    this.#phase = { kind: 'turn' };
    await this.#scan;
  }

  #leaveBetweenTurns(): void {
    window.clearTimeout(this.#rescanTimer);
    this.#rescanTimer = undefined;
    if (this.#phase.kind === 'between-turns') {
      this.#phase.stopWatching?.();
      this.#phase.stopWatching = null;
    }
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
    const transcript = await readAntigravityTranscript(this.options.storeRoot, this.options.sessionId);
    if (this.#disposed) return;
    const turnEnd = this.#unmatchedTurnEnd;
    this.#unmatchedTurnEnd = null;
    // agy flushes a turn's steps before settling its prompt, so the latest request is the turn that just ended.
    const request = transcript ? readAntigravityLatestUserInput(transcript) : undefined;
    if (turnEnd !== null && request !== undefined) this.#turnEnds.set(request, Math.floor(turnEnd / 1_000) * 1_000);
    const phase = this.#phase;
    if (phase.kind !== 'between-turns' || !transcript) return;
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
    if (unfinished || hasAntigravityOutstandingSubagents(transcript)) {
      phase.stopWatching ??= this.#watch();
      return;
    }
    this.#expectingWork = false;
    this.#leaveBetweenTurns();
  }

  /** Started after the live turn it follows ended (transcript times have second precision). */
  #isUnstreamed(response: AntigravityAutomaticResponse): boolean {
    const turnEnd = response.afterUserInput === undefined ? undefined : this.#turnEnds.get(response.afterUserInput);
    return turnEnd !== undefined && response.startedAt >= turnEnd;
  }

  #watch(): () => void {
    const onChange = () => {
      window.clearTimeout(this.#rescanTimer);
      this.#rescanTimer = window.setTimeout(() => this.#requestScan(), RESCAN_DELAY_MS);
    };
    const [transcriptPath] = resolveAntigravityTranscriptPaths(this.options.storeRoot, this.options.sessionId);
    let watcher: FSWatcher | null = null;
    let poll: number | undefined;
    const startPolling = () => { poll ??= window.setInterval(onChange, POLL_INTERVAL_MS); };
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
