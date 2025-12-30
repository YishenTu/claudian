import * as imageCache from '@/core/images/imageCache';
import { DEFAULT_SETTINGS, VIEW_TYPE_CLAUDIAN } from '@/core/types';

// Mock fs for ClaudianService
jest.mock('fs');

// Now import the plugin after mocking
import ClaudianPlugin from '@/main';

describe('ClaudianPlugin', () => {
  let plugin: ClaudianPlugin;
  let mockApp: any;
  let mockManifest: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    mockApp = {
      vault: {
        adapter: {
          basePath: '/test/vault',
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
          remove: jest.fn().mockResolvedValue(undefined),
          mkdir: jest.fn().mockResolvedValue(undefined),
          list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
          stat: jest.fn().mockResolvedValue(null),
          rename: jest.fn().mockResolvedValue(undefined),
        },
      },
      workspace: {
        getLeavesOfType: jest.fn().mockReturnValue([]),
        getRightLeaf: jest.fn().mockReturnValue({
          setViewState: jest.fn().mockResolvedValue(undefined),
        }),
        revealLeaf: jest.fn(),
      },
    };

    mockManifest = {
      id: 'claudian',
      name: 'Claudian',
      version: '0.1.0',
    };

    // Create plugin instance with mocked app
    plugin = new ClaudianPlugin(mockApp, mockManifest);
    (plugin.loadData as jest.Mock).mockResolvedValue({});
  });

  describe('onload', () => {
    it('should initialize settings with defaults', async () => {
      await plugin.onload();

      expect(plugin.settings).toBeDefined();
      expect(plugin.settings.enableBlocklist).toBe(DEFAULT_SETTINGS.enableBlocklist);
      expect(plugin.settings.showToolUse).toBe(DEFAULT_SETTINGS.showToolUse);
      expect(plugin.settings.blockedCommands).toEqual(DEFAULT_SETTINGS.blockedCommands);
    });

    it('should initialize agentService', async () => {
      await plugin.onload();

      expect(plugin.agentService).toBeDefined();
    });

    it('should register the view', async () => {
      await plugin.onload();

      expect((plugin.registerView as jest.Mock)).toHaveBeenCalledWith(
        VIEW_TYPE_CLAUDIAN,
        expect.any(Function)
      );
    });

    it('should add ribbon icon', async () => {
      await plugin.onload();

      expect((plugin.addRibbonIcon as jest.Mock)).toHaveBeenCalledWith(
        'bot',
        'Open Claudian',
        expect.any(Function)
      );
    });

    it('should add command to open view', async () => {
      await plugin.onload();

      expect((plugin.addCommand as jest.Mock)).toHaveBeenCalledWith({
        id: 'open-view',
        name: 'Open chat view',
        callback: expect.any(Function),
      });
    });

    it('should add settings tab', async () => {
      await plugin.onload();

      expect((plugin.addSettingTab as jest.Mock)).toHaveBeenCalled();
    });
  });

  describe('onunload', () => {
    it('should call cleanup on agentService', async () => {
      await plugin.onload();

      const cleanupSpy = jest.spyOn(plugin.agentService, 'cleanup');

      plugin.onunload();

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('activateView', () => {
    it('should reveal existing leaf if view already exists', async () => {
      const mockLeaf = { id: 'existing-leaf' };
      mockApp.workspace.getLeavesOfType.mockReturnValue([mockLeaf]);

      await plugin.onload();
      await plugin.activateView();

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
    });

    it('should create new leaf in right sidebar if view does not exist', async () => {
      const mockRightLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getRightLeaf.mockReturnValue(mockRightLeaf);

      await plugin.onload();
      await plugin.activateView();

      expect(mockApp.workspace.getRightLeaf).toHaveBeenCalledWith(false);
      expect(mockRightLeaf.setViewState).toHaveBeenCalledWith({
        type: VIEW_TYPE_CLAUDIAN,
        active: true,
      });
    });

    it('should handle null right leaf gracefully', async () => {
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getRightLeaf.mockReturnValue(null);

      await plugin.onload();

      // Should not throw
      await expect(plugin.activateView()).resolves.not.toThrow();
    });
  });

  describe('loadSettings', () => {
    it('should merge saved data with defaults', async () => {
      // Mock settings file exists with custom values
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/settings.json') {
          return JSON.stringify({
            enableBlocklist: false,
            showToolUse: false,
          });
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.settings.enableBlocklist).toBe(false);
      expect(plugin.settings.showToolUse).toBe(false);
      // Should still have defaults for blockedCommands
      expect(plugin.settings.blockedCommands).toEqual(DEFAULT_SETTINGS.blockedCommands);
    });

    it('should normalize blockedCommands when stored value is partial', async () => {
      // Mock settings file exists with partial blockedCommands
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/settings.json') {
          return JSON.stringify({
            blockedCommands: { unix: ['rm -rf', '  '] },
          });
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.settings.blockedCommands.unix).toEqual(['rm -rf']);
      expect(plugin.settings.blockedCommands.windows).toEqual(DEFAULT_SETTINGS.blockedCommands.windows);
    });

    it('should use defaults when no saved data', async () => {
      // No settings file exists
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      (plugin.loadData as jest.Mock).mockResolvedValue(null);

      await plugin.loadSettings();

      expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    });

    it('should use defaults when loadData returns empty object', async () => {
      // No settings file exists
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      (plugin.loadData as jest.Mock).mockResolvedValue({});

      await plugin.loadSettings();

      expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    });

    it('should reconcile model from environment and persist when changed', async () => {
      // Mock settings file with environment variables
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/settings.json') {
          return JSON.stringify({
            environmentVariables: 'ANTHROPIC_MODEL=custom-model',
            lastEnvHash: '',
          });
        }
        return '';
      });

      const saveSpy = jest.spyOn(plugin, 'saveSettings');
      await plugin.loadSettings();

      expect(plugin.settings.model).toBe('custom-model');
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  describe('saveSettings', () => {
    it('should save settings to file and minimal data to data.json', async () => {
      await plugin.onload();

      plugin.settings.enableBlocklist = false;
      plugin.settings.showToolUse = false;

      await plugin.saveSettings();

      // Settings should be written to .claude/settings.json via vault adapter
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        '.claude/settings.json',
        expect.stringContaining('"enableBlocklist": false')
      );

      // Plugin state should be saved to data.json (machine-specific only)
      const savedData = (plugin.saveData as jest.Mock).mock.calls[0][0];
      expect(savedData).toHaveProperty('activeConversationId');
      expect(savedData).toHaveProperty('lastEnvHash');
      expect(savedData).toHaveProperty('lastClaudeModel');
      expect(savedData).toHaveProperty('lastCustomModel');
      // permissions is now in settings.json, not data.json
      expect(savedData).not.toHaveProperty('permissions');
    });
  });

  describe('applyEnvironmentVariables', () => {
    it('toggles restart notification state based on runtime env', async () => {
      await plugin.onload();
      (plugin as any).runtimeEnvironmentVariables = 'A=1';

      await plugin.applyEnvironmentVariables('A=2');
      expect((plugin as any).hasNotifiedEnvChange).toBe(true);

      await plugin.applyEnvironmentVariables('A=3');
      expect((plugin as any).hasNotifiedEnvChange).toBe(true);

      await plugin.applyEnvironmentVariables('A=1');
      expect((plugin as any).hasNotifiedEnvChange).toBe(false);
    });
  });

  describe('ribbon icon callback', () => {
    it('should call activateView when ribbon icon is clicked', async () => {
      await plugin.onload();

      // Get the callback passed to addRibbonIcon
      const ribbonCallback = (plugin.addRibbonIcon as jest.Mock).mock.calls[0][2];
      const activateViewSpy = jest.spyOn(plugin, 'activateView');

      ribbonCallback();

      expect(activateViewSpy).toHaveBeenCalled();
    });
  });

  describe('command callback', () => {
    it('should call activateView when command is executed', async () => {
      await plugin.onload();

      // Get the callback passed to addCommand
      const commandConfig = (plugin.addCommand as jest.Mock).mock.calls[0][0];
      const activateViewSpy = jest.spyOn(plugin, 'activateView');

      commandConfig.callback();

      expect(activateViewSpy).toHaveBeenCalled();
    });
  });

  describe('createConversation', () => {
    it('should create a new conversation with unique ID', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      expect(conv.id).toMatch(/^conv-\d+-[a-z0-9]+$/);
      expect(conv.messages).toEqual([]);
      expect(conv.sessionId).toBeNull();
    });

    it('should set new conversation as active', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const active = plugin.getActiveConversation();

      expect(active?.id).toBe(conv.id);
    });

    it('should generate default title with timestamp', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      // Title should contain month and time
      expect(conv.title).toBeTruthy();
      expect(conv.title.length).toBeGreaterThan(0);
    });

    it('should reset agent service session', async () => {
      await plugin.onload();

      const resetSessionSpy = jest.spyOn(plugin.agentService, 'resetSession');

      await plugin.createConversation();

      expect(resetSessionSpy).toHaveBeenCalled();
    });
  });

  describe('switchConversation', () => {
    it('should switch to existing conversation', async () => {
      await plugin.onload();

      const conv1 = await plugin.createConversation();
      const conv2 = await plugin.createConversation();

      expect(plugin.getActiveConversation()?.id).toBe(conv2.id);

      await plugin.switchConversation(conv1.id);

      expect(plugin.getActiveConversation()?.id).toBe(conv1.id);
    });

    it('should restore session ID when switching', async () => {
      await plugin.onload();

      const conv1 = await plugin.createConversation();
      await plugin.updateConversation(conv1.id, { sessionId: 'session-123' });

      await plugin.createConversation();

      const setSessionIdSpy = jest.spyOn(plugin.agentService, 'setSessionId');

      await plugin.switchConversation(conv1.id);

      expect(setSessionIdSpy).toHaveBeenCalledWith('session-123');
    });

    it('should return null for non-existent conversation', async () => {
      await plugin.onload();

      const result = await plugin.switchConversation('non-existent-id');

      expect(result).toBeNull();
    });
  });

  describe('deleteConversation', () => {
    it('should delete conversation by ID', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const convId = conv.id;

      // Create another so we have at least one left
      await plugin.createConversation();

      await plugin.deleteConversation(convId);

      const list = plugin.getConversationList();
      expect(list.find(c => c.id === convId)).toBeUndefined();
    });

    it('should create new conversation if deleted active and no others exist', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.deleteConversation(conv.id);

      // Should have created a new conversation
      const active = plugin.getActiveConversation();
      expect(active).not.toBeNull();
      expect(active?.id).not.toBe(conv.id);
    });

    it('should switch to first conversation if deleted active', async () => {
      await plugin.onload();

      const conv1 = await plugin.createConversation();
      const conv2 = await plugin.createConversation();

      // Active is conv2
      expect(plugin.getActiveConversation()?.id).toBe(conv2.id);

      await plugin.deleteConversation(conv2.id);

      // Should switch to conv1
      expect(plugin.getActiveConversation()?.id).toBe(conv1.id);
    });
  });

  describe('cleanupConversationImages', () => {
    it('deletes cached images not used elsewhere', async () => {
      await plugin.onload();
      const deleteSpy = jest.spyOn(imageCache, 'deleteCachedImages').mockImplementation(() => {});

      const convA: any = {
        id: 'a',
        title: 'A',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        messages: [
          { id: 'm1', role: 'user', content: '', timestamp: 0, images: [
            { id: 'i1', name: 'x', mediaType: 'image/png', cachePath: 'path1', size: 1, source: 'file' },
            { id: 'i2', name: 'y', mediaType: 'image/png', cachePath: 'path2', size: 1, source: 'file' },
          ] },
        ],
      };

      const convB: any = {
        id: 'b',
        title: 'B',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        messages: [
          { id: 'm2', role: 'user', content: '', timestamp: 0, images: [
            { id: 'i3', name: 'z', mediaType: 'image/png', cachePath: 'path1', size: 1, source: 'file' },
          ] },
        ],
      };

      (plugin as any).conversations = [convA, convB];
      (plugin as any).cleanupConversationImages(convA);

      expect(deleteSpy).toHaveBeenCalledWith(plugin.app, ['path2']);
      deleteSpy.mockRestore();
    });
  });

  describe('renameConversation', () => {
    it('should rename conversation', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.renameConversation(conv.id, 'New Title');

      const updated = plugin.getActiveConversation();
      expect(updated?.title).toBe('New Title');
    });

    it('should use default title if empty string provided', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.renameConversation(conv.id, '   ');

      const updated = plugin.getActiveConversation();
      expect(updated?.title).toBeTruthy();
    });
  });

  describe('updateConversation', () => {
    it('should update conversation messages', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const messages = [
        { id: 'msg-1', role: 'user' as const, content: 'Hello', timestamp: Date.now() },
      ];

      await plugin.updateConversation(conv.id, { messages });

      const updated = plugin.getActiveConversation();
      expect(updated?.messages).toEqual(messages);
    });

    it('should update conversation sessionId', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.updateConversation(conv.id, { sessionId: 'new-session-id' });

      const updated = plugin.getActiveConversation();
      expect(updated?.sessionId).toBe('new-session-id');
    });

    it('should update updatedAt timestamp', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const originalUpdatedAt = conv.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise(resolve => setTimeout(resolve, 10));

      await plugin.updateConversation(conv.id, { title: 'Changed' });

      const updated = plugin.getActiveConversation();
      expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });
  });

  describe('getConversationList', () => {
    it('should return conversation metadata', async () => {
      await plugin.onload();

      await plugin.createConversation();

      const list = plugin.getConversationList();

      expect(list.length).toBeGreaterThan(0);
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('title');
      expect(list[0]).toHaveProperty('messageCount');
      expect(list[0]).toHaveProperty('preview');
    });

    it('should return preview from first user message', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello Claude', timestamp: Date.now() },
        ],
      });

      const list = plugin.getConversationList();
      const meta = list.find(c => c.id === conv.id);

      expect(meta?.preview).toContain('Hello Claude');
    });
  });

  describe('loadSettings with conversations', () => {
    it('should load saved conversations from JSONL files', async () => {
      const timestamp = Date.now();
      const sessionJsonl = JSON.stringify({
        type: 'meta',
        id: 'conv-saved-1',
        title: 'Saved Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        sessionId: 'saved-session',
      });

      // Mock session file exists
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/sessions' || path === '.claude/sessions/conv-saved-1.jsonl';
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claude/sessions') {
          return { files: ['.claude/sessions/conv-saved-1.jsonl'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/sessions/conv-saved-1.jsonl') {
          return sessionJsonl;
        }
        return '';
      });

      // Mock minimal data.json with activeConversationId
      (plugin.loadData as jest.Mock).mockResolvedValue({
        activeConversationId: 'conv-saved-1',
        migrationVersion: 2,
      });

      await plugin.loadSettings();

      const active = plugin.getActiveConversation();
      expect(active?.id).toBe('conv-saved-1');
      expect(active?.title).toBe('Saved Chat');
    });

    it('should clear session IDs when provider base URL changes', async () => {
      const timestamp = Date.now();
      const sessionJsonl = JSON.stringify({
        type: 'meta',
        id: 'conv-saved-1',
        title: 'Saved Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        sessionId: 'saved-session',
      });

      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/settings.json' ||
          path === '.claude/sessions' ||
          path === '.claude/sessions/conv-saved-1.jsonl';
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claude/sessions') {
          return { files: ['.claude/sessions/conv-saved-1.jsonl'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/settings.json') {
          return JSON.stringify({
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
          });
        }
        if (path === '.claude/sessions/conv-saved-1.jsonl') {
          return sessionJsonl;
        }
        return '';
      });

      (plugin.loadData as jest.Mock).mockResolvedValue({
        activeConversationId: 'conv-saved-1',
        lastEnvHash: 'old-hash',
        migrationVersion: 2,
      });

      await plugin.loadSettings();

      const active = plugin.getActiveConversation();
      expect(active?.sessionId).toBeNull();

      const sessionWrite = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claude/sessions/conv-saved-1.jsonl'
      );
      expect(sessionWrite).toBeDefined();
      const metaLine = (sessionWrite?.[1] as string).split(/\r?\n/)[0];
      const meta = JSON.parse(metaLine);
      expect(meta.sessionId).toBeNull();
    });

    it('should handle invalid activeConversationId', async () => {
      // No sessions exist
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      mockApp.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });

      (plugin.loadData as jest.Mock).mockResolvedValue({
        activeConversationId: 'non-existent',
        migrationVersion: 2,
      });

      await plugin.loadSettings();

      plugin.getConversationList();
      // Should have cleared the invalid ID
      expect(plugin.getActiveConversation()).toBeNull();
    });
  });

});
