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
    providerId: 'qoder',
    scope: 'runtime',
    source: command.source ?? 'sdk',
    userInvocable: command.userInvocable,
  };
}

function skillToEntry(skill: string): ProviderCommandEntry {
  return {
    content: '',
    description: `Qoder skill: ${skill}`,
    displayPrefix: '$',
    id: `qoder:skill:${skill}`,
    insertPrefix: '$',
    isDeletable: false,
    isEditable: false,
    kind: 'skill',
    name: skill,
    providerId: 'qoder',
    scope: 'runtime',
    source: 'sdk',
  };
}

export class QoderCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  constructor(private readonly getSkills: () => readonly string[]) {}

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = commands.map(command => ({ ...command }));
  }

  async listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]> {
    const commands = context.runtimeCommands
      ?? (context.allowCachedRuntimeCommands === false ? [] : this.runtimeCommands);
    const commandEntries = commands.map(slashCommandToEntry);
    const skillEntries = this.getSkills().map(skillToEntry);
    return context.includeBuiltIns
      ? [...commandEntries, ...skillEntries]
      : skillEntries;
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'qoder',
      skillPrefix: '$',
      triggerChars: ['/', '$'],
    };
  }

  async refresh(): Promise<void> {}
}
