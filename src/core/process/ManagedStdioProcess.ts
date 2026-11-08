import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import crossSpawn from 'cross-spawn';

import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '@/core/process/windowsCmdShim';

const DEFAULT_SIGKILL_TIMEOUT_MS = 3_000;
const DEFAULT_FINAL_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_STDERR_BUFFER_LIMIT = 8_000;
const spawn = crossSpawn as typeof nodeSpawn;

export interface ManagedStdioProcessOptions {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Bypass cross-spawn's implicit Windows shell fallback. */
  directSpawn?: boolean;
  finalShutdownTimeoutMs?: number;
  killProcessTree?: boolean;
  sigkillTimeoutMs?: number;
  /** Shutdown first closes stdin and waits this long for a stdin-leased child to exit before signalling it. */
  stdinCloseGraceMs?: number;
  stderrBufferLimit?: number;
  windowsVerbatimArguments?: boolean;
  stdio?: 'pipe' | ['pipe', 'pipe', 'pipe'];
}

export interface ManagedStdioProcessExitState {
  closed: boolean;
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
}

type ErrorListener = (error: Error) => void;
type LifecycleListener = (state: ManagedStdioProcessExitState) => void;
/** The first error or exit, whichever ends the process for its owner; `error` is set unless it exited cleanly. */
type TerminationListener = (error?: Error) => void;
type TerminationDescriber = (code: number | null, signal: NodeJS.Signals | null) => Error;

/**
 * `running` holds a child that may still exit; `ended` is terminal for liveness, while exit and
 * close events keep refining its exit state.
 */
type ProcessState =
  | { readonly kind: 'unstarted' }
  | { readonly kind: 'running'; readonly proc: ChildProcessWithoutNullStreams; spawnConfirmed: boolean; error?: Error }
  | { readonly kind: 'ended'; readonly proc: ChildProcessWithoutNullStreams | null; exit: ManagedStdioProcessExitState };

export class ManagedStdioProcess {
  private state: ProcessState = { kind: 'unstarted' };
  private readonly closeListeners = new Set<LifecycleListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly exitListeners = new Set<LifecycleListener>();
  private readonly terminationListeners = new Set<{ listener: TerminationListener; describe: TerminationDescriber }>();
  private terminationNotified = false;
  private resolvedSpawnSpec: WindowsCmdShimSpawnSpec | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private stderrBuffer = '';
  private readonly stderrDecoder = new StringDecoder('utf8');
  private stderrDataListener: ((chunk: Buffer | string) => void) | null = null;

  readonly #ownsProcessGroup: boolean;

  constructor(private readonly options: ManagedStdioProcessOptions) {
    this.#ownsProcessGroup = options.killProcessTree === true && process.platform !== 'win32';
  }

  private get proc(): ChildProcessWithoutNullStreams | null {
    return this.state.kind === 'unstarted' ? null : this.state.proc;
  }

  private get alive(): boolean {
    return this.state.kind === 'running';
  }

  get stdin(): Writable {
    return this.#requireProcess().stdin;
  }

  get stdout(): Readable {
    return this.#requireProcess().stdout;
  }

  get stderr(): Readable {
    return this.#requireProcess().stderr;
  }

