import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { CodexSkillCatalog } from '@/providers/codex/commands/CodexSkillCatalog';
import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexSkillListProvider } from '@/providers/codex/skills/CodexSkillListingService';
import {
  CodexSkillStorage,
  createCodexSkillPersistenceKey,
} from '@/providers/codex/storage/CodexSkillStorage';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    exists: jest.fn(async (path: string) => path in files || Object.keys(files).some(k => k.startsWith(path + '/'))),
    read: jest.fn(async (path: string) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      return files[path];
    }),
    write: jest.fn(),
    delete: jest.fn(),
    listFolders: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      const folders = new Set<string>();
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          if (firstSlash >= 0) {
            folders.add(prefix + rest.slice(0, firstSlash));
          }
        }
      }
      return Array.from(folders);
    }),
    listFiles: jest.fn(),
    listFilesRecursive: jest.fn(),
    ensureFolder: jest.fn(),
    rename: jest.fn(),
    append: jest.fn(),
    stat: jest.fn(),
    deleteFolder: jest.fn(),
  } as unknown as VaultFileAdapter;
}

function createMockSkillListProvider(
  skills: SkillMetadata[] = [],
): CodexSkillListProvider {
  return {
    listSkills: jest.fn().mockResolvedValue(skills),
    invalidate: jest.fn(),
  };
}

