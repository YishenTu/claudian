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
    it('returns SDK runtime commands as ProviderCommandEntry', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const sdkCommands: SlashCommand[] = [
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
        { id: 'sdk:review', name: 'review', description: 'Review code', content: '', source: 'sdk' },
      ];
      catalog.setRuntimeCommands(sdkCommands);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(2);

      const commitEntry = entries.find(e => e.name === 'commit');
      expect(commitEntry).toBeDefined();
      expect(commitEntry!.providerId).toBe('claude');
      expect(commitEntry!.scope).toBe('runtime');
      expect(commitEntry!.source).toBe('sdk');
      expect(commitEntry!.isEditable).toBe(false);
      expect(commitEntry!.isDeletable).toBe(false);
      expect(commitEntry!.displayPrefix).toBe('/');
      expect(commitEntry!.insertPrefix).toBe('/');
    });

    it('returns empty when no runtime commands and no probe', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(0);
    });

    it('filters out built-in hidden SDK commands', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      catalog.setRuntimeCommands([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
        { id: 'sdk:init', name: 'init', description: 'Init', content: '', source: 'sdk' },
        { id: 'sdk:debug', name: 'debug', description: 'Debug', content: '', source: 'sdk' },
        { id: 'sdk:cost', name: 'cost', description: 'Cost', content: '', source: 'sdk' },
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      const names = entries.map(e => e.name);
      expect(names).toEqual(['commit', 'review']);
      expect(names).not.toContain('init');
      expect(names).not.toContain('debug');
      expect(names).not.toContain('cost');
    });

    it('probes SDK on cold start when cache is empty', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('commit');
      expect(entries[0].scope).toBe('runtime');
    });

    it('falls back to vault commands and skills when SDK discovery is empty', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review code
---
Review this code`,
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy app
---
Deploy the app`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(2);
      expect(entries.map(entry => entry.name).sort()).toEqual(['deploy', 'review']);
      expect(entries.every(entry => entry.scope === 'vault')).toBe(true);
    });

    it('does not probe when runtime commands are cached', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      catalog.setRuntimeCommands([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).not.toHaveBeenCalled();
    });

    it('probes independently when cached runtime fallback is disabled', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:cold', name: 'cold', description: 'Cold tab command', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);
      catalog.setRuntimeCommands([
        { id: 'sdk:active', name: 'active', description: 'Active tab command', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listDropdownEntries({
        includeBuiltIns: false,
        allowCachedRuntimeCommands: false,
      });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries.map(entry => entry.name)).toEqual(['cold']);
    });

    it('deduplicates concurrent probe calls', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      const [a, b] = await Promise.all([
        catalog.listDropdownEntries({ includeBuiltIns: false }),
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ]);

      expect(probe).toHaveBeenCalledTimes(1);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('does not overwrite runtime commands with stale probe results', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);

      let resolveProbe: (v: SlashCommand[]) => void;
      const probe = jest.fn().mockReturnValue(new Promise<SlashCommand[]>((r) => { resolveProbe = r; }));
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      // Start probe (it will hang)
      const entriesPromise = catalog.listDropdownEntries({ includeBuiltIns: false });

      // Runtime provides fresh data while probe is in-flight
      catalog.setRuntimeCommands([
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'sdk' },
      ]);

      // Probe returns stale data
      resolveProbe!([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      const entries = await entriesPromise;

      // Runtime data wins — probe result is discarded
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('review');
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
