import type { Plugin } from 'obsidian';

import { StorageService } from '@/core/storage';
import { createPermissionRule } from '@/core/types';

function createMockAdapter(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const folders = new Set<string>();

  return {
    adapter: {
      exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
      read: jest.fn(async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`Missing file: ${path}`);
        return content;
      }),
      write: jest.fn(async (path: string, content: string) => {
        files.set(path, content);
      }),
      remove: jest.fn(async (path: string) => {
        files.delete(path);
      }),
      mkdir: jest.fn(async (path: string) => {
        folders.add(path);
      }),
      list: jest.fn(async (path: string) => {
        const prefix = `${path}/`;
        const filesInFolder = Array.from(files.keys()).filter(fp => fp.startsWith(prefix));
        const filesAtLevel = filesInFolder.filter(fp => !fp.slice(prefix.length).includes('/'));
        const folderSet = new Set<string>();
        for (const fp of filesInFolder) {
          const parts = fp.slice(prefix.length).split('/');
          if (parts.length > 1) folderSet.add(`${path}/${parts[0]}`);
        }
        return { files: filesAtLevel, folders: Array.from(folderSet) };
      }),
      rename: jest.fn(),
      stat: jest.fn(async (path: string) => {
        if (!files.has(path)) return null;
        return { mtime: 1, size: files.get(path)!.length };
      }),
    },
    files,
    folders,
  };
}

function createMockPlugin(options: {
  dataJson?: unknown;
  initialFiles?: Record<string, string>;
}) {
  const { adapter, files, folders } = createMockAdapter(options.initialFiles);
  const plugin = {
    app: { vault: { adapter } },
    loadData: jest.fn().mockResolvedValue(options.dataJson ?? null),
    saveData: jest.fn().mockResolvedValue(undefined),
  };
  return { plugin: plugin as unknown as Plugin, adapter, files, folders };
}

