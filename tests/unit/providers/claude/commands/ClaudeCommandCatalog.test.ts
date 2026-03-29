import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SlashCommand } from '@/core/types';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { SkillStorage } from '@/providers/claude/storage/SkillStorage';
import { SlashCommandStorage } from '@/providers/claude/storage/SlashCommandStorage';

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
    listFilesRecursive: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      return Object.keys(files).filter(k => k.startsWith(prefix));
    }),
    ensureFolder: jest.fn(),
    rename: jest.fn(),
    append: jest.fn(),
    stat: jest.fn(),
    deleteFolder: jest.fn(),
  } as unknown as VaultFileAdapter;
}

describe('ClaudeCommandCatalog', () => {
  describe('listDropdownEntries', () => {
    it('returns vault commands and skills as ProviderCommandEntry', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review code
allowed-tools:
  - Read
model: claude-sonnet-4-5
---
Review this code`,
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy app
disable-model-invocation: true
user-invocable: false
context: fork
agent: deployer
---
Deploy the app`,
      });

      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(2);

      const reviewEntry = entries.find(e => e.name === 'review');
      expect(reviewEntry).toBeDefined();
      expect(reviewEntry!.providerId).toBe('claude');
      expect(reviewEntry!.kind).toBe('command');
      expect(reviewEntry!.scope).toBe('vault');
      expect(reviewEntry!.displayPrefix).toBe('/');
      expect(reviewEntry!.insertPrefix).toBe('/');
      expect(reviewEntry!.allowedTools).toEqual(['Read']);
      expect(reviewEntry!.model).toBe('claude-sonnet-4-5');

      const deployEntry = entries.find(e => e.name === 'deploy');
      expect(deployEntry).toBeDefined();
      expect(deployEntry!.providerId).toBe('claude');
      expect(deployEntry!.kind).toBe('skill');
      expect(deployEntry!.scope).toBe('vault');
      expect(deployEntry!.disableModelInvocation).toBe(true);
      expect(deployEntry!.userInvocable).toBe(false);
      expect(deployEntry!.context).toBe('fork');
      expect(deployEntry!.agent).toBe('deployer');
    });

    it('merges runtime SDK commands when provided', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const sdkCommands: SlashCommand[] = [
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
      ];
      catalog.setRuntimeCommands(sdkCommands);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      const commitEntry = entries.find(e => e.name === 'commit');
      expect(commitEntry).toBeDefined();
      expect(commitEntry!.providerId).toBe('claude');
      expect(commitEntry!.scope).toBe('runtime');
      expect(commitEntry!.source).toBe('sdk');
      expect(commitEntry!.isEditable).toBe(false);
      expect(commitEntry!.isDeletable).toBe(false);
    });
  });

  describe('listVaultEntries', () => {
    it('returns only vault-owned commands and skills', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review code
---
Review this code`,
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy
---
Deploy the app`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      // Set SDK commands to verify they're excluded from vault entries
      catalog.setRuntimeCommands([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listVaultEntries();

      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.scope === 'vault')).toBe(true);
      expect(entries.find(e => e.name === 'commit')).toBeUndefined();
    });
  });

  describe('saveVaultEntry', () => {
    it('saves a command entry via command storage', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.saveVaultEntry({
        id: 'cmd-review',
        providerId: 'claude',
        kind: 'command',
        name: 'review',
        description: 'Review code',
        allowedTools: ['Read', 'Edit'],
        model: 'claude-sonnet-4-5',
        content: 'Review this code',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/commands/review.md',
        expect.stringContaining('Review this code'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/commands/review.md',
        expect.stringContaining('allowed-tools:'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/commands/review.md',
        expect.stringContaining('model: claude-sonnet-4-5'),
      );
    });

    it('saves a skill entry via skill storage', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.saveVaultEntry({
        id: 'skill-deploy',
        providerId: 'claude',
        kind: 'skill',
        name: 'deploy',
        description: 'Deploy app',
        content: 'Deploy the app',
        disableModelInvocation: true,
        userInvocable: false,
        context: 'fork',
        agent: 'deployer',
        hooks: { preToolUse: ['check'] },
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.claude/skills/deploy');
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/deploy/SKILL.md',
        expect.stringContaining('Deploy the app'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/deploy/SKILL.md',
        expect.stringContaining('disable-model-invocation: true'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/deploy/SKILL.md',
        expect.stringContaining('user-invocable: false'),
      );
    });
  });

  describe('deleteVaultEntry', () => {
    it('deletes a command entry', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review
---
Review`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.deleteVaultEntry({
        id: 'cmd-review',
        providerId: 'claude',
        kind: 'command',
        name: 'review',
        description: 'Review',
        content: 'Review',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.delete).toHaveBeenCalled();
    });

    it('deletes a skill entry', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy
---
Deploy`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.deleteVaultEntry({
        id: 'skill-deploy',
        providerId: 'claude',
        kind: 'skill',
        name: 'deploy',
        description: 'Deploy',
        content: 'Deploy',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.delete).toHaveBeenCalledWith('.claude/skills/deploy/SKILL.md');
    });
  });

  describe('getDropdownConfig', () => {
    it('returns Claude-specific config', () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const config = catalog.getDropdownConfig();

      expect(config.triggerChars).toEqual(['/']);
      expect(config.builtInPrefix).toBe('/');
      expect(config.skillPrefix).toBe('/');
      expect(config.commandPrefix).toBe('/');
    });
  });
});
