import type {
  ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import crossSpawn from 'cross-spawn';

import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '@/utils/windowsCmdShim';

const DEFAULT_SIGKILL_TIMEOUT_MS = 3_000;
const DEFAULT_FINAL_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_STDERR_BUFFER_LIMIT = 8_000;
const spawn = crossSpawn as typeof nodeSpawn;

export interface ManagedStdioProcessOptions {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  finalShutdownTimeoutMs?: number;
  killProcessTree?: boolean;
  sigkillTimeoutMs?: number;
  stderrBufferLimit?: number;
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

export class ManagedStdioProcess {
  private alive = false;
  private readonly closeListeners = new Set<LifecycleListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private exitState: ManagedStdioProcessExitState | null = null;
  private readonly exitListeners = new Set<LifecycleListener>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private resolvedSpawnSpec: WindowsCmdShimSpawnSpec | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private spawnConfirmed = false;
  private startAttempted = false;
  private stderrBuffer = '';
  private stderrDataListener: ((chunk: Buffer | string) => void) | null = null;

  constructor(private readonly options: ManagedStdioProcessOptions) {}

  get stdin(): Writable {
    return this.requireProcess().stdin;
  }

  get stdout(): Readable {
    return this.requireProcess().stdout;
  }

  get stderr(): Readable {
    return this.requireProcess().stderr;
  }

  start(): void {
    if (this.startAttempted || this.shutdownPromise) {
      return;
    }
    this.startAttempted = true;

    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec(this.options);
    this.resolvedSpawnSpec = resolvedSpawnSpec;

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: this.options.stdio ?? 'pipe',
        windowsHide: true,
      });
    } catch (error) {
      const spawnError = toError(error);
      this.exitState = {
        closed: true,
        code: null,
        error: spawnError,
        signal: null,
      };
      this.notifyError(spawnError);
      this.clearLifecycleListeners();
      throw spawnError;
    }

    this.proc = proc;
    this.spawnConfirmed = typeof proc.pid === 'number';
    this.alive = (
      (proc.exitCode === null || proc.exitCode === undefined)
      && (proc.signalCode === null || proc.signalCode === undefined)
      && !proc.killed
    );
    this.stderrDataListener = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const limit = this.options.stderrBufferLimit ?? DEFAULT_STDERR_BUFFER_LIMIT;
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-limit);
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
    return this.exitState ? { ...this.exitState } : null;
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
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    const proc = this.proc;
    if (!proc || !this.alive) {
      this.shutdownPromise = Promise.resolve();
      return this.shutdownPromise;
    }

    this.shutdownPromise = new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: number | null = null;
      let finalTimer: number | null = null;
      let unsubscribeExit: (() => void) | null = null;
      let unsubscribeClose: (() => void) | null = null;

      const finish = (): void => {
        if (settled) return;
        settled = true;
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
          this.killProcess(proc, 'SIGKILL');
        }
        finalTimer = window.setTimeout(() => {
          this.alive = false;
          this.cleanupProcessListeners(proc);
          destroyStdio(proc);
          this.clearLifecycleListeners();
          finish();
        }, this.options.finalShutdownTimeoutMs ?? DEFAULT_FINAL_SHUTDOWN_TIMEOUT_MS);
      }, this.options.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS);

      this.killProcess(proc, 'SIGTERM');
    });

    return this.shutdownPromise;
  }

  private readonly handleError = (error: Error): void => {
    if (!this.spawnConfirmed) {
      this.alive = false;
    }
    this.exitState = {
      closed: false,
      code: this.exitState?.code ?? null,
      error,
      signal: this.exitState?.signal ?? null,
    };
    this.notifyError(error);
  };

  private readonly handleSpawn = (): void => {
    this.spawnConfirmed = true;
  };

  private readonly handleExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.alive = false;
    this.exitState = {
      closed: false,
      code,
      ...(this.exitState?.error ? { error: this.exitState.error } : {}),
      signal,
    };
    for (const listener of [...this.exitListeners]) {
      safelyNotify(() => listener(this.getExitState()!));
    }
  };

  private readonly handleClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.alive = false;
    this.exitState = {
      closed: true,
      code,
      ...(this.exitState?.error ? { error: this.exitState.error } : {}),
      signal,
    };
    for (const listener of [...this.closeListeners]) {
      safelyNotify(() => listener(this.getExitState()!));
    }
    this.cleanupProcessListeners(this.proc);
    this.clearLifecycleListeners();
  };

  private requireProcess(): ChildProcessWithoutNullStreams {
    if (!this.proc) {
      throw new Error('Managed stdio process is not started');
    }
    return this.proc;
  }

  private killProcess(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    try {
      return terminateSpawnedProcess(proc, signal, spawn, this.resolvedSpawnSpec);
    } catch {
      return false;
    }
  }

  private notifyError(error: Error): void {
    for (const listener of [...this.errorListeners]) {
      safelyNotify(() => listener(error));
    }
  }

  private cleanupProcessListeners(proc: ChildProcessWithoutNullStreams | null): void {
    if (!proc) return;
    proc.off('spawn', this.handleSpawn);
    proc.off('error', this.handleError);
    proc.off('exit', this.handleExit);
    proc.off('close', this.handleClose);
    if (this.stderrDataListener) {
      proc.stderr.off('data', this.stderrDataListener);
      this.stderrDataListener = null;
    }
  }

  private clearLifecycleListeners(): void {
    this.errorListeners.clear();
    this.exitListeners.clear();
    this.closeListeners.clear();
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
