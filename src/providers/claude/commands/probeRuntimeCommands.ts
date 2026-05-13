import type { SlashCommand as SDKSlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import type { SlashCommand } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
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

/**
 * Probes the Claude SDK locally to discover available commands and skills.
 *
 * Fires a throwaway query with an empty prompt — the SDK emits a system/init
 * event from local config parsing alone (no API call, no cost). The probe
 * captures that event, calls supportedCommands() for full metadata, then aborts.
 */
export async function probeRuntimeCommands(plugin: ClaudianPlugin): Promise<SlashCommand[]> {
  const vaultPath = getVaultPath(plugin.app);
  if (!vaultPath) return [];

  const cliPath = plugin.getResolvedProviderCliPath('claude');
  if (!cliPath) return [];

  const customEnv = parseEnvironmentVariables(
    plugin.getActiveEnvironmentVariables('claude')
  );
  const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);
  const claudeSettings = getClaudeProviderSettings(
    plugin.settings,
  );

  const abortController = new AbortController();
  let commands: SlashCommand[] = [];
  const extraArgs = {
    ...(claudeSettings.safeMode === 'auto' ? { 'enable-auto-mode': null } : {}),
    ...(claudeSettings.enableChrome ? { chrome: null } : {}),
  };

  try {
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

    for await (const event of conversation) {
      if (event.type === 'system' && event.subtype === 'init') {
        try {
          const sdkCommands: SDKSlashCommand[] = await conversation.supportedCommands();
          commands = mapSdkCommands(sdkCommands);
        } catch { /* best-effort */ }
        abortController.abort();
        break;
      }
    }
  } catch {
    // Probe is best-effort; swallow abort errors.
  }

  return commands;
}
