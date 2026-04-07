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
import {
  type CodexSkillStorage,
  createCodexSkillPersistenceKey,
  parseCodexSkillPersistenceKey,
  resolveCodexSkillLocationFromPath,
} from '../storage/CodexSkillStorage';

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

function buildSkillId(
  skill: Pick<SkillMetadata, 'name' | 'path' | 'scope'>,
  location?: { rootId: string; name: string } | null,
): string {
  if (location) {
    return `${CODEX_SKILL_ID_PREFIX}${location.rootId}-${location.name}`;
  }

  const encodedPath = encodeURIComponent(skill.path);
  return `${CODEX_SKILL_ID_PREFIX}${skill.scope}-${encodedPath}`;
}

function listedSkillToProviderEntry(
  skill: SkillMetadata,
  vaultPath: string | null,
): ProviderCommandEntry {
  const location = vaultPath ? resolveCodexSkillLocationFromPath(skill.path, vaultPath) : null;
  const isVault = skill.scope === 'repo' && location !== null;

  return {
    id: buildSkillId(skill, isVault ? location : null),
    providerId: 'codex',
    kind: 'skill',
    name: skill.name,
    description: getCodexSkillDescription(skill),
    content: '',
    scope: isVault ? 'vault' : 'user',
    source: 'user',
    isEditable: isVault,
    isDeletable: isVault,
    displayPrefix: '$',
    insertPrefix: '$',
    ...(isVault
      ? {
          persistenceKey: createCodexSkillPersistenceKey({
            rootId: location!.rootId,
            currentName: location!.name,
          }),
        }
      : {}),
  };
}

export class CodexSkillCatalog implements ProviderCommandCatalog {
  constructor(
    private storage: CodexSkillStorage,
    private listProvider: CodexSkillListProvider,
    private vaultPath: string | null,
  ) {}

  setRuntimeCommands(_commands: SlashCommand[]): void {
    // Codex dropdown entries come from app-server metadata; runtime commands are ignored.
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    const skills = (await this.listProvider.listSkills())
      .filter(skill => skill.enabled)
      .sort(compareCodexSkillPriority);
    const entries = skills.map(skill => listedSkillToProviderEntry(skill, this.vaultPath));
    return context.includeBuiltIns ? [CODEX_COMPACT_COMMAND, ...entries] : entries;
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    if (!this.vaultPath) {
      return [];
    }

    const listedSkills = (await this.listProvider.listSkills())
      .filter(skill => skill.scope === 'repo')
      .sort(compareCodexSkillPriority);
    const entries: ProviderCommandEntry[] = [];

    for (const listedSkill of listedSkills) {
      const location = resolveCodexSkillLocationFromPath(listedSkill.path, this.vaultPath);
      if (!location) {
        continue;
      }

      const storedSkill = await this.storage.load(location);
      if (!storedSkill) {
        continue;
      }

      entries.push({
        id: `${CODEX_SKILL_ID_PREFIX}${location.rootId}-${storedSkill.name}`,
        providerId: 'codex',
        kind: 'skill',
        name: storedSkill.name,
        description: storedSkill.description ?? getCodexSkillDescription(listedSkill),
        content: storedSkill.content,
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
        persistenceKey: createCodexSkillPersistenceKey({
          rootId: location.rootId,
          currentName: location.name,
        }),
      });
    }

    return entries;
  }

  async saveVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const persistenceState = parseCodexSkillPersistenceKey(entry.persistenceKey);
    await this.storage.save({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      rootId: persistenceState?.rootId,
      previousLocation: persistenceState?.currentName
        ? { rootId: persistenceState.rootId, name: persistenceState.currentName }
        : undefined,
    });
    this.listProvider.invalidate();
  }

  async deleteVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const persistenceState = parseCodexSkillPersistenceKey(entry.persistenceKey);
    await this.storage.delete({
      name: persistenceState?.currentName ?? entry.name,
      rootId: persistenceState?.rootId ?? 'vault-codex',
    });
    this.listProvider.invalidate();
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
