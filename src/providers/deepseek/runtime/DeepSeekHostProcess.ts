import { access } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';

import { findNodeExecutable, getEnhancedPath } from '@/core/process/env';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { ManagedStdioProcess, type ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type { SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';
import type { WSLSessionToolRelay } from '@/core/session-tools/WSLSessionToolRelay';

import { DeepSeekRemoteClient } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekProfile } from '../types';
import type { DeepSeekExecutionContext } from './DeepSeekExecutionContext';
import { getDeepSeekHome } from './DeepSeekHome';
import { getDeepSeekDesktopInstallation, resolveDeepSeekNodeEntry } from './DeepSeekInstallation';
import { type DeepSeekLaunchArtifacts, prepareDeepSeekLaunchArtifacts } from './DeepSeekLaunchArtifacts';
import type { DeepSeekPresetPlugin } from './DeepSeekPresetPlugins';
import { DEEPSEEK_WSL_INSTALLATION_HELP, probeDeepSeekWSLInstallation } from './DeepSeekWSLInstallation';

// Native MCP may spend 60 seconds in each discovery phase; retain a finite, cancellable startup budget.
const STARTUP_TIMEOUT_MS = 180_000;
// Native's interrupt force-exits 5 seconds after it starts; the margin covers process exit before the forced stop.
const GRACEFUL_EXIT_TIMEOUT_MS = 6_000;

export interface DeepSeekLaunchOptions {
  readonly execution?: DeepSeekExecutionContext;
  readonly sessionToolRelay?: WSLSessionToolRelay;
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
    const execution = options.execution;
    const wsl = execution?.target.method === 'wsl';
    const desktop = wsl ? undefined : getDeepSeekDesktopInstallation(options.cliPath);
    const cliPath = desktop?.cliPath ?? options.cliPath;
    const profile = desktop ? 'desktop' : 'web';
    const environment = { ...options.environment, ...(!wsl ? { PATH: getEnhancedPath(options.environment.PATH, isAbsolute(cliPath) ? cliPath : undefined) } : {}) };
    const profileDirectory = wsl
      ? execution.pathMapper.toHostPath(posix.join(execution.targetHome, 'profiles', 'web'))!
      : join(getDeepSeekHome(environment, options.cwd), 'profiles', profile);
    if (!profileDirectory) throw new Error('DeepSeek Web profile cannot be accessed in the selected WSL distro.');
    try { await access(join(profileDirectory, 'package.json')); } catch {
      throw new Error(desktop
        ? 'DeepSeek Desktop profile is unavailable. Open DeepSeek Harness Desktop and complete its setup first.'
        : wsl ? `DeepSeek Web profile is unavailable in WSL. ${DEEPSEEK_WSL_INSTALLATION_HELP}`
          : 'DeepSeek Web profile is unavailable. Configure the native dsh web runtime first.');
    }
    // Desktop runs its own executable as Node, and npm dsh runs through Node on its package entry; no wrapper script or
    // Windows .cmd (which needs a shell) is spawned.
    const entry = desktop || wsl ? undefined : resolveDeepSeekNodeEntry(cliPath);
    let spec: ManagedStdioProcessOptions = {
      cwd: options.cwd, directSpawn: true, killProcessTree: true,
      ...(desktop
        ? { command: desktop.executable, args: ['--expose-internals'], env: { ...environment, ELECTRON_RUN_AS_NODE: '1' } }
        : { command: entry ? findNodeExecutable(environment.PATH) ?? 'node' : cliPath, args: entry ? [entry] : [], env: environment }),
    };
    if (wsl) {
      const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const launch = { target: execution.target, hostCwd: options.cwd, env, forwardEnvironment: execution.forwardEnvironment };
      const installation = await probeDeepSeekWSLInstallation({ ...launch, command: cliPath, configuredPath: cliPath });
      if (!installation.entryPath || !installation.nodePath) throw new Error(DEEPSEEK_WSL_INSTALLATION_HELP);
      // Shared shell startup captures exported values in a temporary file. Send only credential-free launch metadata;
      // the plugin adds URL/route credentials from the existing private endpoint file to its per-call descriptor env.
      if (options.sessionToolRelay) {
        const relay = options.sessionToolRelay;
        env.CLAUDIAN_DEEPSEEK_SESSION_RELAY = JSON.stringify({ command: relay.command, args: relay.args, env: {
          WSLENV: relay.env.WSLENV, CLAUDIAN_SESSION_TOOL_MODE: relay.env.CLAUDIAN_SESSION_TOOL_MODE,
        } });
      }
      spec = { command: installation.nodePath, args: [installation.entryPath], env, cwd: options.cwd, directSpawn: true, killProcessTree: true };
    }
    const artifacts = await prepareDeepSeekLaunchArtifacts(undefined, options.presetPlugins, options.sessionToolRoute, execution?.pathMapper);
    const patchPath = wsl ? execution.pathMapper.toTargetPath(artifacts.patchPath) : artifacts.patchPath;
    if (!patchPath) { await artifacts.dispose(); throw new Error('DeepSeek launch patch is inaccessible inside WSL.'); }
    const args = [...spec.args, ...(desktop
      ? [artifacts.desktopRunnerPath, desktop.installAnchor, profileDirectory, patchPath]
      : ['--profile', 'web', '--patch', patchPath, '--no-open', '--port', '0'])];
    if (wsl) {
      const launch = buildTargetLaunchSpec({
        target: execution.target, hostCwd: options.cwd, command: spec.command, args,
        env: Object.fromEntries(Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), forwardEnvironment: [...execution.forwardEnvironment, { key: 'CLAUDIAN_DEEPSEEK_SESSION_RELAY' }],
      });
      spec = { ...spec, ...launch, cwd: launch.spawnCwd };
    } else spec = { ...spec, args };
    const child = new ManagedStdioProcess({
      ...spec,
      stderrBufferLimit: 1,
    });
    let client: DeepSeekRemoteClient | undefined;
    const deadline = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
    const startup = AbortSignal.any([signal, deadline]);
    try {
      const url = await readLaunchURL(child, startup);
      try { client = await DeepSeekRemoteClient.open(url, startup); } catch (error) {
        if (!wsl || signal.aborted) throw error;
        throw new Error('Could not connect to DeepSeek inside WSL through localhost. Check that dsh is running in the selected distro; for WSL2 NAT, enable localhostForwarding in .wslconfig and restart WSL. Keep the native listener on loopback.', { cause: error });
      }
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

  writePrompt(sessionId: string, text: string): Promise<void> { return this.artifacts.writePrompt(sessionId, text); }

  removePrompt(sessionId: string): Promise<void> { return this.artifacts.removePrompt(sessionId); }

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
    // Each stream buffers separately: a stderr line between two stdout chunks must not join the token.
    const output = { stdout: '', stderr: '' };
    let settled = false;
    let offError = (): void => {};
    let offExit = (): void => {};
    const finish = (error?: Error, url?: string): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort); offError(); offExit();
      if (child.isStarted()) { child.stdout.off('data', stdoutData); child.stderr.off('data', stderrData); }
      output.stdout = ''; output.stderr = '';
      if (error) reject(error); else resolve(url!);
    };
    const abort = (): void => finish(new Error('DeepSeek startup cancelled or timed out.'));
    const data = (stream: keyof typeof output, chunk: Buffer | string): void => {
      output[stream] = (output[stream] + chunk.toString()).slice(-16_384);
      // The token may arrive across chunks; accept it only once a delimiter ends it.
      const url = output[stream].match(/(https?:\/\/[^\s"'<>]+\?token=[A-Za-z0-9_%.-]+)[\s"'<>]/)?.[1];
      if (url) finish(undefined, url);
    };
    const stdoutData = (chunk: Buffer | string): void => data('stdout', chunk);
    const stderrData = (chunk: Buffer | string): void => data('stderr', chunk);
    offError = child.onError(() => finish(new Error('DeepSeek process could not start. Check the configured CLI path.')));
    offExit = child.onExit(() => finish(new Error('DeepSeek exited before becoming ready. Check the selected native profile and MCP configuration.')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    // stdin stays open: the bundled lifecycle plugin exits the Host when Claudian's end of the pipe closes.
    // A synchronous spawn failure reaches onError before start() throws, so that rejection is already settled.
    child.start();
    // Removing these listeners leaves the streams flowing, draining later output without retaining tokens or diagnostics.
    child.stdout.on('data', stdoutData); child.stderr.on('data', stderrData);
  });
}
