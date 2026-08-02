import type { Readable, Writable } from 'node:stream';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';

import type { CodexLaunchSpec } from './codexLaunchTypes';

const STDERR_BUFFER_LIMIT = 8_192;

type ExitCallback = (code: number | null, signal: string | null) => void;

export class CodexAppServerProcess {
  private readonly exitCallbacks: ExitCallback[] = [];
  private readonly process: ManagedStdioProcess;

  constructor(
    launchSpec: Pick<CodexLaunchSpec, 'command' | 'args' | 'spawnCwd' | 'env'>,
  ) {
    this.process = new ManagedStdioProcess({
      args: launchSpec.args,
      command: launchSpec.command,
      cwd: launchSpec.spawnCwd,
      env: launchSpec.env,
      stderrBufferLimit: STDERR_BUFFER_LIMIT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.onClose(({ code, signal }) => {
      for (const callback of [...this.exitCallbacks]) {
        try {
          callback(code, signal);
        } catch {
          // Exit observers cannot interrupt process cleanup.
        }
      }
      this.exitCallbacks.length = 0;
    });
  }

  get stdin(): Writable {
    this.assertStarted();
    return this.process.stdin;
  }

  get stdout(): Readable {
    this.assertStarted();
    return this.process.stdout;
  }

  get stderr(): Readable {
    this.assertStarted();
    return this.process.stderr;
  }

  start(): void {
    this.process.start();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  getStderrSnapshot(): string {
    return this.process.getStderrSnapshot();
  }

  onExit(callback: ExitCallback): void {
    this.exitCallbacks.push(callback);
  }

  offExit(callback: ExitCallback): void {
    const index = this.exitCallbacks.indexOf(callback);
    if (index !== -1) this.exitCallbacks.splice(index, 1);
  }

  shutdown(): Promise<void> {
    return this.process.shutdown();
  }

  private assertStarted(): void {
    if (!this.process.isStarted()) {
      throw new Error('Process not started');
    }
  }
}
