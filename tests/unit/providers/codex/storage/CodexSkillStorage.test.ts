import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  CodexSkillStorage,
  createCodexSkillPersistenceKey,
  parseCodexSkillPersistenceKey,
  resolveCodexSkillLocationFromPath,
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

/** Simulates a home-level adapter with separate files. */
function createMockHomeAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return createMockAdapter(files);
}

describe('CodexSkillStorage', () => {
  describe('scanAll', () => {
    it('scans skills from vault .codex/skills', async () => {
      const vaultAdapter = createMockAdapter({
        '.codex/skills/my-skill/SKILL.md': `---
description: A Codex skill
---
Do codex things`,
      });

      const storage = new CodexSkillStorage(vaultAdapter);
      const skills = await storage.scanAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-skill');
      expect(skills[0].description).toBe('A Codex skill');
      expect(skills[0].content).toBe('Do codex things');
      expect(skills[0].provenance).toBe('vault');
      expect(skills[0].rootId).toBe('vault-codex');
    });

    it('scans skills from vault .agents/skills', async () => {
      const vaultAdapter = createMockAdapter({
        '.agents/skills/agent-skill/SKILL.md': `---
description: An agent skill
---
Agent task`,
      });

      const storage = new CodexSkillStorage(vaultAdapter);
      const skills = await storage.scanAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('agent-skill');
      expect(skills[0].provenance).toBe('vault');
      expect(skills[0].rootId).toBe('vault-agents');
    });

    it('scans skills from home .codex/skills and .agents/skills', async () => {
      const vaultAdapter = createMockAdapter({});
      const homeAdapter = createMockHomeAdapter({
        '.codex/skills/home-skill/SKILL.md': `---
description: Home codex skill
---
Home task`,
        '.agents/skills/home-agent/SKILL.md': `---
description: Home agent skill
---
Home agent task`,
      });

      const storage = new CodexSkillStorage(vaultAdapter, homeAdapter);
      const skills = await storage.scanAll();

      expect(skills).toHaveLength(2);
      expect(skills.every(s => s.provenance === 'home')).toBe(true);
    });

    it('deduplicates by name with vault taking priority over home', async () => {
      const vaultAdapter = createMockAdapter({
        '.codex/skills/shared/SKILL.md': `---
description: Vault version
---
Vault prompt`,
      });
      const homeAdapter = createMockHomeAdapter({
        '.codex/skills/shared/SKILL.md': `---
description: Home version
---
Home prompt`,
      });

      const storage = new CodexSkillStorage(vaultAdapter, homeAdapter);
      const skills = await storage.scanAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].provenance).toBe('vault');
      expect(skills[0].description).toBe('Vault version');
    });

    it('returns empty array when no directories exist', async () => {
      const vaultAdapter = createMockAdapter({});
      (vaultAdapter.exists as jest.Mock).mockResolvedValue(false);

      const storage = new CodexSkillStorage(vaultAdapter);
      const skills = await storage.scanAll();

      expect(skills).toEqual([]);
    });
  });

  describe('scanVault', () => {
    it('returns only vault-level skills', async () => {
      const vaultAdapter = createMockAdapter({
        '.codex/skills/vault-skill/SKILL.md': `---
description: Vault skill
---
Task`,
      });
      const homeAdapter = createMockHomeAdapter({
        '.codex/skills/home-skill/SKILL.md': `---
description: Home skill
---
Task`,
      });

      const storage = new CodexSkillStorage(vaultAdapter, homeAdapter);
      const vaultSkills = await storage.scanVault();

      expect(vaultSkills).toHaveLength(1);
      expect(vaultSkills[0].name).toBe('vault-skill');
      expect(vaultSkills[0].provenance).toBe('vault');
    });
  });

  describe('save', () => {
    it('saves to vault .codex/skills/{name}/SKILL.md', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);

      await storage.save({
        name: 'new-skill',
        description: 'A new skill',
        content: 'Do the thing',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.codex/skills/new-skill');
      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/skills/new-skill/SKILL.md',
        expect.stringContaining('A new skill'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.codex/skills/new-skill/SKILL.md',
        expect.stringContaining('Do the thing'),
      );
    });

    it('preserves the original root when saving an .agents skill', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);

      await storage.save({
        name: 'agent-skill',
        description: 'Agent skill',
        content: 'Do the thing',
        rootId: 'vault-agents',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.agents/skills/agent-skill');
      expect(adapter.write).toHaveBeenCalledWith(
        '.agents/skills/agent-skill/SKILL.md',
        expect.stringContaining('Do the thing'),
      );
    });
  });

  describe('load', () => {
    it('loads a managed vault skill by location', async () => {
      const adapter = createMockAdapter({
        '.agents/skills/agent-skill/SKILL.md': `---
description: Agent skill
---
Do the thing`,
      });
      const storage = new CodexSkillStorage(adapter);

      const skill = await storage.load({ name: 'agent-skill', rootId: 'vault-agents' });

      expect(skill).toEqual({
        name: 'agent-skill',
        description: 'Agent skill',
        content: 'Do the thing',
        provenance: 'vault',
        rootId: 'vault-agents',
      });
    });

    it('returns null when the skill file is missing', async () => {
      const storage = new CodexSkillStorage(createMockAdapter({}));

      await expect(
        storage.load({ name: 'missing-skill', rootId: 'vault-codex' }),
      ).resolves.toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes from vault .codex/skills/{name}', async () => {
      const adapter = createMockAdapter({
        '.codex/skills/target/SKILL.md': `---
description: Target
---
Prompt`,
      });
      const storage = new CodexSkillStorage(adapter);

      await storage.delete({ name: 'target', rootId: 'vault-codex' });

      expect(adapter.delete).toHaveBeenCalledWith('.codex/skills/target/SKILL.md');
      expect(adapter.deleteFolder).toHaveBeenCalledWith('.codex/skills/target');
    });

    it('deletes from the provided .agents root when requested', async () => {
      const adapter = createMockAdapter({
        '.agents/skills/target/SKILL.md': `---
description: Target
---
Prompt`,
      });
      const storage = new CodexSkillStorage(adapter);

      await storage.delete({ name: 'target', rootId: 'vault-agents' });

      expect(adapter.delete).toHaveBeenCalledWith('.agents/skills/target/SKILL.md');
      expect(adapter.deleteFolder).toHaveBeenCalledWith('.agents/skills/target');
    });

    it('removes the previous directory after a rename', async () => {
      const adapter = createMockAdapter({});
      const storage = new CodexSkillStorage(adapter);

      await storage.save({
        name: 'renamed-skill',
        description: 'Updated',
        content: 'Prompt',
        rootId: 'vault-agents',
        previousLocation: {
          name: 'original-skill',
          rootId: 'vault-codex',
        },
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.agents/skills/renamed-skill/SKILL.md',
        expect.any(String),
      );
      expect(adapter.delete).toHaveBeenCalledWith('.codex/skills/original-skill/SKILL.md');
      expect(adapter.deleteFolder).toHaveBeenCalledWith('.codex/skills/original-skill');
    });
  });

  describe('persistence keys', () => {
    it('round-trips root identity and current name', () => {
      const key = createCodexSkillPersistenceKey({
        rootId: 'vault-agents',
        currentName: 'my-skill',
      });

      expect(parseCodexSkillPersistenceKey(key)).toEqual({
        rootId: 'vault-agents',
        currentName: 'my-skill',
      });
    });

    it('parses legacy raw-root persistence keys', () => {
      expect(parseCodexSkillPersistenceKey('.codex/skills')).toEqual({
        rootId: 'vault-codex',
      });
    });
  });

  describe('resolveCodexSkillLocationFromPath', () => {
    it('resolves .codex skill paths inside the vault', () => {
      expect(
        resolveCodexSkillLocationFromPath(
          '/test/vault/.codex/skills/review/SKILL.md',
          '/test/vault',
        ),
      ).toEqual({
        name: 'review',
        rootId: 'vault-codex',
      });
    });

    it('resolves .agents skill paths inside the vault', () => {
      expect(
        resolveCodexSkillLocationFromPath(
          '/test/vault/.agents/skills/review/SKILL.md',
          '/test/vault',
        ),
      ).toEqual({
        name: 'review',
        rootId: 'vault-agents',
      });
    });

    it('returns null for unmanaged skill paths', () => {
      expect(
        resolveCodexSkillLocationFromPath(
          '/test/vault/scripts/skills/review/SKILL.md',
          '/test/vault',
        ),
      ).toBeNull();
    });
  });
});
