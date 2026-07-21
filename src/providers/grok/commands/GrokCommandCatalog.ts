import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
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

function dedupeRuntimeCommands(commands: SlashCommand[]): SlashCommand[] {
  const deduped: SlashCommand[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const normalizedName = command.name.trim().replace(/^\/+/, '');
    if (!normalizedName) continue;

    const key = normalizedName.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push({
      ...command,
      name: normalizedName,
    });
  }

  return deduped;
}

export class GrokCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = dedupeRuntimeCommands(commands);
  }

  async listDropdownEntries(
    _context: { includeBuiltIns: boolean },
  ): Promise<ProviderCommandEntry[]> {
    return this.runtimeCommands.map(slashCommandToEntry);
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    return [];
  }

  async saveVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
    throw new Error('Grok runtime commands are not editable from Claudian.');
  }

  async deleteVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
    throw new Error('Grok runtime commands are not deletable from Claudian.');
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
