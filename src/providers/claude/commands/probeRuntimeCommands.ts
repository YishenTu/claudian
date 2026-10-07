import type { SlashCommand as SDKSlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { ClaudeRuntimeUnavailableError, probeClaudeRuntime } from '../runtime/probeClaudeRuntime';

/**
 * Maps Claude Code's command list; `builtin` marks Claude Code's own commands.
 * Session init names skills separately, qualifying plugin skills (`plugin:skill`)
 * that the command list reports unqualified.
 */
export function mapSDKCommands(
  sdkCommands: readonly SDKSlashCommand[],
  skillNames: readonly string[],
): SlashCommand[] {
  const skills = new Set(skillNames.map(name => name.slice(name.indexOf(':') + 1)));
  return sdkCommands.map(command => ({
    id: `sdk:${command.name}`,
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    content: '',
    source: command.builtin ? 'builtin' : 'sdk',
    kind: skills.has(command.name) ? 'skill' : 'command',
  }));
}

/**
 * Discovers Claude commands and skills from an independent SDK initialization.
 * Resolves empty only when no CLI can run; discovery failures reject.
 */
export async function probeRuntimeCommands(
  host: ProviderHost,
  signal?: AbortSignal,
): Promise<SlashCommand[]> {
  try {
    const { commands, skills } = await probeClaudeRuntime(host, signal);
    return mapSDKCommands(commands, skills);
  } catch (error) {
    if (error instanceof ClaudeRuntimeUnavailableError) return [];
    throw error;
  }
}
