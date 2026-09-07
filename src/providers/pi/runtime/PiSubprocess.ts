import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import {
  cliPathRequiresNode,
  findNodeExecutable,
  getEnhancedPath,
} from '@/utils/env';

const STDERR_BUFFER_LIMIT = 8_000;
const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

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
    const enhancedPath = getEnhancedPath(
      launchSpec.env.PATH,
      path.isAbsolute(launchSpec.command) ? launchSpec.command : undefined,
    );
    const processSpec = resolvePiProcessSpec(launchSpec, enhancedPath);
    this.process = new ManagedStdioProcess({
      ...launchSpec,
      ...processSpec,
      env: {
        ...launchSpec.env,
        PATH: enhancedPath,
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

function resolvePiProcessSpec(
  launchSpec: PiSubprocessLaunchSpec,
  enhancedPath: string,
): Pick<
  ConstructorParameters<typeof ManagedStdioProcess>[0],
  'args' | 'command' | 'killProcessTree'
> {
  const command = launchSpec.command.trim();
  if (process.platform !== 'win32') {
    return { args: launchSpec.args, command, killProcessTree: false };
  }

  let nodeEntrypoint: string | null = null;
  if (command.toLowerCase().endsWith('.cmd')) {
    nodeEntrypoint = resolveInstalledPiBin(command);
    if (!nodeEntrypoint) {
      throw new Error(
        `The Pi Windows launcher could not be resolved to its Node.js entry point: ${command}`,
      );
    }
  } else if (cliPathRequiresNode(command)) {
    nodeEntrypoint = command;
  }

  if (!nodeEntrypoint) {
    return { args: launchSpec.args, command, killProcessTree: false };
  }

  const nodeExecutable = findNodeExecutable(enhancedPath);
  if (!nodeExecutable) {
    throw new Error(
      'Pi requires Node.js, but node.exe was not found on PATH. Install Node.js or configure a native Pi executable.',
    );
  }
  return {
    args: [nodeEntrypoint, ...launchSpec.args],
    command: nodeExecutable,
    killProcessTree: true,
  };
}

function resolveInstalledPiBin(command: string): string | null {
  if (path.basename(command).toLowerCase() !== 'pi.cmd') return null;

  const shimTarget = readWindowsCommandShimTarget(command);
  return shimTarget ? resolveOwningPiPackageBin(shimTarget) : null;
}

function readWindowsCommandShimTarget(command: string): string | null {
  try {
    const contents = fs.readFileSync(command, 'utf8');
    for (const rawLine of contents.split(/\r?\n/u)) {
      const line = rawLine.trim();
      const relativeMatch = /"%(?:~dp0|dp0%)\\([^"\r\n]+?)"\s+%\*\s*$/iu.exec(line);
      if (
        relativeMatch?.[1]
        && isSupportedWindowsNodeInvocation(line.slice(0, relativeMatch.index))
      ) {
        const relativeTarget = relativeMatch[1].replace(/[\\/]/gu, path.sep);
        return path.resolve(path.dirname(command), relativeTarget);
      }

      const absoluteMatch = /"([^"\r\n]+)"\s+%\*\s*$/u.exec(line);
      if (
        absoluteMatch?.[1]
        && path.isAbsolute(absoluteMatch[1])
        && isSupportedWindowsNodeInvocation(line.slice(0, absoluteMatch.index))
      ) {
        return path.normalize(absoluteMatch[1]);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isSupportedWindowsNodeInvocation(value: string): boolean {
  const invocation = value.trim().replace(/^@/u, '').trim();
  if (/^node(?:\.exe)?$/iu.test(invocation)) return true;
  if (/^"%~dp0\\node(?:\.exe)?"$/iu.test(invocation)) return true;
  if (/^"(?:[a-z]:[\\/]|\\\\)[^"\r\n]*[\\/]node(?:\.exe)?"$/iu.test(invocation)) {
    return true;
  }
  return /^endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+(?:set\s+PATHEXT=[^&\r\n]+\s+&\s+)?"%_prog%"$/iu.test(invocation);
}

function resolveOwningPiPackageBin(target: string): string | null {
  const resolvedTarget = path.resolve(target);
  let current = path.dirname(resolvedTarget);
  while (true) {
    const binPath = readPiPackageBin(current);
    if (binPath && pathsEqual(binPath, resolvedTarget)) return binPath;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function readPiPackageBin(packageRoot: string): string | null {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as {
      bin?: string | Record<string, unknown>;
      name?: unknown;
    };
    if (packageJson.name !== PI_PACKAGE_NAME) return null;
    const relativeBin = typeof packageJson.bin === 'object'
      && packageJson.bin !== null
      && typeof packageJson.bin.pi === 'string'
      ? packageJson.bin.pi
      : null;
    if (!relativeBin) return null;

    const resolvedRoot = path.resolve(packageRoot);
    const resolvedBin = path.resolve(resolvedRoot, relativeBin);
    const relative = path.relative(resolvedRoot, resolvedBin);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return fs.statSync(resolvedBin).isFile() ? resolvedBin : null;
  } catch {
    return null;
  }
}

function formatExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  if (code === null) return 'unknown';
  return `code ${code}`;
}