describe('CodexSkillCatalog', () => {
  describe('listDropdownEntries', () => {
    it('returns skills from app-server metadata instead of directory scans', async () => {
      const storage = new CodexSkillStorage(createMockAdapter({}), createMockAdapter({}));
      const listProvider = createMockSkillListProvider([
        {
          name: 'my-skill',
          description: 'A Codex skill',
          path: '/test/vault/.codex/skills/my-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
        {
          name: 'home-skill',
          description: 'Home skill',
          path: '/Users/test/.codex/skills/home-skill/SKILL.md',
          scope: 'user',
          enabled: true,
        },
      ]);
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(2);
      expect(entries.some(e => e.name === 'compact')).toBe(false);

      const vaultEntry = entries.find(e => e.name === 'my-skill');
      expect(vaultEntry).toBeDefined();
      expect(vaultEntry!.providerId).toBe('codex');
      expect(vaultEntry!.kind).toBe('skill');
      expect(vaultEntry!.scope).toBe('vault');
      expect(vaultEntry!.displayPrefix).toBe('$');
      expect(vaultEntry!.insertPrefix).toBe('$');
      expect(vaultEntry!.source).toBe('user');
      expect(vaultEntry!.content).toBe('');
      expect(vaultEntry!.persistenceKey).toBe(
        createCodexSkillPersistenceKey({
          rootId: 'vault-codex',
          currentName: 'my-skill',
        }),
      );
      expect(vaultEntry!.id).toBe('codex-skill-vault-codex-my-skill');

      const homeEntry = entries.find(e => e.name === 'home-skill');
      expect(homeEntry).toBeDefined();
      expect(homeEntry!.scope).toBe('user');
      expect(homeEntry!.isEditable).toBe(false);
      expect(homeEntry!.isDeletable).toBe(false);
      expect(homeEntry!.persistenceKey).toBeUndefined();
    });

    it('omits disabled skills from dropdown entries', async () => {
      const storage = new CodexSkillStorage(createMockAdapter({}), createMockAdapter({}));
      const listProvider = createMockSkillListProvider([
        {
          name: 'enabled-skill',
          description: 'Enabled',
          path: '/test/vault/.codex/skills/enabled-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
        {
          name: 'disabled-skill',
          description: 'Disabled',
          path: '/test/vault/.codex/skills/disabled-skill/SKILL.md',
          scope: 'repo',
          enabled: false,
        },
      ]);
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries.map(entry => entry.name)).toEqual(['enabled-skill']);
    });
  });

  describe('listVaultEntries', () => {
    it('returns only managed repo-level skills and loads stored content', async () => {
      const vaultAdapter = createMockAdapter({
        '.codex/skills/vault-skill/SKILL.md': `---
description: Vault
---
Prompt`,
      });
      const storage = new CodexSkillStorage(vaultAdapter, createMockAdapter({}));
      const listProvider = createMockSkillListProvider([
        {
          name: 'vault-skill',
          description: 'Vault',
          path: '/test/vault/.codex/skills/vault-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
        {
          name: 'home-skill',
          description: 'Home',
          path: '/Users/test/.codex/skills/home-skill/SKILL.md',
          scope: 'user',
          enabled: true,
        },
        {
          name: 'other-repo-skill',
          description: 'Other repo',
          path: '/test/vault/scripts/skills/other-repo-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
      ]);
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      const entries = await catalog.listVaultEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('vault-skill');
      expect(entries[0].scope).toBe('vault');
      expect(entries[0].content).toBe('Prompt');
    });

  });

  describe('saveVaultEntry', () => {
    it('saves through storage to vault .codex/skills', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const listProvider = createMockSkillListProvider();
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      await catalog.saveVaultEntry({
        id: 'codex-skill-new',
        providerId: 'codex',
        kind: 'skill',
        name: 'new-skill',
        description: 'New skill',
        content: 'Do things',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
        persistenceKey: createCodexSkillPersistenceKey({
          rootId: 'vault-codex',
          currentName: 'old-skill',
        }),
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.codex/skills/new-skill');
      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/skills/new-skill/SKILL.md',
        expect.stringContaining('Do things'),
      );
      expect(adapter.delete).toHaveBeenCalledWith('.codex/skills/old-skill/SKILL.md');
      expect(listProvider.invalidate).toHaveBeenCalled();
    });

    it('preserves .agents storage root when editing an existing .agents skill', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage, createMockSkillListProvider(), '/test/vault');

      await catalog.saveVaultEntry({
        id: 'codex-skill-agent',
        providerId: 'codex',
        kind: 'skill',
        name: 'agent',
        description: 'Agent skill',
        content: 'Do things',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
        persistenceKey: createCodexSkillPersistenceKey({
          rootId: 'vault-agents',
          currentName: 'agent',
        }),
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.agents/skills/agent');
      expect(adapter.write).toHaveBeenCalledWith(
        '.agents/skills/agent/SKILL.md',
        expect.stringContaining('Do things'),
      );
    });
  });

  describe('deleteVaultEntry', () => {
    it('deletes through storage', async () => {
      const adapter = createMockAdapter({
        '.codex/skills/target/SKILL.md': `---
description: Target
---
Prompt`,
      });
      const storage = new CodexSkillStorage(adapter);
      const listProvider = createMockSkillListProvider();
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      await catalog.deleteVaultEntry({
        id: 'codex-skill-target',
        providerId: 'codex',
        kind: 'skill',
        name: 'target',
        description: 'Target',
        content: 'Prompt',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
      });

      expect(adapter.delete).toHaveBeenCalledWith('.codex/skills/target/SKILL.md');
      expect(listProvider.invalidate).toHaveBeenCalled();
    });

    it('deletes from .agents when the persistence key points there', async () => {
      const adapter = createMockAdapter({
        '.agents/skills/target/SKILL.md': `---
description: Target
---
Prompt`,
      });
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage, createMockSkillListProvider(), '/test/vault');

      await catalog.deleteVaultEntry({
        id: 'codex-skill-target',
        providerId: 'codex',
        kind: 'skill',
        name: 'target',
        description: 'Target',
        content: 'Prompt',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
        persistenceKey: createCodexSkillPersistenceKey({
          rootId: 'vault-agents',
          currentName: 'target',
        }),
      });

      expect(adapter.delete).toHaveBeenCalledWith('.agents/skills/target/SKILL.md');
    });
  });

  describe('getDropdownConfig', () => {
    it('returns Codex-specific config with $ for skills', () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage, createMockSkillListProvider(), '/test/vault');

      const config = catalog.getDropdownConfig();

      expect(config.triggerChars).toEqual(['/', '$']);
      expect(config.builtInPrefix).toBe('/');
      expect(config.skillPrefix).toBe('$');
      expect(config.commandPrefix).toBe('/');
    });
  });

  describe('refresh', () => {
    it('forces an app-server reload instead of relying on scans', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const listProvider = createMockSkillListProvider([]);
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      await catalog.refresh();

      expect(listProvider.invalidate).toHaveBeenCalledTimes(1);
      expect(listProvider.listSkills).toHaveBeenCalledWith({ forceReload: true });
    });
  });

  describe('built-in /compact command', () => {
    it('includes /compact in dropdown entries', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage, createMockSkillListProvider(), '/test/vault');

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: true });
      const compactEntry = entries.find(e => e.name === 'compact');

      expect(compactEntry).toBeDefined();
      expect(compactEntry!.providerId).toBe('codex');
      expect(compactEntry!.kind).toBe('command');
      expect(compactEntry!.displayPrefix).toBe('/');
      expect(compactEntry!.insertPrefix).toBe('/');
      expect(compactEntry!.isEditable).toBe(false);
      expect(compactEntry!.isDeletable).toBe(false);
      expect(compactEntry!.source).toBe('builtin');
    });

    it('places /compact before scan-backed skills', async () => {
      const storage = new CodexSkillStorage(createMockAdapter({}), createMockAdapter({}));
      const listProvider = createMockSkillListProvider([
        {
          name: 'my-skill',
          description: 'A skill',
          path: '/test/vault/.codex/skills/my-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
      ]);
      const catalog = new CodexSkillCatalog(storage, listProvider, '/test/vault');

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: true });

      const compactIndex = entries.findIndex(e => e.name === 'compact');
      const skillIndex = entries.findIndex(e => e.name === 'my-skill');

      expect(compactIndex).toBeGreaterThanOrEqual(0);
      expect(skillIndex).toBeGreaterThanOrEqual(0);
      expect(compactIndex).toBeLessThan(skillIndex);
    });

    it('does not include /compact in vault entries', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage, createMockSkillListProvider(), '/test/vault');

      const entries = await catalog.listVaultEntries();
      const compactEntry = entries.find(e => e.name === 'compact');

      expect(compactEntry).toBeUndefined();
    });
  });
});
