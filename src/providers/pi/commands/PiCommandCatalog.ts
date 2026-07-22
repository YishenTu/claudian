import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
  ProviderCommandListContext,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';

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
    providerId: 'pi',
    scope: 'runtime',
    source: command.source ?? 'sdk',
    userInvocable: command.userInvocable,
  };
}

export class PiCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = commands.map((command) => ({ ...command }));
  }

  async listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]> {
    const commands = context.runtimeCommands
      ?? (context.allowCachedRuntimeCommands === false ? [] : this.runtimeCommands);
    return commands.map(slashCommandToEntry);
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'pi',
      skillPrefix: '/',
      triggerChars: ['/'],
    };
  }

  async refresh(): Promise<void> {}
}
