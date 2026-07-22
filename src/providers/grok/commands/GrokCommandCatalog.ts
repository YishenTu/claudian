import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
  ProviderCommandListContext,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';

function slashCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    id: command.id,
    providerId: 'grok',
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

export class GrokCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = commands.map(command => ({ ...command }));
  }

  async listDropdownEntries(
    context: ProviderCommandListContext,
  ): Promise<ProviderCommandEntry[]> {
    const commands = context.runtimeCommands
      ?? (context.allowCachedRuntimeCommands === false ? [] : this.runtimeCommands);
    return commands.map(slashCommandToEntry);
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'grok',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '/',
      commandPrefix: '/',
    };
  }

  async refresh(): Promise<void> {}
}
