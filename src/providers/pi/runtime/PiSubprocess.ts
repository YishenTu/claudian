import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import {
  cliPathRequiresNode,
  findNodeExecutable,
  getEnhancedPath,
} from '@/core/process/env';
import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import {
  readPackageBin,
  readWindowsCommandShimTarget,
  resolveOwningPackageBin,
} from '@/core/process/windowsCmdShim';

const STDERR_BUFFER_LIMIT = 8_000;
const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_MANAGED_LAUNCHER = 'pi-launcher.js';
const PI_MANAGED_RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

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
      this.#notifyClose(error);
    });
    this.process.onExit(({ code, signal }) => {
      const exitError = this.closeError ?? (
        code === 0 && signal === null
          ? undefined
          : new Error(`Pi subprocess exited (${formatExit(code, signal)})`)
      );
      this.#notifyClose(exitError);
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

  #assertStarted(): void {
    if (!this.process.isStarted()) {
      throw new Error('Pi subprocess is not started');
    }
  }

  #notifyClose(error?: Error): void {
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

export function resolvePiProcessSpec(
  launchSpec: PiSubprocessLaunchSpec,
  enhancedPath: string,
): Pick<
  ConstructorParameters<typeof ManagedStdioProcess>[0],
  'args' | 'command' | 'directSpawn' | 'killProcessTree'
> {
  const command = launchSpec.command.trim();
  if (process.platform !== 'win32') {
    return { args: launchSpec.args, command, killProcessTree: false };
  }

  let nodeEntrypoint: string | null = null;
  if (isWindowsPiLauncher(command)) {
    nodeEntrypoint = resolveInstalledPiBin(command);
    if (!nodeEntrypoint) {
      throw new Error(
        `The Pi Windows launcher could not be resolved to its Node.js entry point: ${command}. `
          + `Set the Pi CLI path to the ${PI_PACKAGE_NAME} package's dist/bundle/cli.js instead.`,
      );
    }
  } else if (cliPathRequiresNode(command)) {
    nodeEntrypoint = command;
  }

  if (!nodeEntrypoint) {
    return { args: launchSpec.args, command, killProcessTree: false };
  }

  return {
    args: [nodeEntrypoint, ...launchSpec.args],
    command: findNodeExecutable(enhancedPath) ?? 'node',
    directSpawn: true,
    killProcessTree: true,
  };
}

function isWindowsPiLauncher(command: string): boolean {
  const extension = path.extname(command).toLowerCase();
  return extension === '.cmd' || extension === '.ps1';
}

function resolveInstalledPiBin(command: string): string | null {
  const basename = path.basename(command).toLowerCase();
  let shimTarget: string | null = null;
  if (basename === 'pi.cmd') {
    shimTarget = readWindowsCommandShimTarget(command);
  } else if (basename === 'pi.ps1') {
    shimTarget = readManagedPowerShellLauncherTarget(command);
  }
  if (!shimTarget) return null;

  return resolveOwningPackageBin(shimTarget, PI_PACKAGE_NAME, 'pi') ?? resolveManagedPiReleaseBin(shimTarget);
}

// The pi.dev managed installer's PowerShell launcher runs its sibling
// pi-launcher.js; any other PowerShell script is unproved.
function readManagedPowerShellLauncherTarget(command: string): string | null {
  try {
    const contents = fs.readFileSync(command, 'utf8');
    const declaresLauncher = contents.split(/\r?\n/u).some(line => (
      /^\$launcher\s*=\s*Join-Path\s+\$basedir\s+"pi-launcher\.js"$/iu.test(line.trim())
    ));
    return declaresLauncher
      ? path.join(path.dirname(command), PI_MANAGED_LAUNCHER)
      : null;
  } catch {
    return null;
  }
}

// pi.dev managed installs keep launchers in <root>/bin and versioned releases
// under <root>/install, selected by its current-version file.
function resolveManagedPiReleaseBin(launcher: string): string | null {
  if (path.basename(launcher).toLowerCase() !== PI_MANAGED_LAUNCHER) return null;

  const installRoot = path.resolve(path.dirname(launcher), '..', 'install');
  try {
    if (!fs.statSync(launcher).isFile()) return null;
    const marker = JSON.parse(
      fs.readFileSync(path.join(installRoot, 'managed-install.json'), 'utf8'),
    ) as { kind?: unknown; layout?: unknown; schemaVersion?: unknown };
    if (
      marker.kind !== 'pi-managed-install'
      || marker.schemaVersion !== 1
      || marker.layout !== 'releases-v1'
    ) {
      return null;
    }

    const version = fs.readFileSync(path.join(installRoot, 'current-version'), 'utf8').trim();
    if (!PI_MANAGED_RELEASE_VERSION.test(version)) return null;
    return readPackageBin(path.join(
      installRoot,
      'releases',
      version,
      'node_modules',
      ...PI_PACKAGE_NAME.split('/'),
    ), PI_PACKAGE_NAME, 'pi');
  } catch {
    return null;
  }
}

function formatExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  if (code === null) return 'unknown';
  return `code ${code}`;
}
