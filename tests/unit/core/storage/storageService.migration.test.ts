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

  it('merges env object from CC format into environmentVariables during migration', async () => {
    const legacySettings = {
      userName: 'Test User',
      permissions: [],
      environmentVariables: 'FOO=bar',
      env: { BAZ: 'qux' },
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
    const envVars = saved.environmentVariables as string;
    expect(envVars).toContain('FOO=bar');
    expect(envVars).toContain('BAZ=qux');
  });

  it('preserves CC-format permissions during migration', async () => {
    const legacySettings = {
      userName: 'Test User',
      permissions: {
        allow: [{ toolName: 'Read', ruleContent: '/vault/*' }],
        deny: [],
        ask: [],
        defaultMode: 'default',
        additionalDirectories: ['/external'],
      },
    };

    const { plugin, files } = createMockPlugin({
      dataJson: null,
      initialFiles: {
        '.claude/settings.json': JSON.stringify(legacySettings),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const ccSettings = JSON.parse(files.get('.claude/settings.json') || '{}') as Record<string, any>;
    expect(ccSettings.permissions.allow).toEqual([{ toolName: 'Read', ruleContent: '/vault/*' }]);
    expect(ccSettings.permissions.defaultMode).toBe('default');
    expect(ccSettings.permissions.additionalDirectories).toEqual(['/external']);
  });

  it('migrates data.json state fields to claudian-settings when empty', async () => {
    // Migration only writes when the target field is falsy.
    // Default lastClaudeModel='haiku' (truthy) → won't overwrite
    // Default lastCustomModel='' (falsy) → will overwrite
    // Default lastEnvHash='' (falsy) → will overwrite
    const { plugin, files } = createMockPlugin({
      dataJson: {
        lastEnvHash: 'abc123',
        lastClaudeModel: 'claude-3-sonnet',
        lastCustomModel: 'custom-model',
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const saved = JSON.parse(files.get('.claude/claudian-settings.json') || '{}') as Record<string, unknown>;
    expect(saved.lastEnvHash).toBe('abc123');
    // lastClaudeModel defaults to 'haiku' (truthy), so migration doesn't overwrite it
    expect(saved.lastClaudeModel).toBe('haiku');
    expect(saved.lastCustomModel).toBe('custom-model');
  });

  it('does not overwrite existing claudian-settings fields from data.json', async () => {
    const { plugin, files } = createMockPlugin({
      dataJson: {
        lastEnvHash: 'old-hash',
        lastClaudeModel: 'old-model',
      },
      initialFiles: {
        '.claude/claudian-settings.json': JSON.stringify({
          userName: 'Test User',
          lastEnvHash: 'existing-hash',
          lastClaudeModel: 'existing-model',
        }),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const saved = JSON.parse(files.get('.claude/claudian-settings.json') || '{}') as Record<string, unknown>;
    expect(saved.lastEnvHash).toBe('existing-hash');
    expect(saved.lastClaudeModel).toBe('existing-model');
  });

  it('skips existing slash commands during migration', async () => {
    const command: SlashCommand = {
      id: 'cmd-review',
      name: 'review',
      content: 'Review the file.',
    };

    const { plugin, files } = createMockPlugin({
      dataJson: { slashCommands: [command] },
      initialFiles: {
        '.claude/commands/review.md': 'Existing content',
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    // Should keep existing file, not overwrite
    expect(files.get('.claude/commands/review.md')).toBe('Existing content');
  });

  it('migrates conversations from data.json', async () => {
    const conversation = {
      id: 'conv-1',
      title: 'Test Conversation',
      createdAt: 1000,
      updatedAt: 2000,
      sessionId: null,
      messages: [{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1000 }],
    };

    const { plugin, files } = createMockPlugin({
      dataJson: { conversations: [conversation] },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    expect(files.has('.claude/sessions/conv-1.jsonl')).toBe(true);
  });

  it('skips existing conversations during migration', async () => {
    const conversation = {
      id: 'conv-1',
      title: 'Test Conversation',
      createdAt: 1000,
      updatedAt: 2000,
      sessionId: null,
      messages: [],
    };

    const { plugin, files } = createMockPlugin({
      dataJson: { conversations: [conversation] },
      initialFiles: {
        '.claude/sessions/conv-1.jsonl': '{"existing": true}',
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    // Should keep existing file
    expect(files.get('.claude/sessions/conv-1.jsonl')).toBe('{"existing": true}');
  });

  it('handles conversation migration errors gracefully', async () => {
    const conversation = {
      id: 'conv-fail',
      title: 'Failing Conversation',
      createdAt: 1000,
      updatedAt: 2000,
      sessionId: null,
      messages: [],
    };

    const { plugin } = createMockPlugin({
      dataJson: { conversations: [conversation] },
      shouldFailWrite: (path) => path.includes('conv-fail'),
    });

    const storage = new StorageService(plugin);
    // Should not throw
    await storage.initialize();

    // data.json should NOT be cleared due to error
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('handles loadDataJson error gracefully', async () => {
    const plugin = {
      app: { vault: { adapter: createMockAdapter().adapter } },
      loadData: jest.fn().mockRejectedValue(new Error('data.json read error')),
      saveData: jest.fn().mockResolvedValue(undefined),
    } as unknown as Plugin;

    const storage = new StorageService(plugin);
    // Should not throw - loadDataJson returns null on error
    await expect(storage.initialize()).resolves.toBeDefined();
  });

  it('converts legacy permissions array format during migration', async () => {
    const legacySettings = {
      userName: 'Test User',
      permissions: [
        { type: 'allow', tool: 'Read', rule: '/vault/*' },
        { type: 'deny', tool: 'Bash', rule: 'rm *' },
      ],
    };

    const { plugin, files } = createMockPlugin({
      dataJson: null,
      initialFiles: {
        '.claude/settings.json': JSON.stringify(legacySettings),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const ccSettings = JSON.parse(files.get('.claude/settings.json') || '{}') as Record<string, any>;
    // Legacy format should be converted to CC format with allow/deny/ask arrays
    expect(ccSettings.permissions).toHaveProperty('allow');
    expect(ccSettings.permissions).toHaveProperty('deny');
  });

  it('converts legacy permissions with toolName/pattern format during settings migration', async () => {
    const legacySettings = {
      userName: 'Test User',
      permissions: [
        { toolName: 'Bash', pattern: 'git *', approvedAt: 1000, scope: 'always' },
        { toolName: 'Read', pattern: '/vault/*', approvedAt: 2000, scope: 'always' },
        { toolName: 'Write', pattern: '/tmp/*', approvedAt: 3000, scope: 'session' },
      ],
    };

    const { plugin, files } = createMockPlugin({
      dataJson: null,
      initialFiles: {
        '.claude/settings.json': JSON.stringify(legacySettings),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const ccSettings = JSON.parse(files.get('.claude/settings.json') || '{}') as Record<string, any>;
    // Legacy format should be converted via legacyPermissionsToCCPermissions
    // Only 'always' scope permissions are converted
    expect(ccSettings.permissions.allow).toContain('Bash(git *)');
    expect(ccSettings.permissions.allow).toContain('Read(/vault/*)');
    // Session scope should be excluded
    expect(ccSettings.permissions.allow).not.toContain('Write(/tmp/*)');
    expect(ccSettings.permissions.deny).toEqual([]);
    expect(ccSettings.permissions.ask).toEqual([]);
  });

  it('migrates lastClaudeModel from data.json when claudian-settings has falsy value', async () => {
    const { plugin, files } = createMockPlugin({
      dataJson: {
        lastClaudeModel: 'claude-3-sonnet',
      },
      initialFiles: {
        '.claude/settings.json': JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
        }),
        '.claude/claudian-settings.json': JSON.stringify({
          userName: 'Test User',
          lastClaudeModel: '',
        }),
      },
    });

    const storage = new StorageService(plugin);
    await storage.initialize();

    const saved = JSON.parse(files.get('.claude/claudian-settings.json') || '{}') as Record<string, unknown>;
    expect(saved.lastClaudeModel).toBe('claude-3-sonnet');
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
