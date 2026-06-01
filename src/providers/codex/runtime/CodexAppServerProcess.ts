import { type ChildProcess, spawn } from 'child_process';
import type { Readable, Writable } from 'stream';

import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '../../../utils/windowsCmdShim';
import type { CodexLaunchSpec } from './codexLaunchTypes';

const SIGKILL_TIMEOUT_MS = 3_000;

type ExitCallback = (code: number | null, signal: string | null) => void;

export class CodexAppServerProcess {
  private proc: ChildProcess | null = null;
  private alive = false;
  private exitCallbacks: ExitCallback[] = [];
  private resolvedSpawnSpec: WindowsCmdShimSpawnSpec | null = null;

  constructor(
    private readonly launchSpec: Pick<CodexLaunchSpec, 'command' | 'args' | 'spawnCwd' | 'env'>,
  ) {}

  start(): void {
    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec(this.launchSpec);
    this.resolvedSpawnSpec = resolvedSpawnSpec;

    this.proc = spawn(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.launchSpec.spawnCwd,
      env: this.launchSpec.env,
      windowsHide: true,
      ...(resolvedSpawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    this.alive = true;

    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      for (const cb of this.exitCallbacks) {
        cb(code, signal);
      }
    });

    this.proc.on('error', () => {
      this.alive = false;
    });
  }

  get stdin(): Writable {
    if (!this.proc?.stdin) throw new Error('Process not started');
    return this.proc.stdin;
  }

  get stdout(): Readable {
    if (!this.proc?.stdout) throw new Error('Process not started');
    return this.proc.stdout;
  }

  get stderr(): Readable {
    if (!this.proc?.stderr) throw new Error('Process not started');
    return this.proc.stderr;
  }

  isAlive(): boolean {
    return this.alive;
  }

  onExit(callback: ExitCallback): void {
    this.exitCallbacks.push(callback);
  }

  offExit(callback: ExitCallback): void {
    const idx = this.exitCallbacks.indexOf(callback);
    if (idx !== -1) this.exitCallbacks.splice(idx, 1);
  }

  async shutdown(): Promise<void> {
    if (!this.proc || !this.alive) return;

    return new Promise<void>((resolve) => {
      const onExit = () => {
        window.clearTimeout(killTimer);
        resolve();
      };

      this.proc!.once('exit', onExit);
      this.killProc('SIGTERM');

      const killTimer = window.setTimeout(() => {
        if (this.alive) {
          this.killProc('SIGKILL');
        }
      }, SIGKILL_TIMEOUT_MS);
    });
  }

  private killProc(signal: NodeJS.Signals): boolean {
    if (!this.proc) {
      return false;
    }
    return terminateSpawnedProcess(this.proc, signal, spawn, this.resolvedSpawnSpec);
  }
}
