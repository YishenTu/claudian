import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import { isSkill } from '../../../utils/slashCommand';
import type { SkillStorage } from '../storage/SkillStorage';
import type { SlashCommandStorage } from '../storage/SlashCommandStorage';

function slashCommandToEntry(cmd: SlashCommand): ProviderCommandEntry {
  const skill = isSkill(cmd);
  return {
    id: cmd.id,
    providerId: 'claude',
    kind: skill ? 'skill' : 'command',
    name: cmd.name,
    description: cmd.description,
    content: cmd.content,
    argumentHint: cmd.argumentHint,
    allowedTools: cmd.allowedTools,
    model: cmd.model,
    disableModelInvocation: cmd.disableModelInvocation,
    userInvocable: cmd.userInvocable,
    context: cmd.context,
    agent: cmd.agent,
    hooks: cmd.hooks,
    scope: cmd.source === 'sdk' ? 'runtime' : 'vault',
    source: cmd.source ?? 'user',
    isEditable: cmd.source !== 'sdk',
    isDeletable: cmd.source !== 'sdk',
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

function entryToSlashCommand(entry: ProviderCommandEntry): SlashCommand {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    content: entry.content,
    argumentHint: entry.argumentHint,
    allowedTools: entry.allowedTools,
    model: entry.model,
    disableModelInvocation: entry.disableModelInvocation,
    userInvocable: entry.userInvocable,
    context: entry.context,
    agent: entry.agent,
    hooks: entry.hooks,
    source: entry.source,
    kind: entry.kind,
  };
}

export class ClaudeCommandCatalog implements ProviderCommandCatalog {
  private sdkCommands: SlashCommand[] = [];

  constructor(
    private commandStorage: SlashCommandStorage,
    private skillStorage: SkillStorage,
  ) {}

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.sdkCommands = commands;
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    void context;
    const commands = await this.commandStorage.loadAll();
    const skills = await this.skillStorage.loadAll();
    const vaultEntries = [...commands, ...skills].map(slashCommandToEntry);
    const sdkEntries = this.sdkCommands.map(slashCommandToEntry);

    // Deduplicate: vault entries take priority over SDK entries
    const seen = new Set(vaultEntries.map(e => e.name.toLowerCase()));
    const deduped = sdkEntries.filter(e => !seen.has(e.name.toLowerCase()));

    return [...vaultEntries, ...deduped];
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    const commands = await this.commandStorage.loadAll();
    const skills = await this.skillStorage.loadAll();
    return [...commands, ...skills].map(slashCommandToEntry);
  }

  async saveVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const cmd = entryToSlashCommand(entry);
    if (entry.kind === 'skill') {
      await this.skillStorage.save(cmd);
    } else {
      await this.commandStorage.save(cmd);
    }
  }

  async deleteVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    if (entry.kind === 'skill') {
      await this.skillStorage.delete(entry.id);
    } else {
      await this.commandStorage.delete(entry.id);
    }
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'claude',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '/',
      commandPrefix: '/',
    };
  }

  async refresh(): Promise<void> {
    // Claude revalidation happens externally via setRuntimeCommands
  }
}
