import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import type { SkillMetadata } from '../runtime/codexAppServerTypes';
import {
  type CodexSkillListProvider,
  compareCodexSkillPriority,
  getCodexSkillDescription,
} from '../skills/CodexSkillListingService';

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

function buildSkillId(skill: Pick<SkillMetadata, 'path' | 'scope'>): string {
  const encodedPath = encodeURIComponent(skill.path);
  return `${CODEX_SKILL_ID_PREFIX}${skill.scope}-${encodedPath}`;
}

function listedSkillToProviderEntry(skill: SkillMetadata): ProviderCommandEntry {
  return {
    id: buildSkillId(skill),
    providerId: 'codex',
    kind: 'skill',
    name: skill.name,
    description: getCodexSkillDescription(skill),
    content: '',
    scope: skill.scope === 'repo' ? 'vault' : 'user',
    source: 'user',
    isEditable: false,
    isDeletable: false,
    displayPrefix: '$',
    insertPrefix: '$',
  };
}

export class CodexSkillCatalog implements ProviderCommandCatalog {
  constructor(private listProvider: CodexSkillListProvider) {}

  setRuntimeCommands(_commands: SlashCommand[]): void {
    // Codex dropdown entries come from app-server metadata; runtime commands are ignored.
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    const skills = (await this.listProvider.listSkills())
      .filter(skill => skill.enabled)
      .sort(compareCodexSkillPriority);
    const entries = skills.map(listedSkillToProviderEntry);
    return context.includeBuiltIns ? [CODEX_COMPACT_COMMAND, ...entries] : entries;
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
    this.listProvider.invalidate();
    await this.listProvider.listSkills({ forceReload: true });
  }
}