  start(): void {
    if (this.state.kind !== 'unstarted' || this.shutdownPromise) {
      return;
    }

    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec(this.options);
    this.resolvedSpawnSpec = resolvedSpawnSpec;

    let proc: ChildProcessWithoutNullStreams;
    try {
      const spawnProcess = this.options.directSpawn ? nodeSpawn : spawn;
      proc = spawnProcess(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: this.options.stdio ?? 'pipe',
        windowsHide: true,
        ...(this.#ownsProcessGroup ? { detached: true } : {}),
        ...(this.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      const spawnError = toError(error);
      this.state = { kind: 'ended', proc: null, exit: { closed: true, code: null, error: spawnError, signal: null } };
      this.#notifyError(spawnError);
      this.#clearLifecycleListeners();
      throw spawnError;
    }

    const alive = (
      (proc.exitCode === null || proc.exitCode === undefined)
      && (proc.signalCode === null || proc.signalCode === undefined)
      && !proc.killed
    );
    this.state = alive
      ? { kind: 'running', proc, spawnConfirmed: typeof proc.pid === 'number' }
      : { kind: 'ended', proc, exit: { closed: false, code: proc.exitCode ?? null, signal: proc.signalCode ?? null } };
    this.stderrDataListener = (chunk: Buffer | string) => {
      if (Buffer.isBuffer(chunk)) {
        this.#appendStderr(this.stderrDecoder.write(chunk));
      } else if (chunk.length > 0) {
        this.#finalizeStderr();
        this.#appendStderr(chunk);
      }
    };
    proc.stderr.on('data', this.stderrDataListener);
    proc.on('spawn', this.handleSpawn);
    proc.on('error', this.handleError);
    proc.on('exit', this.handleExit);
    proc.on('close', this.handleClose);
  }

  isStarted(): boolean {
    return this.proc !== null;
  }

  isAlive(): boolean {
    return this.alive;
  }

  getExitState(): ManagedStdioProcessExitState | null {
    if (this.state.kind === 'ended') return { ...this.state.exit };
    if (this.state.kind === 'running' && this.state.error) {
      return { closed: false, code: null, error: this.state.error, signal: null };
    }
    return null;
  }

  /**
   * Notifies once, on the first error or exit. A non-clean exit is reported with `describe`, unless an
   * earlier error already explains it.
   */
  onTerminated(listener: TerminationListener, describe: TerminationDescriber): () => void {
    const entry = { listener, describe };
    this.terminationListeners.add(entry);
    return () => {
      this.terminationListeners.delete(entry);
    };
  }

  getStderrSnapshot(): string {
    return this.stderrBuffer.trim();
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  onExit(listener: LifecycleListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onClose(listener: LifecycleListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      const graceMs = this.options.stdinCloseGraceMs;
      this.shutdownPromise = graceMs !== undefined && this.proc && this.alive
        ? this.#closeStdin(this.proc.stdin, graceMs).then(() => this.#terminate())
        : this.#terminate();
    }
    return this.shutdownPromise;
  }

  /** A signal skips the child's own cleanup; on Windows it also stops only a WSL launcher, not its Linux command. */
  #closeStdin(stdin: Writable, graceMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { window.clearTimeout(timer); offExit(); resolve(); };
      const timer = window.setTimeout(done, graceMs);
      const offExit = this.onExit(done);
      // A pipe the child already closed fails asynchronously; the deadline still bounds the wait.
      stdin.on('error', () => {}).end();
    });
  }

  #terminate(): Promise<void> {
    const proc = this.proc;
    if (!proc || !this.alive) {
      if (proc) this.#killOwnedProcessGroup(proc, 'SIGKILL');
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: number | null = null;
      let finalTimer: number | null = null;
      let unsubscribeExit: (() => void) | null = null;
      let unsubscribeClose: (() => void) | null = null;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        // The root may exit before descendants that ignored its graceful signal.
        this.#killOwnedProcessGroup(proc, 'SIGKILL');
        if (killTimer !== null) window.clearTimeout(killTimer);
        if (finalTimer !== null) window.clearTimeout(finalTimer);
        unsubscribeExit?.();
        unsubscribeClose?.();
        resolve();
      };

      unsubscribeExit = this.onExit(finish);
      unsubscribeClose = this.onClose(finish);

      killTimer = window.setTimeout(() => {
        if (this.alive) {
          this.#killProcess(proc, 'SIGKILL');
        }
        finalTimer = window.setTimeout(() => {
          // The child never reported its exit; it is abandoned with its stdio destroyed.
          const error = this.state.kind === 'running' ? this.state.error : undefined;
          this.state = { kind: 'ended', proc, exit: { closed: false, code: null, ...(error ? { error } : {}), signal: null } };
          this.#cleanupProcessListeners(proc);
          destroyStdio(proc);
          this.#clearLifecycleListeners();
          finish();
        }, this.options.finalShutdownTimeoutMs ?? DEFAULT_FINAL_SHUTDOWN_TIMEOUT_MS);
      }, this.options.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS);

      this.#killProcess(proc, 'SIGTERM');
    });
  }

  private readonly handleError = (error: Error): void => {
    const state = this.state;
    if (state.kind === 'running') {
      // An error before the spawn is confirmed means the child never ran.
      if (state.spawnConfirmed) state.error = error;
      else this.state = { kind: 'ended', proc: state.proc, exit: { closed: false, code: null, error, signal: null } };
    } else if (state.kind === 'ended') {
      state.exit = { ...state.exit, closed: false, error };
    }
    this.#notifyError(error);
  };

  private readonly handleSpawn = (): void => {
    if (this.state.kind === 'running') this.state.spawnConfirmed = true;
  };

  private readonly handleExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    const error = this.#recordedError();
    this.state = { kind: 'ended', proc: this.proc, exit: { closed: false, code, ...(error ? { error } : {}), signal } };
    for (const listener of [...this.exitListeners]) {
      safelyNotify(() => listener(this.getExitState()!));
    }
    this.#notifyTerminated(code, signal);
  };

  private readonly handleClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.#finalizeStderr();
    const error = this.#recordedError();
    this.state = { kind: 'ended', proc: this.proc, exit: { closed: true, code, ...(error ? { error } : {}), signal } };
    for (const listener of [...this.closeListeners]) {
      safelyNotify(() => listener(this.getExitState()!));
    }
    this.#cleanupProcessListeners(this.proc);
    this.#clearLifecycleListeners();
  };

  #requireProcess(): ChildProcessWithoutNullStreams {
    if (!this.proc) {
      throw new Error('Managed stdio process is not started');
    }
    return this.proc;
  }

  #killProcess(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    try {
      if (this.#ownsProcessGroup) {
        return this.#killOwnedProcessGroup(proc, signal);
      }
      return terminateSpawnedProcess(proc, signal, spawn, this.resolvedSpawnSpec);
    } catch {
      return false;
    }
  }

  #killOwnedProcessGroup(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    if (!this.#ownsProcessGroup || !proc.pid) return false;
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  #recordedError(): Error | undefined {
    if (this.state.kind === 'running') return this.state.error;
    return this.state.kind === 'ended' ? this.state.exit.error : undefined;
  }

  #notifyError(error: Error): void {
    for (const listener of [...this.errorListeners]) {
      safelyNotify(() => listener(error));
    }
    this.#notifyTerminated(null, null, error);
  }

  #notifyTerminated(code: number | null, signal: NodeJS.Signals | null, error = this.#recordedError()): void {
    if (this.terminationNotified) return;
    this.terminationNotified = true;
    const entries = [...this.terminationListeners];
    this.terminationListeners.clear();
    for (const { listener, describe } of entries) {
      const reported = error ?? (code === 0 && signal === null ? undefined : describe(code, signal));
      safelyNotify(() => listener(reported));
    }
  }

  #cleanupProcessListeners(proc: ChildProcessWithoutNullStreams | null): void {
    if (!proc) return;
    this.#finalizeStderr();
    proc.off('spawn', this.handleSpawn);
    proc.off('error', this.handleError);
    proc.off('exit', this.handleExit);
    proc.off('close', this.handleClose);
    if (this.stderrDataListener) {
      proc.stderr.off('data', this.stderrDataListener);
      this.stderrDataListener = null;
    }
  }

  #appendStderr(text: string): void {
    const limit = this.options.stderrBufferLimit ?? DEFAULT_STDERR_BUFFER_LIMIT;
    const content = `${this.stderrBuffer}${text}`;
    const tail = content.slice(-limit);
    const cut = content.length - tail.length;
    // If the cut splits a valid surrogate pair, omit its remaining half too.
    this.stderrBuffer = cut > 0 && (content.codePointAt(cut - 1) ?? 0) > 0xffff ? tail.slice(1) : tail;
  }

  #finalizeStderr(): void {
    this.#appendStderr(this.stderrDecoder.end());
  }

  #clearLifecycleListeners(): void {
    this.errorListeners.clear();
    this.exitListeners.clear();
    this.closeListeners.clear();
    this.terminationListeners.clear();
  }
}

function destroyStdio(proc: ChildProcessWithoutNullStreams): void {
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    try {
      stream.destroy();
    } catch {
      // The final shutdown deadline remains bounded even if a stream misbehaves.
    }
  }
}

function safelyNotify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Lifecycle observers cannot interrupt process cleanup.
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
