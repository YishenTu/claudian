import * as os from 'os';

import { DEFAULT_SETTINGS, VIEW_TYPE_CLAUDIAN } from '@/core/types';
import * as sdkSession from '@/utils/sdkSession';

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
        getLeaf: jest.fn().mockReturnValue({
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
      expect(plugin.settings.blockedCommands).toEqual(DEFAULT_SETTINGS.blockedCommands);
    });

    // Note: With multi-tab, agentService is per-tab via TabManager, not on plugin

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

    it('should migrate legacy cli path to hostname-based paths and clear old field', async () => {
      const legacyPath = '/legacy/claude';
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        // claudeCliPath is now in claudian-settings.json
        return path === '.claude/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/claudian-settings.json') {
          return JSON.stringify({ claudeCliPath: legacyPath });
        }
        return '';
      });

      await plugin.onload();

      const hostname = os.hostname();
      // Should migrate to hostname-based path
      expect(plugin.settings.claudeCliPathsByHost[hostname]).toBe(legacyPath);
      // Should clear legacy field after migration
      expect(plugin.settings.claudeCliPath).toBe('');
      // Should save settings with migrated path and cleared legacy field
      expect(mockApp.vault.adapter.write).toHaveBeenCalled();
      const settingsWrite = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claude/claudian-settings.json'
      );
      expect(settingsWrite).toBeDefined();
      const savedSettings = JSON.parse(settingsWrite[1]);
      expect(savedSettings.claudeCliPathsByHost[hostname]).toBe(legacyPath);
      expect(savedSettings.claudeCliPath).toBe('');
    });
  });

  describe('onunload', () => {
    // Note: With multi-tab, cleanup is handled per-tab via ClaudianView.onClose()
    it('should complete without error', async () => {
      await plugin.onload();

      expect(() => plugin.onunload()).not.toThrow();
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

    it('should create new leaf in main editor area when openInMainTab is enabled', async () => {
      const mockMainLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeaf.mockReturnValue(mockMainLeaf);

      await plugin.onload();
      plugin.settings.openInMainTab = true;
      await plugin.activateView();

      expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith('tab');
      expect(mockApp.workspace.getRightLeaf).not.toHaveBeenCalled();
      expect(mockMainLeaf.setViewState).toHaveBeenCalledWith({
        type: VIEW_TYPE_CLAUDIAN,
        active: true,
      });
    });

    it('should handle null main leaf gracefully when openInMainTab is enabled', async () => {
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeaf.mockReturnValue(null);

      await plugin.onload();
      plugin.settings.openInMainTab = true;

      await expect(plugin.activateView()).resolves.not.toThrow();
    });
  });

  describe('loadSettings', () => {
    it('should merge saved data with defaults', async () => {
      // Mock claudian-settings.json exists with custom values (Claudian-specific settings)
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/claudian-settings.json') {
          return JSON.stringify({
            enableBlocklist: false,
          });
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.settings.enableBlocklist).toBe(false);
      // Should still have defaults for blockedCommands
      expect(plugin.settings.blockedCommands).toEqual(DEFAULT_SETTINGS.blockedCommands);
    });

    it('should normalize blockedCommands when stored value is partial', async () => {
      // Mock claudian-settings.json exists with partial blockedCommands
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/claudian-settings.json') {
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
      // Mock claudian-settings.json with environment variables
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/claudian-settings.json') {
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
    it('should save settings to file', async () => {
      await plugin.onload();

      plugin.settings.enableBlocklist = false;

      await plugin.saveSettings();

      // Claudian-specific settings should be written to .claude/claudian-settings.json
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        '.claude/claudian-settings.json',
        expect.stringContaining('"enableBlocklist": false')
      );

      // The written content should include state fields
      const writeCall = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claude/claudian-settings.json'
      );
      expect(writeCall).toBeDefined();
      const content = JSON.parse(writeCall[1]);
      expect(content).not.toHaveProperty('activeConversationId');
      expect(content).toHaveProperty('lastEnvHash');
      expect(content).toHaveProperty('lastClaudeModel');
      expect(content).toHaveProperty('lastCustomModel');
      // Permissions are now in .claude/settings.json (CC format), not claudian-settings.json
      expect(content).not.toHaveProperty('permissions');
    });
  });

  describe('applyEnvironmentVariables', () => {
    it('updates runtime env vars when changed', async () => {
      await plugin.onload();
      (plugin as any).runtimeEnvironmentVariables = 'A=1';

      await plugin.applyEnvironmentVariables('A=2');
      expect((plugin as any).runtimeEnvironmentVariables).toBe('A=2');

      await plugin.applyEnvironmentVariables('A=3');
      expect((plugin as any).runtimeEnvironmentVariables).toBe('A=3');

      // No change - should not update
      const currentEnv = (plugin as any).runtimeEnvironmentVariables;
      await plugin.applyEnvironmentVariables('A=3');
      expect((plugin as any).runtimeEnvironmentVariables).toBe(currentEnv);
    });

    it('invalidates sessions when env hash changes', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation('session-123');
      const saveMetadataSpy = jest.spyOn(plugin.storage.sessions, 'saveMetadata');
      saveMetadataSpy.mockClear();

      await plugin.applyEnvironmentVariables('ANTHROPIC_MODEL=claude-sonnet-4-5');

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.sessionId).toBeNull();
      expect(saveMetadataSpy).toHaveBeenCalled();
    });

    it('broadcasts ensureReady with force when env changes without model change', async () => {
      await plugin.onload();

      // Mock getView to return a view with tabManager
      const mockEnsureReady = jest.fn().mockResolvedValue(true);
      const mockBroadcast = jest.fn().mockImplementation(async (fn) => {
        await fn({ ensureReady: mockEnsureReady });
      });
      const mockTabManager = {
        broadcastToAllTabs: mockBroadcast,
        getAllTabs: jest.fn().mockReturnValue([]),
      };
      const mockView = {
        getTabManager: jest.fn().mockReturnValue(mockTabManager),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getView').mockReturnValue(mockView as any);

      // Change env but not in a way that affects model
      await plugin.applyEnvironmentVariables('SOME_VAR=value');

      expect(mockBroadcast).toHaveBeenCalled();
      expect(mockEnsureReady).toHaveBeenCalledWith({ force: true });
    });
  });

  describe('ribbon icon callback', () => {
    it('reveals existing view when ribbon icon is clicked', async () => {
      await plugin.onload();
      const mockLeaf = { id: 'existing' };
      mockApp.workspace.getLeavesOfType.mockReturnValue([mockLeaf]);

      const ribbonCallback = (plugin.addRibbonIcon as jest.Mock).mock.calls[0][2];
      await ribbonCallback();

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
    });
  });

  describe('command callback', () => {
    it('reveals existing view when command is executed', async () => {
      await plugin.onload();
      const mockLeaf = { id: 'existing' };
      mockApp.workspace.getLeavesOfType.mockReturnValue([mockLeaf]);

      const commandConfig = (plugin.addCommand as jest.Mock).mock.calls[0][0];
      await commandConfig.callback();

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
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

    it('should allow retrieving created conversation by ID', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const fetched = await plugin.getConversationById(conv.id);

      expect(fetched?.id).toBe(conv.id);
    });

    it('should generate default title with timestamp', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      // Title should contain month and time
      expect(conv.title).toBeTruthy();
      expect(conv.title.length).toBeGreaterThan(0);
    });

    // Note: Session management is now per-tab via TabManager
  });

  describe('switchConversation', () => {
    it('should switch to existing conversation', async () => {
      await plugin.onload();

      const conv1 = await plugin.createConversation();
      await plugin.createConversation(); // Create second conversation to switch from

      const result = await plugin.switchConversation(conv1.id);

      expect(result?.id).toBe(conv1.id);
    });

    // Note: Session ID restoration is now handled per-tab via TabManager

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

    it('should allow deleting last conversation without recreating', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.deleteConversation(conv.id);

      const list = plugin.getConversationList();
      expect(list.find(c => c.id === conv.id)).toBeUndefined();
    });
  });

  describe('renameConversation', () => {
    it('should rename conversation', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.renameConversation(conv.id, 'New Title');

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.title).toBe('New Title');
    });

    it('should use default title if empty string provided', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.renameConversation(conv.id, '   ');

      const updated = await plugin.getConversationById(conv.id);
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

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.messages).toEqual(messages);
    });

    it('should update conversation sessionId', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();

      await plugin.updateConversation(conv.id, { sessionId: 'new-session-id' });

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.sessionId).toBe('new-session-id');
    });

    it('should update updatedAt timestamp', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const originalUpdatedAt = conv.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise(resolve => setTimeout(resolve, 10));

      await plugin.updateConversation(conv.id, { title: 'Changed' });

      const updated = await plugin.getConversationById(conv.id);
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

      // Mock files exist
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        // Session files
        if (path === '.claude/sessions' || path === '.claude/sessions/conv-saved-1.jsonl') {
          return true;
        }
        // claudian-settings.json exists
        if (path === '.claude/claudian-settings.json') {
          return true;
        }
        return false;
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
        if (path === '.claude/claudian-settings.json') {
          return JSON.stringify({});
        }
        return '';
      });

      // data.json is minimal (no state - already migrated)
      (plugin.loadData as jest.Mock).mockResolvedValue({});

      await plugin.loadSettings();

      const loaded = await plugin.getConversationById('conv-saved-1');
      expect(loaded?.id).toBe('conv-saved-1');
      expect(loaded?.title).toBe('Saved Chat');
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
        return path === '.claude/claudian-settings.json' ||
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
        if (path === '.claude/claudian-settings.json') {
          // All these fields are now in claudian-settings.json
          return JSON.stringify({
            lastEnvHash: 'old-hash',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
          });
        }
        if (path === '.claude/sessions/conv-saved-1.jsonl') {
          return sessionJsonl;
        }
        return '';
      });

      // data.json is minimal (already migrated)
      (plugin.loadData as jest.Mock).mockResolvedValue({});

      await plugin.loadSettings();

      const loaded = await plugin.getConversationById('conv-saved-1');
      expect(loaded?.sessionId).toBeNull();

      const sessionWrite = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claude/sessions/conv-saved-1.jsonl'
      );
      expect(sessionWrite).toBeDefined();
      const metaLine = (sessionWrite?.[1] as string).split(/\r?\n/)[0];
      const meta = JSON.parse(metaLine);
      expect(meta.sessionId).toBeNull();
    });

    it('should ignore legacy activeConversationId when no sessions exist', async () => {
      // No sessions exist
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      mockApp.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });

      (plugin.loadData as jest.Mock).mockResolvedValue({
        activeConversationId: 'non-existent',
        migrationVersion: 2,
      });

      await plugin.loadSettings();

      expect(plugin.getConversationList()).toHaveLength(0);
    });
  });

  describe('Multi-session message loading', () => {
    it('should load messages from previousSdkSessionIds when present', async () => {
      const timestamp = Date.now();

      // Setup conversation with previousSdkSessionIds
      const sessionMeta = JSON.stringify({
        type: 'meta',
        id: 'conv-multi-session',
        title: 'Multi Session Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        sdkSessionId: 'session-B',
        previousSdkSessionIds: ['session-A'],
        isNative: true,
      });

      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claude/claudian-settings.json' ||
          path === '.claude/sessions' ||
          path === '.claude/sessions/conv-multi-session.meta.json';
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claude/sessions') {
          return { files: ['.claude/sessions/conv-multi-session.meta.json'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claude/sessions/conv-multi-session.meta.json') {
          return sessionMeta;
        }
        if (path === '.claude/claudian-settings.json') {
          return JSON.stringify({});
        }
        return '';
      });

      (plugin.loadData as jest.Mock).mockResolvedValue({});

      await plugin.loadSettings();

      const loaded = await plugin.getConversationById('conv-multi-session');
      expect(loaded?.previousSdkSessionIds).toEqual(['session-A']);
      expect(loaded?.sdkSessionId).toBe('session-B');
    });

    it('should preserve previousSdkSessionIds through conversation updates', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        sdkSessionId: 'session-B',
        previousSdkSessionIds: ['session-A'],
        isNative: true,
      });

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.previousSdkSessionIds).toEqual(['session-A']);
      expect(updated?.sdkSessionId).toBe('session-B');

      // Further update should preserve previousSdkSessionIds
      await plugin.updateConversation(conv.id, {
        title: 'Updated Title',
      });

      const afterTitleUpdate = await plugin.getConversationById(conv.id);
      expect(afterTitleUpdate?.previousSdkSessionIds).toEqual(['session-A']);
    });

    it('should handle empty previousSdkSessionIds array', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        sdkSessionId: 'session-A',
        previousSdkSessionIds: [],
        isNative: true,
      });

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.previousSdkSessionIds).toEqual([]);
    });
  });

  describe('loadSdkMessagesForConversation - fork branch', () => {
    it('should load from forkSource.sessionId and truncate at forkSource.resumeAt for pending fork', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        isNative: true,
        forkSource: { sessionId: 'source-session-abc', resumeAt: 'asst-uuid-cutoff' },
        // No sessionId or sdkSessionId → isPendingFork returns true
        sessionId: null,
        sdkSessionId: undefined,
        // Reset sdkMessagesLoaded to simulate plugin restart
        sdkMessagesLoaded: false,
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [
          { id: 'sdk-msg-1', role: 'user', content: 'Hello', timestamp: 1000 },
          { id: 'sdk-msg-2', role: 'assistant', content: 'Hi', timestamp: 1001 },
        ],
        skippedLines: 0,
      });

      // Trigger loadSdkMessagesForConversation via public API
      const loaded = await plugin.getConversationById(conv.id);

      // Should check existence of source session, not the conversation's own session
      expect(existsSpy).toHaveBeenCalledWith(
        expect.any(String),
        'source-session-abc'
      );

      // Should load from forkSource.sessionId with forkSource.resumeAt as truncation point
      expect(loadSpy).toHaveBeenCalledWith(
        expect.any(String),
        'source-session-abc',
        'asst-uuid-cutoff'
      );

      // Messages should be loaded
      expect(loaded?.sdkMessagesLoaded).toBe(true);

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('should NOT use fork path when conversation has its own sdkSessionId', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        isNative: true,
        forkSource: { sessionId: 'source-session', resumeAt: 'asst-uuid' },
        sdkSessionId: 'own-session-id',
        sdkMessagesLoaded: false,
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      await plugin.getConversationById(conv.id);

      // Should load from own session, not forkSource session
      expect(existsSpy).toHaveBeenCalledWith(
        expect.any(String),
        'own-session-id'
      );

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });
  });

  describe('loadSdkMessagesForConversation - subagent recovery', () => {
    it('restores subagent data when Task tool exists but subagent content block is missing', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        isNative: true,
        sdkSessionId: 'session-subagent-recovery',
        sdkMessagesLoaded: false,
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-1',
                name: 'Task',
                input: { description: 'Do sub task' },
                status: 'completed',
                result: 'Task completed',
              } as any,
            ],
            // Simulate partial persisted blocks that lost the task tool block.
            contentBlocks: [{ type: 'text', content: 'Done' }] as any,
          } as any,
        ],
        subagentData: {
          'task-1': {
            id: 'task-1',
            description: 'Recovered subagent',
            status: 'completed',
            result: 'Recovered result',
            toolCalls: [
              {
                id: 'sub-tool-1',
                name: 'Read',
                input: { file_path: 'README.md' },
                status: 'completed',
                result: 'content',
              } as any,
            ],
            isExpanded: false,
          } as any,
        },
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      expect(loadSpy).toHaveBeenCalledWith(
        expect.any(String),
        'session-subagent-recovery',
        undefined
      );
      expect(loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-1')).toEqual(
        expect.objectContaining({
          subagent: expect.objectContaining({
            id: 'task-1',
            description: 'Recovered subagent',
            result: 'Recovered result',
          }),
        })
      );
      expect(loaded?.messages[0].contentBlocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'subagent', subagentId: 'task-1' }),
        ])
      );

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('restores async subagent data and mode when Task tool exists but async block is missing', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        isNative: true,
        sdkSessionId: 'session-async-subagent-recovery',
        sdkMessagesLoaded: false,
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-async-1',
                name: 'Task',
                input: { description: 'Do background task', run_in_background: true },
                status: 'completed',
                result: 'Task started',
              } as any,
            ],
            contentBlocks: [{ type: 'text', content: 'Started' }] as any,
          } as any,
        ],
        subagentData: {
          'task-async-1': {
            id: 'task-async-1',
            description: 'Recovered async subagent',
            mode: 'async',
            asyncStatus: 'completed',
            status: 'completed',
            result: 'Recovered async result',
            toolCalls: [],
            isExpanded: false,
          } as any,
        },
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const block = loaded?.messages[0].contentBlocks?.find(
        (b: any) => b.type === 'subagent' && b.subagentId === 'task-async-1'
      ) as any;

      expect(loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-async-1')).toEqual(
        expect.objectContaining({
          id: 'task-async-1',
          subagent: expect.objectContaining({
            id: 'task-async-1',
            mode: 'async',
            asyncStatus: 'completed',
          }),
        })
      );
      expect(block).toEqual(
        expect.objectContaining({ type: 'subagent', subagentId: 'task-async-1', mode: 'async' })
      );

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('hydrates async subagent tool calls from SDK subagent files on reload', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        isNative: true,
        sdkSessionId: 'session-async-subagent-tools',
        sdkMessagesLoaded: false,
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-async-tools',
                name: 'Task',
                input: { description: 'Do background task', run_in_background: true },
                status: 'completed',
                result: 'Task started',
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-async-tools', mode: 'async' }] as any,
          } as any,
        ],
        subagentData: {
          'task-async-tools': {
            id: 'task-async-tools',
            description: 'Recovered async subagent',
            mode: 'async',
            asyncStatus: 'completed',
            status: 'completed',
            result: 'Recovered async result',
            agentId: 'agent-a123',
            toolCalls: [],
            isExpanded: false,
          } as any,
        },
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });
      const loadSubagentToolsSpy = jest.spyOn(sdkSession, 'loadSubagentToolCalls').mockResolvedValue([
        {
          id: 'sub-tool-1',
          name: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
          result: 'ok',
          isExpanded: false,
        } as any,
      ]);

      const loaded = await plugin.getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-async-tools');

      expect(loadSubagentToolsSpy).toHaveBeenCalledWith(
        expect.any(String),
        'session-async-subagent-tools',
        'agent-a123'
      );
      expect(taskTool?.subagent?.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'sub-tool-1',
            name: 'Bash',
            result: 'ok',
          }),
        ])
      );

      existsSpy.mockRestore();
      loadSpy.mockRestore();
      loadSubagentToolsSpy.mockRestore();
    });

    it('keeps async subagent renderer visible when task block and task tool call are both missing', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        isNative: true,
        sdkSessionId: 'session-async-subagent-fallback',
        sdkMessagesLoaded: false,
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Background work started',
            timestamp: 1000,
            contentBlocks: [{ type: 'text', content: 'Background work started' }] as any,
          } as any,
        ],
        subagentData: {
          'task-async-orphan': {
            id: 'task-async-orphan',
            description: 'Recovered async orphan subagent',
            mode: 'async',
            asyncStatus: 'running',
            status: 'running',
            result: 'Running in background',
            toolCalls: [],
            isExpanded: false,
          } as any,
        },
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const assistant = loaded?.messages.find(m => m.id === 'assistant-1');
      const block = assistant?.contentBlocks?.find(
        (b: any) => b.type === 'subagent' && b.subagentId === 'task-async-orphan'
      ) as any;

      expect(assistant?.toolCalls?.find((tc: any) => tc.id === 'task-async-orphan')).toEqual(
        expect.objectContaining({
          id: 'task-async-orphan',
          name: 'Task',
          subagent: expect.objectContaining({
            id: 'task-async-orphan',
            mode: 'async',
            asyncStatus: 'running',
          }),
        })
      );
      expect(block).toEqual(
        expect.objectContaining({
          type: 'subagent',
          subagentId: 'task-async-orphan',
          mode: 'async',
        })
      );

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });
  });

});
