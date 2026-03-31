import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import type { CodexSkillEntry, CodexSkillStorage } from '../storage/CodexSkillStorage';

const CODEX_SKILL_ID_PREFIX = 'codex-skill-';

const CODEX_COMPACT_COMMAND: ProviderCommandEntry = {
  id: 'codex-builtin-compact',
  providerId: 'codex',
  kind: 'command',
  name: 'compact',
  description: 'Compact conversation history',
  content: '',
  scope: 'system',
  source: 'builtin',
  isEditable: false,
  isDeletable: false,
  displayPrefix: '/',
  insertPrefix: '/',
};

function buildSkillId(skill: CodexSkillEntry): string {
  const rootKey = skill.scanRoot
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${CODEX_SKILL_ID_PREFIX}${rootKey}-${skill.name}`;
}

function skillEntryToProviderEntry(skill: CodexSkillEntry): ProviderCommandEntry {
  const isVault = skill.provenance === 'vault';
  return {
    id: buildSkillId(skill),
    providerId: 'codex',
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    content: skill.content,
    scope: isVault ? 'vault' : 'user',
    source: 'user',
    isEditable: isVault,
    isDeletable: isVault,
    displayPrefix: '$',
    insertPrefix: '$',
    persistenceKey: skill.scanRoot,
  };
}

export class CodexSkillCatalog implements ProviderCommandCatalog {
  constructor(private storage: CodexSkillStorage) {}

  setRuntimeCommands(_commands: SlashCommand[]): void {
    // Codex dropdown entries are scan-backed; runtime commands are ignored.
  }

  async listDropdownEntries(_context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    const skills = await this.storage.scanAll();
    return [CODEX_COMPACT_COMMAND, ...skills.map(skillEntryToProviderEntry)];
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    const skills = await this.storage.scanVault();
    return skills.map(skillEntryToProviderEntry);
  }

  async saveVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    await this.storage.save({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      scanRoot: entry.persistenceKey,
    });
  }

  async deleteVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    await this.storage.delete(entry.name, entry.persistenceKey);
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'codex',
      triggerChars: ['/', '$'],
      builtInPrefix: '/',
      skillPrefix: '$',
      commandPrefix: '/',
    };
  }

  async refresh(): Promise<void> {
    // Scan-backed: no-op; next list call re-scans
  }
}
