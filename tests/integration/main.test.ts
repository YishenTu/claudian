
import { Notice, TFile, TFolder } from 'obsidian';

import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import { type Conversation, VIEW_TYPE_CLAUDIAN } from '@/core/types';
import * as sdkSession from '@/providers/claude/history/ClaudeHistoryStore';
import { SessionStorage } from '@/providers/claude/storage/SessionStorage';
import { DEFAULT_SETTINGS } from '@/providers/claude/types/settings';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '@/providers/codex/settings';
import { computeGrokEnvironmentHash } from '@/providers/grok/env/GrokSettingsReconciler';
import { GrokCliResolver } from '@/providers/grok/runtime/GrokCliResolver';
import { GrokModelCatalogCoordinator } from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import { GrokModelCatalogService } from '@/providers/grok/runtime/GrokModelCatalogService';
import {
  getGrokProviderSettings,
  updateCurrentGrokCatalog,
  updateGrokProviderSettings,
} from '@/providers/grok/settings';
import { getHostnameKey } from '@/utils/env';

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

  function getConversationPersistence(
    target: ClaudianPlugin,
  ): ConversationPersistenceStore {
    return (
      target.storage as typeof target.storage & {
        conversationPersistence: ConversationPersistenceStore;
      }
    ).conversationPersistence;
  }

  function mockMetadataSources(
    ...metadata: Array<{
      id: string;
      providerId: 'claude' | 'codex';
      title: string;
      createdAt: number;
      lastActivityAt: number;
      [key: string]: unknown;
    }>
  ): jest.SpyInstance {
    const metadataById = new Map(metadata.map(item => [item.id, item]));
    return jest.spyOn(SessionStorage.prototype, 'load')
      .mockImplementation(async (id) => {
        const item = metadataById.get(id);
        return item
          ? { metadata: item, needsMigration: false, source: 'current' as const }
          : null;
      });
  }

  function installVaultFiles(initialFiles: Record<string, string>): Map<string, string> {
    const files = new Map(Object.entries(initialFiles));
    const folders = new Set<string>(['.claudian']);
    mockApp.vault.adapter.exists.mockImplementation(async (path: string) => (
      files.has(path) || folders.has(path)
    ));
    mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`Missing test file: ${path}`);
      }
      return content;
    });
    mockApp.vault.adapter.write.mockImplementation(async (path: string, content: string) => {
      files.set(path, content);
    });
    mockApp.vault.adapter.remove.mockImplementation(async (path: string) => {
      files.delete(path);
    });
    mockApp.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      folders.add(path);
    });
    return files;
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
        on: jest.fn().mockReturnValue({ id: 'vault-event' }),
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
        on: jest.fn().mockReturnValue({ id: 'workspace-event' }),
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

    it('registers the file explorer context menu', async () => {
      await plugin.onload();

      expect(mockApp.workspace.on).toHaveBeenCalledWith(
        'file-menu',
        expect.any(Function),
      );
      expect(plugin.registerEvent).toHaveBeenCalledWith({ id: 'workspace-event' });
    });

    it('loads only current-tab metadata before the full history scan', async () => {
      type EmptyMetadataScan = {
        metadata: [];
        complete: true;
        invalidMetadataCount: 0;
      };
      let finishHistoryScan!: (value: EmptyMetadataScan) => void;
      const historyScan = new Promise<EmptyMetadataScan>((resolve) => {
        finishHistoryScan = resolve;
      });
      const restoredMetadata = {
        id: 'restored-conversation',
        providerId: 'claude' as const,
        title: 'Restored conversation',
        createdAt: 1,
        lastActivityAt: 2,
      };
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockReturnValue(historyScan);
      const loadSourceSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue({
          metadata: restoredMetadata,
          needsMigration: false,
          source: 'current',
        });
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
      finishHistoryScan({ metadata: [], complete: true, invalidMetadataCount: 0 });
      await onloadPromise;
      const cachedConversation = plugin.getCachedConversation(restoredMetadata.id);
      const didLoadRestoredMetadata = loadSourceSpy.mock.calls.some(
        ([id]) => id === restoredMetadata.id,
      );
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();

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
        lastActivityAt: 2,
      };
      mockApp.workspace.onLayoutReady = jest.fn((callback: () => void) => {
        layoutReady = callback;
      });
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockResolvedValue({
          metadata: [backgroundMetadata],
          complete: true,
          invalidMetadataCount: 0,
        });
      const loadSourceSpy = mockMetadataSources(backgroundMetadata);

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
      loadSourceSpy.mockRestore();

      expect(beforeLayoutReady).toBeNull();
      expect(listCallCount).toBe(1);
      expect(afterBackgroundLoad?.title).toBe(backgroundMetadata.title);
    });

    it('publishes deferred model fallbacks only after their metadata write is durable', async () => {
      const deferredMetadata = {
        id: 'deferred-retired-model',
        providerId: 'claude' as const,
        title: 'Deferred retired model',
        createdAt: 1,
        lastActivityAt: 2,
        selectedModel: 'claude-code/retired-model',
      };
      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([deferredMetadata]);
          return {
            metadata: [deferredMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);
      const notifyConversationListChanged = jest.fn();
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([{
        notifyConversationListChanged,
      } as any]);
      let markWriteStarted!: () => void;
      const writeStarted = new Promise<void>(resolve => {
        markWriteStarted = resolve;
      });
      let releaseWrite!: () => void;
      const writeRelease = new Promise<void>(resolve => {
        releaseWrite = resolve;
      });
      const saveSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockImplementation(async (metadata) => {
          if (metadata.id === deferredMetadata.id) {
            markWriteStarted();
            await writeRelease;
          }
        });

      const load = (plugin as any).loadRemainingSessionMetadata();
      await writeStarted;
      expect(notifyConversationListChanged).not.toHaveBeenCalled();

      releaseWrite();
      await load;

      expect(plugin.getCachedConversation(deferredMetadata.id)?.selectedModel).toBe('opus');
      expect(notifyConversationListChanged).toHaveBeenCalledTimes(1);
      scanSpy.mockRestore();
      loadSourceSpy.mockRestore();
      saveSpy.mockRestore();
    });

    it('migrates legacy metadata through the repository after a read-only scan', async () => {
      const legacyMetadata = {
        id: 'legacy-background-conversation',
        providerId: 'claude' as const,
        title: 'Legacy background conversation',
        createdAt: 1,
        lastActivityAt: 2,
      };
      const events: string[] = [];

      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async () => {
          events.push('scan');
          return {
            metadata: [legacyMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue({
          metadata: legacyMetadata,
          needsMigration: false,
          source: 'legacy',
        });
      const persistence = getConversationPersistence(plugin);
      const saveSpy = jest.spyOn(persistence, 'saveMetadata')
        .mockImplementation(async () => {
          events.push('save-current');
        });
      const deleteLegacySpy = jest.spyOn(persistence, 'deleteLegacyMetadata')
        .mockImplementation(async () => {
          events.push('delete-legacy');
        });

      await (plugin as any).loadRemainingSessionMetadata();

      expect(events).toEqual(['scan', 'save-current', 'delete-legacy']);
      expect(plugin.getCachedConversation(legacyMetadata.id)?.title)
        .toBe(legacyMetadata.title);

      scanSpy.mockRestore();
      loadSpy.mockRestore();
      saveSpy.mockRestore();
      deleteLegacySpy.mockRestore();
    });

    it('recovers missing model metadata after the background session scan', async () => {
      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockResolvedValue({
          metadata: [],
          complete: true,
          invalidMetadataCount: 0,
        });
      const repository = (plugin as any).conversationRepository;
      const recoverySpy = jest.spyOn(repository, 'recoverMissingSelectedModels')
        .mockResolvedValue([]);

      await (plugin as any).loadRemainingSessionMetadata();

      expect(recoverySpy).toHaveBeenCalledTimes(1);

      scanSpy.mockRestore();
      recoverySpy.mockRestore();
    });

    it('recovers models from original metadata before persisting session invalidation', async () => {
      const metadata = {
        id: 'codex-model-before-invalidation',
        providerId: 'codex' as const,
        title: 'Codex model before invalidation',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'thread-before-invalidation',
        providerState: { threadId: 'thread-before-invalidation' },
      };
      await plugin.onload();
      (plugin as any).pendingEnvironmentInvalidationGenerations.set('codex', 1);
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockResolvedValue({
          metadata: [metadata],
          complete: true,
          invalidMetadataCount: 0,
        });
      const loadSpy = mockMetadataSources(metadata);
      const repository = (plugin as any).conversationRepository;
      const registeredSources: Conversation[] = [];
      const originalRegister = repository.registerHistoricalModelRecoverySources
        .bind(repository);
      const registerSpy = jest.spyOn(repository, 'registerHistoricalModelRecoverySources')
        .mockImplementation((...args: unknown[]) => {
          const sources = args[0] as readonly Conversation[];
          registeredSources.push(...sources);
          originalRegister(sources);
        });
      const events: string[] = [];
      const persistedRecoverySources: unknown[] = [];
      const recoverySpy = jest.spyOn(repository, 'recoverMissingSelectedModels')
        .mockImplementation(async () => {
          events.push('recover');
          return [];
        });
      const persistSpy = jest.spyOn(repository, 'persistConversations')
        .mockImplementation(async (...args: unknown[]) => {
          const conversations = args[0] as readonly Conversation[];
          events.push(`persist:${String(conversations[0]?.sessionId)}`);
          persistedRecoverySources.push(conversations[0]?.modelRecoverySource);
        });

      await (plugin as any).loadRemainingSessionMetadata();

      expect(registeredSources).toContainEqual(expect.objectContaining({
        id: metadata.id,
        sessionId: 'thread-before-invalidation',
        providerState: { threadId: 'thread-before-invalidation' },
      }));
      expect(events).toEqual(['recover', 'persist:null']);
      expect(persistedRecoverySources).toEqual([{
        sessionId: 'thread-before-invalidation',
        providerState: { threadId: 'thread-before-invalidation' },
      }]);

      scanSpy.mockRestore();
      loadSpy.mockRestore();
      registerSpy.mockRestore();
      recoverySpy.mockRestore();
      persistSpy.mockRestore();
    });

    it('invalidates restored and deferred sessions after a provider environment change', async () => {
      const restoredMetadata = {
        id: 'restored-environment-session',
        providerId: 'claude' as const,
        title: 'Restored environment session',
        createdAt: 1,
        lastActivityAt: 3,
        sessionId: 'restored-session-id',
        providerState: { providerSessionId: 'restored-provider-session-id' },
        resumeAtMessageId: 'restored-message-id',
      };
      const deferredMetadata = {
        id: 'deferred-environment-session',
        providerId: 'claude' as const,
        title: 'Deferred environment session',
        createdAt: 1,
        lastActivityAt: 2,
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([restoredMetadata, deferredMetadata]);
          return {
            metadata: [restoredMetadata, deferredMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(
        restoredMetadata,
        deferredMetadata,
      );

      await plugin.onload();
      await (plugin as any).loadRemainingSessionMetadata();

      const restored = plugin.getCachedConversation(restoredMetadata.id);
      const deferred = plugin.getCachedConversation(deferredMetadata.id);
      loadSpy.mockRestore();
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();

      expect(restored).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: {
          previousProviderSessionIds: ['restored-provider-session-id'],
        },
        resumeAtMessageId: 'restored-message-id',
      }));
      expect(deferred).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: {
          previousProviderSessionIds: ['deferred-provider-session-id'],
        },
        resumeAtMessageId: 'deferred-message-id',
      }));
    });

    it('preserves restored and deferred sessions for a reload-policy environment change', async () => {
      const restoredMetadata = {
        id: 'restored-reload-session',
        providerId: 'claude' as const,
        title: 'Restored reload session',
        createdAt: 1,
        lastActivityAt: 3,
        sessionId: 'restored-session-id',
        providerState: { providerSessionId: 'restored-provider-session-id' },
      };
      const deferredMetadata = {
        id: 'deferred-reload-session',
        providerId: 'claude' as const,
        title: 'Deferred reload session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'deferred-session-id',
        providerState: { providerSessionId: 'deferred-provider-session-id' },
      };
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          openTabs: [{ tabId: 'tab-1', conversationId: restoredMetadata.id }],
          activeTabId: 'tab-1',
        },
      });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'loadMetadata')
        .mockResolvedValue(restoredMetadata);
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([restoredMetadata, deferredMetadata]);
          return {
            metadata: [restoredMetadata, deferredMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(
        restoredMetadata,
        deferredMetadata,
      );
      const claudeReconciler = ProviderRegistry.getSettingsReconciler('claude');
      const reconcileSpy = jest.spyOn(claudeReconciler, 'reconcileModelWithEnvironment')
        .mockReturnValue({ changed: true, invalidatedConversations: [] });
      claudeReconciler.environmentSessionPolicy = 'reload';

      try {
        await plugin.onload();
        await (plugin as any).loadRemainingSessionMetadata();
      } finally {
        delete claudeReconciler.environmentSessionPolicy;
        reconcileSpy.mockRestore();
        loadSpy.mockRestore();
        listSpy.mockRestore();
        loadSourceSpy.mockRestore();
      }

      expect(plugin.getCachedConversation(restoredMetadata.id)).toEqual(expect.objectContaining({
        sessionId: 'restored-session-id',
        providerState: { providerSessionId: 'restored-provider-session-id' },
      }));
      expect(plugin.getCachedConversation(deferredMetadata.id)).toEqual(expect.objectContaining({
        sessionId: 'deferred-session-id',
        providerState: { providerSessionId: 'deferred-provider-session-id' },
      }));
      expect(plugin.settings.pendingProviderSessionInvalidations.claude).toBeUndefined();
    });

    it('invalidates later metadata batches when the environment changes during the scan', async () => {
      const firstMetadata = {
        id: 'first-scanned-session',
        providerId: 'claude' as const,
        title: 'First scanned session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'first-session-id',
        providerState: { providerSessionId: 'first-provider-session-id' },
      };
      const laterMetadata = {
        id: 'later-scanned-session',
        providerId: 'claude' as const,
        title: 'Later scanned session',
        createdAt: 1,
        lastActivityAt: 1,
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([firstMetadata]);
          markFirstBatchPublished();
          await laterBatchRelease;
          options?.onBatch?.([laterMetadata]);
          return {
            metadata: [firstMetadata, laterMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(firstMetadata, laterMetadata);

      const load = (plugin as any).loadRemainingSessionMetadata();
      await firstBatchPublished;
      await plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://changed-during-scan.example.com',
      );
      const pendingGeneration = plugin.settings.pendingProviderSessionInvalidations.claude;
      releaseLaterBatch();
      await load;

      const first = plugin.getCachedConversation(firstMetadata.id);
      const later = plugin.getCachedConversation(laterMetadata.id);
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();

      expect(first?.sessionId).toBeNull();
      expect(first?.providerState).toEqual({
        previousProviderSessionIds: ['first-provider-session-id'],
      });
      expect(later?.sessionId).toBeNull();
      expect(later?.providerState).toEqual({
        previousProviderSessionIds: ['later-provider-session-id'],
      });
      expect(pendingGeneration).toEqual(expect.any(Number));
      expect(plugin.settings.pendingProviderSessionInvalidations.claude)
        .toBeUndefined();
    });

    it('waits for an environment metadata write before completing its scan generation', async () => {
      const firstMetadata = {
        id: 'pending-environment-write-session',
        providerId: 'claude' as const,
        title: 'Pending environment write session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'pending-environment-write-session-id',
        providerState: { providerSessionId: 'pending-environment-write-provider-session-id' },
      };
      const laterMetadata = {
        id: 'later-environment-write-session',
        providerId: 'claude' as const,
        title: 'Later environment write session',
        createdAt: 1,
        lastActivityAt: 1,
        sessionId: 'later-environment-write-session-id',
        providerState: { providerSessionId: 'later-environment-write-provider-session-id' },
      };
      let markFirstBatchPublished!: () => void;
      const firstBatchPublished = new Promise<void>((resolve) => {
        markFirstBatchPublished = resolve;
      });
      let finishScan!: () => void;
      const scanRelease = new Promise<void>((resolve) => {
        finishScan = resolve;
      });
      let markEnvironmentWriteStarted!: () => void;
      const environmentWriteStarted = new Promise<void>((resolve) => {
        markEnvironmentWriteStarted = resolve;
      });
      let finishEnvironmentWrite!: () => void;
      const environmentWriteRelease = new Promise<void>((resolve) => {
        finishEnvironmentWrite = resolve;
      });

      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([firstMetadata]);
          markFirstBatchPublished();
          await scanRelease;
          options?.onBatch?.([laterMetadata]);
          return {
            metadata: [firstMetadata, laterMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      let blockedEnvironmentWrite = false;
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockImplementation(async () => {
          if (!blockedEnvironmentWrite) {
            blockedEnvironmentWrite = true;
            markEnvironmentWriteStarted();
            await environmentWriteRelease;
          }
        });

      const load = (plugin as any).loadRemainingSessionMetadata();
      await firstBatchPublished;
      const apply = plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://pending-write.example.com',
      );
      await environmentWriteStarted;
      const pendingGeneration = plugin.settings.pendingProviderSessionInvalidations.claude;
      finishScan();
      await load;

      expect(plugin.settings.pendingProviderSessionInvalidations.claude)
        .toBe(pendingGeneration);

      finishEnvironmentWrite();
      await apply;
      scanSpy.mockRestore();
      saveMetadataSpy.mockRestore();

      expect(pendingGeneration).toEqual(expect.any(Number));
      expect(plugin.settings.pendingProviderSessionInvalidations.claude)
        .toBeUndefined();
    });

    it('keeps a pending provider invalidation after an incomplete metadata scan', async () => {
      const settingsPath = '.claudian/claudian-settings.json';
      const pendingGeneration = 11;
      const deferredMetadata = {
        id: 'incomplete-scan-session',
        providerId: 'claude' as const,
        title: 'Incomplete scan session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'incomplete-scan-session-id',
        providerState: { providerSessionId: 'incomplete-scan-provider-session-id' },
      };
      const files = installVaultFiles({
        [settingsPath]: JSON.stringify({
          pendingProviderSessionInvalidations: { claude: pendingGeneration },
          providerConfigs: {
            claude: {
              environmentHash: 'ANTHROPIC_BASE_URL=https://same.example.com',
              environmentVariables: 'ANTHROPIC_BASE_URL=https://same.example.com',
            },
          },
        }),
      });

      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([deferredMetadata]);
          return {
            metadata: [deferredMetadata],
            complete: false,
            invalidMetadataCount: 0,
          };
        });
      (plugin as any).pendingSessionMetadataScan = false;

      await (plugin as any).loadRemainingSessionMetadata();

      const persistedSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      scanSpy.mockRestore();

      expect(persistedSettings.pendingProviderSessionInvalidations?.claude)
        .toBe(pendingGeneration);
      expect((plugin as any).hasLoadedAllSessionMetadata).toBe(false);
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
        lastActivityAt: 2,
      };

      await plugin.onload();
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata').mockImplementation(async (options) => {
        options?.onBatch?.([backgroundMetadata]);
        markBatchPublished();
        await scanRelease;
        return {
          metadata: [backgroundMetadata],
          complete: true,
          invalidMetadataCount: 0,
        };
      });
      const invalidateSpy = jest.spyOn(
        ProviderSettingsCoordinator,
        'invalidateConversationSessions',
      ).mockImplementation((conversations) => [...conversations]);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');

      const load = (plugin as any).loadRemainingSessionMetadata();
      await batchPublished;
      await plugin.deleteConversation(backgroundMetadata.id);
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

    it('suppresses metadata tombstoned after scanning but before source resolution', async () => {
      const tombstonedMetadata = {
        id: 'tombstoned-during-source-resolution',
        providerId: 'claude' as const,
        title: 'Tombstoned during source resolution',
        createdAt: 1,
        lastActivityAt: 2,
      };

      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([tombstonedMetadata]);
          return {
            metadata: [tombstonedMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue(null);

      await (plugin as any).loadRemainingSessionMetadata();

      expect(loadSpy).toHaveBeenCalledWith(tombstonedMetadata.id);
      expect(plugin.getCachedConversation(tombstonedMetadata.id)).toBeNull();

      scanSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('suppresses an already cached shell tombstoned during source resolution', async () => {
      const tombstonedMetadata = {
        id: 'cached-shell-tombstoned-during-source-resolution',
        providerId: 'claude' as const,
        title: 'Cached shell tombstoned during source resolution',
        createdAt: 1,
        lastActivityAt: 2,
      };

      await plugin.onload();
      const shell = (plugin as any).createConversationMetadataShell(
        tombstonedMetadata,
      );
      (plugin as any).conversationRepository.mergeMetadataConversations([shell]);
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([tombstonedMetadata]);
          return {
            metadata: [tombstonedMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue(null);

      await (plugin as any).loadRemainingSessionMetadata();

      expect(plugin.getCachedConversation(tombstonedMetadata.id)).toBeNull();

      scanSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retries a pending provider invalidation after unload and restart', async () => {
      const settingsPath = '.claudian/claudian-settings.json';
      const deferredMetadata = {
        id: 'restart-deferred-session',
        providerId: 'claude' as const,
        title: 'Restart deferred session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'restart-session-id',
        providerState: { providerSessionId: 'restart-provider-session-id' },
      };
      const files = installVaultFiles({
        [settingsPath]: JSON.stringify({
          providerConfigs: {
            claude: {
              environmentHash: 'ANTHROPIC_BASE_URL=https://old.example.com',
              environmentVariables: 'ANTHROPIC_BASE_URL=https://new.example.com',
            },
          },
        }),
      });

      await plugin.onload();
      const firstRunSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      const pendingGeneration = firstRunSettings.pendingProviderSessionInvalidations?.claude;

      expect(pendingGeneration).toEqual(expect.any(Number));

      plugin.onunload();
      const restartedPlugin = new ClaudianPlugin(mockApp, mockManifest);
      (restartedPlugin.loadData as jest.Mock).mockResolvedValue({});
      const restartedSaveMetadataSpy = jest.spyOn(
        ConversationPersistenceStore.prototype,
        'saveMetadata',
      );
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([deferredMetadata]);
          return {
            metadata: [deferredMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);

      await restartedPlugin.onload();
      await (restartedPlugin as any).loadRemainingSessionMetadata();

      const restartedConversation = restartedPlugin.getCachedConversation(deferredMetadata.id);
      const persistedMetadata = JSON.parse(
        files.get('.claudian/sessions/restart-deferred-session.meta.json') ?? '{}',
      );
      const restartedSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      const deferredInvalidationWrites = restartedSaveMetadataSpy.mock.calls.filter(
        ([metadata]) => metadata.id === deferredMetadata.id,
      );
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();
      restartedSaveMetadataSpy.mockRestore();

      expect(restartedConversation?.sessionId).toBeNull();
      expect(restartedConversation?.providerState).toEqual({
        previousProviderSessionIds: ['restart-provider-session-id'],
      });
      expect(persistedMetadata.sessionId).toBeNull();
      expect(persistedMetadata.providerState).toEqual({
        previousProviderSessionIds: ['restart-provider-session-id'],
      });
      expect(restartedSettings.pendingProviderSessionInvalidations?.claude).toBeUndefined();
      expect(deferredInvalidationWrites).toHaveLength(1);
    });

    it('keeps a pending provider invalidation when a metadata write fails', async () => {
      const settingsPath = '.claudian/claudian-settings.json';
      const pendingGeneration = 7;
      const deferredMetadata = {
        id: 'failed-write-session',
        providerId: 'claude' as const,
        title: 'Failed write session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'failed-write-session-id',
        providerState: { providerSessionId: 'failed-write-provider-session-id' },
      };
      const files = installVaultFiles({
        [settingsPath]: JSON.stringify({
          pendingProviderSessionInvalidations: { claude: pendingGeneration },
          providerConfigs: {
            claude: {
              environmentHash: 'ANTHROPIC_BASE_URL=https://same.example.com',
              environmentVariables: 'ANTHROPIC_BASE_URL=https://same.example.com',
            },
          },
        }),
      });

      await plugin.onload();
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([deferredMetadata]);
          return {
            metadata: [deferredMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockRejectedValueOnce(new Error('metadata write failed'));
      (plugin as any).pendingSessionMetadataScan = false;

      let loadError: unknown;
      try {
        await (plugin as any).loadRemainingSessionMetadata();
      } catch (error) {
        loadError = error;
      }
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();
      saveMetadataSpy.mockRestore();

      expect(loadError).toEqual(new Error('metadata write failed'));
      const persistedSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      expect(persistedSettings.pendingProviderSessionInvalidations?.claude)
        .toBe(pendingGeneration);

      await plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://next.example.com',
      );

      const settingsAfterEnvironmentChange = JSON.parse(files.get(settingsPath) ?? '{}');
      expect(settingsAfterEnvironmentChange.pendingProviderSessionInvalidations?.claude)
        .toEqual(expect.any(Number));
    });

  });

  describe('onunload', () => {
    it('should complete without error', async () => {
      await plugin.onload();

      expect(() => plugin.onunload()).not.toThrow();
    });

    it('disposes the application execution lifecycle registry', async () => {
      await plugin.onload();
      const disposeSpy = jest.spyOn(
        plugin.executionLifecycleRegistry,
        'dispose',
      );

      plugin.onunload();
      await Promise.resolve();

      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('drains views before disposing execution and workspace resources', async () => {
      await plugin.onload();
      let resolveViewDrain!: () => void;
      const viewDrain = new Promise<void>((resolve) => {
        resolveViewDrain = resolve;
      });
      const prepareForPluginUnload = jest.fn(() => viewDrain);
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        view: {
          prepareForPluginUnload,
          getTabManager: jest.fn(),
        },
      }]);
      const disposeExecution = jest.spyOn(
        plugin.executionLifecycleRegistry,
        'dispose',
      ).mockResolvedValue(undefined);
      const disposeWorkspaces = jest.spyOn(
        ProviderWorkspaceRegistry,
        'disposeInitialized',
      ).mockResolvedValue(undefined);

      plugin.onunload();
      await Promise.resolve();

      expect(prepareForPluginUnload).toHaveBeenCalledTimes(1);
      expect(disposeExecution).not.toHaveBeenCalled();
      expect(disposeWorkspaces).not.toHaveBeenCalled();

      resolveViewDrain();
      await (plugin as any).applicationShutdownPromise;

      expect(disposeExecution).toHaveBeenCalledTimes(1);
      expect(disposeWorkspaces).toHaveBeenCalledTimes(1);
      expect(disposeExecution.mock.invocationCallOrder[0]).toBeLessThan(
        disposeWorkspaces.mock.invocationCallOrder[0],
      );
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
    it('deletes the legacy Claude MCP configuration', async () => {
      const files = installVaultFiles({
        '.claude/mcp.json': JSON.stringify({
          mcpServers: {
            legacy: { command: 'legacy-server' },
          },
        }),
      });

      await plugin.loadSettings();

      expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith('.claude/mcp.json');
      expect(files.has('.claude/mcp.json')).toBe(false);
    });

    it('continues loading when the legacy Claude MCP configuration cannot be deleted', async () => {
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => (
        path === '.claude/mcp.json'
      ));
      mockApp.vault.adapter.remove.mockRejectedValue(new Error('permission denied'));

      await expect(plugin.loadSettings()).resolves.toBeUndefined();

      expect(plugin.settings).toBeDefined();
      expect(Notice).toHaveBeenCalledWith('Failed to remove obsolete Claude configuration');
    });

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

    it('normalizes the concurrent running session limit to 5-10', async () => {
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => (
        path === '.claudian/claudian-settings.json'
      ));
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({ maxWarmAgentProcesses: 3 });
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.settings.maxWarmAgentProcesses).toBe(5);
      const writeCall = (mockApp.vault.adapter.write as jest.Mock).mock.calls.filter(
        ([path]) => path === '.claudian/claudian-settings.json',
      ).at(-1);
      expect(writeCall).toBeDefined();
      expect(JSON.parse(writeCall[1]).maxWarmAgentProcesses).toBe(5);
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

  describe('notifyProviderChatOptionsChanged', () => {
    it('reconciles durable conversation models before refreshing views', async () => {
      await plugin.onload();
      const events: string[] = [];
      const repository = (plugin as any).conversationRepository;
      jest.spyOn(repository, 'reconcileSelectedModels').mockImplementation(async () => {
        events.push('reconcile');
        return [];
      });
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([{
        refreshModelSelector: jest.fn(() => events.push('refresh')),
      } as any]);

      plugin.notifyProviderChatOptionsChanged('claude');
      await (plugin as any).providerChatOptionsChangeTail;

      expect(events).toEqual(['reconcile', 'refresh']);
    });

    it('does not refresh model selectors when durable reconciliation fails', async () => {
      await plugin.onload();
      const repository = (plugin as any).conversationRepository;
      jest.spyOn(repository, 'reconcileSelectedModels')
        .mockRejectedValue(new Error('disk full'));
      const refreshModelSelector = jest.fn();
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([{
        refreshModelSelector,
      } as any]);

      plugin.notifyProviderChatOptionsChanged('claude');
      await (plugin as any).providerChatOptionsChangeTail;

      expect(refreshModelSelector).not.toHaveBeenCalled();
    });
  });

  describe('applyEnvironmentVariables', () => {
    it('holds the execution lifecycle transition across the environment settings commit', async () => {
      await plugin.onload();
      const events: string[] = [];
      const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('grok', {
        beforeTransition: () => {
          events.push('before');
        },
        afterTransition: () => {
          events.push('after');
        },
      });
      mockApp.vault.adapter.write.mockImplementation(async () => {
        events.push('write');
      });

      await plugin.applyEnvironmentVariables('provider:grok', 'GROK_PROFILE=new');

      expect(events).toEqual(['before', 'write', 'after']);
      expect(plugin.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=new');
      unregister();
    });

    it('reconciles affected conversation models before refreshing after environment changes', async () => {
      await plugin.onload();
      const events: string[] = [];
      const repository = (plugin as any).conversationRepository;
      jest.spyOn(repository, 'reconcileSelectedModels').mockImplementation(async () => {
        events.push('reconcile');
        return [];
      });
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([{
        invalidateProviderCommandCaches: jest.fn(() => events.push('invalidate')),
        refreshModelSelector: jest.fn(() => events.push('refresh')),
      } as any]);

      await plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_MODEL=claude-sonnet-enterprise',
      );

      expect(events).toEqual(['invalidate', 'reconcile', 'refresh']);
      expect(repository.reconcileSelectedModels).toHaveBeenCalledWith('claude');
    });

    it('lets an initialized transition owner resolve CLI without reinitializing services', async () => {
      await plugin.onload();
      const cliResolver = {
        reset: jest.fn(),
        resolveFromSettings: jest.fn().mockReturnValue('/owned/codex'),
      };
      ProviderWorkspaceRegistry.setServices('codex', { cliResolver });

      await expect(plugin.getResolvedProviderCliPath('codex', {
        providerTransitionOwner: true,
      })).resolves.toBe('/owned/codex');
      expect(cliResolver.resolveFromSettings).toHaveBeenCalledWith(
        plugin.settings,
        { providerTransitionOwner: true },
      );
    });

    it('does not initialize a cold provider for transition-owner CLI resolution', async () => {
      await plugin.onload();
      ProviderWorkspaceRegistry.setServices('grok', undefined);
      const initialize = jest.fn(async () => ({
        cliResolver: {
          reset: jest.fn(),
          resolveFromSettings: jest.fn().mockReturnValue('/cold/grok'),
        },
      }));
      ProviderWorkspaceRegistry.register('grok', { initialize });

      await expect(plugin.getResolvedProviderCliPath('grok', {
        providerTransitionOwner: true,
      })).rejects.toThrow('requires initialized workspace services');
      expect(initialize).not.toHaveBeenCalled();
    });

    it('refreshes an initialized Grok catalog through its owned CLI path while gated', async () => {
      await plugin.onload();
      updateGrokProviderSettings(plugin.settings, {
        cliPath: process.execPath,
        enabled: true,
      });
      const runner = {
        run: jest.fn(async ({ args }: { args: string[] }) => (
          args[0] === '--version'
            ? { exitCode: 0, stdout: 'grok 1.0' }
            : {
              exitCode: 0,
              stdout: 'Default model: grok-4.5\nAvailable models:\n  grok-4.5\n',
            }
        )),
      };
      const service = new GrokModelCatalogService(plugin as any, { runner });
      const coordinator = new GrokModelCatalogCoordinator(plugin as any, service);
      const cliResolver = new GrokCliResolver();
      ProviderWorkspaceRegistry.setServices('grok', {
        cliResolver,
        refreshModelCatalog: context => coordinator.refreshModelCatalog(context),
      });

      const refresh = ProviderWorkspaceRegistry.refreshModelCatalog('grok', {
        providerTransitionOwner: true,
      });
      let refreshed = false;
      void refresh.then(() => { refreshed = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(refreshed).toBe(true);
      expect(runner.run).toHaveBeenCalled();

      await refresh;
    });

    it('computes an initialized Codex catalog fingerprint through owned CLI while gated', async () => {
      await plugin.onload();
      const discoveredModel = {
        defaultReasoningEffort: 'medium',
        defaultServiceTier: null,
        description: 'Owned model',
        displayName: 'Owned model',
        inputModalities: ['text'] as const,
        isDefault: true,
        model: 'owned-model',
        serviceTiers: [],
        supportedReasoningEfforts: [],
      };
      const discovery = {
        discoverModels: jest.fn().mockResolvedValue({
          kind: 'completed',
          models: [discoveredModel],
        }),
      };
      const coordinator = new CodexModelCatalogCoordinator(plugin as any, discovery);
      const cliResolver = {
        reset: jest.fn(),
        resolveFromSettings: jest.fn().mockReturnValue('/owned/codex'),
      };
      ProviderWorkspaceRegistry.setServices('codex', {
        cliResolver,
        refreshModelCatalog: context => coordinator.refreshModelCatalog(context),
      });

      const refresh = ProviderWorkspaceRegistry.refreshModelCatalog('codex', {
        providerTransitionOwner: true,
      });
      let refreshed = false;
      void refresh.then(() => { refreshed = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(refreshed).toBe(true);
      expect(discovery.discoverModels).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        { providerTransitionOwner: true },
      );
      expect(cliResolver.resolveFromSettings).toHaveBeenCalled();

      await refresh;
    });

    it('recovers the committed environment before surfacing a post-commit publication failure', async () => {
      await plugin.onload();
      updateGrokProviderSettings(plugin.settings, {
        enabled: true,
        environmentVariables: 'GROK_PROFILE=old',
      });
      const publicationError = new Error('post-commit publication failed');
      const invalidateSpy = jest.spyOn(
        ProviderSettingsCoordinator,
        'invalidateConversationSessions',
      ).mockImplementationOnce(() => {
        throw publicationError;
      });
      const refreshModelCatalog = jest.fn().mockResolvedValue({ changed: false });
      const refreshAgentMentions = jest.fn().mockResolvedValue(undefined);
      ProviderWorkspaceRegistry.setServices('grok', {
        refreshAgentMentions,
        refreshModelCatalog,
      });
      const invalidateProviderCommandCaches = jest.fn();
      const refreshModelSelector = jest.fn();
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([{
        invalidateProviderCommandCaches,
        refreshModelSelector,
      } as any]);
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('grok');

      try {
        const firstError = await plugin.applyEnvironmentVariables(
          'provider:grok',
          'GROK_PROFILE=committed',
        ).catch(error => error);

        expect(plugin.getEnvironmentVariablesForScope('provider:grok'))
          .toBe('GROK_PROFILE=committed');
        expect(refreshModelCatalog).toHaveBeenCalledTimes(1);
        expect(refreshModelCatalog).toHaveBeenCalledWith({
          providerTransitionOwner: true,
        });
        expect(refreshAgentMentions).toHaveBeenCalledTimes(1);
        expect(refreshAgentMentions).toHaveBeenCalledWith({
          providerTransitionOwner: true,
        });
        expect(invalidateProviderCommandCaches).toHaveBeenCalledWith(['grok']);
        expect(refreshModelSelector).toHaveBeenCalledTimes(1);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
          .toBe(initialGeneration + 1);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
        expect(firstError).toBe(publicationError);

        await plugin.applyEnvironmentVariables('provider:grok', 'GROK_PROFILE=next');

        expect(plugin.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=next');
        expect(refreshModelCatalog).toHaveBeenCalledTimes(2);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
          .toBe(initialGeneration + 2);
        expect(invalidateSpy).toHaveBeenCalledTimes(2);
      } finally {
        invalidateSpy.mockRestore();
      }
    });

    it('retains a committed invalidation generation when publication fails before invalidation', async () => {
      await plugin.onload();
      (plugin as any).hasLoadedAllSessionMetadata = true;
      const conversation = await plugin.createConversation({
        providerId: 'claude',
        sessionId: 'pre-invalidation-session',
      });
      const publicationError = new Error('invalidation publication failed');
      const invalidateSpy = jest.spyOn(
        ProviderSettingsCoordinator,
        'invalidateConversationSessions',
      ).mockImplementationOnce(() => {
        throw publicationError;
      });
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('claude');

      try {
        await expect(plugin.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://publication-failed.example.com',
        )).rejects.toBe(publicationError);

        const generation = plugin.settings.pendingProviderSessionInvalidations.claude;
        expect(generation).toEqual(expect.any(Number));
        expect((plugin as any).pendingEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        expect((plugin as any).blockedEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        expect(conversation.sessionId).toBe('pre-invalidation-session');
        const persistedFailureSettings = JSON.parse(
          [...mockApp.vault.adapter.write.mock.calls]
            .reverse()
            .find(([path]: [string]) => path === '.claudian/claudian-settings.json')?.[1]
            ?? '{}',
        );
        expect(persistedFailureSettings.pendingProviderSessionInvalidations?.claude)
          .toBe(generation);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('claude'))
          .toBe(initialGeneration + 1);

        await plugin.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://publication-retry.example.com',
        );

        expect(conversation.sessionId).toBeNull();
        expect(plugin.settings.pendingProviderSessionInvalidations.claude).toBeUndefined();
        expect((plugin as any).pendingEnvironmentInvalidationGenerations.has('claude')).toBe(false);
        expect((plugin as any).blockedEnvironmentInvalidationGenerations.has('claude')).toBe(false);
        expect(invalidateSpy).toHaveBeenCalledTimes(2);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('claude'))
          .toBe(initialGeneration + 2);
      } finally {
        invalidateSpy.mockRestore();
      }
    });

    it('keeps invalidation pending until every invalidated metadata write succeeds', async () => {
      await plugin.onload();
      (plugin as any).hasLoadedAllSessionMetadata = true;
      const first = await plugin.createConversation({
        providerId: 'claude',
        sessionId: 'partial-write-first',
      });
      const second = await plugin.createConversation({
        providerId: 'claude',
        sessionId: 'partial-write-second',
      });
      const metadataError = new Error('partial invalidation metadata write failed');
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(metadataError);

      try {
        await expect(plugin.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://partial-write.example.com',
        )).rejects.toBe(metadataError);

        const generation = plugin.settings.pendingProviderSessionInvalidations.claude;
        expect(first.sessionId).toBeNull();
        expect(second.sessionId).toBeNull();
        expect(generation).toEqual(expect.any(Number));
        expect((plugin as any).pendingEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        expect((plugin as any).blockedEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        const persistedFailureSettings = JSON.parse(
          [...mockApp.vault.adapter.write.mock.calls]
            .reverse()
            .find(([path]: [string]) => path === '.claudian/claudian-settings.json')?.[1]
            ?? '{}',
        );
        expect(persistedFailureSettings.pendingProviderSessionInvalidations?.claude)
          .toBe(generation);

        await plugin.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://partial-write-retry.example.com',
        );

        const retriedMetadata = saveMetadataSpy.mock.calls.slice(2).map(([metadata]) => metadata);
        expect(retriedMetadata).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id, sessionId: null }),
          expect.objectContaining({ id: second.id, sessionId: null }),
        ]));
        expect(plugin.settings.pendingProviderSessionInvalidations.claude).toBeUndefined();
        expect((plugin as any).pendingEnvironmentInvalidationGenerations.has('claude')).toBe(false);
        expect((plugin as any).blockedEnvironmentInvalidationGenerations.has('claude')).toBe(false);
      } finally {
        saveMetadataSpy.mockRestore();
      }
    });

    it('restores the committed Grok context before releasing a failed settings transition', async () => {
      await plugin.onload();
      updateGrokProviderSettings(plugin.settings, {
        enabled: true,
        environmentVariables: 'GROK_PROFILE=old',
      });
      updateCurrentGrokCatalog(plugin.settings, {
        defaultModelId: 'old-model',
        fingerprint: 'old-catalog',
        models: [{
          displayName: 'Old model',
          rawId: 'old-model',
          reasoningEfforts: [],
          supportsReasoning: false,
        }],
        refreshedAt: 1,
      });
      updateGrokProviderSettings(plugin.settings, {
        environmentHash: computeGrokEnvironmentHash(plugin.settings),
      });
      const committed = structuredClone(getGrokProviderSettings(plugin.settings));
      let contextAtRelease: ReturnType<typeof getGrokProviderSettings> | null = null;
      const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('grok', {
        afterTransition() {
          contextAtRelease = structuredClone(getGrokProviderSettings(plugin.settings));
        },
      });
      const writeError = new Error('settings write failed');
      mockApp.vault.adapter.write.mockRejectedValueOnce(writeError);

      await expect(plugin.applyEnvironmentVariables(
        'provider:grok',
        'GROK_PROFILE=new',
      )).rejects.toBe(writeError);

      expect(mockApp.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(contextAtRelease).toEqual(committed);
      expect(getGrokProviderSettings(plugin.settings)).toEqual(committed);
      expect(plugin.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=old');
      expect(getGrokProviderSettings(plugin.settings).currentCatalog).toEqual(
        committed.currentCatalog,
      );

      expect(plugin.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=old');

      await plugin.applyEnvironmentVariables('provider:grok', 'GROK_PROFILE=new');

      expect(mockApp.vault.adapter.write).toHaveBeenCalledTimes(2);
      expect(plugin.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=new');
      expect(getGrokProviderSettings(plugin.settings).environmentHash)
        .not.toBe(committed.environmentHash);
      expect(getGrokProviderSettings(plugin.settings).currentCatalog).toBeNull();
      unregister();
    });

    it('does not leak failed Claude invalidation into live or deferred conversations', async () => {
      await plugin.onload();
      const live = await plugin.createConversation({
        providerId: 'claude',
        sessionId: 'live-session',
      });
      live.providerState = {
        providerSessionId: 'live-provider-session',
        previousProviderSessionIds: ['live-previous-session'],
      };
      live.resumeAtMessageId = 'live-resume-message';
      const deferredMetadata = {
        id: 'deferred-failed-environment',
        providerId: 'claude' as const,
        title: 'Deferred failed environment',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'deferred-session',
        providerState: {
          providerSessionId: 'deferred-provider-session',
          previousProviderSessionIds: ['deferred-previous-session'],
        },
        resumeAtMessageId: 'deferred-resume-message',
      };
      let markBatchPublished!: () => void;
      const batchPublished = new Promise<void>(resolve => { markBatchPublished = resolve; });
      let finishScan!: () => void;
      const scanRelease = new Promise<void>(resolve => { finishScan = resolve; });
      const scanSpy = jest.spyOn(plugin.storage.sessions, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([deferredMetadata]);
          markBatchPublished();
          await scanRelease;
          return {
            complete: false,
            invalidMetadataCount: 0,
            metadata: [deferredMetadata],
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
      let markWriteStarted!: () => void;
      const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
      let rejectWrite!: (error: Error) => void;
      const failedWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
      let shouldFailSettingsWrite = true;
      mockApp.vault.adapter.write.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json' && shouldFailSettingsWrite) {
          shouldFailSettingsWrite = false;
          markWriteStarted();
          await failedWrite;
        }
      });
      let stateAtRelease: {
        blocked: boolean;
        deferredSessionId: string | null | undefined;
        liveSessionId: string | null;
        pending: unknown;
      } | null = null;
      const afterTransition = jest.fn(() => {
        stateAtRelease = {
          blocked: (plugin as any).blockedEnvironmentInvalidationGenerations.has('claude'),
          deferredSessionId: plugin.getCachedConversation(deferredMetadata.id)?.sessionId,
          liveSessionId: live.sessionId,
          pending: plugin.settings.pendingProviderSessionInvalidations.claude,
        };
      });
      const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('claude', {
        afterTransition,
      });

      const writeError = new Error('environment settings write failed');
      const apply = plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://failed.example.com',
      ).catch(error => error);
      await writeStarted;
      const scan = (plugin as any).loadRemainingSessionMetadata();
      await batchPublished;
      rejectWrite(writeError);
      expect(await apply).toBe(writeError);
      finishScan();
      await scan;

      const deferred = plugin.getCachedConversation(deferredMetadata.id);
      expect(afterTransition).toHaveBeenCalledTimes(1);
      expect(stateAtRelease).toEqual({
        blocked: false,
        deferredSessionId: 'deferred-session',
        liveSessionId: 'live-session',
        pending: undefined,
      });
      expect(live).toEqual(expect.objectContaining({
        sessionId: 'live-session',
        providerState: {
          providerSessionId: 'live-provider-session',
          previousProviderSessionIds: ['live-previous-session'],
        },
        resumeAtMessageId: 'live-resume-message',
      }));
      expect(deferred).toEqual(expect.objectContaining({
        sessionId: 'deferred-session',
        providerState: deferredMetadata.providerState,
        resumeAtMessageId: 'deferred-resume-message',
      }));
      expect(plugin.settings.pendingProviderSessionInvalidations.claude).toBeUndefined();
      expect((plugin as any).pendingEnvironmentInvalidationGenerations.has('claude')).toBe(false);
      expect((plugin as any).blockedEnvironmentInvalidationGenerations.has('claude')).toBe(false);
      expect(saveMetadataSpy).not.toHaveBeenCalledWith(expect.objectContaining({
        id: deferredMetadata.id,
        sessionId: null,
      }));
      expect(mockApp.vault.adapter.write.mock.calls.filter(
        ([path]: [string]) => path === '.claudian/claudian-settings.json',
      )).toHaveLength(1);

      const invalidateSpy = jest.spyOn(
        ProviderSettingsCoordinator,
        'invalidateConversationSessions',
      );
      saveMetadataSpy.mockClear();
      await plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://retry.example.com',
      );

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(live.sessionId).toBeNull();
      expect(live.providerState).toEqual({
        previousProviderSessionIds: [
          'live-previous-session',
          'live-provider-session',
        ],
      });
      expect(live.resumeAtMessageId).toBe('live-resume-message');
      expect(deferred?.sessionId).toBeNull();
      expect(deferred?.providerState).toEqual({
        previousProviderSessionIds: [
          'deferred-previous-session',
          'deferred-provider-session',
        ],
      });
      expect(deferred?.resumeAtMessageId).toBe('deferred-resume-message');
      expect(saveMetadataSpy.mock.calls.map(([metadata]) => metadata.id).sort()).toEqual([
        deferredMetadata.id,
        live.id,
      ].sort());

      invalidateSpy.mockRestore();
      saveMetadataSpy.mockRestore();
      scanSpy.mockRestore();
      loadSourceSpy.mockRestore();
      unregister();
    });

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
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
      saveMetadataSpy.mockClear();

      await plugin.applyEnvironmentVariables('provider:claude', 'ANTHROPIC_MODEL=claude-sonnet-4-5');

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.sessionId).toBeNull();
      expect(saveMetadataSpy).toHaveBeenCalled();
    });

    it('serializes overlapping environment invalidation writes', async () => {
      await plugin.onload();
      (plugin as any).hasLoadedAllSessionMetadata = true;
      await plugin.createConversation({ sessionId: 'overlapping-session' });
      let finishFirstWrite!: () => void;
      const firstWriteRelease = new Promise<void>((resolve) => {
        finishFirstWrite = resolve;
      });
      let markFirstWriteStarted!: () => void;
      const firstWriteStarted = new Promise<void>((resolve) => {
        markFirstWriteStarted = resolve;
      });
      let blockedFirstWrite = false;
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockImplementation(async () => {
          if (!blockedFirstWrite) {
            blockedFirstWrite = true;
            markFirstWriteStarted();
            await firstWriteRelease;
          }
        });

      const firstUpdate = plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://first-overlap.example.com',
      );
      await firstWriteStarted;
      let secondUpdateSettled = false;
      const secondUpdate = plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://second-overlap.example.com',
      ).finally(() => {
        secondUpdateSettled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 1));
      const markerWhileFirstWritePending =
        plugin.settings.pendingProviderSessionInvalidations.claude;
      const secondSettledWhileFirstWritePending = secondUpdateSettled;

      finishFirstWrite();
      await Promise.all([firstUpdate, secondUpdate]);
      saveMetadataSpy.mockRestore();

      expect(markerWhileFirstWritePending).toEqual(expect.any(Number));
      expect(secondSettledWhileFirstWritePending).toBe(false);
      expect(plugin.settings.pendingProviderSessionInvalidations.claude)
        .toBeUndefined();
    });

    it('flushes already-invalidated sessions after an earlier environment write fails', async () => {
      await plugin.onload();
      (plugin as any).hasLoadedAllSessionMetadata = true;
      await plugin.createConversation({ sessionId: 'failed-overlap-session' });
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockRejectedValueOnce(new Error('metadata write failed'));

      await expect(plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://failed-write.example.com',
      )).rejects.toThrow('metadata write failed');
      await plugin.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://retry-write.example.com',
      );
      const saveCallCount = saveMetadataSpy.mock.calls.length;
      const retriedMetadata = saveMetadataSpy.mock.calls[1]?.[0];
      saveMetadataSpy.mockRestore();

      expect(saveCallCount).toBe(2);
      expect(retriedMetadata).toEqual(expect.objectContaining({
        sessionId: null,
      }));
      expect(plugin.settings.pendingProviderSessionInvalidations.claude)
        .toBeUndefined();
    });

    it('invalidates provider executions through the lifecycle registry when env changes', async () => {
      await plugin.onload();
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('claude');

      const mockView = {
        getTabManager: jest.fn(),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      // Change env but not in a way that affects model
      await plugin.applyEnvironmentVariables('shared', 'SOME_VAR=value');

      expect(plugin.executionLifecycleRegistry.getProviderGeneration('claude'))
        .toBe(initialGeneration + 1);
      expect(mockView.getTabManager).not.toHaveBeenCalled();
    });

    it('does not inspect open tab execution state during provider transitions', async () => {
      await plugin.onload();

      const createView = () => {
        const getTabManager = jest.fn();
        return {
          getTabManager,
          view: {
            getTabManager,
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

      expect(first.getTabManager).not.toHaveBeenCalled();
      expect(second.getTabManager).not.toHaveBeenCalled();
    });

    it('invalidates Claude conversation metadata without inspecting tab execution state', async () => {
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

      const mockView = {
        getTabManager: jest.fn(),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.applyEnvironmentVariables('provider:claude', 'ANTHROPIC_MODEL=claude-sonnet-4-5');

      expect(plugin.getConversationSync(conversation.id)?.sessionId).toBeNull();
      expect(mockView.getTabManager).not.toHaveBeenCalled();
    });

    it('reloads preserved sessions while resetting only invalidation-policy providers', async () => {
      await plugin.onload();

      const reloadConversation = await plugin.createConversation({
        providerId: 'claude',
        sessionId: 'preserved-session',
      });
      await plugin.updateConversation(reloadConversation.id, {
        providerState: { providerSessionId: 'preserved-provider-session' },
      });
      const invalidatedConversation = await plugin.createConversation({
        providerId: 'codex',
        sessionId: 'invalidated-session',
      });
      await plugin.updateConversation(invalidatedConversation.id, {
        providerState: { threadId: 'invalidated-thread' },
      });

      const claudeReconciler = ProviderRegistry.getSettingsReconciler('claude');
      const reconcileSpy = jest.spyOn(claudeReconciler, 'reconcileModelWithEnvironment')
        .mockReturnValue({ changed: true, invalidatedConversations: [] });
      claudeReconciler.environmentSessionPolicy = 'reload';
      const stagePendingSpy = jest.spyOn(plugin as any, 'stagePendingSessionInvalidations');
      const getTabManager = jest.fn();
      const mockView = {
        getTabManager,
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      try {
        await plugin.applyEnvironmentVariables(
          'shared',
          [
            'ANTHROPIC_BASE_URL=https://reload.example.com',
            'OPENAI_BASE_URL=https://invalidate.example.com',
          ].join('\n'),
        );
      } finally {
        delete claudeReconciler.environmentSessionPolicy;
        reconcileSpy.mockRestore();
      }

      const preserved = await plugin.getConversationById(reloadConversation.id);
      const invalidated = await plugin.getConversationById(invalidatedConversation.id);
      expect(stagePendingSpy).toHaveBeenCalledWith(
        expect.anything(),
        ['codex'],
      );
      expect(stagePendingSpy).toHaveBeenCalledTimes(1);
      expect(preserved).toEqual(expect.objectContaining({
        sessionId: 'preserved-session',
        providerState: { providerSessionId: 'preserved-provider-session' },
      }));
      expect(invalidated).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: undefined,
      }));
      expect(getTabManager).not.toHaveBeenCalled();
    });

    it('does not touch an initialized blank Grok tab during an environment transition', async () => {
      await plugin.onload();
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('grok');

      const mockView = {
        getTabManager: jest.fn(),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.applyEnvironmentVariables(
        'provider:grok',
        'GROK_PROFILE=first-turn-reload',
      );

      expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
        .toBe(initialGeneration + 1);
      expect(mockView.getTabManager).not.toHaveBeenCalled();
    });

    it('does not coordinate environment changes through open Grok tabs', async () => {
      await plugin.onload();
      const conversation = await plugin.createConversation({ providerId: 'grok' });
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('grok');
      const mockView = {
        getTabManager: jest.fn(),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.applyEnvironmentVariables(
        'provider:grok',
        'GROK_PROFILE=streaming-first-turn',
      );

      expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
        .toBe(initialGeneration + 1);
      expect(mockView.getTabManager).not.toHaveBeenCalled();
      expect(plugin.getConversationSync(conversation.id)?.sessionId).toBeNull();
    });
  });

  describe('applyProviderRuntimeSettings', () => {
    it('persists a CLI fingerprint and restart-safe session invalidation atomically', async () => {
      const settingsPath = '.claudian/claudian-settings.json';
      const deferredMetadata = {
        id: 'runtime-settings-restart-session',
        providerId: 'codex' as const,
        title: 'Runtime settings restart session',
        createdAt: 1,
        lastActivityAt: 2,
        sessionId: 'codex-thread-id',
        providerState: { threadId: 'codex-thread-id' },
      };
      const files = installVaultFiles({
        [settingsPath]: JSON.stringify({
          model: '',
          providerConfigs: {
            codex: {
              enabled: true,
              environmentHash: '',
              environmentVariables: '',
            },
          },
          settingsProvider: 'codex',
        }),
      });

      await plugin.onload();
      (plugin as any).hasLoadedAllSessionMetadata = false;
      const hostnameKey = getHostnameKey();
      await plugin.applyProviderRuntimeSettings(['codex'], (settings) => {
        updateCodexProviderSettings(settings, {
          cliPathsByHost: { [hostnameKey]: '/custom/codex' },
        });
      });

      const firstRunSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      const fingerprint = firstRunSettings.providerConfigs.codex.environmentHash;
      expect(firstRunSettings.providerConfigs.codex.cliPathsByHost).toEqual({
        [hostnameKey]: '/custom/codex',
      });
      expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
      expect(firstRunSettings.pendingProviderSessionInvalidations?.codex)
        .toEqual(expect.any(Number));

      plugin.onunload();
      const restartedPlugin = new ClaudianPlugin(mockApp, mockManifest);
      (restartedPlugin.loadData as jest.Mock).mockResolvedValue({});
      const saveMetadataSpy = jest.spyOn(
        ConversationPersistenceStore.prototype,
        'saveMetadata',
      );
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scanMetadata')
        .mockImplementation(async (options) => {
          options?.onBatch?.([deferredMetadata]);
          return {
            metadata: [deferredMetadata],
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);

      await restartedPlugin.onload();
      await (restartedPlugin as any).loadRemainingSessionMetadata();

      const restartedConversation = restartedPlugin.getCachedConversation(deferredMetadata.id);
      const persistedMetadata = JSON.parse(
        files.get('.claudian/sessions/runtime-settings-restart-session.meta.json') ?? '{}',
      );
      const restartedSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      const invalidationWrites = saveMetadataSpy.mock.calls.filter(
        ([metadata]) => metadata.id === deferredMetadata.id,
      );
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();
      saveMetadataSpy.mockRestore();

      expect(restartedConversation).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: undefined,
      }));
      expect(persistedMetadata).toEqual(expect.objectContaining({
        sessionId: null,
      }));
      expect(persistedMetadata).not.toHaveProperty('providerState');
      expect(restartedSettings.providerConfigs.codex.environmentHash).toBe(fingerprint);
      expect(restartedSettings.pendingProviderSessionInvalidations?.codex).toBeUndefined();
      expect(invalidationWrites).toHaveLength(1);
    });

    it('advances the Grok fingerprint while preserving reload-policy sessions', async () => {
      await plugin.onload();
      const conversation = await plugin.createConversation({
        providerId: 'grok',
        sessionId: 'grok-session-id',
      });
      await plugin.updateConversation(conversation.id, {
        providerState: { sessionDirectory: '/tmp/grok/session-id' },
      });
      const hostnameKey = getHostnameKey();

      await plugin.applyProviderRuntimeSettings(['grok'], (settings) => {
        updateGrokProviderSettings(settings, {
          cliPathsByHost: { [hostnameKey]: '/custom/grok' },
          enabled: true,
        });
      });

      const grokSettings = getGrokProviderSettings(plugin.settings);
      expect(grokSettings.environmentHash).toBe(computeGrokEnvironmentHash(plugin.settings));
      expect(plugin.getConversationSync(conversation.id)).toEqual(expect.objectContaining({
        sessionId: 'grok-session-id',
        providerState: { sessionDirectory: '/tmp/grok/session-id' },
      }));
      expect(ProviderSettingsCoordinator.reconcileProviders(
        plugin.settings,
        [conversation],
        ['grok'],
      ).changed).toBe(false);
    });

    it('finishes durable invalidation when a post-commit apply hook fails', async () => {
      await plugin.onload();
      (plugin as any).hasLoadedAllSessionMetadata = true;
      const conversation = await plugin.createConversation({
        providerId: 'codex',
        sessionId: 'post-commit-thread',
      });
      await plugin.updateConversation(conversation.id, {
        providerState: { threadId: 'post-commit-thread' },
      });
      const hostnameKey = getHostnameKey();

      await expect(plugin.applyProviderRuntimeSettings(
        ['codex'],
        (settings) => {
          updateCodexProviderSettings(settings, {
            cliPathsByHost: { [hostnameKey]: '/custom/post-commit-codex' },
          });
        },
        () => {
          throw new Error('resolver reset failed');
        },
      )).rejects.toThrow('resolver reset failed');

      const codexSettings = getCodexProviderSettings(plugin.settings);
      expect(codexSettings.cliPathsByHost).toEqual({
        [hostnameKey]: '/custom/post-commit-codex',
      });
      expect(isVersionedRuntimeInputFingerprint(
        codexSettings.environmentHash,
      )).toBe(true);
      expect(plugin.getConversationSync(conversation.id)).toEqual(expect.objectContaining({
        sessionId: null,
        providerState: undefined,
      }));
      expect(plugin.settings.pendingProviderSessionInvalidations.codex).toBeUndefined();
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
    it('uses the layout-neutral New label', async () => {
      await plugin.onload();

      expect(getRegisteredCommand('new-tab').name).toBe('New');
    });

    it('delegates New to the active dual-pane navigation policy', async () => {
      await plugin.onload();

      const handleNewConversationCommand = jest.fn().mockResolvedValue(true);
      const createNewTab = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(plugin, 'getView').mockReturnValue({
        createNewTab,
        getTabManager: jest.fn().mockReturnValue({}),
        handleNewConversationCommand,
      } as any);

      const command = getRegisteredCommand('new-tab');
      expect(command.checkCallback(false)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(handleNewConversationCommand).toHaveBeenCalledTimes(1);
      expect(createNewTab).not.toHaveBeenCalled();
    });

    it('keeps replace and close tab commands out of dual mode', async () => {
      await plugin.onload();

      jest.spyOn(plugin, 'getView').mockReturnValue({
        isDualPaneMode: () => true,
        getTabManager: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({ state: { isStreaming: false } }),
        }),
      } as any);

      const replaceCommand = getRegisteredCommand('new-session');
      const closeCommand = getRegisteredCommand('close-current-tab');
      expect(replaceCommand.name).toBe('Replace current conversation');
      expect(replaceCommand.checkCallback(true)).toBe(false);
      expect(closeCommand.checkCallback(true)).toBe(false);
    });

    it('opens the view without creating a duplicate tab when no tab layout is persisted', async () => {
      await plugin.onload();

      const createNewTab = jest.fn().mockResolvedValue(undefined);
      const focusActiveInput = jest.fn();
      const mockView = {
        createNewTab,
        focusActiveInput,
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
      expect(focusActiveInput).toHaveBeenCalledTimes(1);
    });

    it('starts from the fresh runtime tab after reopening a persisted layout', async () => {
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
      const focusActiveInput = jest.fn();
      const mockView = {
        createNewTab,
        focusActiveInput,
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
      expect(focusActiveInput).toHaveBeenCalledTimes(1);
    });

    it('stays available regardless of the former tab limit', async () => {
      await plugin.onload();

      const mockView = {
        getTabManager: jest.fn().mockReturnValue({
          canCreateTab: jest.fn().mockReturnValue(false),
        }),
      };

      jest.spyOn(plugin, 'getView').mockReturnValue(mockView as any);

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(true);
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

    it('ignores the persisted runtime layout when checking new-tab availability', async () => {
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

      expect(command.checkCallback(true)).toBe(true);
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
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
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
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
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
      const saveSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
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

    it('does not expose or invoke provider-native session deletion', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation({ sessionId: 'provider-session-1' });

      await plugin.deleteConversation(conv.id);

      expect('deleteSDKSession' in sdkSession).toBe(false);
      expect(plugin.getConversationList().find(item => item.id === conv.id)).toBeUndefined();
    });

    it('should reset every open tab that references the deleted conversation', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation();
      const cancelStreaming = jest.fn();
      const createNew = jest.fn().mockResolvedValue(undefined);
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        view: {
          notifyConversationListChanged: jest.fn(),
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

      await plugin.deleteConversation(conv.id);

      expect(cancelStreaming).toHaveBeenCalledTimes(1);
      expect(createNew).toHaveBeenCalledWith({ force: true });
    });

    it('attempts every matching tab and retries only failed deletion associations', async () => {
      await plugin.onload();
      const conv = await plugin.createConversation();
      const firstTab = {
        conversationId: conv.id as string | null,
        controllers: {
          inputController: { cancelStreaming: jest.fn() },
          conversationController: {
            createNew: jest.fn()
              .mockRejectedValueOnce(new Error('first tab failed'))
              .mockImplementation(async () => {
                firstTab.conversationId = null;
              }),
          },
        },
      };
      const secondTab = {
        conversationId: conv.id as string | null,
        controllers: {
          inputController: { cancelStreaming: jest.fn() },
          conversationController: {
            createNew: jest.fn().mockImplementation(async () => {
              secondTab.conversationId = null;
            }),
          },
        },
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        view: {
          notifyConversationListChanged: jest.fn(),
          getTabManager: () => ({
            getAllTabs: () => [firstTab, secondTab],
          }),
        },
      }]);

      await expect(plugin.deleteConversation(conv.id)).rejects.toThrow('first tab failed');

      expect(firstTab.controllers.conversationController.createNew).toHaveBeenCalledTimes(1);
      expect(secondTab.controllers.conversationController.createNew).toHaveBeenCalledTimes(1);
      expect(plugin.getConversationList().find(item => item.id === conv.id)).toBeUndefined();

      await expect(plugin.deleteConversation(conv.id)).resolves.toBeUndefined();

      expect(firstTab.controllers.conversationController.createNew).toHaveBeenCalledTimes(2);
      expect(secondTab.controllers.conversationController.createNew).toHaveBeenCalledTimes(1);
      expect(firstTab.conversationId).toBeNull();
      expect(secondTab.conversationId).toBeNull();
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
        'different-reported-session',
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

    it('notifies every open view after conversation list mutations', async () => {
      await plugin.onload();
      const firstView = {
        getTabManager: jest.fn().mockReturnValue(null),
        notifyConversationListChanged: jest.fn(),
      };
      const secondView = {
        getTabManager: jest.fn().mockReturnValue(null),
        notifyConversationListChanged: jest.fn(),
      };
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([
        firstView as any,
        secondView as any,
      ]);

      const conversation = await plugin.createConversation();
      await plugin.renameConversation(conversation.id, 'Renamed');
      await plugin.deleteConversation(conversation.id);

      expect(firstView.notifyConversationListChanged).toHaveBeenCalledTimes(3);
      expect(secondView.notifyConversationListChanged).toHaveBeenCalledTimes(3);
    });
  });

  describe('linked note renames', () => {
    it('registers Vault rename and delete listeners', async () => {
      await plugin.onload();

      expect(mockApp.vault.on).toHaveBeenCalledWith('rename', expect.any(Function));
      expect(mockApp.vault.on).toHaveBeenCalledWith('delete', expect.any(Function));
    });

    it('rewrites linked file and folder paths without changing activity timestamps', async () => {
      await plugin.onload();
      const fileConversation = await plugin.createConversation();
      const folderConversation = await plugin.createConversation();
      await plugin.updateConversation(fileConversation.id, { currentNote: 'Notes/Old.md' });
      await plugin.updateConversation(folderConversation.id, {
        currentNote: 'Projects/Old/Plan.md',
      });
      const fileUpdatedAt = fileConversation.lastActivityAt;
      const folderUpdatedAt = folderConversation.lastActivityAt;
      await plugin.setLinkedNotePinned('Notes/Old.md', true);
      await plugin.setLinkedNotePinned('Projects/Old/Plan.md', true);

      await (plugin as any).handleLinkedNoteRename(
        new (TFile as any)('Notes/New.md'),
        'Notes/Old.md',
      );
      await (plugin as any).handleLinkedNoteRename(
        new (TFolder as any)('Projects/New'),
        'Projects/Old',
      );

      expect(fileConversation).toMatchObject({
        currentNote: 'Notes/New.md',
        lastActivityAt: fileUpdatedAt,
      });
      expect(folderConversation).toMatchObject({
        currentNote: 'Projects/New/Plan.md',
        lastActivityAt: folderUpdatedAt,
      });
      expect(plugin.settings.pinnedLinkedNotePaths).toEqual([
        'Notes/New.md',
        'Projects/New/Plan.md',
      ]);
    });

    it('removes deleted file and folder paths from pinned linked notes', async () => {
      await plugin.onload();
      await plugin.setLinkedNotePinned('Notes/Plan.md', true);
      await plugin.setLinkedNotePinned('Projects/Archive/One.md', true);
      await plugin.setLinkedNotePinned('Projects/Archive/Two.md', true);

      await (plugin as any).handlePinnedLinkedNoteDeleted(
        new (TFile as any)('Notes/Plan.md'),
      );
      await (plugin as any).handlePinnedLinkedNoteDeleted(
        new (TFolder as any)('Projects/Archive'),
      );

      expect(plugin.settings.pinnedLinkedNotePaths).toEqual([]);
    });
  });

  describe('updateConversation', () => {
    it('creates linked-note metadata atomically and publishes later note changes', async () => {
      await plugin.onload();
      const notifyConversationListChanged = jest.fn();
      jest.spyOn(plugin, 'getAllViews').mockReturnValue([{
        notifyConversationListChanged,
      } as any]);

      const conv = await plugin.createConversation({
        currentNote: 'Projects/Initial.md',
      });

      expect(plugin.getConversationList().find(({ id }) => id === conv.id)?.currentNote)
        .toBe('Projects/Initial.md');
      notifyConversationListChanged.mockClear();

      await plugin.updateConversation(conv.id, {
        currentNote: 'Projects/Updated.md',
      });

      expect(plugin.getConversationList().find(({ id }) => id === conv.id)?.currentNote)
        .toBe('Projects/Updated.md');
      expect(notifyConversationListChanged).toHaveBeenCalledTimes(1);

      notifyConversationListChanged.mockClear();
      await plugin.updateConversation(conv.id, {
        lastActivityAt: 1234,
        titleGenerationStatus: 'failed',
      });

      expect(plugin.getConversationList().find(({ id }) => id === conv.id)).toMatchObject({
        lastActivityAt: 1234,
        titleGenerationStatus: 'failed',
      });
      expect(notifyConversationListChanged).toHaveBeenCalledTimes(1);
    });

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

    it('should preserve lastActivityAt for metadata-only updates', async () => {
      await plugin.onload();

      const conv = await plugin.createConversation();
      const originalLastActivityAt = conv.lastActivityAt;

      await plugin.updateConversation(conv.id, { title: 'Changed' });

      const updated = await plugin.getConversationById(conv.id);
      expect(updated?.lastActivityAt).toBe(originalLastActivityAt);
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
    it('migrates a legacy Codex fingerprint before reconciling persisted sessions', async () => {
      const timestamp = Date.now();
      const metadataPath = '.claudian/sessions/conv-codex-legacy.meta.json';
      const sessionMetadata = {
        id: 'conv-codex-legacy',
        providerId: 'codex',
        title: 'Legacy Codex Chat',
        createdAt: timestamp,
        lastActivityAt: timestamp,
        sessionId: 'codex-thread-123',
        selectedModel: 'openai-codex/gpt-5',
        providerState: {
          threadId: 'codex-thread-123',
          sessionFilePath: 'C:\\Users\\tester\\.codex\\sessions\\codex-thread-123.jsonl',
        },
      };

      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => (
        path === '.claudian/claudian-settings.json'
        || path === '.claudian/sessions'
        || path === metadataPath
      ));
      mockApp.vault.adapter.list.mockImplementation(async (path: string) => (
        path === '.claudian/sessions'
          ? { files: [metadataPath], folders: [] }
          : { files: [], folders: [] }
      ));
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({
            providerConfigs: {
              codex: {
                cliPath: 'C:\\Users\\tester\\codex.exe',
                enabled: true,
                environmentHash: '',
                environmentVariables: '',
              },
            },
          });
        }
        if (path === metadataPath) {
          return JSON.stringify(sessionMetadata);
        }
        return '';
      });

      await plugin.loadSettings();

      expect(plugin.getCachedConversation(sessionMetadata.id)).toMatchObject({
        sessionId: sessionMetadata.sessionId,
        providerState: sessionMetadata.providerState,
      });
      expect(isVersionedRuntimeInputFingerprint(
        getCodexProviderSettings(plugin.settings).environmentHash,
      )).toBe(true);
      expect(mockApp.vault.adapter.write).not.toHaveBeenCalledWith(
        metadataPath,
        expect.any(String),
      );
    });

    it('should preserve Claude metadata during startup when local native history is missing', async () => {
      const timestamp = Date.now();
      const sessionMeta = JSON.stringify({
        id: 'conv-stale-1',
        providerId: 'claude',
        title: 'Stale Chat',
        createdAt: timestamp,
        lastActivityAt: timestamp,
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
        lastActivityAt: timestamp,
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
        lastActivityAt: timestamp,
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
        lastActivityAt: timestamp,
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
