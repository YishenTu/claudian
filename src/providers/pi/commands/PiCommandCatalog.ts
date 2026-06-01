import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
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

function dedupeRuntimeCommands(commands: SlashCommand[]): SlashCommand[] {
  const deduped: SlashCommand[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const normalizedName = command.name.trim().replace(/^\/+/, '');
    if (!normalizedName) {
      continue;
    }

    const key = normalizedName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      ...command,
      name: normalizedName,
    });
  }

  return deduped;
}

export class PiCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = dedupeRuntimeCommands(commands);
  }

  async listDropdownEntries(_context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    return this.runtimeCommands.map(slashCommandToEntry);
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    return [];
  }

  async saveVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
    throw new Error('Pi runtime commands are not editable from Claudian.');
  }

  async deleteVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
    throw new Error('Pi runtime commands are not deletable from Claudian.');
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
