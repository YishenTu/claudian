import { spawn, type ChildProcess } from 'child_process';

export interface AcpAgentConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Manages an ACP agent subprocess.
 * Similar to CodexAppServerProcess but for ACP agents.
 */
export class AcpProcessManager {
  private proc: ChildProcess | null = null;
  private exitPromise: Promise<void> | null = null;
  private exitResolve: (() => void) | null = null;

  constructor(private readonly config: AcpAgentConfig) {}

  start(): void {
    if (this.proc) {
      throw new Error('ACP agent process already started');
    }

    this.proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'], // stdin, stdout, stderr
    });

    this.proc.on('exit', () => {
      if (this.exitResolve) {
        this.exitResolve();
      }
    });

    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  get stdin(): NodeJS.WritableStream {
    if (!this.proc || !this.proc.stdin) {
      throw new Error('ACP agent process not started or stdin not available');
    }
    return this.proc.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    if (!this.proc || !this.proc.stdout) {
      throw new Error('ACP agent process not started or stdout not available');
    }
    return this.proc.stdout;
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;

    const proc = this.proc;
    this.proc = null;

    // Try graceful shutdown first
    proc.kill('SIGTERM');

    // Wait up to 5 seconds for graceful exit
    const timeout = setTimeout(() => {
      if (this.isAlive()) {
        proc.kill('SIGKILL');
      }
    }, 5000);

    await this.exitPromise;
    clearTimeout(timeout);
  }

  onExit(callback: () => void): void {
    this.exitPromise?.then(callback);
  }
}
