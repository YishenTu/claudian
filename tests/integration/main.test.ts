
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import * as sdkSession from '@/providers/claude/history/ClaudeHistoryStore';
import { SessionStorage } from '@/providers/claude/storage/SessionStorage';
import { DEFAULT_SETTINGS } from '@/providers/claude/types/settings';

// Mock fs for ClaudianService
jest.mock('fs');

// Now import the plugin after mocking
import ClaudianPlugin from '@/main';

describe('ClaudianPlugin', () => {
  let plugin: ClaudianPlugin;
  let mockApp: any;
  let mockManifest: any;

  function getRegisteredCommand(commandId: string) {
    const call = (plugin.addCommand as jest.Mock).mock.calls.find(
      ([config]) => config.id === commandId,
    );

    if (!call) {
      throw new Error(`Command ${commandId} was not registered`);
    }

    return call[0];
  }

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    jest.spyOn(sdkSession, 'locateSDKSession').mockImplementation(async (_vaultPath, sessionId) => ({
      availability: 'available',
      sessionPath: `/test/claude-project/${sessionId}.jsonl`,
    }));
    jest.spyOn(sdkSession, 'locateSDKSessions').mockImplementation(async (_vaultPath, sessionIds) => new Map(
      sessionIds.map(sessionId => [sessionId, {
        availability: 'available' as const,
        sessionPath: `/test/claude-project/${sessionId}.jsonl`,
      }]),
    ));

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
        onLayoutReady: jest.fn(),
        getLeavesOfType: jest.fn().mockReturnValue([]),
        getRightLeaf: jest.fn().mockReturnValue({
          setViewState: jest.fn().mockResolvedValue(undefined),
        }),
        getLeftLeaf: jest.fn().mockReturnValue({
          setViewState: jest.fn().mockResolvedValue(undefined),
        }),
        getLeaf: jest.fn().mockReturnValue({
          setViewState: jest.fn().mockResolvedValue(undefined),
        }),
        setActiveLeaf: jest.fn(),
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
      expect(plugin.settings.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
      expect(plugin.settings.hiddenProviderCommands).toEqual(DEFAULT_SETTINGS.hiddenProviderCommands);
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

    it('loads restored-tab metadata without waiting for the full history scan', async () => {
      let finishHistoryScan!: (value: []) => void;
      const historyScan = new Promise<[]>((resolve) => {
        finishHistoryScan = resolve;
      });
      const restoredMetadata = {
        id: 'restored-conversation',
        providerId: 'claude' as const,
        title: 'Restored conversation',
        createdAt: 1,
        updatedAt: 2,
      };
      const listSpy = jest.spyOn(SessionStorage.prototype, 'listMetadata')
        .mockReturnValue(historyScan);
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'loadMetadata')
        .mockResolvedValue(restoredMetadata);
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          openTabs: [{ tabId: 'tab-1', conversationId: restoredMetadata.id }],
          activeTabId: 'tab-1',
        },
      });

      const onloadPromise = plugin.onload();
      const completedBeforeHistoryScan = await Promise.race([
        onloadPromise.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 20)),
      ]);
      finishHistoryScan([]);
      await onloadPromise;
      const cachedConversation = plugin.getCachedConversation(restoredMetadata.id);
      const didLoadRestoredMetadata = loadSpy.mock.calls.some(
        ([id]) => id === restoredMetadata.id,
      );
      listSpy.mockRestore();
      loadSpy.mockRestore();

      expect(completedBeforeHistoryScan).toBe(true);
      expect(didLoadRestoredMetadata).toBe(true);
      expect(cachedConversation?.title).toBe(restoredMetadata.title);
    });

    it('publishes the remaining conversation metadata after layout readiness', async () => {
      let layoutReady!: () => void;
      const backgroundMetadata = {
        id: 'background-conversation',
        providerId: 'claude' as const,
        title: 'Background conversation',
        createdAt: 1,
        updatedAt: 2,
      };
      mockApp.workspace.onLayoutReady = jest.fn((callback: () => void) => {
        layoutReady = callback;
      });
      const listSpy = jest.spyOn(SessionStorage.prototype, 'listMetadata')
        .mockResolvedValue([backgroundMetadata]);

      await plugin.onload();
      const beforeLayoutReady = plugin.getCachedConversation(backgroundMetadata.id);
      layoutReady();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (plugin.getCachedConversation(backgroundMetadata.id)) break;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      const afterBackgroundLoad = plugin.getCachedConversation(backgroundMetadata.id);
      const listCallCount = listSpy.mock.calls.length;
      listSpy.mockRestore();

      expect(beforeLayoutReady).toBeNull();
      expect(listCallCount).toBe(1);
      expect(afterBackgroundLoad?.title).toBe(backgroundMetadata.title);
    });

    it('invalidates restored and deferred sessions after a provider environment change', async () => {
      const restoredMetadata = {
        id: 'restored-environment-session',
        providerId: 'claude' as const,
        title: 'Restored environment session',
        createdAt: 1,
        updatedAt: 3,
        sessionId: 'restored-session-id',
        providerState: { providerSessionId: 'restored-provider-session-id' },
        resumeAtMessageId: 'restored-message-id',
      };
      const deferredMetadata = {
        id: 'deferred-environment-session',
        providerId: 'claude' as const,
        title: 'Deferred environment session',
        createdAt: 1,
        updatedAt: 2,
        sessionId: 'deferred-session-id',
        providerState: { providerSessionId: 'deferred-provider-session-id' },
        resumeAtMessageId: 'deferred-message-id',
      };
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => (
        path === '.claudian/claudian-settings.json'
      ));
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({
            providerConfigs: {
              claude: {
                environmentHash: 'ANTHROPIC_BASE_URL=https://old.example.com',
                environmentVariables: 'ANTHROPIC_BASE_URL=https://new.example.com',
              },
            },
          });
        }
        return '';
      });
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          openTabs: [{ tabId: 'tab-1', conversationId: restoredMetadata.id }],
          activeTabId: 'tab-1',
        },
      });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'loadMetadata')
        .mockResolvedValue(restoredMetadata);
      const listSpy = jest.spyOn(SessionStorage.prototype, 'listMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([restoredMetadata, deferredMetadata]);
          return [restoredMetadata, deferredMetadata];
        });

      await plugin.onload();
      await (plugin as any).loadRemainingSessionMetadata();

      const restored = plugin.getCachedConversation(restoredMetadata.id);
      const deferred = plugin.getCachedConversation(deferredMetadata.id);
      loadSpy.mockRestore();
      listSpy.mockRestore();

      expect(restored).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: undefined,
      }));
      expect(restored).not.toHaveProperty('resumeAtMessageId');
      expect(deferred).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: undefined,
      }));
      expect(deferred).not.toHaveProperty('resumeAtMessageId');
    });

    it('invalidates later metadata batches when the environment changes during the scan', async () => {
      const firstMetadata = {
        id: 'first-scanned-session',
        providerId: 'claude' as const,
        title: 'First scanned session',
        createdAt: 1,
        updatedAt: 2,
        sessionId: 'first-session-id',
        providerState: { providerSessionId: 'first-provider-session-id' },
      };
      const laterMetadata = {
        id: 'later-scanned-session',
        providerId: 'claude' as const,
        title: 'Later scanned session',
        createdAt: 1,
        updatedAt: 1,
        sessionId: 'later-session-id',
        providerState: { providerSessionId: 'later-provider-session-id' },
      };
      let markFirstBatchPublished!: () => void;
      const firstBatchPublished = new Promise<void>((resolve) => {
        markFirstBatchPublished = resolve;
      });
      let releaseLaterBatch!: () => void;
      const laterBatchRelease = new Promise<void>((resolve) => {
        releaseLaterBatch = resolve;
      });

      await plugin.onload();
      const listSpy = jest.spyOn(SessionStorage.prototype, 'listMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([firstMetadata]);
          markFirstBatchPublished();
          await laterBatchRelease;
          options?.onBatch?.([laterMetadata]);
          return [firstMetadata, laterMetadata];
        });

      const load = (plugin as any).loadRemainingSessionMetadata();
      await firstBatchPublished;
      await plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://changed-during-scan.example.com',
      );
      releaseLaterBatch();
      await load;

      const first = plugin.getCachedConversation(firstMetadata.id);
      const later = plugin.getCachedConversation(laterMetadata.id);
      listSpy.mockRestore();

      expect(first?.sessionId).toBeNull();
      expect(first?.providerState).toBeUndefined();
      expect(later?.sessionId).toBeNull();
      expect(later?.providerState).toBeUndefined();
    });

    it('does not persist a background metadata shell deleted before reconciliation', async () => {
      let finishScan!: () => void;
      let markBatchPublished!: () => void;
      const scanRelease = new Promise<void>((resolve) => {
        finishScan = resolve;
      });
      const batchPublished = new Promise<void>((resolve) => {
        markBatchPublished = resolve;
      });
      const backgroundMetadata = {
        id: 'deleted-background-conversation',
        providerId: 'claude' as const,
        title: 'Deleted background conversation',
        createdAt: 1,
        updatedAt: 2,
      };

      await plugin.onload();
      const listSpy = jest.spyOn(SessionStorage.prototype, 'listMetadata').mockImplementation(async (options) => {
        options?.onBatch?.([backgroundMetadata]);
        markBatchPublished();
        await scanRelease;
        return [backgroundMetadata];
      });
      const invalidateSpy = jest.spyOn(
        ProviderSettingsCoordinator,
        'invalidateConversationSessions',
      ).mockImplementation((conversations) => [...conversations]);
      const saveMetadataSpy = jest.spyOn(plugin.storage.sessions, 'saveMetadata');

      const load = (plugin as any).loadRemainingSessionMetadata();
      await batchPublished;
      await plugin.deleteConversation(backgroundMetadata.id, { deleteProviderSession: false });
      saveMetadataSpy.mockClear();
      finishScan();
      await load;
      const invalidationCallCount = invalidateSpy.mock.calls.length;
      const saveMetadataCallCount = saveMetadataSpy.mock.calls.length;
      listSpy.mockRestore();
      invalidateSpy.mockRestore();
      saveMetadataSpy.mockRestore();

      expect(invalidationCallCount).toBeGreaterThan(0);
      expect(saveMetadataCallCount).toBe(0);
      expect(plugin.getCachedConversation(backgroundMetadata.id)).toBeNull();
    });

  });

  describe('onunload', () => {
    it('should complete without error', async () => {
      await plugin.onload();

      expect(() => plugin.onunload()).not.toThrow();
    });

    it('keeps the latest open-tab snapshot when views are not closed first', async () => {
      await plugin.onload();
      const state = {
        openTabs: [{ tabId: 'tab-1', conversationId: 'conversation-1' }],
        activeTabId: 'tab-1',
      };
      const persistSpy = jest.spyOn(plugin, 'persistTabManagerState').mockResolvedValue(undefined);
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        view: {
          getPersistedTabState: jest.fn().mockReturnValue(state),
          getTabManager: jest.fn(),
        },
      }]);

      plugin.onunload();
      await Promise.resolve();
      await Promise.resolve();

      expect(persistSpy).toHaveBeenCalledWith(state);
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

    it('should create new leaf in right sidebar by default if view does not exist', async () => {
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

    it('should create new leaf in left sidebar when chatViewPlacement is left-sidebar', async () => {
      const mockLeftLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeftLeaf.mockReturnValue(mockLeftLeaf);

      await plugin.onload();
      plugin.settings.chatViewPlacement = 'left-sidebar';
      await plugin.activateView();

      expect(mockApp.workspace.getLeftLeaf).toHaveBeenCalledWith(false);
      expect(mockApp.workspace.getRightLeaf).not.toHaveBeenCalled();
      expect(mockApp.workspace.getLeaf).not.toHaveBeenCalled();
      expect(mockLeftLeaf.setViewState).toHaveBeenCalledWith({
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

    it('should create new leaf in main editor area when chatViewPlacement is main-tab', async () => {
      const mockMainLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeaf.mockReturnValue(mockMainLeaf);

      await plugin.onload();
      plugin.settings.chatViewPlacement = 'main-tab';
      await plugin.activateView();

      expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith('tab');
      expect(mockApp.workspace.getRightLeaf).not.toHaveBeenCalled();
      expect(mockApp.workspace.getLeftLeaf).not.toHaveBeenCalled();
      expect(mockMainLeaf.setViewState).toHaveBeenCalledWith({
        type: VIEW_TYPE_CLAUDIAN,
        active: true,
      });
    });

    it('should handle null main leaf gracefully when chatViewPlacement is main-tab', async () => {
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeaf.mockReturnValue(null);

      await plugin.onload();
      plugin.settings.chatViewPlacement = 'main-tab';

      await expect(plugin.activateView()).resolves.not.toThrow();
    });
  });

  describe('loadSettings', () => {
    it('should merge saved data with defaults', async () => {
      // Mock claudian-settings.json exists with custom values (Claudian-specific settings)
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({
            userName: 'TestUser',
          });
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.settings.userName).toBe('TestUser');
      expect(plugin.settings.hiddenProviderCommands).toEqual(DEFAULT_SETTINGS.hiddenProviderCommands);
    });

    it('should strip legacy blocklist fields when loading old settings', async () => {
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({
            enableBlocklist: false,
            blockedCommands: { unix: ['rm -rf', '  '] },
          });
        }
        return '';
      });

      await plugin.loadSettings();

      expect('enableBlocklist' in plugin.settings).toBe(false);
      expect('blockedCommands' in plugin.settings).toBe(false);
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        '.claudian/claudian-settings.json',
        expect.any(String),
      );
      const writeCall = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claudian/claudian-settings.json',
      );
      expect(writeCall).toBeDefined();
      const content = JSON.parse(writeCall[1]);
      expect(content).not.toHaveProperty('enableBlocklist');
      expect(content).not.toHaveProperty('blockedCommands');
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

    it('should migrate legacy openInMainTab true to main-tab placement', async () => {
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({ openInMainTab: true });
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.settings.chatViewPlacement).toBe('main-tab');
      const writeCall = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claudian/claudian-settings.json',
      );
      expect(writeCall).toBeDefined();
      const content = JSON.parse(writeCall[1]);
      expect(content.chatViewPlacement).toBe('main-tab');
      expect(content).not.toHaveProperty('openInMainTab');
    });

    it('should reconcile model from environment and persist when changed', async () => {
      // Mock claudian-settings.json with environment variables
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({
            environmentVariables: 'ANTHROPIC_MODEL=custom-model',
            lastEnvHash: '',
          });
        }
        return '';
      });

      const saveSpy = jest.spyOn(plugin, 'saveSettings');
      await plugin.loadSettings();

      expect(plugin.settings.model).toBe('claude-code/custom-model');
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  describe('saveSettings', () => {
    it('should save settings to file', async () => {
      await plugin.onload();

      await plugin.saveSettings();

      // Claudian-specific settings should be written to .claudian/claudian-settings.json
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        '.claudian/claudian-settings.json',
        expect.any(String)
      );

      // The written content should include state fields
      const writeCall = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claudian/claudian-settings.json'
      );
      expect(writeCall).toBeDefined();
      const content = JSON.parse(writeCall[1]);
      expect(content).not.toHaveProperty('activeConversationId');
      expect(content).toHaveProperty('providerConfigs.claude.environmentHash');
      expect(content).toHaveProperty('providerConfigs.claude.lastModel');
      expect(content).toHaveProperty('lastCustomModel');
      expect(content).not.toHaveProperty('enableBlocklist');
      expect(content).not.toHaveProperty('blockedCommands');
      // Permissions are now in .claude/settings.json (CC format), not claudian-settings.json
      expect(content).not.toHaveProperty('permissions');
    });
  });

  describe('applyEnvironmentVariables', () => {
    it('updates runtime env vars when changed', async () => {
      await plugin.onload();

      await plugin.applyEnvironmentVariables('shared', 'A=2');
      expect(plugin.getEnvironmentVariablesForScope('shared')).toBe('A=2');

      await plugin.applyEnvironmentVariables('shared', 'A=3');
      expect(plugin.getEnvironmentVariablesForScope('shared')).toBe('A=3');

      // No change - should not update
      const currentEnv = plugin.getEnvironmentVariablesForScope('shared');
      await plugin.applyEnvironmentVariables('shared', 'A=3');
      expect(plugin.getEnvironmentVariablesForScope('shared')).toBe(currentEnv);
    });

    it('invalidates sessions when env hash changes', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation({ sessionId: 'session-123' });
      const saveMetadataSpy = jest.spyOn(plugin.storage.sessions, 'saveMetadata');
      saveMetadataSpy.mockClear();

      await plugin.applyEnvironmentVariables('provider:claude', 'ANTHROPIC_MODEL=claude-sonnet-4-5');

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.sessionId).toBeNull();
      expect(saveMetadataSpy).toHaveBeenCalled();
    });

    it('broadcasts ensureReady with force when env changes without model change', async () => {
      await plugin.onload();

      // Mock one open view with an initialized Claude runtime.
      const mockSyncConversationState = jest.fn();
      const mockEnsureReady = jest.fn().mockResolvedValue(true);
      const mockTabManager = {
        getAllTabs: jest.fn().mockReturnValue([{
          providerId: 'claude',
          conversationId: null,
          state: { isStreaming: false },
          serviceInitialized: true,
          service: {
            ensureReady: mockEnsureReady,
            syncConversationState: mockSyncConversationState,
          },
          ui: { externalContextSelector: { getExternalContexts: jest.fn().mockReturnValue([]) } },
        }]),
      };
      const mockView = {
        getTabManager: jest.fn().mockReturnValue(mockTabManager),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      // Change env but not in a way that affects model
      await plugin.applyEnvironmentVariables('shared', 'SOME_VAR=value');

      expect(mockSyncConversationState).toHaveBeenCalledWith(null, []);
      expect(mockEnsureReady).toHaveBeenCalledWith({ force: true });
    });

    it('restarts affected runtimes in every open Claudian view', async () => {
      await plugin.onload();

      const createView = () => {
        const ensureReady = jest.fn().mockResolvedValue(true);
        const tabManager = {
          getAllTabs: jest.fn().mockReturnValue([{
            providerId: 'claude',
            conversationId: null,
            state: { isStreaming: false },
            serviceInitialized: true,
            service: {
              ensureReady,
              syncConversationState: jest.fn(),
            },
            ui: { externalContextSelector: { getExternalContexts: jest.fn().mockReturnValue([]) } },
          }]),
        };
        return {
          ensureReady,
          view: {
            getTabManager: jest.fn().mockReturnValue(tabManager),
            invalidateProviderCommandCaches: jest.fn(),
            refreshModelSelector: jest.fn(),
          },
        };
      };
      const first = createView();
      const second = createView();
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([
        first.view as any,
        second.view as any,
      ]);

      await plugin.applyEnvironmentVariables('shared', 'SOME_VAR=value');

      expect(first.ensureReady).toHaveBeenCalledWith({ force: true });
      expect(second.ensureReady).toHaveBeenCalledWith({ force: true });
    });

    it('syncs live external contexts before restarting invalidated Claude runtimes', async () => {
      await plugin.onload();

      const conversation = await plugin.createConversation({
        providerId: 'claude',
        sessionId: 'session-123',
      });
      await plugin.updateConversation(conversation.id, {
        externalContextPaths: ['/saved/context'],
        messages: [{
          content: 'hi',
          id: 'msg-1',
          role: 'user',
          timestamp: Date.now(),
          userMessageId: 'msg-1',
        }],
      });

      const mockSyncConversationState = jest.fn();
      const mockResetSession = jest.fn();
      const mockEnsureReady = jest.fn().mockResolvedValue(true);
      const mockTabManager = {
        getAllTabs: jest.fn().mockReturnValue([{
          conversationId: conversation.id,
          providerId: 'claude',
          state: { isStreaming: false },
          serviceInitialized: true,
          service: {
            ensureReady: mockEnsureReady,
            resetSession: mockResetSession,
            syncConversationState: mockSyncConversationState,
          },
          ui: { externalContextSelector: { getExternalContexts: jest.fn().mockReturnValue(['/live/context']) } },
        }]),
      };
      const mockView = {
        getTabManager: jest.fn().mockReturnValue(mockTabManager),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.applyEnvironmentVariables('provider:claude', 'ANTHROPIC_MODEL=claude-sonnet-4-5');

      expect(mockSyncConversationState).toHaveBeenCalledWith(
        expect.objectContaining({ id: conversation.id }),
        ['/live/context'],
      );
      expect(mockResetSession).toHaveBeenCalledTimes(1);
      expect(mockEnsureReady).toHaveBeenCalledWith();
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

  describe('new-tab command', () => {
    it('opens the view without creating a duplicate tab when no tab layout is persisted', async () => {
      await plugin.onload();

      const createNewTab = jest.fn().mockResolvedValue(undefined);
      const mockView = {
        createNewTab,
      };

      let viewOpened = false;
      jest.spyOn(plugin, 'activateView').mockImplementation(async () => {
        viewOpened = true;
      });
      jest.spyOn(plugin, 'getView').mockImplementation(() => (
        viewOpened ? mockView as any : null
      ));

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(true);
      expect(command.checkCallback(false)).toBe(true);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(plugin.activateView).toHaveBeenCalledTimes(1);
      expect(createNewTab).not.toHaveBeenCalled();
    });

    it('creates a new tab after reopening a persisted tab layout', async () => {
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          openTabs: [
            { tabId: 'tab-1', conversationId: null },
          ],
          activeTabId: 'tab-1',
        },
      });

      await plugin.onload();

      const createNewTab = jest.fn().mockResolvedValue(undefined);
      const mockView = {
        createNewTab,
      };

      let viewOpened = false;
      jest.spyOn(plugin, 'activateView').mockImplementation(async () => {
        viewOpened = true;
      });
      jest.spyOn(plugin, 'getView').mockImplementation(() => (
        viewOpened ? mockView as any : null
      ));

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(true);
      expect(command.checkCallback(false)).toBe(true);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(plugin.activateView).toHaveBeenCalledTimes(1);
      expect(createNewTab).toHaveBeenCalledTimes(1);
    });

    it('stays unavailable when the open view is already at the tab limit', async () => {
      await plugin.onload();

      const mockView = {
        getTabManager: jest.fn().mockReturnValue({
          canCreateTab: jest.fn().mockReturnValue(false),
        }),
      };

      jest.spyOn(plugin, 'getView').mockReturnValue(mockView as any);

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(false);
    });

    it('keeps tab commands unavailable while a Claudian leaf view is not initialized', async () => {
      await plugin.onload();

      mockApp.workspace.getLeavesOfType.mockReturnValue([{ view: {} }]);

      for (const commandId of ['new-tab', 'new-session', 'close-current-tab']) {
        const command = getRegisteredCommand(commandId);

        expect(() => command.checkCallback(true)).not.toThrow();
        expect(command.checkCallback(true)).toBe(false);
      }
    });

    it('stays unavailable when reopening the persisted layout would already hit the tab limit', async () => {
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          openTabs: [
            { tabId: 'tab-1', conversationId: null },
            { tabId: 'tab-2', conversationId: null },
            { tabId: 'tab-3', conversationId: null },
          ],
          activeTabId: 'tab-3',
        },
      });

      await plugin.onload();

      jest.spyOn(plugin, 'getView').mockReturnValue(null);

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(false);
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

    it('should store the selected model in conversation metadata', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation({ selectedModel: 'opus' });
      const fetched = await plugin.getConversationById(conv.id);

      expect(conv.selectedModel).toBe('opus');
      expect(fetched?.selectedModel).toBe('opus');
    });

    it('should preserve custom selected models that are not in picker options', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation({
        providerId: 'codex',
        selectedModel: 'gpt-5.4-experimental',
      });
      const fetched = await plugin.getConversationById(conv.id);

      expect(conv.selectedModel).toBe('gpt-5.4-experimental');
      expect(fetched?.selectedModel).toBe('gpt-5.4-experimental');
    });

    it('should lazily migrate missing selected model from usage metadata', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      delete (conv as { selectedModel?: string }).selectedModel;
      conv.usage = {
        model: 'opus',
        inputTokens: 1,
        contextTokens: 1,
        contextWindow: 200000,
        percentage: 1,
      };
      const saveMetadataSpy = jest.spyOn(plugin.storage.sessions, 'saveMetadata');
      saveMetadataSpy.mockClear();

      const fetched = await plugin.getConversationById(conv.id);

      expect(fetched?.selectedModel).toBe('opus');
      expect(saveMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({
        selectedModel: 'opus',
      }));
    });

    it('should not permanently default legacy conversations with unknown model metadata', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      delete (conv as { selectedModel?: string }).selectedModel;
      const saveMetadataSpy = jest.spyOn(plugin.storage.sessions, 'saveMetadata');
      saveMetadataSpy.mockClear();

      const fetched = await plugin.getConversationById(conv.id);

      expect(fetched?.selectedModel).toBeUndefined();
      expect(saveMetadataSpy).not.toHaveBeenCalled();
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

    it('should preserve a conversation when local Claude history is missing', async () => {
      await plugin.onload();
      const conversation = await plugin.createConversation({
        sessionId: 'session-removed-after-startup',
      });
      const availabilitySpy = jest.mocked(sdkSession.locateSDKSession)
        .mockResolvedValue({ availability: 'missing' });

      const result = await plugin.switchConversation(conversation.id);

      expect(result?.id).toBe(conversation.id);
      expect(plugin.getConversationList()).toHaveLength(1);
      expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
        '.claudian/sessions/session-removed-after-startup.meta.json',
      );
      availabilitySpy.mockRestore();
    });

    it('should preserve a conversation whose Claude session belongs to a previous vault path', async () => {
      await plugin.onload();
      const conversation = await plugin.createConversation({
        sessionId: 'session-from-previous-vault-path',
      });
      const availabilitySpy = jest.mocked(sdkSession.locateSDKSession)
        .mockResolvedValue({
          availability: 'relocated',
          sessionPath: '/old-project/session-from-previous-vault-path.jsonl',
        });
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      const result = await plugin.switchConversation(conversation.id);

      expect(result?.id).toBe(conversation.id);
      expect(plugin.getConversationList()).toHaveLength(1);
      expect(result?.sessionId).toBeNull();
      expect(result?.providerState).toEqual(expect.objectContaining({
        previousProviderSessionIds: ['session-from-previous-vault-path'],
      }));
      expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
        '.claudian/sessions/session-from-previous-vault-path.meta.json',
      );
      availabilitySpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('should restore resume metadata when relocated-state persistence fails', async () => {
      await plugin.onload();
      const conversation = await plugin.createConversation({
        sessionId: 'session-relocation-save-failure',
      });
      const availabilitySpy = jest.mocked(sdkSession.locateSDKSession)
        .mockResolvedValue({
          availability: 'relocated',
          sessionPath: '/old-project/session-relocation-save-failure.jsonl',
        });
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });
      const saveSpy = jest.spyOn(plugin.storage.sessions, 'saveMetadata')
        .mockRejectedValueOnce(new Error('Write failed'));

      const result = await plugin.switchConversation(conversation.id);

      expect(result?.sessionId).toBe('session-relocation-save-failure');
      expect(result?.providerState).toBeUndefined();

      availabilitySpy.mockRestore();
      loadSpy.mockRestore();
      saveSpy.mockRestore();
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

    it('should preserve the provider-native session when requested', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation({ sessionId: 'provider-session-1' });
      const deleteNativeSpy = jest.spyOn(sdkSession, 'deleteSDKSession');

      await plugin.deleteConversation(conv.id, { deleteProviderSession: false });

      expect(deleteNativeSpy).not.toHaveBeenCalled();
      expect(plugin.getConversationList().find(item => item.id === conv.id)).toBeUndefined();
      deleteNativeSpy.mockRestore();
    });

    it('should reset every open tab that references the deleted conversation', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation();
      const cancelStreaming = jest.fn();
      const createNew = jest.fn().mockResolvedValue(undefined);
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        view: {
          getTabManager: () => ({
            getAllTabs: () => [{
              conversationId: conv.id,
              controllers: {
                inputController: { cancelStreaming },
                conversationController: { createNew },
              },
            }],
          }),
        },
      }]);

      await plugin.deleteConversation(conv.id, { deleteProviderSession: false });

      expect(cancelStreaming).toHaveBeenCalledTimes(1);
      expect(createNew).toHaveBeenCalledWith({ force: true });
    });
  });

  describe('handleMissingProviderSession', () => {
    it('preserves the record when the provider cannot verify a safe disposition', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation({
        providerId: 'codex',
        sessionId: 'unverified-provider-session',
      });

      await expect(plugin.handleMissingProviderSession(
        conv.id,
        'unverified-provider-session',
      )).resolves.toBe('preserved');
      expect(plugin.getConversationSync(conv.id)).toBe(conv);
    });

    it('removes the record when every provider transcript segment is missing', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation({ sessionId: 'missing-current' });
      jest.mocked(sdkSession.locateSDKSessions).mockResolvedValue(new Map([
        ['missing-current', { availability: 'missing' }],
      ]));

      await expect(plugin.handleMissingProviderSession(
        conv.id,
        'missing-current',
      )).resolves.toBe('deleted');
      expect(plugin.getConversationList().find(item => item.id === conv.id)).toBeUndefined();
    });

    it('preserves the record and clears resume state when older history is inaccessible', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation({ sessionId: 'missing-current' });
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'missing-current',
          previousProviderSessionIds: ['temporarily-inaccessible'],
        },
      });
      jest.mocked(sdkSession.locateSDKSessions).mockResolvedValue(new Map([
        ['temporarily-inaccessible', { availability: 'unknown' }],
        ['missing-current', { availability: 'missing' }],
      ]));

      await expect(plugin.handleMissingProviderSession(
        conv.id,
        'missing-current',
      )).resolves.toBe('reset');

      const preserved = plugin.getConversationSync(conv.id);
      expect(preserved?.sessionId).toBeNull();
      expect(preserved?.providerState).toEqual({
        previousProviderSessionIds: ['temporarily-inaccessible'],
      });
    });

    it('preserves metadata when the missing-session disposition cannot be read', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation({ sessionId: 'missing-current' });
      jest.mocked(sdkSession.locateSDKSessions).mockRejectedValueOnce(new Error('EACCES'));

      await expect(plugin.handleMissingProviderSession(
        conv.id,
        'missing-current',
      )).resolves.toBe('preserved');
      expect(plugin.getConversationSync(conv.id)?.sessionId).toBe('missing-current');
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

    it('should preserve image data when updating conversation messages', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const messages = [
        {
          id: 'msg-1',
          role: 'user' as const,
          content: 'See attached image',
          timestamp: Date.now(),
          images: [
            {
              id: 'img-1',
              name: 'pasted.png',
              mediaType: 'image/png' as const,
              data: 'YmFzZTY0',
              size: 10,
              source: 'paste' as const,
            },
          ],
        },
      ];

      await plugin.updateConversation(conv.id, { messages });

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.messages[0].images?.[0].data).toBe('YmFzZTY0');
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
    it('should preserve Claude metadata during startup when local native history is missing', async () => {
      const timestamp = Date.now();
      const sessionMeta = JSON.stringify({
        id: 'conv-stale-1',
        providerId: 'claude',
        title: 'Stale Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        sessionId: 'missing-session',
      });

      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json'
          || path === '.claudian/sessions'
          || path === '.claudian/sessions/conv-stale-1.meta.json';
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions') {
          return { files: ['.claudian/sessions/conv-stale-1.meta.json'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions/conv-stale-1.meta.json') {
          return sessionMeta;
        }
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({});
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.getConversationList()).toHaveLength(1);
      expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
        '.claudian/sessions/conv-stale-1.meta.json',
      );
    });

    it('should load saved conversations from metadata files', async () => {
      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const timestamp = Date.now();
      const sessionMeta = JSON.stringify({
        id: 'conv-saved-1',
        title: 'Saved Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        sessionId: 'saved-session',
      });

      // Mock files exist
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        // Session files
        if (path === '.claudian/sessions' || path === '.claudian/sessions/conv-saved-1.meta.json') {
          return true;
        }
        // claudian-settings.json exists
        if (path === '.claudian/claudian-settings.json') {
          return true;
        }
        return false;
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions') {
          return { files: ['.claudian/sessions/conv-saved-1.meta.json'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions/conv-saved-1.meta.json') {
          return sessionMeta;
        }
        if (path === '.claudian/claudian-settings.json') {
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
      existsSpy.mockRestore();
    });

    it('should clear session IDs when provider base URL changes', async () => {
      const timestamp = Date.now();
      const sessionMeta = JSON.stringify({
        id: 'conv-saved-1',
        title: 'Saved Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        sessionId: 'saved-session',
      });

      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json' ||
          path === '.claudian/sessions' ||
          path === '.claudian/sessions/conv-saved-1.meta.json';
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions') {
          return { files: ['.claudian/sessions/conv-saved-1.meta.json'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          // All these fields are now in claudian-settings.json
          return JSON.stringify({
            lastEnvHash: 'old-hash',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
          });
        }
        if (path === '.claudian/sessions/conv-saved-1.meta.json') {
          return sessionMeta;
        }
        return '';
      });

      // data.json is minimal (already migrated)
      (plugin.loadData as jest.Mock).mockResolvedValue({});

      await plugin.loadSettings();

      const loaded = await plugin.getConversationById('conv-saved-1');
      expect(loaded?.sessionId).toBeNull();

      const sessionWrite = (mockApp.vault.adapter.write as jest.Mock).mock.calls.find(
        ([path]) => path === '.claudian/sessions/conv-saved-1.meta.json'
      );
      expect(sessionWrite).toBeDefined();
      const meta = JSON.parse(sessionWrite?.[1] as string);
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
    it('should load messages from previousProviderSessionIds when present', async () => {
      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const timestamp = Date.now();

      // Setup conversation with previousProviderSessionIds
      const sessionMeta = JSON.stringify({
        type: 'meta',
        id: 'conv-multi-session',
        title: 'Multi Session Chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        providerState: {
          providerSessionId: 'session-B',
          previousProviderSessionIds: ['session-A'],
        },
      });

      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json' ||
          path === '.claudian/sessions' ||
          path === '.claudian/sessions/conv-multi-session.meta.json';
      });
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions') {
          return { files: ['.claudian/sessions/conv-multi-session.meta.json'], folders: [] };
        }
        return { files: [], folders: [] };
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/sessions/conv-multi-session.meta.json') {
          return sessionMeta;
        }
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({});
        }
        return '';
      });

      (plugin.loadData as jest.Mock).mockResolvedValue({});

      await plugin.loadSettings();

      const loaded = await plugin.getConversationById('conv-multi-session');
      expect((loaded?.providerState as any)?.previousProviderSessionIds).toEqual(['session-A']);
      expect((loaded?.providerState as any)?.providerSessionId).toBe('session-B');
      existsSpy.mockRestore();
    });

    it('should preserve previousProviderSessionIds through conversation updates', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-B',
          previousProviderSessionIds: ['session-A'],
        },
      });

      const updated = await plugin.getConversationById(conv.id);
      expect((updated?.providerState as any)?.previousProviderSessionIds).toEqual(['session-A']);
      expect((updated?.providerState as any)?.providerSessionId).toBe('session-B');

      // Further update should preserve previousProviderSessionIds
      await plugin.updateConversation(conv.id, {
        title: 'Updated Title',
      });

      const afterTitleUpdate = await plugin.getConversationById(conv.id);
      expect((afterTitleUpdate?.providerState as any)?.previousProviderSessionIds).toEqual(['session-A']);
    });

    it('should handle empty previousProviderSessionIds array', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-A',
          previousProviderSessionIds: [],
        },
      });

      const updated = await plugin.getConversationById(conv.id);
      expect((updated?.providerState as any)?.previousProviderSessionIds).toEqual([]);
    });
  });

  describe('loadSdkMessagesForConversation - fork branch', () => {
    it('should repair blank image data from Claude SDK history during hydration', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-with-image',
        },
        messages: [
          {
            id: 'user-with-image',
            role: 'user',
            content: 'See attached image',
            timestamp: 1000,
            images: [{
              id: 'img-blank',
              name: 'pasted.png',
              mediaType: 'image/png',
              data: '',
              size: 0,
              source: 'paste',
            }],
          },
        ],
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [
          {
            id: 'user-with-image',
            role: 'user',
            content: 'See attached image',
            timestamp: 1000,
            images: [{
              id: 'sdk-img-user-with-image-0',
              name: 'image-1',
              mediaType: 'image/png',
              data: 'aGVsbG8=',
              size: 5,
              source: 'paste',
            }],
          },
        ],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);

      expect(loadSpy).toHaveBeenCalledWith(
        expect.any(String),
        'session-with-image',
        undefined,
        undefined,
        expect.any(Object),
      );
      expect(loaded?.messages[0].images?.[0]).toMatchObject({
        id: 'img-blank',
        data: 'aGVsbG8=',
        mediaType: 'image/png',
        size: 5,
      });

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('should load from forkSource.sessionId and truncate at forkSource.resumeAt for pending fork', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          forkSource: { sessionId: 'source-session-abc', resumeAt: 'asst-uuid-cutoff' },
          // No providerSessionId → isPendingFork returns true
          providerSessionId: undefined,
        },
        sessionId: null,
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
      expect(sdkSession.locateSDKSession).toHaveBeenCalledWith(
        expect.any(String),
        'source-session-abc',
        expect.any(Object),
      );

      // Should load from forkSource.sessionId with forkSource.resumeAt as truncation point
      expect(loadSpy).toHaveBeenCalledWith(
        expect.any(String),
        'source-session-abc',
        'asst-uuid-cutoff',
        undefined,
        expect.any(Object),
      );

      // Messages should be loaded
      expect(loaded?.messages).toBeDefined();

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('should NOT use fork path when conversation has its own providerSessionId', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          forkSource: { sessionId: 'source-session', resumeAt: 'asst-uuid' },
          providerSessionId: 'own-session-id',
        },
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      await plugin.getConversationById(conv.id);

      // Should load from own session, not forkSource session
      expect(sdkSession.locateSDKSession).toHaveBeenCalledWith(
        expect.any(String),
        'own-session-id',
        expect.any(Object),
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
        providerState: {
          providerSessionId: 'session-subagent-recovery',
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
        },
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
        undefined,
        undefined,
        expect.any(Object),
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

    it('prefers richer SDK task result over stale cached subagent result', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-subagent-merge',
          subagentData: {
            'task-merge-1': {
              id: 'task-merge-1',
              description: 'Recovered subagent',
              mode: 'async',
              asyncStatus: 'completed',
              status: 'completed',
              result: 'Short stale result',
              toolCalls: [],
              isExpanded: false,
            } as any,
          },
        },
        messages: [
          {
            id: 'assistant-merge',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-merge-1',
                name: 'Task',
                input: { description: 'Do sub task', run_in_background: true },
                status: 'completed',
                result: 'Full SDK result from queue-operation',
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-merge-1', mode: 'async' }] as any,
          } as any,
        ],
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-merge-1');

      expect(loadSpy).toHaveBeenCalledWith(
        expect.any(String),
        'session-subagent-merge',
        undefined,
        undefined,
        expect.any(Object),
      );
      expect(taskTool?.result).toBe('Full SDK result from queue-operation');
      expect(taskTool?.subagent?.result).toBe('Full SDK result from queue-operation');

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('keeps the richer cached async result when both SDK and cache are terminal', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-subagent-cache-richer',
          subagentData: {
            'task-merge-2': {
              id: 'task-merge-2',
              description: 'Recovered subagent',
              mode: 'async',
              asyncStatus: 'completed',
              status: 'completed',
              result: 'Recovered final result with full details',
              toolCalls: [],
              isExpanded: false,
              agentId: 'agent-cache-richer',
            } as any,
          },
        },
        messages: [],
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [
          {
            id: 'assistant-cache-richer',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-merge-2',
                name: 'Task',
                input: { description: 'SDK async subagent', run_in_background: true },
                status: 'completed',
                result: 'Short SDK result',
                subagent: {
                  id: 'task-merge-2',
                  description: 'SDK async subagent',
                  mode: 'async',
                  asyncStatus: 'completed',
                  status: 'completed',
                  result: 'Short SDK result',
                  toolCalls: [],
                  isExpanded: false,
                  agentId: 'agent-cache-richer',
                },
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-merge-2', mode: 'async' }] as any,
          } as any,
        ],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-merge-2');

      expect(taskTool?.status).toBe('completed');
      expect(taskTool?.result).toBe('Recovered final result with full details');
      expect(taskTool?.subagent?.result).toBe('Recovered final result with full details');

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('drops stale asyncStatus from cached sync subagents during recovery', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-sync-subagent-cleanup',
          subagentData: {
            'task-sync-1': {
              id: 'task-sync-1',
              description: 'Recovered sync subagent',
              mode: 'sync',
              asyncStatus: 'completed',
              status: 'completed',
              result: 'Recovered sync result',
              toolCalls: [],
              isExpanded: false,
            } as any,
          },
        },
        messages: [
          {
            id: 'assistant-sync',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-sync-1',
                name: 'Task',
                input: { description: 'Do sync task' },
                status: 'completed',
                result: 'Sync result',
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-sync-1', mode: 'sync' }] as any,
          } as any,
        ],
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-sync-1');

      expect(taskTool?.subagent?.mode).toBe('sync');
      expect(taskTool?.subagent?.asyncStatus).toBeUndefined();

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('prefers terminal SDK async status over stale cached running state', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-async-sdk-terminal',
          subagentData: {
            'task-async-sdk-terminal': {
              id: 'task-async-sdk-terminal',
              description: 'Cached async subagent',
              mode: 'async',
              asyncStatus: 'running',
              status: 'running',
              result: 'Still running',
              toolCalls: [],
              isExpanded: false,
            } as any,
          },
        },
        messages: [],
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [
          {
            id: 'assistant-sdk-terminal',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-async-sdk-terminal',
                name: 'Task',
                input: { description: 'SDK async subagent', run_in_background: true },
                status: 'completed',
                result: 'Full SDK final result',
                subagent: {
                  id: 'task-async-sdk-terminal',
                  description: 'SDK async subagent',
                  mode: 'async',
                  asyncStatus: 'completed',
                  status: 'completed',
                  result: 'Full SDK final result',
                  toolCalls: [],
                  isExpanded: false,
                  agentId: 'agent-sdk-terminal',
                },
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-async-sdk-terminal', mode: 'async' }] as any,
          } as any,
        ],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-async-sdk-terminal');

      expect(taskTool?.status).toBe('completed');
      expect(taskTool?.result).toBe('Full SDK final result');
      expect(taskTool?.subagent?.status).toBe('completed');
      expect(taskTool?.subagent?.asyncStatus).toBe('completed');
      expect(taskTool?.subagent?.result).toBe('Full SDK final result');

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('prefers cached terminal async status over SDK launch-only running state', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-async-cache-terminal',
          subagentData: {
            'task-async-cache-terminal': {
              id: 'task-async-cache-terminal',
              description: 'Cached async subagent',
              mode: 'async',
              asyncStatus: 'completed',
              status: 'completed',
              result: 'Recovered final result',
              toolCalls: [],
              isExpanded: false,
              agentId: 'agent-cache-terminal',
            } as any,
          },
        },
        messages: [],
      });

      const existsSpy = jest.spyOn(sdkSession, 'sdkSessionExists').mockReturnValue(true);
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [
          {
            id: 'assistant-sdk-running',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [
              {
                id: 'task-async-cache-terminal',
                name: 'Task',
                input: { description: 'SDK async subagent', run_in_background: true },
                status: 'running',
                result: 'Task launched in background.',
                subagent: {
                  id: 'task-async-cache-terminal',
                  description: 'SDK async subagent',
                  mode: 'async',
                  asyncStatus: 'running',
                  status: 'running',
                  result: 'Task launched in background.',
                  toolCalls: [],
                  isExpanded: false,
                  agentId: 'agent-cache-terminal',
                },
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-async-cache-terminal', mode: 'async' }] as any,
          } as any,
        ],
        skippedLines: 0,
      });

      const loaded = await plugin.getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-async-cache-terminal');

      expect(taskTool?.status).toBe('completed');
      expect(taskTool?.result).toBe('Recovered final result');
      expect(taskTool?.subagent?.status).toBe('completed');
      expect(taskTool?.subagent?.asyncStatus).toBe('completed');
      expect(taskTool?.subagent?.result).toBe('Recovered final result');

      existsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('restores async subagent data and mode when Task tool exists but async block is missing', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      await plugin.updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-async-subagent-recovery',
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
        },
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
        providerState: {
          providerSessionId: 'session-async-subagent-tools',
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
        },
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
        'agent-a123',
        undefined,
        expect.any(Object),
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
        providerState: {
          providerSessionId: 'session-async-subagent-fallback',
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
        },
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Background work started',
            timestamp: 1000,
            contentBlocks: [{ type: 'text', content: 'Background work started' }] as any,
          } as any,
        ],
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
          name: TOOL_SUBAGENT,
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
