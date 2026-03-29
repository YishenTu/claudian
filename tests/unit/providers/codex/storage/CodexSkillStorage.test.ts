import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
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
      expect(skills[0].scanRoot).toBe('.codex/skills');
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
      expect(skills[0].scanRoot).toBe('.agents/skills');
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
        scanRoot: '.agents/skills',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.agents/skills/agent-skill');
      expect(adapter.write).toHaveBeenCalledWith(
        '.agents/skills/agent-skill/SKILL.md',
        expect.stringContaining('Do the thing'),
      );
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

      await storage.delete('target');

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

      await storage.delete('target', '.agents/skills');

      expect(adapter.delete).toHaveBeenCalledWith('.agents/skills/target/SKILL.md');
      expect(adapter.deleteFolder).toHaveBeenCalledWith('.agents/skills/target');
    });
  });
});
