import type { Plugin } from 'obsidian';

import { StorageService } from '@/core/storage';
import { DEFAULT_SETTINGS, type SlashCommand } from '@/core/types';

type AdapterOptions = {
  shouldFailWrite?: (path: string) => boolean;
};

function createMockAdapter(
  initialFiles: Record<string, string> = {},
  options: AdapterOptions = {}
) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const folders = new Set<string>();
  const shouldFailWrite = options.shouldFailWrite ?? (() => false);

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`Missing file: ${path}`);
      }
      return content;
    }),
    write: jest.fn(async (path: string, content: string) => {
      if (shouldFailWrite(path)) {
        throw new Error(`Write failed: ${path}`);
      }
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
      const filesInFolder = Array.from(files.keys()).filter((filePath) => filePath.startsWith(prefix));
      const filesAtLevel = filesInFolder.filter((filePath) => {
        const rest = filePath.slice(prefix.length);
        return !rest.includes('/');
      });
      const folderSet = new Set<string>();
      for (const filePath of filesInFolder) {
        const rest = filePath.slice(prefix.length);
        const parts = rest.split('/');
        if (parts.length > 1) {
          folderSet.add(`${path}/${parts[0]}`);
        }
      }
      return { files: filesAtLevel, folders: Array.from(folderSet) };
    }),
    rename: jest.fn(async (oldPath: string, newPath: string) => {
      const content = files.get(oldPath);
      if (content !== undefined) {
        files.delete(oldPath);
        files.set(newPath, content);
      }
    }),
    stat: jest.fn(async (path: string) => {
      if (!files.has(path)) {
        return null;
      }
      return { mtime: 1, size: files.get(path)!.length };
    }),
  };

  return { adapter, files, folders };
}

function createMockPlugin(options: {
  dataJson?: unknown;
  initialFiles?: Record<string, string>;
  shouldFailWrite?: (path: string) => boolean;
}) {
  const { adapter, files } = createMockAdapter(options.initialFiles, {
    shouldFailWrite: options.shouldFailWrite,
  });

  const plugin = {
    app: { vault: { adapter } },
    loadData: jest.fn().mockResolvedValue(options.dataJson ?? null),
    saveData: jest.fn().mockResolvedValue(undefined),
  };

  return { plugin: plugin as unknown as Plugin, adapter, files };
}

describe('StorageService migration', () => {
  it('clears data.json after successful legacy content migration', async () => {
    const command: SlashCommand = {
      id: 'cmd-review',
      name: 'review',
      content: 'Review the file.',
    };

    const { plugin, files } = createMockPlugin({
      dataJson: { slashCommands: [command] },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    expect(files.has('.claude/commands/review.md')).toBe(true);
    expect(plugin.saveData).toHaveBeenCalledWith({});
  });

  it('does not clear data.json when legacy content migration fails', async () => {
    const command: SlashCommand = {
      id: 'cmd-review',
      name: 'review',
      content: 'Review the file.',
    };

    const { plugin } = createMockPlugin({
      dataJson: { slashCommands: [command] },
      shouldFailWrite: (path) => path.startsWith('.claude/commands/'),
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('normalizes legacy blockedCommands during settings migration', async () => {
    const legacySettings = {
      userName: 'Test User',
      blockedCommands: ['rm -rf', '  '],
      permissions: [],
    };

    const { plugin, files } = createMockPlugin({
      dataJson: null,
      initialFiles: {
        '.claude/settings.json': JSON.stringify(legacySettings),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const saved = JSON.parse(files.get('.claude/claudian-settings.json') || '{}') as Record<string, unknown>;
    const blocked = saved.blockedCommands as { unix: string[]; windows: string[] };

    expect(blocked.unix).toEqual(['rm -rf']);
    expect(blocked.windows).toEqual(DEFAULT_SETTINGS.blockedCommands.windows);
  });

  it('does not migrate legacy activeConversationId from data.json', async () => {
    const { plugin, files } = createMockPlugin({
      dataJson: { activeConversationId: 'conv-1' },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const rawSettings = files.get('.claude/claudian-settings.json');
    // If settings file was created, it should NOT contain the legacy activeConversationId
    const containsLegacyField = rawSettings
      ? 'activeConversationId' in (JSON.parse(rawSettings) as Record<string, unknown>)
      : false;
    expect(containsLegacyField).toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('preserves tabManagerState when clearing legacy data.json state', async () => {
    const tabManagerState = {
      openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
      activeTabId: 'tab-1',
    };
    const { plugin } = createMockPlugin({
      dataJson: {
        lastEnvHash: 'hash',
        tabManagerState,
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    expect(plugin.saveData).toHaveBeenCalledWith({
      tabManagerState,
    });
  });

  it('initializes persistentExternalContextPaths to empty array when migrating old settings', async () => {
    // Legacy settings without persistentExternalContextPaths
    const legacySettings = {
      userName: 'Test User',
      permissions: [],
      allowedExportPaths: ['~/Desktop'],
      // Note: no persistentExternalContextPaths
    };

    const { plugin, files } = createMockPlugin({
      dataJson: null,
      initialFiles: {
        '.claude/settings.json': JSON.stringify(legacySettings),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const saved = JSON.parse(files.get('.claude/claudian-settings.json') || '{}') as Record<string, unknown>;
    expect(saved.persistentExternalContextPaths).toEqual([]);
  });

  it('preserves persistentExternalContextPaths from existing settings', async () => {
    const existingSettings = {
      userName: 'Test User',
      permissions: [],
      persistentExternalContextPaths: ['/path/a', '/path/b'],
    };

    const { plugin, files } = createMockPlugin({
      dataJson: null,
      initialFiles: {
        '.claude/claudian-settings.json': JSON.stringify(existingSettings),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const saved = JSON.parse(files.get('.claude/claudian-settings.json') || '{}') as Record<string, unknown>;
    expect(saved.persistentExternalContextPaths).toEqual(['/path/a', '/path/b']);
  });
});
