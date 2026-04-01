import * as path from 'path';

import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { parseSlashCommandContent, serializeSlashCommandMarkdown } from '../../../utils/slashCommand';

export const CODEX_VAULT_SKILLS_PATH = '.codex/skills';
export const AGENTS_VAULT_SKILLS_PATH = '.agents/skills';

export type CodexSkillRootId = 'vault-codex' | 'vault-agents';

export const CODEX_SKILL_ROOT_OPTIONS = [
  { id: 'vault-codex' as const, label: CODEX_VAULT_SKILLS_PATH },
  { id: 'vault-agents' as const, label: AGENTS_VAULT_SKILLS_PATH },
];

const ROOT_PATH_BY_ID: Record<CodexSkillRootId, string> = {
  'vault-codex': CODEX_VAULT_SKILLS_PATH,
  'vault-agents': AGENTS_VAULT_SKILLS_PATH,
};

const ROOT_ID_BY_PATH = new Map<string, CodexSkillRootId>(
  Object.entries(ROOT_PATH_BY_ID).map(([rootId, rootPath]) => [rootPath, rootId as CodexSkillRootId]),
);

const ALL_SCAN_ROOTS: CodexSkillRootId[] = ['vault-codex', 'vault-agents'];
const SKILL_PERSISTENCE_PREFIX = 'codex-skill';

export type CodexSkillStorageAdapter = Pick<
  VaultFileAdapter,
  'read' | 'write' | 'delete' | 'deleteFolder' | 'listFolders' | 'ensureFolder'
>;

export interface CodexSkillEntry {
  name: string;
  description?: string;
  content: string;
  provenance: 'vault' | 'home';
  rootId: CodexSkillRootId;
}

export interface CodexSkillLocation {
  name: string;
  rootId: CodexSkillRootId;
}

export interface CodexSkillSaveInput {
  name: string;
  description?: string;
  content: string;
  rootId?: CodexSkillRootId;
  previousLocation?: CodexSkillLocation;
}

export interface CodexSkillPersistenceState {
  rootId: CodexSkillRootId;
  currentName?: string;
}

export function createCodexSkillPersistenceKey(
  state: CodexSkillPersistenceState,
): string {
  const parts = [SKILL_PERSISTENCE_PREFIX, state.rootId];
  if (state.currentName) {
    parts.push(encodeURIComponent(state.currentName));
  }
  return parts.join(':');
}

export function parseCodexSkillPersistenceKey(
  persistenceKey?: string,
): CodexSkillPersistenceState | null {
  if (!persistenceKey) {
    return null;
  }

  const legacyRootId = ROOT_ID_BY_PATH.get(persistenceKey);
  if (legacyRootId) {
    return { rootId: legacyRootId };
  }

  const [prefix, rootId, encodedName] = persistenceKey.split(':');
  if (prefix !== SKILL_PERSISTENCE_PREFIX) {
    return null;
  }
  if (rootId !== 'vault-codex' && rootId !== 'vault-agents') {
    return null;
  }

  return {
    rootId,
    ...(encodedName ? { currentName: decodeURIComponent(encodedName) } : {}),
  };
}

export function resolveCodexSkillLocationFromPath(
  skillPath: string,
  vaultPath: string,
): CodexSkillLocation | null {
  const normalizedSkillPath = path.normalize(skillPath);
  const normalizedVaultPath = path.normalize(vaultPath);

  for (const [rootId, rootPath] of Object.entries(ROOT_PATH_BY_ID) as Array<[CodexSkillRootId, string]>) {
    const rootDir = path.normalize(path.join(normalizedVaultPath, rootPath));
    const relative = path.relative(rootDir, normalizedSkillPath);

    if (
      !relative
      || relative.startsWith(`..${path.sep}`)
      || relative === '..'
    ) {
      continue;
    }

    const parts = relative.split(path.sep);
    if (parts.length !== 2 || parts[1] !== 'SKILL.md' || !parts[0]) {
      continue;
    }

    return {
      name: parts[0],
      rootId,
    };
  }

  return null;
}

export class CodexSkillStorage {
  constructor(
    private vaultAdapter: CodexSkillStorageAdapter,
    private homeAdapter?: CodexSkillStorageAdapter,
  ) {}

  async scanAll(): Promise<CodexSkillEntry[]> {
    const vaultSkills = await this.scanRoots(this.vaultAdapter, ALL_SCAN_ROOTS, 'vault');
    const homeSkills = this.homeAdapter
      ? await this.scanRoots(this.homeAdapter, ALL_SCAN_ROOTS, 'home')
      : [];

    // Deduplicate: vault takes priority over home
    const seen = new Set(vaultSkills.map(s => s.name.toLowerCase()));
    const deduped = homeSkills.filter(s => !seen.has(s.name.toLowerCase()));

    return [...vaultSkills, ...deduped];
  }

  async scanVault(): Promise<CodexSkillEntry[]> {
    return this.scanRoots(this.vaultAdapter, ALL_SCAN_ROOTS, 'vault');
  }

  async save(input: CodexSkillSaveInput): Promise<void> {
    const targetRootId = input.rootId ?? 'vault-codex';
    const targetLocation = { rootId: targetRootId, name: input.name };
    const { dirPath, filePath } = this.buildLocationPaths(targetLocation);
    const previousLocation = input.previousLocation;

    await this.vaultAdapter.ensureFolder(dirPath);
    const markdown = serializeSlashCommandMarkdown(
      { name: input.name, description: input.description },
      input.content,
    );
    await this.vaultAdapter.write(filePath, markdown);

    if (
      previousLocation
      && (previousLocation.rootId !== targetRootId || previousLocation.name !== input.name)
    ) {
      await this.delete(previousLocation);
    }
  }

  async delete(location: CodexSkillLocation): Promise<void> {
    const { dirPath, filePath } = this.buildLocationPaths(location);
    await this.vaultAdapter.delete(filePath);
    await this.vaultAdapter.deleteFolder(dirPath);
  }

  async load(location: CodexSkillLocation): Promise<CodexSkillEntry | null> {
    const { filePath } = this.buildLocationPaths(location);

    try {
      const content = await this.vaultAdapter.read(filePath);
      const parsed = parseSlashCommandContent(content);

      return {
        name: location.name,
        description: parsed.description,
        content: parsed.promptContent,
        provenance: 'vault',
        rootId: location.rootId,
      };
    } catch {
      return null;
    }
  }

  private async scanRoots(
    adapter: CodexSkillStorageAdapter,
    roots: CodexSkillRootId[],
    provenance: 'vault' | 'home',
  ): Promise<CodexSkillEntry[]> {
    const results: CodexSkillEntry[] = [];

    for (const rootId of roots) {
      const rootPath = ROOT_PATH_BY_ID[rootId];
      try {
        const folders = await adapter.listFolders(rootPath);
        for (const folder of folders) {
          const skillName = folder.split('/').pop()!;
          const skillPath = `${rootPath}/${skillName}/SKILL.md`;

          try {
            const content = await adapter.read(skillPath);
            const parsed = parseSlashCommandContent(content);

            results.push({
              name: skillName,
              description: parsed.description,
              content: parsed.promptContent,
              provenance,
              rootId,
            });
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Root doesn't exist or can't be read
      }
    }

    return results;
  }

  private buildLocationPaths(location: CodexSkillLocation): { dirPath: string; filePath: string } {
    const rootPath = ROOT_PATH_BY_ID[location.rootId];
    const dirPath = `${rootPath}/${location.name}`;
    return {
      dirPath,
      filePath: `${dirPath}/SKILL.md`,
    };
  }
}
