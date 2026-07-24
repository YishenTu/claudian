import type { SlashCommand as SDKSlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { throwIfAborted, toAbortError } from '../../../utils/abort';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { loadClaudeAgentQuery } from '../loadClaudeAgentSdk';
import { createCustomSpawnFunction } from '../runtime/customSpawn';
import {
  getClaudeProviderSettings,
  resolveClaudeSettingSources,
} from '../settings';

function mapSdkCommands(sdkCommands: SDKSlashCommand[]): SlashCommand[] {
  return sdkCommands.map((cmd) => ({
    id: `sdk:${cmd.name}`,
    name: cmd.name,
    description: cmd.description,
    argumentHint: cmd.argumentHint,
    content: '',
    source: 'sdk' as const,
  }));
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  throwIfAborted(signal, 'Claude command discovery aborted');

  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toAbortError(
      signal,
      'Claude command discovery aborted',
    ));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Probes the Claude SDK locally to discover available commands and skills.
 *
 * Fires a throwaway query with an empty prompt — the SDK emits a system/init
 * event from local config parsing alone (no API call, no cost). The probe
 * captures that event, calls supportedCommands() for full metadata, then aborts.
 */
export async function probeRuntimeCommands(
  plugin: ProviderHost,
  signal?: AbortSignal,
): Promise<SlashCommand[]> {
  throwIfAborted(signal, 'Claude command discovery aborted');
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let commands: SlashCommand[] = [];

  try {
    const vaultPath = getVaultPath(plugin.app);
    if (!vaultPath) return [];

    const cliPath = await awaitWithAbort(
      Promise.resolve(plugin.getResolvedProviderCliPath('claude')),
      signal,
    );
    if (!cliPath) return [];

    const customEnv = parseEnvironmentVariables(
      plugin.getActiveEnvironmentVariables('claude')
    );
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);
    const claudeSettings = getClaudeProviderSettings(
      plugin.settings,
    );
    const extraArgs = {
      ...(claudeSettings.safeMode === 'auto' ? { 'enable-auto-mode': null } : {}),
      ...(claudeSettings.enableChrome ? { chrome: null } : {}),
    };
    const agentQuery = await awaitWithAbort(loadClaudeAgentQuery(), signal);
    const conversation = agentQuery({
      prompt: '',
      options: {
        cwd: vaultPath,
        abortController,
        pathToClaudeCodeExecutable: cliPath,
        env: { ...process.env, ...customEnv, PATH: enhancedPath },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: resolveClaudeSettingSources(claudeSettings.loadUserSettings),
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath),
        persistSession: false,
      },
    });

    while (true) {
      const next = await awaitWithAbort(conversation.next(), signal);
      if (next.done) {
        break;
      }
      const event = next.value;
      if (event.type === 'system' && event.subtype === 'init') {
        try {
          const sdkCommands: SDKSlashCommand[] = await awaitWithAbort(
            conversation.supportedCommands(),
            signal,
          );
          commands = mapSdkCommands(sdkCommands);
        } catch {
          throwIfAborted(signal, 'Claude command discovery aborted');
        }
        break;
      }
    }
  } catch {
    throwIfAborted(signal, 'Claude command discovery aborted');
    // Probe failures are best-effort; caller cancellation remains observable.
  } finally {
    signal?.removeEventListener('abort', onAbort);
    abortController.abort();
  }

  return commands;
}
