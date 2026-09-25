import type { SlashCommand as SDKSlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { throwIfAborted, toAbortError } from '../../../utils/abort';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { loadClaudeAgentQuery } from '../loadClaudeAgentSDK';
import { createCustomSpawnFunction } from '../runtime/customSpawn';
import {
  getClaudeProviderSettings,
  resolveClaudeSettingSources,
} from '../settings';

// Claude emits system/init only after MCP servers connect; cap that wait so
// one slow server cannot stall discovery.
const PROBE_MCP_TIMEOUT_MS = '5000';

function mapSDKCommands(sdkCommands: SDKSlashCommand[]): SlashCommand[] {
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
 * Resolves empty only when no CLI can run; discovery failures reject.
 */
export async function probeRuntimeCommands(
  plugin: ProviderHost,
  signal?: AbortSignal,
): Promise<SlashCommand[]> {
  throwIfAborted(signal, 'Claude command discovery aborted');
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

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
        env: {
          MCP_TIMEOUT: PROBE_MCP_TIMEOUT_MS,
          ...process.env,
          ...customEnv,
          PATH: enhancedPath,
        },
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
        throw new Error('Claude command discovery ended before initialization');
      }
      const event = next.value;
      if (event.type === 'system' && event.subtype === 'init') {
        const sdkCommands: SDKSlashCommand[] = await awaitWithAbort(
          conversation.supportedCommands(),
          signal,
        );
        return mapSDKCommands(sdkCommands);
      }
    }
  } catch (error) {
    throwIfAborted(signal, 'Claude command discovery aborted');
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    abortController.abort();
  }
}
