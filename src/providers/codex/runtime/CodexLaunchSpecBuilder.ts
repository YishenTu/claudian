import {
  type ExecutionTargetSettings,
  resolveExecutionTarget,
} from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget, TargetLaunchSpec } from '@/core/process/execution-target/types';

import type { CodexProviderSettings } from '../config';
import { getCodexWSLForwardedEnvironment } from './codexWSLEnvironment';

export interface BuildCodexLaunchSpecOptions {
  codexSettings: ExecutionTargetSettings & Pick<CodexProviderSettings, 'responseVerbosity' | 'environmentVariables'>;
  resolvedCliCommand: string | null;
  environmentText?: string;
  cliArgs?: readonly string[];
  hostVaultPath: string | null;
  env: Record<string, string>;
  executionTarget?: ExecutionTarget;
  hostPlatform?: NodeJS.Platform;
  resolveDefaultWSLDistro?: () => string | undefined;
}

const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);

export function buildCodexLaunchSpec(
  options: BuildCodexLaunchSpecOptions,
): TargetLaunchSpec {
  const target = options.executionTarget ?? resolveExecutionTarget({
    settings: options.codexSettings,
    hostPlatform: options.hostPlatform,
    hostVaultPath: options.hostVaultPath,
    resolveDefaultWSLDistro: options.resolveDefaultWSLDistro,
  });

  const resolvedCliCommand = options.resolvedCliCommand?.trim() || 'codex';
  const verbosity = options.codexSettings.responseVerbosity;
  // Verbosity has no turn/start override. Launch args participate in the runtime
  // fingerprint, so changing this setting replaces the server for subsequent work.
  const cliArgs = options.cliArgs ?? [
    ...CODEX_APP_SERVER_ARGS,
    ...(verbosity === 'default' ? [] : ['-c', `model_verbosity="${verbosity}"`]),
  ];
  return buildTargetLaunchSpec({
    target, command: resolvedCliCommand, args: cliArgs,
    hostCwd: options.hostVaultPath ?? process.cwd(), env: options.env,
    forwardEnvironment: getCodexWSLForwardedEnvironment(options.env, options.environmentText ?? options.codexSettings.environmentVariables),
  });
}
