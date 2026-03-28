import { type ChildProcess,spawn } from 'child_process';
import type { Readable, Writable } from 'stream';

const SIGKILL_TIMEOUT_MS = 3_000;

type ExitCallback = (code: number | null, signal: string | null) => void;

export class CodexAppServerProcess {
  private proc: ChildProcess | null = null;
  private alive = false;
  private exitCallbacks: ExitCallback[] = [];

  constructor(
    private readonly codexPath: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
  ) {}

  start(): void {
    this.proc = spawn(this.codexPath, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: this.env,
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

  async shutdown(): Promise<void> {
    if (!this.proc || !this.alive) return;

    return new Promise<void>((resolve) => {
      const onExit = () => {
        clearTimeout(killTimer);
        resolve();
      };

      this.proc!.once('exit', onExit);
      this.proc!.kill('SIGTERM');

      const killTimer = setTimeout(() => {
        if (this.alive) {
          this.proc!.kill('SIGKILL');
        }
      }, SIGKILL_TIMEOUT_MS);
    });
  }
}
