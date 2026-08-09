import { spawn } from 'node:child_process';

import type { ProviderInteractionPort, ProviderSessionConfig } from '../../../core/execution';
import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
} from '../../../utils/windowsCmdShim';
import {
  DefaultOmpAcpSessionKernel,
  type OmpAcpSessionKernel,
  type OmpAcpSessionKernelOptions,
} from '../execution/OmpAcpSessionKernel';
import {
  normalizeOmpConfigChoices,
  normalizeOmpConfigOptionModels,
  normalizeOmpDiscoveredModels,
  type OmpDiscoveredModel,
} from '../models';
import { buildOmpEnvironment } from '../runtime/OmpLaunchSpec';

const MODEL_COMMAND_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export interface OmpCatalogCommandRequest {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface OmpCatalogCommandResult {
  exitCode: number | null;
  stdout: string;
  termination?: 'abort' | 'error' | 'output-limit' | 'timeout';
}

export interface OmpCatalogCommandRunner {
  run(request: OmpCatalogCommandRequest): Promise<OmpCatalogCommandResult>;
}

export interface OmpModelCatalog {
  models: OmpDiscoveredModel[];
  thinking: {
    configId: string;
    currentValue: string | null;
    options: Array<{ description?: string; id: string; name: string }>;
  } | null;
}

export interface OmpModelDiscoveryServiceOptions {
  readonly createKernel?: (options: OmpAcpSessionKernelOptions) => OmpAcpSessionKernel;
  readonly runner?: OmpCatalogCommandRunner;
}

export class OmpModelDiscoveryService {
  private readonly createKernel: (options: OmpAcpSessionKernelOptions) => OmpAcpSessionKernel;
  private readonly runner: OmpCatalogCommandRunner;

  constructor(
    private readonly plugin: ProviderHost,
    options: OmpModelDiscoveryServiceOptions = {},
  ) {
    this.createKernel = options.createKernel
      ?? (kernelOptions => new DefaultOmpAcpSessionKernel(kernelOptions));
    this.runner = options.runner ?? new SpawnOmpCatalogCommandRunner();
  }

  async discover(signal?: AbortSignal): Promise<OmpDiscoveredModel[]> {
    return (await this.discoverCatalog(signal)).models;
  }

  async discoverCatalog(signal?: AbortSignal): Promise<OmpModelCatalog> {
    signal?.throwIfAborted();
    const kernel = this.createKernel({
      config: getMetadataSessionConfig(this.plugin),
      getActiveTurnId: () => null,
      onClosed: () => undefined,
      onNotification: () => undefined,
      plugin: this.plugin,
    });
    try {
      await kernel.connect();
      signal?.throwIfAborted();
      const session = await kernel.openSession();
      signal?.throwIfAborted();
      const thinking = normalizeOmpConfigChoices(session.configOptions, 'thought_level');
      const acpModels = normalizeOmpConfigOptionModels(session.configOptions);
      const models = await this.discoverCliModels(signal).catch(() => acpModels);
      return {
        models: models.length > 0 ? models : acpModels,
        thinking: thinking.configId
          ? {
            configId: thinking.configId,
            currentValue: thinking.currentValue,
            options: thinking.options,
          }
          : null,
      };
    } finally {
      await kernel.dispose();
    }
  }

  private async discoverCliModels(signal?: AbortSignal): Promise<OmpDiscoveredModel[]> {
    const command = await this.plugin.getResolvedProviderCliPath('omp') ?? 'omp';
    const result = await this.runner.run({
      args: ['models', '--json'],
      command,
      cwd: getVaultPath(this.plugin.app) ?? process.cwd(),
      env: buildOmpEnvironment(
        process.env,
        getRuntimeEnvironmentVariables(this.plugin.settings, 'omp'),
      ),
      signal,
      timeoutMs: MODEL_COMMAND_TIMEOUT_MS,
    });
    if (result.termination || result.exitCode !== 0) return [];
    return parseOmpModelsOutput(result.stdout);
  }

}

export function parseOmpModelsOutput(output: string): OmpDiscoveredModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return normalizeOmpCliModels((parsed as Record<string, unknown>).models);
}

function normalizeOmpCliModels(value: unknown): OmpDiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  return normalizeOmpDiscoveredModels(value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const selector = typeof record.selector === 'string' ? record.selector.trim() : '';
    const rawId = selector || (provider && id ? `${provider}/${id}` : id);
    return {
      description: provider && id ? `${provider}/${id}` : undefined,
      label: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : rawId,
      rawId,
    };
  }));
}

export class SpawnOmpCatalogCommandRunner implements OmpCatalogCommandRunner {
  run(request: OmpCatalogCommandRequest): Promise<OmpCatalogCommandResult> {
    if (request.signal?.aborted) {
      return Promise.resolve({ exitCode: null, stdout: '', termination: 'abort' });
    }
    return new Promise(resolve => {
      const spawnSpec = resolveWindowsCmdShimSpawnSpec(request);
      let child: ReturnType<typeof spawn> | null = null;
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;
      const finish = (result: OmpCatalogCommandResult): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (): void => {
        if (child) terminateSpawnedProcess(child, 'SIGKILL', spawn, spawnSpec);
      };
      const onAbort = (): void => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'abort' });
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = globalThis.setTimeout(() => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'timeout' });
      }, request.timeoutMs);
      if (request.signal?.aborted) {
        finish({ exitCode: null, stdout: '', termination: 'abort' });
        return;
      }
      try {
        child = spawn(spawnSpec.command, spawnSpec.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch {
        finish({ exitCode: null, stdout: '', termination: 'error' });
        return;
      }
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      const spawnedChild = child;
      if (!spawnedChild.stdout) {
        finish({ exitCode: null, stdout: '', termination: 'error' });
        return;
      }
      spawnedChild.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > MAX_STDOUT_BYTES) {
          terminate();
          finish({ exitCode: null, stdout: '', termination: 'output-limit' });
          return;
        }
        chunks.push(buffer);
      });
      spawnedChild.once('error', () => finish({ exitCode: null, stdout: '', termination: 'error' }));
      spawnedChild.once('close', exitCode => finish({
        exitCode,
        stdout: Buffer.concat(chunks).toString('utf8'),
      }));
    });
  }
}

function getMetadataSessionConfig(plugin: ProviderHost): ProviderSessionConfig {
  const adapter = plugin.app.vault.adapter as { basePath?: unknown };
  return {
    interactionPort: DENY_INTERACTION_PORT,
    lifecycle: 'ephemeral',
    nativePersistence: 'disabled-if-supported',
    vaultWorkingDirectory: typeof adapter.basePath === 'string' && adapter.basePath
      ? adapter.basePath
      : process.cwd(),
  };
}

const DENY_INTERACTION_PORT: ProviderInteractionPort = {
  askUserQuestion: async ({ interactionId }) => ({ answers: null, interactionId }),
  dismissInteraction: () => undefined,
  requestApproval: async ({ interactionId }) => ({ decision: 'deny', interactionId }),
  requestPlanDecision: async ({ interactionId }) => ({ decision: null, interactionId }),
};
