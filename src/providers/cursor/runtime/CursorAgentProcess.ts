import { type ChildProcess, spawn } from 'child_process';
import type { Readable } from 'stream';

import type { CursorLaunchSpec } from './CursorLaunchSpecBuilder';

const SIGKILL_TIMEOUT_MS = 3_000;

export type CursorProcessExitCallback = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

/**
 * Wraps a single `cursor-agent` invocation. Each run is spawned, drained,
 * and disposed; there is no persistent process between turns. The lifecycle
 * mirrors `CodexAppServerProcess` (graceful SIGTERM → SIGKILL fallback) but
 * is simplified for one-shot use.
 */
export class CursorAgentProcess {
  private proc: ChildProcess | null = null;
  private alive = false;
  private exitCallbacks: CursorProcessExitCallback[] = [];

  constructor(private readonly launchSpec: CursorLaunchSpec) {}

  start(): void {
    this.proc = spawn(this.launchSpec.command, this.launchSpec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this.launchSpec.spawnCwd,
      env: this.launchSpec.env,
      windowsHide: true,
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

  get stdout(): Readable {
    if (!this.proc?.stdout) {
      throw new Error('CursorAgentProcess not started');
    }
    return this.proc.stdout;
  }

  get stderr(): Readable {
    if (!this.proc?.stderr) {
      throw new Error('CursorAgentProcess not started');
    }
    return this.proc.stderr;
  }

  isAlive(): boolean {
    return this.alive;
  }

  onExit(callback: CursorProcessExitCallback): void {
    this.exitCallbacks.push(callback);
  }

  offExit(callback: CursorProcessExitCallback): void {
    const idx = this.exitCallbacks.indexOf(callback);
    if (idx !== -1) {
      this.exitCallbacks.splice(idx, 1);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.proc || !this.alive) {
      return;
    }

    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.alive) {
          this.proc?.kill('SIGKILL');
        }
      }, SIGKILL_TIMEOUT_MS);

      this.proc!.once('exit', () => {
        window.clearTimeout(timer);
        resolve();
      });

      this.proc!.kill('SIGTERM');
    });
  }
}
