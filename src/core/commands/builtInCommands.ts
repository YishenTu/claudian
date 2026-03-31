/**
 * Claudian - Built-in slash commands
 *
 * System commands that perform actions (not prompt expansions).
 * These are handled separately from user-defined slash commands.
 */

import type { ProviderId } from '../providers/types';

export type BuiltInCommandAction = 'clear' | 'add-dir' | 'resume' | 'fork';

export interface BuiltInCommand {
  name: string;
  aliases?: string[];
  description: string;
  action: BuiltInCommandAction;
  /** Whether this command accepts arguments. */
  hasArgs?: boolean;
  /** Hint for arguments shown in dropdown (e.g., "path"). */
  argumentHint?: string;
  /** When set, only these providers show this command in the dropdown. */
  providers?: ProviderId[];
}

export interface BuiltInCommandResult {
  command: BuiltInCommand;
  /** Arguments passed to the command (trimmed, after command name). */
  args: string;
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: 'clear',
    aliases: ['new'],
    description: 'Start a new conversation',
    action: 'clear',
  },
  {
    name: 'add-dir',
    description: 'Add external context directory',
    action: 'add-dir',
    hasArgs: true,
    argumentHint: '[path/to/directory]',
  },
  {
    name: 'resume',
    description: 'Resume a previous conversation',
    action: 'resume',
    providers: ['claude'],
  },
  {
    name: 'fork',
    description: 'Fork entire conversation to new session',
    action: 'fork',
    providers: ['claude', 'codex'],
  },
];

/** Map of command names/aliases to their definitions. */
const commandMap = new Map<string, BuiltInCommand>();

for (const cmd of BUILT_IN_COMMANDS) {
  commandMap.set(cmd.name.toLowerCase(), cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandMap.set(alias.toLowerCase(), cmd);
    }
  }
}

export function isBuiltInCommandSupported(
  command: BuiltInCommand,
  providerId?: ProviderId,
): boolean {
  return !command.providers || !providerId || command.providers.includes(providerId);
}

/**
 * Checks if input is a built-in command.
 * Returns the command and arguments if found, null otherwise.
 */
export function detectBuiltInCommand(input: string): BuiltInCommandResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command name (first word after /)
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s(.*))?$/);
  if (!match) return null;

  const cmdName = match[1].toLowerCase();
  const command = commandMap.get(cmdName);
  if (!command) return null;

  const args = (match[2] || '').trim();

  return { command, args };
}

/**
 * Gets built-in commands for dropdown display.
 * When providerId is given, excludes commands restricted to other providers.
 */
export function getBuiltInCommandsForDropdown(providerId?: ProviderId): Array<{
  id: string;
  name: string;
  description: string;
  content: string;
  argumentHint?: string;
}> {
  return BUILT_IN_COMMANDS
    .filter((cmd) => isBuiltInCommandSupported(cmd, providerId))
    .map((cmd) => ({
      id: `builtin:${cmd.name}`,
      name: cmd.name,
      description: cmd.description,
      content: '', // Built-in commands don't have prompt content
      argumentHint: cmd.argumentHint,
    }));
}
