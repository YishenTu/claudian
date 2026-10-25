import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
  ProviderCommandListContext,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SkillMetadata } from '../runtime/codexAppServerTypes';
import {
  type CodexSkillListProvider,
  compareCodexSkillPriority,
  getCodexSkillDescription,
} from '../skills/CodexSkillListingService';

const CODEX_SKILL_ID_PREFIX = 'codex-skill-';

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

export class CodexCommandCatalog implements ProviderCommandCatalog {
  constructor(private listProvider: CodexSkillListProvider) {}

  async listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]> {
    const skills = (await this.listProvider.listSkills(
      context.signal ? { signal: context.signal } : undefined,
    ))
      .filter(skill => skill.enabled)
      .sort(compareCodexSkillPriority);
    return skills.map(listedSkillToProviderEntry);
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'codex',
      refreshOnOpen: true,
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
