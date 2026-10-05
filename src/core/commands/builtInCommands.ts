/**
 * Claudian - Built-in slash commands
 *
 * System commands that perform actions (not prompt expansions).
 * These are handled separately from user-defined slash commands.
 */

import { ProviderRegistry } from '../providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderId } from '../providers/types';

export type BuiltInCommandAction =
  | 'clear'
  | 'resume'
  | 'fork'
  | 'fast'
  | 'side';
type BuiltInCommandCapability =
  | 'supportsNativeHistory'
  | 'supportsFork'
  | 'supportsFastMode';
type BuiltInCommandCapabilityContext =
  Partial<Pick<ProviderCapabilities, BuiltInCommandCapability>>
  & Partial<Pick<ProviderCapabilities, 'providerId'>>;
type BuiltInCommandSupportContext = ProviderId | BuiltInCommandCapabilityContext;

export interface BuiltInCommand {
  name: string;
  aliases?: string[];
  description: string;
  action: BuiltInCommandAction;
  /** Hint for arguments shown in dropdown (e.g., "path"). */
  argumentHint?: string;
  /** When set, provider capabilities must expose this feature. */
  requiredCapability?: BuiltInCommandCapability;
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
    requiredCapability: 'supportsFastMode',
  },
  {
    name: 'side',
    aliases: ['btw'],
    description: 'Ask a temporary side question from the latest reply',
    action: 'side',
    argumentHint: 'prompt',
    requiredCapability: 'supportsFork',
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

export function isBuiltInCommandSupported(
  command: BuiltInCommand,
  context?: BuiltInCommandSupportContext,
): boolean {
  if (!context) {
    return true;
  }

  if (!command.requiredCapability) {
    return true;
  }

  const capabilities = resolveCapabilities(context);
  return capabilities ? capabilities[command.requiredCapability] === true : false;
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
  const parsed = parseLeadingBuiltInCommand(input);
  if (!parsed || /[\r\n\u2028\u2029]/.test(parsed.rawArguments)) return null;
  const { command } = parsed;
  if (!isBuiltInCommandSupported(command, context)) return null;
  const args = parsed.rawArguments.trim();

  return { command, args };
}

export interface SideChatCommandMatch {
  /** Alias exactly as typed, lowercased. */
  readonly alias: string;
  /** Trimmed argument; empty when the alias was submitted on its own. */
  readonly argument: string;
}

/**
 * Recognizes a complete leading side-chat command token, including multiline
 * arguments that the single-line built-in matcher deliberately rejects.
 */
export function detectSideChatCommand(input: string): SideChatCommandMatch | null {
  const parsed = parseLeadingBuiltInCommand(input);
  if (!parsed || parsed.command.action !== 'side') return null;
  return { alias: parsed.alias, argument: parsed.rawArguments.trim() };
}

/**
 * Leading built-in command token that Claudian owns for the main chat only,
 * regardless of provider capability. Side-chat aliases are excluded because
 * they are the side feature's own controls.
 */
export function detectMainOnlyBuiltInCommand(input: string): BuiltInCommand | null {
  const parsed = parseLeadingBuiltInCommand(input);
  return parsed && parsed.command.action !== 'side' ? parsed.command : null;
}

/** Whether the current provider exposes the side-chat command at all. */
export function isSideChatCommandSupported(
  context?: BuiltInCommandSupportContext,
): boolean {
  const command = commandMap.get('side');
  return Boolean(command && isBuiltInCommandSupported(command, context));
}

/**
 * Gets built-in commands for dropdown display.
 * When providerId is given, excludes commands restricted to other providers.
 */
export function getBuiltInCommandsForDropdown(context?: BuiltInCommandSupportContext): Array<{
  id: string;
  name: string;
  aliases?: readonly string[];
  description: string;
  content: string;
  argumentHint?: string;
}> {
  return BUILT_IN_COMMANDS
    .filter((cmd) => isBuiltInCommandSupported(cmd, context))
    .map((cmd) => ({
      id: `builtin:${cmd.name}`,
      name: cmd.name,
      aliases: cmd.aliases,
      description: cmd.description,
      content: '', // Built-in commands don't have prompt content
      argumentHint: cmd.argumentHint,
    }));
}

/** One token boundary for preview, reservation, and submitted command dispatch. */
function parseLeadingBuiltInCommand(input: string): {
  command: BuiltInCommand;
  alias: string;
  rawArguments: string;
} | null {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const alias = match[1].toLowerCase();
  const command = commandMap.get(alias);
  return command ? { command, alias, rawArguments: match[2] ?? '' } : null;
}
