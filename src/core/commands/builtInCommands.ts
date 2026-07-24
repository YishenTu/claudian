/**
 * Claudian - Built-in slash commands
 *
 * System commands that perform actions (not prompt expansions).
 * These are handled separately from user-defined slash commands.
 */

import { ProviderRegistry } from '../providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderId } from '../providers/types';

export type BuiltInCommandAction = 'clear' | 'add-dir' | 'resume' | 'fork' | 'fast';
type BuiltInCommandCapability = 'supportsNativeHistory' | 'supportsFork';
type BuiltInCommandCapabilityContext =
  Pick<ProviderCapabilities, BuiltInCommandCapability>
  & Partial<Pick<ProviderCapabilities, 'providerId'>>;
type BuiltInCommandSupportContext = ProviderId | BuiltInCommandCapabilityContext;

export interface BuiltInCommand {
  name: string;
  aliases?: string[];
  description: string;
  action: BuiltInCommandAction;
  /** Whether this command accepts arguments. */
  hasArgs?: boolean;
  /** Hint for arguments shown in dropdown (e.g., "path"). */
  argumentHint?: string;
  /** When set, provider capabilities must expose this feature. */
  requiredCapability?: BuiltInCommandCapability;
  /** When set, only these providers expose and execute the command. */
  supportedProviderIds?: ProviderId[];
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
    requiredCapability: 'supportsNativeHistory',
  },
  {
    name: 'fork',
    description: 'Fork entire conversation to new session',
    action: 'fork',
    requiredCapability: 'supportsFork',
  },
  {
    name: 'fast',
    description: 'Toggle fast mode',
    action: 'fast',
    supportedProviderIds: ['codex'],
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

function resolveCapabilities(
  context: BuiltInCommandSupportContext,
): BuiltInCommandCapabilityContext | null {
  if (typeof context !== 'string') {
    return context;
  }

  try {
    return ProviderRegistry.getCapabilities(context);
  } catch {
    return null;
  }
}

function isBuiltInCommandProviderSupported(
  command: BuiltInCommand,
  context?: BuiltInCommandSupportContext,
): boolean {
  if (!command.supportedProviderIds || !context) {
    return true;
  }

  const providerId = typeof context === 'string' ? context : context.providerId;
  return Boolean(providerId && command.supportedProviderIds.includes(providerId));
}

export function isBuiltInCommandSupported(
  command: BuiltInCommand,
  context?: BuiltInCommandSupportContext,
): boolean {
  if (!context) {
    return true;
  }

  if (!isBuiltInCommandProviderSupported(command, context)) {
    return false;
  }

  if (!command.requiredCapability) {
    return true;
  }

  const capabilities = resolveCapabilities(context);
  return capabilities ? capabilities[command.requiredCapability] : false;
}

/**
 * Checks if input is a built-in command.
 * Provider-scoped commands are left to other providers' command handling.
 * Returns the command and arguments if found, null otherwise.
 */
export function detectBuiltInCommand(
  input: string,
  context?: BuiltInCommandSupportContext,
): BuiltInCommandResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command name (first word after /)
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s(.*))?$/);
  if (!match) return null;

  const cmdName = match[1].toLowerCase();
  const command = commandMap.get(cmdName);
  if (!command) return null;
  if (!isBuiltInCommandProviderSupported(command, context)) return null;

  const args = (match[2] || '').trim();

  return { command, args };
}

/**
 * Gets built-in commands for dropdown display.
 * When providerId is given, excludes commands restricted to other providers.
 */
export function getBuiltInCommandsForDropdown(context?: BuiltInCommandSupportContext): Array<{
  id: string;
  name: string;
  description: string;
  content: string;
  argumentHint?: string;
}> {
  return BUILT_IN_COMMANDS
    .filter((cmd) => isBuiltInCommandSupported(cmd, context))
    .map((cmd) => ({
      id: `builtin:${cmd.name}`,
      name: cmd.name,
      description: cmd.description,
      content: '', // Built-in commands don't have prompt content
      argumentHint: cmd.argumentHint,
    }));
}
