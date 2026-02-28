import * as fs from 'fs';

import { GLOBAL_SKILLS_DIR, SKILLS_PATH, SkillStorage } from '@/core/storage/SkillStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

jest.mock('fs');
const fsMock = fs as jest.Mocked<typeof fs>;

// Helper to build a dirent-like object
function makeDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as unknown as fs.Dirent;
}

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  const mockAdapter = {
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
  return mockAdapter;
}

describe('SkillStorage', () => {
  beforeEach(() => {
    // Clear call counts and reset default implementations between tests
    jest.clearAllMocks();
    // Default: global skills dir does not exist (isolates legacy tests)
    fsMock.existsSync.mockReturnValue(false);
    (fsMock.readdirSync as jest.Mock).mockReturnValue([]);
  });

  it('exports SKILLS_PATH', () => {
    expect(SKILLS_PATH).toBe('.claude/skills');
  });

  it('exports GLOBAL_SKILLS_DIR', () => {
    expect(GLOBAL_SKILLS_DIR).toContain('.claude');
    expect(GLOBAL_SKILLS_DIR).toContain('skills');
  });

  describe('loadAll', () => {
    it('loads skills from subdirectories with SKILL.md', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/my-skill/SKILL.md': `---
description: A helpful skill
userInvocable: true
---
Do the thing`,
      });
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('skill-my-skill');
      expect(skills[0].name).toBe('my-skill');
      expect(skills[0].description).toBe('A helpful skill');
      expect(skills[0].userInvocable).toBe(true);
      expect(skills[0].content).toBe('Do the thing');
      expect(skills[0].source).toBe('user');
    });

    it('loads multiple skills', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/skill-a/SKILL.md': `---
description: Skill A
---
Prompt A`,
        '.claude/skills/skill-b/SKILL.md': `---
description: Skill B
disableModelInvocation: true
---
Prompt B`,
      });
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name).sort()).toEqual(['skill-a', 'skill-b']);
    });

    it('skips folders without SKILL.md', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/has-skill/SKILL.md': `---
description: Valid
---
Prompt`,
        '.claude/skills/no-skill/README.md': 'Just a readme',
      });
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('has-skill');
    });

    it('returns empty array when skills directory does not exist', async () => {
      const adapter = createMockAdapter({});
      (adapter.exists as jest.Mock).mockResolvedValue(false);
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toEqual([]);
    });

    it('returns empty array when listFolders throws an error', async () => {
      const adapter = createMockAdapter({});
      (adapter.listFolders as jest.Mock).mockRejectedValue(new Error('Permission denied'));
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toEqual([]);
    });

    it('skips malformed skill and continues loading valid ones', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/good/SKILL.md': `---
description: Valid
---
Prompt`,
        '.claude/skills/bad/SKILL.md': 'content',
      });
      const originalRead = adapter.read as jest.Mock;
      const originalImpl = originalRead.getMockImplementation()!;
      originalRead.mockImplementation(async (p: string) => {
        if (p.includes('bad')) throw new Error('Corrupt file');
        return originalImpl(p);
      });
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('good');
    });

    it('parses all skill frontmatter fields', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/full/SKILL.md': `---
description: Full skill
disableModelInvocation: true
userInvocable: true
context: fork
agent: code-reviewer
model: sonnet
allowed-tools:
  - Read
  - Grep
---
Full prompt`,
      });
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(1);
      const skill = skills[0];
      expect(skill.description).toBe('Full skill');
      expect(skill.disableModelInvocation).toBe(true);
      expect(skill.userInvocable).toBe(true);
      expect(skill.context).toBe('fork');
      expect(skill.agent).toBe('code-reviewer');
      expect(skill.model).toBe('sonnet');
      expect(skill.allowedTools).toEqual(['Read', 'Grep']);
      expect(skill.content).toBe('Full prompt');
    });

    it('loads skills without frontmatter as content-only', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/valid/SKILL.md': `---
description: Valid
---
Prompt`,
        '.claude/skills/invalid/SKILL.md': 'No frontmatter at all',
      });
      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      // Invalid skill has no frontmatter but still loads (content only)
      expect(skills).toHaveLength(2);
    });
  });

  describe('save', () => {
    it('writes skill to correct path', async () => {
      const adapter = createMockAdapter({});
      const storage = new SkillStorage(adapter);

      await storage.save({
        id: 'skill-my-skill',
        name: 'my-skill',
        description: 'A skill',
        content: 'Do the thing',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.claude/skills/my-skill');
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/my-skill/SKILL.md',
        expect.stringContaining('description: A skill')
      );
    });

    it('serializes hooks field', async () => {
      const adapter = createMockAdapter({});
      const storage = new SkillStorage(adapter);
      const hooks = { PreToolUse: [{ matcher: 'Bash' }] };

      await storage.save({
        id: 'skill-hooked',
        name: 'hooked',
        content: 'prompt',
        hooks,
      });

      const written = (adapter.write as jest.Mock).mock.calls[0][1] as string;
      expect(written).toContain('hooks: ');
      expect(written).toContain(JSON.stringify(hooks));
    });

    it('serializes skill fields in kebab-case', async () => {
      const adapter = createMockAdapter({});
      const storage = new SkillStorage(adapter);

      await storage.save({
        id: 'skill-kebab',
        name: 'kebab',
        description: 'Kebab test',
        content: 'prompt',
        disableModelInvocation: true,
        userInvocable: false,
        context: 'fork',
        agent: 'code-reviewer',
      });

      const written = (adapter.write as jest.Mock).mock.calls[0][1] as string;
      expect(written).toContain('disable-model-invocation: true');
      expect(written).toContain('user-invocable: false');
      expect(written).toContain('context: fork');
      expect(written).toContain('agent: code-reviewer');
      // Should NOT contain camelCase variants
      expect(written).not.toContain('disableModelInvocation');
      expect(written).not.toContain('userInvocable');
    });

    it('omits hooks when undefined', async () => {
      const adapter = createMockAdapter({});
      const storage = new SkillStorage(adapter);

      await storage.save({
        id: 'skill-no-hooks',
        name: 'no-hooks',
        content: 'prompt',
      });

      const written = (adapter.write as jest.Mock).mock.calls[0][1] as string;
      expect(written).not.toContain('hooks:');
    });
  });

  describe('delete', () => {
    it('deletes skill file and cleans up directory', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/target/SKILL.md': `---
description: Target
---
Prompt`,
      });
      const storage = new SkillStorage(adapter);

      await storage.delete('skill-target');

      expect(adapter.delete).toHaveBeenCalledWith('.claude/skills/target/SKILL.md');
      expect(adapter.deleteFolder).toHaveBeenCalledWith('.claude/skills/target');
    });
  });

  describe('global skills', () => {
    it('loads a global skill when the directory exists', async () => {
      const adapter = createMockAdapter({});
      const skillContent = `---
description: Global skill
---
Global prompt`;

      fsMock.existsSync.mockImplementation((p) => {
        const s = String(p);
        return s === GLOBAL_SKILLS_DIR || s.endsWith('SKILL.md');
      });
      (fsMock.readdirSync as jest.Mock).mockReturnValue([
        makeDirent('my-global-skill', true),
      ]);
      fsMock.readFileSync.mockReturnValue(skillContent as any);

      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('skill-global-my-global-skill');
      expect(skills[0].name).toBe('my-global-skill');
      expect(skills[0].description).toBe('Global skill');
      expect(skills[0].source).toBe('user');
    });

    it('vault skill takes precedence over global skill with the same name', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/shared/SKILL.md': `---
description: Vault version
---
Vault prompt`,
      });

      fsMock.existsSync.mockImplementation((p) => {
        const s = String(p);
        return s === GLOBAL_SKILLS_DIR || s.endsWith('SKILL.md');
      });
      (fsMock.readdirSync as jest.Mock).mockReturnValue([
        makeDirent('shared', true),
      ]);
      fsMock.readFileSync.mockReturnValue(`---
description: Global version
---
Global prompt` as any);

      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('skill-shared');        // vault id, not global
      expect(skills[0].description).toBe('Vault version');
    });

    it('does not fail when global skills directory does not exist', async () => {
      const adapter = createMockAdapter({});
      fsMock.existsSync.mockReturnValue(false);

      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toEqual([]);
      expect(fsMock.readdirSync).not.toHaveBeenCalled();
    });

    it('skips a global subdir that has no SKILL.md', async () => {
      const adapter = createMockAdapter({});

      fsMock.existsSync.mockImplementation((p) => {
        const s = String(p);
        // Dir exists, but SKILL.md does not
        return s === GLOBAL_SKILLS_DIR;
      });
      (fsMock.readdirSync as jest.Mock).mockReturnValue([
        makeDirent('no-skill-here', true),
      ]);

      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(0);
    });

    it('skips files (non-directories) inside global skills dir', async () => {
      const adapter = createMockAdapter({});

      fsMock.existsSync.mockReturnValue(true);
      (fsMock.readdirSync as jest.Mock).mockReturnValue([
        makeDirent('some-file.md', false),
      ]);

      const storage = new SkillStorage(adapter);
      const skills = await storage.loadAll();

      expect(skills).toHaveLength(0);
    });
  });
});
