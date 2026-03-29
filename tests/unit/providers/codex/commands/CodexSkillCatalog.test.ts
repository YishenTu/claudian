import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { CodexSkillCatalog } from '@/providers/codex/commands/CodexSkillCatalog';
import { CodexSkillStorage } from '@/providers/codex/storage/CodexSkillStorage';

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

describe('CodexSkillCatalog', () => {
  describe('listDropdownEntries', () => {
    it('returns scan-backed entries without runtime dependency', async () => {
      const vaultAdapter = createMockAdapter({
        '.codex/skills/my-skill/SKILL.md': `---
description: A Codex skill
---
Do codex things`,
      });
      const homeAdapter = createMockAdapter({
        '.codex/skills/home-skill/SKILL.md': `---
description: Home skill
---
Home task`,
      });

      const storage = new CodexSkillStorage(vaultAdapter, homeAdapter);
      const catalog = new CodexSkillCatalog(storage);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(2);

      const vaultEntry = entries.find(e => e.name === 'my-skill');
      expect(vaultEntry).toBeDefined();
      expect(vaultEntry!.providerId).toBe('codex');
      expect(vaultEntry!.kind).toBe('skill');
      expect(vaultEntry!.scope).toBe('vault');
      expect(vaultEntry!.displayPrefix).toBe('$');
      expect(vaultEntry!.insertPrefix).toBe('$');
      expect(vaultEntry!.source).toBe('user');
      expect(vaultEntry!.persistenceKey).toBe('.codex/skills');
      expect(vaultEntry!.id).toBe('codex-skill-codex-skills-my-skill');

      const homeEntry = entries.find(e => e.name === 'home-skill');
      expect(homeEntry).toBeDefined();
      expect(homeEntry!.scope).toBe('user');
      expect(homeEntry!.isEditable).toBe(false);
      expect(homeEntry!.isDeletable).toBe(false);
      expect(homeEntry!.persistenceKey).toBe('.codex/skills');
      expect(homeEntry!.id).toBe('codex-skill-codex-skills-home-skill');
    });
  });

  describe('listVaultEntries', () => {
    it('returns only vault-level skills', async () => {
      const vaultAdapter = createMockAdapter({
        '.codex/skills/vault-skill/SKILL.md': `---
description: Vault
---
Prompt`,
      });
      const homeAdapter = createMockAdapter({
        '.codex/skills/home-skill/SKILL.md': `---
description: Home
---
Prompt`,
      });

      const storage = new CodexSkillStorage(vaultAdapter, homeAdapter);
      const catalog = new CodexSkillCatalog(storage);

      const entries = await catalog.listVaultEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('vault-skill');
      expect(entries[0].scope).toBe('vault');
    });
  });

  describe('saveVaultEntry', () => {
    it('saves through storage to vault .codex/skills', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage);

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
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.codex/skills/new-skill');
      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/skills/new-skill/SKILL.md',
        expect.stringContaining('Do things'),
      );
    });

    it('preserves .agents storage root when editing an existing .agents skill', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage);

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
        persistenceKey: '.agents/skills',
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
      const catalog = new CodexSkillCatalog(storage);

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
    });

    it('deletes from .agents when the persistence key points there', async () => {
      const adapter = createMockAdapter({
        '.agents/skills/target/SKILL.md': `---
description: Target
---
Prompt`,
      });
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage);

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
        persistenceKey: '.agents/skills',
      });

      expect(adapter.delete).toHaveBeenCalledWith('.agents/skills/target/SKILL.md');
    });
  });

  describe('getDropdownConfig', () => {
    it('returns Codex-specific config with $ for skills', () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);
      const catalog = new CodexSkillCatalog(storage);

      const config = catalog.getDropdownConfig();

      expect(config.triggerChars).toEqual(['/', '$']);
      expect(config.builtInPrefix).toBe('/');
      expect(config.skillPrefix).toBe('$');
      expect(config.commandPrefix).toBe('/');
    });
  });
});
