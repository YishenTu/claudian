import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import type { TargetLaunchSpec } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import { decodeCodexConfig } from '../config';
import type { InitializeResult } from './codexAppServerTypes';
import { buildCodexLaunchSpec } from './CodexLaunchSpecBuilder';
import type { CodexRPCTransport } from './CodexRPCTransport';

const CODEX_APP_SERVER_CLIENT_INFO = Object.freeze({
  name: 'claudian',
  version: '1.0.0',
});

export function getCodexAppServerWorkingDirectory(host: Pick<ProviderRuntimeHost, 'workingDirectory'>): string {
  return host.workingDirectory ?? process.cwd();
}

export function buildCodexAppServerEnvironment(
  host: Pick<ProviderRuntimeHost, 'environmentText'>,
  target?: ExecutionTarget,
): Record<string, string> {
  const customEnv = parseEnvironmentVariables(host.environmentText);
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const enhancedPath = target?.method === 'wsl' ? customEnv.PATH ?? baseEnv.PATH : getEnhancedPath(customEnv.PATH);

  return {
    ...baseEnv,
    ...customEnv,
    PATH: enhancedPath,
  };
}

function resolveCodexExecutionTarget(host: ProviderRuntimeHost, hostVaultPath: string): Promise<ExecutionTarget> {
  return resolveExecutionTargetAsync({ settings: decodeCodexConfig(host.config), hostVaultPath });
}

export async function resolveCodexExecutionWorkingDirectory(host: ProviderRuntimeHost, hostWorkingDirectory: string): Promise<string> {
  const target = await resolveCodexExecutionTarget(host, hostWorkingDirectory);
  if (target.method !== 'wsl') return hostWorkingDirectory;
  const targetPath = createExecutionPathMapper(target).toTargetPath(hostWorkingDirectory);
  if (!targetPath) throw new Error('The Vault path cannot be represented in the selected WSL distro.');
  return targetPath;
}

export async function resolveCodexAppServerLaunchSpec(
  host: ProviderRuntimeHost,
  context?: ProviderTransitionOwnerContext,
): Promise<TargetLaunchSpec> {
  const hostVaultPath = getCodexAppServerWorkingDirectory(host);
  const executionTarget = await resolveCodexExecutionTarget(host, hostVaultPath);

  return buildCodexLaunchSpec({
    codexSettings: decodeCodexConfig(host.config),
    resolvedCliCommand: await host.resolveCliPath({
      ...context,
      executionTarget,
    }),
    hostVaultPath,
    env: buildCodexAppServerEnvironment(host, executionTarget),
    environmentText: host.environmentText,
    executionTarget,
  });
}

export async function initializeCodexAppServerTransport(
  transport: CodexRPCTransport,
): Promise<InitializeResult> {
  const result = await transport.request<InitializeResult>('initialize', {
    clientInfo: CODEX_APP_SERVER_CLIENT_INFO,
    capabilities: { experimentalApi: true },
  });

  transport.notify('initialized');
  return result;
}
