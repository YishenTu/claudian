import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { findNodeExecutable, getEnhancedPath } from '@/core/process/env';
import { ManagedStdioProcess, type ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type { SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';

import { DeepSeekRemoteClient } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekPreset, DeepSeekProfile } from '../types';
import { getDeepSeekHome } from './DeepSeekHome';
import { getDeepSeekDesktopInstallation, resolveDeepSeekNodeEntry } from './DeepSeekInstallation';
import { type DeepSeekLaunchArtifacts, prepareDeepSeekLaunchArtifacts } from './DeepSeekLaunchArtifacts';
import type { DeepSeekPresetPlugin } from './DeepSeekPresetPlugins';

// Native MCP may spend 60 seconds in each discovery phase; retain a finite, cancellable startup budget.
const STARTUP_TIMEOUT_MS = 180_000;
// Native's interrupt force-exits 5 seconds after it starts; the margin covers process exit before the forced stop.
const GRACEFUL_EXIT_TIMEOUT_MS = 6_000;

export interface DeepSeekLaunchOptions {
  readonly sessionToolRoute?: Pick<SessionToolRoute, 'url' | 'routeId'>;
  readonly cliPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** The user's additional chat preset rows, already validated. */
  readonly presetPlugins?: readonly DeepSeekPresetPlugin[];
}

/** One owned native Host process with its launch overlay and authenticated transport. */
export class DeepSeekHostProcess {
  private disposal?: Promise<void>;

  private constructor(
    readonly client: DeepSeekRemoteClient,
    readonly profile: DeepSeekProfile,
    private readonly process: ManagedStdioProcess,
    private readonly artifacts: DeepSeekLaunchArtifacts,
  ) {}

  static async start(options: DeepSeekLaunchOptions, signal: AbortSignal): Promise<DeepSeekHostProcess> {
    signal.throwIfAborted();
    const desktop = getDeepSeekDesktopInstallation(options.cliPath);
    const cliPath = desktop?.cliPath ?? options.cliPath;
    const profile = desktop ? 'desktop' : 'web';
    const environment = { ...options.environment, PATH: getEnhancedPath(options.environment.PATH, isAbsolute(cliPath) ? cliPath : undefined) };
    const profileDirectory = join(getDeepSeekHome(environment, options.cwd), 'profiles', profile);
    try { await access(join(profileDirectory, 'package.json')); } catch {
      throw new Error(desktop
        ? 'DeepSeek Desktop profile is unavailable. Open DeepSeek Harness Desktop and complete its setup first.'
        : 'DeepSeek Web profile is unavailable. Configure the native dsh web runtime first.');
    }
    // Desktop runs its own executable as Node, and npm dsh runs through Node on its package entry; no wrapper script or
    // Windows .cmd (which needs a shell) is spawned.
    const entry = desktop ? undefined : resolveDeepSeekNodeEntry(cliPath);
    const spec: ManagedStdioProcessOptions = {
      cwd: options.cwd, directSpawn: true, killProcessTree: true,
      ...(desktop
        ? { command: desktop.executable, args: ['--expose-internals'], env: { ...environment, ELECTRON_RUN_AS_NODE: '1' } }
        : { command: entry ? findNodeExecutable(environment.PATH) ?? 'node' : cliPath, args: entry ? [entry] : [], env: environment }),
    };
    const artifacts = await prepareDeepSeekLaunchArtifacts(undefined, options.presetPlugins, options.sessionToolRoute);
    const child = new ManagedStdioProcess({
      ...spec,
      args: [...spec.args, ...(desktop
        ? [artifacts.desktopRunnerPath, desktop.installAnchor, profileDirectory, artifacts.patchPath]
        : ['--profile', 'web', '--patch', artifacts.patchPath, '--no-open', '--port', '0'])],
      stderrBufferLimit: 1,
    });
    let client: DeepSeekRemoteClient | undefined;
    const deadline = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
    const startup = AbortSignal.any([signal, deadline]);
    try {
      const url = await readLaunchURL(child, startup);
      client = await DeepSeekRemoteClient.open(url, startup);
      startup.throwIfAborted();
      if (!child.isAlive()) throw new Error('DeepSeek exited during authentication.');
      return new DeepSeekHostProcess(client, profile, child, artifacts);
    } catch (error) {
      client?.dispose();
      await child.shutdown();
      await artifacts.dispose();
      if (signal.aborted) throw new Error('DeepSeek startup cancelled.', { cause: error });
      if (deadline.aborted) throw new Error('DeepSeek startup timed out while loading the native profile and MCP servers.', { cause: error });
      throw error;
    }
  }

  writePrompt(preset: DeepSeekPreset, text: string): Promise<void> { return this.artifacts.writePrompt(preset, text); }

  writeCodeMode(enabled: boolean): Promise<void> { return this.artifacts.writeCodeMode(enabled); }

  offerEphemeralFork(parent: string, atSeq: number): Promise<() => Promise<void>> { return this.artifacts.offerEphemeralFork(parent, atSeq); }

  readEphemeralReady(): Promise<boolean> { return this.artifacts.readEphemeralReady(); }

  /** Disposal-caused exits stay silent. */
  onExit(listener: () => void): () => void {
    return this.process.onExit(() => { if (!this.disposal) listener(); });
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.client.dispose();
      // Then kill what remains: a Host past its grace period with its tree, else any leftover POSIX process group.
      this.disposal = this.exitGracefully().then(() => this.process.shutdown()).finally(() => this.artifacts.dispose());
    }
    return this.disposal;
  }

  /**
   * Closing stdin lets the lifecycle plugin run native's bounded interrupt, which drains session writers and removes
   * its locks. A kill skips it on Windows, where the first signal is a forced tree termination.
   */
  private exitGracefully(): Promise<void> {
    if (!this.process.isAlive()) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => { window.clearTimeout(timer); offExit(); resolve(); };
      const timer = window.setTimeout(done, GRACEFUL_EXIT_TIMEOUT_MS);
      const offExit = this.process.onExit(done);
      // A pipe the Host already closed fails asynchronously; the deadline still bounds the wait.
      this.process.stdin.on('error', () => {}).end();
    });
  }
}

function readLaunchURL(child: ManagedStdioProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let offError = (): void => {};
    let offExit = (): void => {};
    const finish = (error?: Error, url?: string): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort); offError(); offExit();
      if (child.isStarted()) { child.stdout.off('data', data); child.stderr.off('data', data); }
      output = '';
      if (error) reject(error); else resolve(url!);
    };
    const abort = (): void => finish(new Error('DeepSeek startup cancelled or timed out.'));
    const data = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).slice(-16_384);
      // The token may arrive across chunks; accept it only once a delimiter ends it.
      const url = output.match(/(https?:\/\/[^\s"'<>]+\?token=[A-Za-z0-9_%.-]+)[\s"'<>]/)?.[1];
      if (url) finish(undefined, url);
    };
    offError = child.onError(() => finish(new Error('DeepSeek process could not start. Check the configured CLI path.')));
    offExit = child.onExit(() => finish(new Error('DeepSeek exited before becoming ready. Check the selected native profile and MCP configuration.')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    // stdin stays open: the bundled lifecycle plugin exits the Host when Claudian's end of the pipe closes.
    // A synchronous spawn failure reaches onError before start() throws, so that rejection is already settled.
    child.start();
    // Removing these listeners leaves the streams flowing, draining later output without retaining tokens or diagnostics.
    child.stdout.on('data', data); child.stderr.on('data', data);
  });
}
