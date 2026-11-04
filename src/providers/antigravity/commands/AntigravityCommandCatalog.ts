import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

/**
 * Built-in agy commands that cannot work over ACP: `plan` enters plan mode (Claudian has none);
 * the others delegate to subagents or run later in the background, and agy streams neither back.
 */
export const ANTIGRAVITY_HIDDEN_COMMANDS: ReadonlySet<string> = new Set(['boost', 'browser', 'plan', 'schedule', 'teamwork']);

export function filterAntigravityCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter(command => !ANTIGRAVITY_HIDDEN_COMMANDS.has(command.name.toLowerCase()));
}

function slashCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    agent: command.agent,
    allowedTools: command.allowedTools,
    argumentHint: command.argumentHint,
    content: command.content,
    context: command.context,
    description: command.description,
    disableModelInvocation: command.disableModelInvocation,
    displayPrefix: '/',
    hooks: command.hooks,
    id: command.id,
    insertPrefix: '/',
    isDeletable: false,
    isEditable: false,
    kind: command.kind ?? 'command',
    model: command.model,
    name: command.name,
    providerId: 'antigravity',
    scope: 'runtime',
    source: command.source ?? 'sdk',
    userInvocable: command.userInvocable,
  };
}

export class AntigravityCommandCatalog extends RuntimeCommandCatalog {
  constructor() {
    super({
      dropdownConfig: {
        builtInPrefix: '/',
        commandPrefix: '/',
        providerId: 'antigravity',
        skillPrefix: '/',
        triggerChars: ['/'],
      },
      projectEntry: slashCommandToEntry,
    });
  }
}
