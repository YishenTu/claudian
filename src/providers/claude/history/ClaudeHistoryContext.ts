import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';

import { decodeClaudeConfig } from '../config';
import type { ClaudeConfigDirContext } from '../config/ClaudeConfigDir';
import { getClaudeWSLForwardedEnvironment } from '../runtime/claudeWSLEnvironment';

// Only the latest resolved store is retained. Synchronous metadata projections must never probe WSL.
let resolvedStore: { key: string; context: ClaudeConfigDirContext } | undefined;

export function invalidateClaudeHistoryContext(): void {
  resolvedStore = undefined;
}

function storeKey(context: ClaudeConfigDirContext, vaultPath: string): string {
  const settings = decodeClaudeConfig(context.config ?? {});
  return JSON.stringify([
    vaultPath, context.hostPlatform ?? process.platform,
    context.executionTarget ?? [settings.installationMethod, settings.wslDistroOverride],
    context.environmentText ?? '',
    Object.entries(context.environment ?? process.env).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

/** Null means WSL has not yet resolved these store inputs; retain native-backed metadata. */
export function getClaudeHistoryContextForProjection(
  context: ClaudeConfigDirContext | undefined,
  vaultPath: string,
): ClaudeConfigDirContext | undefined | null {
  if (!context || context.targetEnvironmentResolved) return context;
  const settings = decodeClaudeConfig(context.config ?? {});
  const isWSL = context.executionTarget?.method === 'wsl'
    || (!context.executionTarget && (context.hostPlatform ?? process.platform) === 'win32' && settings.installationMethod === 'wsl');
  if (!isWSL) return context;
  if (resolvedStore?.key === storeKey(context, vaultPath)) return resolvedStore.context;
  resolvedStore = undefined;
  return null;
}

/** Resolve Claude's store through the same target shell/environment as the SDK process. */
export async function resolveClaudeHistoryContext(
  context: ClaudeConfigDirContext | undefined,
  vaultPath: string,
): Promise<ClaudeConfigDirContext | undefined> {
  if (!context || context.targetEnvironmentResolved) return context;
  const key = storeKey(context, vaultPath);
  if (resolvedStore?.key !== key) resolvedStore = undefined;
  const target = context.executionTarget ?? (context.config ? await resolveExecutionTargetAsync({
    settings: decodeClaudeConfig(context.config ?? {}), hostPlatform: context.hostPlatform, hostVaultPath: vaultPath,
  }) : undefined);
  if (target?.method !== 'wsl') return context;
  const env = Object.fromEntries(Object.entries(context.environment ?? process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const environment = await probeTargetEnvironment({
    target, hostCwd: vaultPath, env, variables: ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'],
    forwardEnvironment: getClaudeWSLForwardedEnvironment(env, context.environmentText ?? ''),
  });
  const home = environment?.HOME;
  const tmpDir = environment?.TMPDIR || '/tmp';
  if (!home?.startsWith('/') || !tmpDir.startsWith('/')) {
    throw new Error('Unable to resolve Claude Code configuration in the selected WSL distro');
  }
  const configDir = environment?.CLAUDE_CONFIG_DIR ?? `${home}/.claude`;
  const resolved = {
    ...context, vaultPath, executionTarget: target, targetEnvironmentResolved: true,
    environment: { ...context.environment, HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: tmpDir },
  };
  resolvedStore = { key, context: resolved };
  return resolved;
}