describe('StorageService convenience methods', () => {
  const ccSettingsJson = JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: {
      allow: ['Bash(git *)'],
      deny: ['Bash(rm -rf)'],
      ask: [],
    },
  });

  const claudianSettingsJson = JSON.stringify({
    userName: 'Test',
    model: 'haiku',
    permissionMode: 'yolo',
  });

  describe('getPermissions', () => {
    it('delegates to ccSettings.getPermissions', async () => {
      const { plugin } = createMockPlugin({
        initialFiles: {
          '.claude/settings.json': ccSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const perms = await storage.getPermissions();
      expect(perms.allow).toContainEqual('Bash(git *)');
      expect(perms.deny).toContainEqual('Bash(rm -rf)');
    });
  });

  describe('updatePermissions', () => {
    it('saves updated permissions via ccSettings', async () => {
      const { plugin, files } = createMockPlugin({
        initialFiles: {
          '.claude/settings.json': ccSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      await storage.updatePermissions({
        allow: [createPermissionRule('Read')],
        deny: [],
        ask: [],
      });

      const saved = JSON.parse(files.get('.claude/settings.json')!) as Record<string, unknown>;
      expect((saved.permissions as { allow: string[] }).allow).toContainEqual('Read');
    });
  });

  describe('addAllowRule', () => {
    it('adds a new allow rule', async () => {
      const { plugin, files } = createMockPlugin({
        initialFiles: {
          '.claude/settings.json': ccSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      await storage.addAllowRule('Read(/vault/*)');

      const saved = JSON.parse(files.get('.claude/settings.json')!) as Record<string, unknown>;
      expect((saved.permissions as { allow: string[] }).allow).toContainEqual('Read(/vault/*)');
    });
  });

  describe('addDenyRule', () => {
    it('adds a new deny rule', async () => {
      const { plugin, files } = createMockPlugin({
        initialFiles: {
          '.claude/settings.json': ccSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      await storage.addDenyRule('Write(/etc/*)');

      const saved = JSON.parse(files.get('.claude/settings.json')!) as Record<string, unknown>;
      expect((saved.permissions as { deny: string[] }).deny).toContainEqual('Write(/etc/*)');
    });
  });

  describe('removePermissionRule', () => {
    it('removes a rule from all permission lists', async () => {
      const settings = JSON.stringify({
        permissions: {
          allow: ['Bash(git *)'],
          deny: ['Bash(git *)'],
          ask: ['Bash(git *)'],
        },
      });
      const { plugin, files } = createMockPlugin({
        initialFiles: { '.claude/settings.json': settings },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      await storage.removePermissionRule('Bash(git *)');

      const saved = JSON.parse(files.get('.claude/settings.json')!) as Record<string, unknown>;
      const perms = saved.permissions as { allow: string[]; deny: string[]; ask: string[] };
      expect(perms.allow).not.toContainEqual('Bash(git *)');
      expect(perms.deny).not.toContainEqual('Bash(git *)');
      expect(perms.ask).not.toContainEqual('Bash(git *)');
    });
  });

  describe('updateClaudianSettings', () => {
    it('updates partial claudian settings', async () => {
      const { plugin, files } = createMockPlugin({
        initialFiles: {
          '.claude/claudian-settings.json': claudianSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      await storage.updateClaudianSettings({ userName: 'NewUser' });

      const saved = JSON.parse(files.get('.claude/claudian-settings.json')!) as Record<string, unknown>;
      expect(saved.userName).toBe('NewUser');
    });
  });

  describe('saveClaudianSettings', () => {
    it('saves full claudian settings', async () => {
      const { plugin, files } = createMockPlugin({
        initialFiles: {
          '.claude/claudian-settings.json': claudianSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const existing = await storage.loadClaudianSettings();
      existing.userName = 'FullSave';
      await storage.saveClaudianSettings(existing);

      const saved = JSON.parse(files.get('.claude/claudian-settings.json')!) as Record<string, unknown>;
      expect(saved.userName).toBe('FullSave');
    });
  });

  describe('loadClaudianSettings', () => {
    it('loads claudian settings', async () => {
      const { plugin } = createMockPlugin({
        initialFiles: {
          '.claude/claudian-settings.json': claudianSettingsJson,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const settings = await storage.loadClaudianSettings();
      expect(settings.userName).toBe('Test');
      expect(settings.model).toBe('haiku');
    });
  });

  describe('loadAllSlashCommands', () => {
    it('returns commands from both commands and skills directories', async () => {
      const commandContent = [
        '---',
        'description: Review code',
        '---',
        'Review this code',
      ].join('\n');
      const skillContent = [
        '---',
        'description: A skill',
        '---',
        'Do the skill',
      ].join('\n');
      const { plugin } = createMockPlugin({
        initialFiles: {
          '.claude/commands/review.md': commandContent,
          '.claude/skills/my-skill/SKILL.md': skillContent,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const commands = await storage.loadAllSlashCommands();
      expect(commands.length).toBeGreaterThanOrEqual(1);
      expect(commands.some(c => c.name === 'review')).toBe(true);
    });

    it('returns empty array when no commands exist', async () => {
      const { plugin } = createMockPlugin({});
      const storage = new StorageService(plugin);
      await storage.initialize();

      const commands = await storage.loadAllSlashCommands();
      expect(commands).toEqual([]);
    });
  });

  describe('getAdapter', () => {
    it('returns the VaultFileAdapter instance', () => {
      const { plugin } = createMockPlugin({});
      const storage = new StorageService(plugin);
      const adapter = storage.getAdapter();
      expect(adapter).toBeDefined();
      expect(typeof adapter.exists).toBe('function');
    });
  });

  describe('getLegacyActiveConversationId', () => {
    it('returns id from claudian settings', async () => {
      const settings = JSON.stringify({
        userName: 'Test',
        activeConversationId: 'conv-from-settings',
      });
      const { plugin } = createMockPlugin({
        initialFiles: {
          '.claude/claudian-settings.json': settings,
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const id = await storage.getLegacyActiveConversationId();
      expect(id).toBe('conv-from-settings');
    });

    it('falls back to data.json when not in claudian settings', async () => {
      const { plugin } = createMockPlugin({
        dataJson: { activeConversationId: 'conv-from-data' },
        initialFiles: {
          '.claude/claudian-settings.json': JSON.stringify({ userName: 'Test' }),
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const id = await storage.getLegacyActiveConversationId();
      expect(id).toBe('conv-from-data');
    });

    it('returns null when not found in either source', async () => {
      const { plugin } = createMockPlugin({
        dataJson: {},
        initialFiles: {
          '.claude/claudian-settings.json': JSON.stringify({ userName: 'Test' }),
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      const id = await storage.getLegacyActiveConversationId();
      expect(id).toBeNull();
    });
  });

  describe('clearLegacyActiveConversationId', () => {
    it('clears from data.json', async () => {
      const { plugin } = createMockPlugin({
        dataJson: { activeConversationId: 'conv-1', otherField: 'keep' },
        initialFiles: {
          '.claude/claudian-settings.json': JSON.stringify({ userName: 'Test' }),
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      await storage.clearLegacyActiveConversationId();

      expect(plugin.saveData).toHaveBeenCalledWith(
        expect.objectContaining({ otherField: 'keep' }),
      );
      const savedData = (plugin.saveData as jest.Mock).mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as Record<string, unknown>;
          return !('activeConversationId' in arg);
        },
      );
      expect(savedData).toBeDefined();
    });

    it('no-ops when data.json has no activeConversationId', async () => {
      const { plugin } = createMockPlugin({
        dataJson: { otherField: 'keep' },
        initialFiles: {
          '.claude/claudian-settings.json': JSON.stringify({ userName: 'Test' }),
        },
      });
      const storage = new StorageService(plugin);
      await storage.initialize();

      // Reset mock calls from initialize
      (plugin.saveData as jest.Mock).mockClear();

      await storage.clearLegacyActiveConversationId();

      // saveData should not have been called for data.json cleanup
      expect(plugin.saveData).not.toHaveBeenCalled();
    });
  });

  describe('getTabManagerState', () => {
    it('returns validated state from data.json', async () => {
      const state = {
        openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
        activeTabId: 'tab-1',
      };
      const { plugin } = createMockPlugin({
        dataJson: { tabManagerState: state },
      });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).toEqual(state);
    });

    it('returns null when no state exists', async () => {
      const { plugin } = createMockPlugin({ dataJson: {} });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).toBeNull();
    });

    it('returns null when data.json is null', async () => {
      const { plugin } = createMockPlugin({ dataJson: null });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).toBeNull();
    });

    it('returns null for invalid state (not an object)', async () => {
      const { plugin } = createMockPlugin({
        dataJson: { tabManagerState: 'invalid' },
      });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).toBeNull();
    });

    it('returns null when openTabs is not an array', async () => {
      const { plugin } = createMockPlugin({
        dataJson: { tabManagerState: { openTabs: 'not-array' } },
      });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).toBeNull();
    });

    it('skips invalid tab entries', async () => {
      const state = {
        openTabs: [
          { tabId: 'tab-1', conversationId: 'conv-1' },
          null,
          { tabId: 123 },
          'invalid',
          { tabId: 'tab-2', conversationId: null },
        ],
        activeTabId: 'tab-1',
      };
      const { plugin } = createMockPlugin({
        dataJson: { tabManagerState: state },
      });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).not.toBeNull();
      expect(result!.openTabs).toHaveLength(2);
      expect(result!.openTabs[0].tabId).toBe('tab-1');
      expect(result!.openTabs[1].tabId).toBe('tab-2');
      expect(result!.openTabs[1].conversationId).toBeNull();
    });

    it('normalizes non-string conversationId to null', async () => {
      const state = {
        openTabs: [{ tabId: 'tab-1', conversationId: 123 }],
        activeTabId: 'tab-1',
      };
      const { plugin } = createMockPlugin({
        dataJson: { tabManagerState: state },
      });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result!.openTabs[0].conversationId).toBeNull();
    });

    it('normalizes non-string activeTabId to null', async () => {
      const state = {
        openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
        activeTabId: 123,
      };
      const { plugin } = createMockPlugin({
        dataJson: { tabManagerState: state },
      });
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result!.activeTabId).toBeNull();
    });

    it('returns null when loadData throws', async () => {
      const { plugin } = createMockPlugin({});
      (plugin.loadData as jest.Mock).mockRejectedValue(new Error('Read error'));
      const storage = new StorageService(plugin);

      const result = await storage.getTabManagerState();
      expect(result).toBeNull();
    });
  });

  describe('setTabManagerState', () => {
    it('persists state to data.json', async () => {
      const { plugin } = createMockPlugin({ dataJson: {} });
      const storage = new StorageService(plugin);

      const state = {
        openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
        activeTabId: 'tab-1',
      };
      await storage.setTabManagerState(state);

      expect(plugin.saveData).toHaveBeenCalledWith(
        expect.objectContaining({ tabManagerState: state }),
      );
    });

    it('merges with existing data.json content', async () => {
      const { plugin } = createMockPlugin({
        dataJson: { existingKey: 'keep' },
      });
      const storage = new StorageService(plugin);

      await storage.setTabManagerState({
        openTabs: [],
        activeTabId: null,
      });

      expect(plugin.saveData).toHaveBeenCalledWith(
        expect.objectContaining({
          existingKey: 'keep',
          tabManagerState: { openTabs: [], activeTabId: null },
        }),
      );
    });

    it('silently handles save errors', async () => {
      const { plugin } = createMockPlugin({});
      (plugin.loadData as jest.Mock).mockRejectedValue(new Error('Read error'));
      const storage = new StorageService(plugin);

      // Should not throw
      await expect(
        storage.setTabManagerState({ openTabs: [], activeTabId: null }),
      ).resolves.toBeUndefined();
    });
  });
});
