import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

function slashCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    id: command.id,
    providerId: 'antigravity',
    kind: 'command',
    name: command.name,
    description: command.description,
    content: command.content,
    argumentHint: command.argumentHint,
    allowedTools: command.allowedTools,
    model: command.model,
    disableModelInvocation: command.disableModelInvocation,
    userInvocable: command.userInvocable,
    context: command.context,
    agent: command.agent,
    hooks: command.hooks,
    scope: 'runtime',
    source: command.source ?? 'sdk',
    isEditable: false,
    isDeletable: false,
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

export const BUILT_IN_ANTIGRAVITY_COMMANDS: SlashCommand[] = [
  {
    id: 'antigravity:plan',
    name: 'plan',
    description: 'Plan carefully before executing a task (generates an implementation plan artifact and awaits user approval)',
    content: '/plan',
    kind: 'command',
    source: 'builtin',
  },
  {
    id: 'antigravity:logout',
    name: 'logout',
    description: 'Log out and clear stored credentials',
    content: '/logout',
    kind: 'command',
    source: 'builtin',
  },
];

export class AntigravityCommandCatalog extends RuntimeCommandCatalog {
  constructor() {
    super({
      dropdownConfig: {
        builtInPrefix: '/',
        commandPrefix: '/',
        discoveryTimeoutMs: 3000,
        providerId: 'antigravity',
        skillPrefix: '/',
        triggerChars: ['/'],
      },
      projectEntry: slashCommandToEntry,
    });
    this.setCommandSnapshot(BUILT_IN_ANTIGRAVITY_COMMANDS);
  }
}
