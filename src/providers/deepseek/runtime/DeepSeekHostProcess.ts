import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { cliPathRequiresNode, findNodeExecutable, getEnhancedPath } from '@/core/process/env';
import { ManagedStdioProcess, type ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import { runProcessProbe } from '@/core/process/ProcessProbe';

import { DeepSeekRemoteClient } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekPreset } from '../types';
import { type DeepSeekLaunchArtifacts, prepareDeepSeekLaunchArtifacts } from './DeepSeekLaunchArtifacts';
import type { DeepSeekPresetPlugin } from './DeepSeekPresetPlugins';

// Native MCP may spend 60 seconds in each discovery phase; retain a finite, cancellable startup budget.
const STARTUP_TIMEOUT_MS = 180_000;

export interface DeepSeekLaunchOptions {
  readonly cliPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** The user's additional chat preset rows, already validated. */
  readonly presetPlugins?: readonly DeepSeekPresetPlugin[];
}

export function getDeepSeekHome(environment: NodeJS.ProcessEnv): string {
  return resolve(environment.DSH_HOME || join(environment.HOME || environment.USERPROFILE || homedir(), '.dsh'));
}

/** One native Web Host process with its launch overlay and authenticated transport. */
export class DeepSeekHostProcess {
  private disposal?: Promise<void>;
  private readonly exitListeners = new Set<() => void>();

  private constructor(
    readonly client: DeepSeekRemoteClient,
    private readonly process: ManagedStdioProcess,
    private readonly artifacts: DeepSeekLaunchArtifacts,
  ) {
    process.onExit(() => {
      if (!this.disposal) for (const listener of this.exitListeners) listener();
    });
  }

  static async start(options: DeepSeekLaunchOptions, signal: AbortSignal): Promise<DeepSeekHostProcess> {
    signal.throwIfAborted();
    if (process.platform === 'win32') throw new Error('DeepSeek Harness integration is not yet qualified on Windows.');
    const environment = { ...options.environment, PATH: getEnhancedPath(options.environment.PATH, isAbsolute(options.cliPath) ? options.cliPath : undefined) };
    try { await access(join(getDeepSeekHome(environment), 'profiles', 'web', 'package.json')); } catch {
      throw new Error('DeepSeek Web profile is unavailable. Configure the native dsh web runtime first.');
    }
    const usesNode = cliPathRequiresNode(options.cliPath);
    const spec: ManagedStdioProcessOptions = {
      command: usesNode ? findNodeExecutable(environment.PATH) ?? 'node' : options.cliPath,
      args: usesNode ? [options.cliPath] : [], cwd: options.cwd, env: environment,
      directSpawn: true, killProcessTree: true,
    };
    const version = await runProcessProbe({ ...spec, args: [...spec.args, '--version'] });
    signal.throwIfAborted();
    if (version?.trim() !== '0.2.0-rc.2') {
      throw new Error('Unsupported DeepSeek Harness version. This integration requires 0.2.0-rc.2.');
    }
    const artifacts = await prepareDeepSeekLaunchArtifacts(undefined, options.presetPlugins);
    const child = new ManagedStdioProcess({
      ...spec,
      args: [...spec.args, '--profile', 'web', '--patch', artifacts.patchPath, '--no-open', '--port', '0'],
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
      return new DeepSeekHostProcess(client, child, artifacts);
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

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.exitListeners.clear();
      this.client.dispose();
      this.disposal = this.process.shutdown().finally(() => this.artifacts.dispose());
    }
    return this.disposal;
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
    offExit = child.onExit(() => finish(new Error('DeepSeek exited before becoming ready. Check the native Web profile and MCP configuration.')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      // stdin stays open: the bundled lifecycle plugin exits the Host when Claudian's end of the pipe closes.
      child.start();
      child.stdout.on('data', data); child.stderr.on('data', data);
      // Drain later output without retaining tokens or native configuration diagnostics.
      child.stdout.resume(); child.stderr.resume();
    } catch { finish(new Error('DeepSeek process could not start.')); }
  });
}
