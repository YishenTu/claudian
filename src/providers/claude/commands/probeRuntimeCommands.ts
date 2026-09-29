import type { SlashCommand as SDKSlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { ClaudeRuntimeUnavailableError, probeClaudeRuntime } from '../runtime/probeClaudeRuntime';

/** Maps Claude Code's command list; `builtin` marks Claude Code's own commands. */
export function mapSDKCommands(sdkCommands: readonly SDKSlashCommand[]): SlashCommand[] {
  return sdkCommands.map(command => ({
    id: `sdk:${command.name}`,
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    content: '',
    source: command.builtin ? 'builtin' : 'sdk',
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
    return mapSDKCommands((await probeClaudeRuntime(host, signal)).commands);
  } catch (error) {
    if (error instanceof ClaudeRuntimeUnavailableError) return [];
    throw error;
  }
}
