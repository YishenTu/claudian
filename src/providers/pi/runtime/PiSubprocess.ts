import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import { getEnhancedPath } from '@/utils/env';

const STDERR_BUFFER_LIMIT = 8_000;

export interface PiSubprocessLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type CloseListener = (error?: Error) => void;

export class PiSubprocess {
  private closeError: Error | null = null;
  private readonly closeListeners = new Set<CloseListener>();
  private notifiedClose = false;
  private readonly process: ManagedStdioProcess;

  constructor(launchSpec: PiSubprocessLaunchSpec) {
    this.process = new ManagedStdioProcess({
      ...launchSpec,
      env: {
        ...launchSpec.env,
        PATH: getEnhancedPath(
          launchSpec.env.PATH,
          path.isAbsolute(launchSpec.command) ? launchSpec.command : undefined,
        ),
      },
      stderrBufferLimit: STDERR_BUFFER_LIMIT,
    });
    this.process.onError((error) => {
      this.closeError = error;
      this.notifyClose(error);
    });
    this.process.onExit(({ code, signal }) => {
      const exitError = this.closeError ?? (
        code === 0 && signal === null
          ? undefined
          : new Error(`Pi subprocess exited (${formatExit(code, signal)})`)
      );
      this.notifyClose(exitError);
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

  start(): void {
    this.process.start();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  getStderrSnapshot(): string {
    return this.process.getStderrSnapshot();
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  shutdown(): Promise<void> {
    return this.process.shutdown();
  }

  private assertStarted(): void {
    if (!this.process.isStarted()) {
      throw new Error('Pi subprocess is not started');
    }
  }

  private notifyClose(error?: Error): void {
    if (this.notifiedClose) return;
    this.notifiedClose = true;
    for (const listener of [...this.closeListeners]) {
      try {
        listener(error);
      } catch {
        // Close observers cannot interrupt provider cleanup.
      }
    }
    this.closeListeners.clear();
  }
}

function formatExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  if (code === null) return 'unknown';
  return `code ${code}`;
}
