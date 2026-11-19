import { type FSWatcher, watch } from 'node:fs';
import path from 'node:path';

import { resolveAntigravityTranscriptPaths } from '../history/AntigravityHistoryPaths';
import {
  type AntigravityTranscript,
  hasAntigravityOutstandingSubagents,
  readAntigravityHistoryRevision,
  readAntigravityLatestRequest,
  readAntigravityTranscript,
} from '../history/AntigravityHistoryStore';

/** Coalesces the bursts of change events one transcript write produces. */
const RESCAN_DELAY_MS = 200;
/** Used only where the transcript directory cannot be watched or its watch is unreliable. */
const POLL_INTERVAL_MS = 5_000;
/**
 * A subagent that needs approval outside Auto or YOLO never reports (agy does not relay its request over ACP), so
 * watching ends after this long without a transcript change and the session may be released again.
 */
const QUIET_LIMIT_MS = 30 * 60_000;

export interface AntigravitySubagentWatcherOptions {
  /** Polls instead of watching, for stores whose change notifications are unreliable. */
  readonly poll?: boolean;
  readonly storeRoot: string;
  readonly sessionId: string;
}

/** Watching the transcript between turns until every subagent has reported. */
interface Watching {
  readonly stopWatching: () => void;
  quietTimer: number;
  rescanTimer?: number;
}

/**
 * A subagent a live turn launched keeps working after `end_turn` and lives only as long as agy's process. agy reports
 * no subagent lifecycle over ACP, so this watches the transcript between turns until every such subagent has reported,
 * and the session holds idle release meanwhile. agy streams its reply to each report live.
 */
export class AntigravitySubagentWatcher {
  #watching: Watching | null = null;
  /** Set by a live subagent launch; cleared once a scan finds every subagent reported. */
  #expectingWork = false;
  /**
   * The user request of the first turn recorded since agy's process started. Subagents die with their process, so
   * only those created from this request on can still report.
   */
  #processFirstRequest: number | undefined;
  /** Counts ended processes, so a read that began under an earlier process affects only the request it recorded. */
  #processGeneration = 0;
  /** A settled prompt whose request the next scan records. */
  #unrecordedTurn = false;
  #scan: Promise<void> | null = null;
  #rescanRequested = false;
  #disposed = false;

  constructor(private readonly options: AntigravitySubagentWatcherOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** agy's process, and with it the subagent, must outlive idle release while a subagent may still report. */
  get isWatching(): boolean {
    return this.#watching !== null;
  }

  /** A live turn launched a subagent, which may report after the turn. */
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
    this.#stopWatching();
  }

  /**
   * A requested run or agy's own reply ended. `prompted` is false for a run that ended before agy received its prompt;
   * it records no request.
   */
  turnEnded(prompted: boolean): void {
    if (this.#disposed) return;
    this.#stopWatching();
    // Ordinary turns leave nothing to wait for, so their transcript is not read.
    if (!this.#expectingWork) return;
    if (prompted) this.#unrecordedTurn = true;
    // Watch before reading so a write during the first read is not missed.
    this.#startWatching();
    this.#requestScan();
  }

  /** Settles once no transcript read is left running. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopWatching();
    await this.#scan;
  }

  #startWatching(): void {
    const stopWatching = this.#watch();
    this.#watching = { quietTimer: window.setTimeout(() => this.#giveUp(), QUIET_LIMIT_MS), stopWatching };
  }

  #stopWatching(): void {
    const watching = this.#watching;
    if (!watching) return;
    window.clearTimeout(watching.quietTimer);
    window.clearTimeout(watching.rescanTimer);
    watching.stopWatching();
    this.#watching = null;
  }

  /** Nothing more is expected until a live turn launches another subagent. */
  #giveUp(): void {
    this.#expectingWork = false;
    this.#stopWatching();
  }

  #onTranscriptChange(): void {
    const watching = this.#watching;
    if (!watching) return;
    window.clearTimeout(watching.quietTimer);
    watching.quietTimer = window.setTimeout(() => this.#giveUp(), QUIET_LIMIT_MS);
    window.clearTimeout(watching.rescanTimer);
    watching.rescanTimer = window.setTimeout(() => this.#requestScan(), RESCAN_DELAY_MS);
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
    let transcript: AntigravityTranscript | null;
    try {
      transcript = await readAntigravityTranscript(this.options.storeRoot, this.options.sessionId);
    } catch (error) {
      // A failed read records nothing; the current process's next read records the turn instead.
      if (recordsTurn && generation === this.#processGeneration) this.#unrecordedTurn = true;
      throw error;
    }
    if (this.#disposed || !transcript) return;
    // agy flushes a turn's steps before settling its prompt, so the latest request is the turn that just ended.
    const request = recordsTurn ? readAntigravityLatestRequest(transcript) : undefined;
    if (request !== undefined && generation === this.#processGeneration) this.#processFirstRequest ??= request;
    // Watching belongs to the current process; its own rescan follows a read begun under an earlier one.
    if (generation !== this.#processGeneration || !this.#watching) return;
    if (this.#processFirstRequest !== undefined && hasAntigravityOutstandingSubagents(transcript, this.#processFirstRequest)) return;
    this.#giveUp();
  }

  #watch(): () => void {
    const onChange = () => this.#onTranscriptChange();
    const [transcriptPath] = resolveAntigravityTranscriptPaths(this.options.storeRoot, this.options.sessionId);
    let watcher: FSWatcher | null = null;
    let poll: number | undefined;
    // Only a changed file counts, so an unchanged transcript still reaches the quiet limit.
    let revision: string | null | undefined;
    // Either transcript file may be the one agy appends to.
    const pollOnce = () => void readAntigravityHistoryRevision(this.options.storeRoot, this.options.sessionId).then(next => {
      if (next === revision) return;
      revision = next;
      onChange();
    });
    const startPolling = () => { poll ??= window.setInterval(pollOnce, POLL_INTERVAL_MS); };
    if (this.options.poll) {
      startPolling();
      return () => window.clearInterval(poll);
    }
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
