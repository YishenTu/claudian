import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import { getVaultPath } from '../../../utils/path';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
} from '../../../utils/windowsCmdShim';
import {
  type GrokDiscoveredModel,
  normalizeGrokDiscoveredModels,
} from '../models';
import { getGrokProviderSettings } from '../settings';
import { buildGrokRuntimeEnv } from './GrokRuntimeEnvironment';

const FINGERPRINT_VERSION = '1';
const MODEL_COMMAND_TIMEOUT_MS = 20_000;
const VERSION_COMMAND_TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

export interface GrokCatalogCommandRequest {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface GrokCatalogCommandResult {
  exitCode: number | null;
  stdout: string;
  termination?: 'abort' | 'error' | 'output-limit' | 'timeout';
}

export interface GrokCatalogCommandRunner {
  run(request: GrokCatalogCommandRequest): Promise<GrokCatalogCommandResult>;
}

export type GrokModelCatalogDiscoveryResult =
  | {
    defaultModelId: string | null;
    diagnostics?: string;
    fingerprint: string;
    kind: 'completed';
    models: GrokDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export interface GrokModelCatalogServiceLike {
  discoverCatalog(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<GrokModelCatalogDiscoveryResult>;
  getCatalogFingerprint(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<string>;
}

export interface GrokModelCatalogServiceOptions {
  modelCommandTimeoutMs?: number;
  runner?: GrokCatalogCommandRunner;
  versionCommandTimeoutMs?: number;
}

export interface GrokCatalogFingerprintInputs {
  command: string;
  environmentKeys: string[];
  version: string;
}

interface GrokResolvedCatalogCommandContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  environmentKeys: string[];
}

export function buildGrokCatalogFingerprint(inputs: GrokCatalogFingerprintInputs): string {
  const payload = [
    FINGERPRINT_VERSION,
    inputs.command.trim(),
    inputs.version.trim(),
    Array.from(new Set(inputs.environmentKeys.map(key => key.trim()).filter(Boolean))).sort(),
  ];
  return `${FINGERPRINT_VERSION}:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`;
}

export function parseGrokModelsOutput(output: string): {
  defaultModelId: string | null;
  models: GrokDiscoveredModel[];
} {
  const lines = stripAnsi(output).split(/\r?\n/);
  let defaultModelId: string | null = null;
  let inAvailableModels = false;
  const rawModels: Array<{ displayName: string; rawId: string }> = [];

  for (const line of lines) {
    const defaultMatch = line.match(/^\s*Default model:\s*(\S+)/i);
    if (defaultMatch) {
      defaultModelId = normalizeModelToken(defaultMatch[1]);
      continue;
    }

    if (/^\s*Available models:\s*$/i.test(line)) {
      inAvailableModels = true;
      continue;
    }
    if (!inAvailableModels || !line.trim()) {
      continue;
    }
    if (!/^\s/u.test(line)) {
      inAvailableModels = false;
      continue;
    }

    const modelLine = line.trim().replace(/^[-*]\s+/, '');
    const rawId = normalizeModelToken(modelLine.split(/\s+/)[0] ?? '');
    if (rawId) {
      rawModels.push({ displayName: rawId, rawId });
    }
  }

  return {
    defaultModelId,
    models: normalizeGrokDiscoveredModels(rawModels),
  };
}

export class GrokModelCatalogService implements GrokModelCatalogServiceLike {
  private readonly runner: GrokCatalogCommandRunner;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: GrokModelCatalogServiceOptions = {},
  ) {
    this.runner = options.runner ?? new SpawnGrokCatalogCommandRunner();
  }

  async getCatalogFingerprint(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<string> {
    const context = await this.resolveCommandContext(ownerContext);
    return this.resolveFingerprint(context, signal);
  }

  async discoverCatalog(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<GrokModelCatalogDiscoveryResult> {
    if (!getGrokProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    try {
      const context = await this.resolveCommandContext(ownerContext);
      const fingerprint = await this.resolveFingerprint(context, signal);
      const commandResult = await this.runner.run({
        args: ['models'],
        command: context.command,
        cwd: context.cwd,
        env: context.env,
        signal,
        timeoutMs: this.options.modelCommandTimeoutMs ?? MODEL_COMMAND_TIMEOUT_MS,
      });
      const diagnostics = describeModelsCommandFailure(commandResult);
      if (diagnostics) {
        return {
          defaultModelId: null,
          diagnostics,
          fingerprint,
          kind: 'completed',
          models: [],
        };
      }

      const parsed = parseGrokModelsOutput(commandResult.stdout);
      if (parsed.models.length === 0) {
        return {
          ...parsed,
          diagnostics: 'Grok models returned no available models',
          fingerprint,
          kind: 'completed',
        };
      }
      return { ...parsed, fingerprint, kind: 'completed' };
    } catch {
      return {
        defaultModelId: null,
        diagnostics: 'Grok models could not be started',
        fingerprint: buildGrokCatalogFingerprint({
          command: '',
          environmentKeys: [],
          version: 'unavailable',
        }),
        kind: 'completed',
        models: [],
      };
    }
  }

  private async resolveCommandContext(
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<GrokResolvedCatalogCommandContext> {
    const command = await this.plugin.getResolvedProviderCliPath(
      'grok',
      ownerContext,
    ) ?? 'grok';
    const configuredEnvironment = getRuntimeEnvironmentVariables(this.plugin.settings, 'grok');
    return {
      command,
      cwd: getVaultPath(this.plugin.app) ?? process.cwd(),
      env: buildGrokRuntimeEnv(this.plugin.settings, command),
      environmentKeys: Object.keys(configuredEnvironment),
    };
  }

  private async resolveFingerprint(
    context: GrokResolvedCatalogCommandContext,
    signal?: AbortSignal,
  ): Promise<string> {
    let version = 'unavailable';
    try {
      const versionResult = await this.runner.run({
        args: ['--version'],
        command: context.command,
        cwd: context.cwd,
        env: context.env,
        signal,
        timeoutMs: this.options.versionCommandTimeoutMs ?? VERSION_COMMAND_TIMEOUT_MS,
      });
      if (versionResult.exitCode === 0 && !versionResult.termination) {
        version = versionResult.stdout.trim() || version;
      } else {
        version = `unavailable:${versionResult.termination ?? versionResult.exitCode ?? 'unknown'}`;
      }
    } catch {
      version = 'unavailable:error';
    }

    return buildGrokCatalogFingerprint({
      command: context.command,
      environmentKeys: context.environmentKeys,
      version,
    });
  }
}

export class SpawnGrokCatalogCommandRunner implements GrokCatalogCommandRunner {
  run(request: GrokCatalogCommandRequest): Promise<GrokCatalogCommandResult> {
    if (request.signal?.aborted) {
      return Promise.resolve({ exitCode: null, stdout: '', termination: 'abort' });
    }

    return new Promise((resolve) => {
      const spawnSpec = resolveWindowsCmdShimSpawnSpec(request);
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;

      const finish = (result: GrokCatalogCommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (): void => {
        terminateSpawnedProcess(proc, 'SIGKILL', spawn, spawnSpec);
      };
      const onAbort = (): void => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'abort' });
      };
      const timeout = window.setTimeout(() => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'timeout' });
      }, request.timeoutMs);

      request.signal?.addEventListener('abort', onAbort, { once: true });
      proc.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > MAX_STDOUT_BYTES) {
          terminate();
          finish({ exitCode: null, stdout: '', termination: 'output-limit' });
          return;
        }
        chunks.push(buffer);
      });
      proc.once('error', () => {
        finish({ exitCode: null, stdout: '', termination: 'error' });
      });
      proc.once('close', (exitCode) => {
        finish({ exitCode, stdout: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }
}

function describeModelsCommandFailure(result: GrokCatalogCommandResult): string | null {
  switch (result.termination) {
    case 'abort':
      return 'Grok models was cancelled';
    case 'error':
      return 'Grok models could not be started';
    case 'output-limit':
      return 'Grok models returned too much output';
    case 'timeout':
      return 'Grok models timed out';
    default:
      return result.exitCode === 0
        ? null
        : `Grok models exited with code ${result.exitCode ?? 'unknown'}`;
  }
}

function normalizeModelToken(value: string): string | null {
  const normalized = value.trim().replace(/,+$/u, '');
  return normalized
    && !normalized.endsWith(':')
    && /^[A-Za-z0-9@][A-Za-z0-9@._/+:-]*$/u.test(normalized)
    ? normalized
    : null;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, '');
}
