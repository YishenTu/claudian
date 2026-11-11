import type { Readable, Writable } from 'node:stream';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';

const STDERR_BUFFER_LIMIT = 8_000;

export interface ACPSubprocessLaunchSpec {
  windowsVerbatimArguments?: boolean;
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type CloseListener = (error?: Error) => void;

export class ACPSubprocess {
  private readonly process: ManagedStdioProcess;

  constructor(launchSpec: ACPSubprocessLaunchSpec) {
    this.process = new ManagedStdioProcess({
      ...launchSpec,
      stderrBufferLimit: STDERR_BUFFER_LIMIT,
    });
  }

  get stdin(): Writable {
    this.#assertStarted();
    return this.process.stdin;
  }

  get stdout(): Readable {
    this.#assertStarted();
    return this.process.stdout;
  }

  start(): void {
    this.process.start();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  onClose(listener: CloseListener): () => void {
    return this.process.onTerminated(
      listener,
      (code, signal) => new Error(`ACP subprocess exited (${formatExit(code, signal)})`),
    );
  }

  shutdown(): Promise<void> {
    return this.process.shutdown();
  }

  #assertStarted(): void {
    if (!this.process.isStarted()) {
      throw new Error('ACP subprocess is not started');
    }
  }
}

function formatExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  if (code === null) return 'unknown';
  return `code ${code}`;
}
