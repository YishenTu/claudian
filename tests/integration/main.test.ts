import { DEFAULT_CLAUDIAN_SETTINGS as DEFAULT_SETTINGS } from '@test/helpers/defaultSettings';
import { testClock } from '@test/helpers/testClock';
import { Notice, TFile, TFolder } from 'obsidian';

import type { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionSnapshotStore } from '@/app/conversations/SessionSnapshotStore';
import { PinnedLinkedContentPathCoordinator } from '@/app/settings/PinnedLinkedContentPathCoordinator';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import type { SessionMetadataReadResult } from '@/app/storage/SessionStorage';
import { SessionStorage } from '@/app/storage/SessionStorage';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import type { ClaudianChatFeatureHost } from '@/composition/ClaudianFeatureHosts';
import type { ClaudianViews } from '@/composition/ClaudianViews';
import { getDeviceSessionsPath } from '@/core/bootstrap/storagePaths';
import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import { type ClaudianSettings, type Conversation, type SessionMetadata, VIEW_TYPE_CLAUDIAN } from '@/core/types';
import { ZenModeController } from '@/features/chat/zen/ZenModeController';
import * as sdkSession from '@/providers/claude/history/ClaudeHistoryStore';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '@/providers/codex/settings';
import { computeGrokEnvironmentHash } from '@/providers/grok/env/GrokSettingsReconciler';
import { GrokCLIResolver } from '@/providers/grok/runtime/GrokCLIResolver';
import { GrokModelCatalogCoordinator } from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import { GrokModelCatalogService } from '@/providers/grok/runtime/GrokModelCatalogService';
import {
  getGrokProviderSettings,
  updateCurrentGrokCatalog,
  updateGrokProviderSettings,
} from '@/providers/grok/settings';

// Mock fs for ClaudianService
jest.mock('fs');

// Now import the plugin after mocking
import ClaudianPlugin from '@/main';

describe('ClaudianPlugin', () => {
  let plugin: ClaudianPlugin;
  let pluginInstances: ClaudianPlugin[];
  let mockApp: any;
  let mockManifest: any;

  function createPlugin(): ClaudianPlugin {
    const instance = new ClaudianPlugin(mockApp, mockManifest);
    pluginInstances.push(instance);
    return instance;
  }

  // The awaited work stays pending, so any completion proves onload does not await it.
  // The bound only limits how long a regression takes to report, not how fast onload runs.
  async function completesWhilePending(promise: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForCondition(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(condition()).toBe(true);
  }

  function getRegisteredCommand(commandId: string) {
    const call = (plugin.addCommand as jest.Mock).mock.calls.find(
      ([config]) => config.id === commandId,
    );

    if (!call) {
      throw new Error(`Command ${commandId} was not registered`);
    }

    return call[0];
  }

  function chatHostOf(target: ClaudianPlugin = plugin): ClaudianChatFeatureHost {
    return (target as unknown as { chatHost: ClaudianChatFeatureHost }).chatHost;
  }

  function viewsOf(target: ClaudianPlugin = plugin): ClaudianViews {
    return (target as unknown as { views: ClaudianViews }).views;
  }

  function storageOf(target: ClaudianPlugin = plugin): SharedStorageService {
    return (target as unknown as { storage: SharedStorageService }).storage;
  }

  function repositoryOf(target: ClaudianPlugin = plugin): ConversationRepository {
    return chatHostOf(target).executionPersistence;
  }

  /** The runtime settings coordinator wired into the plugin's session metadata loader. */
  function runtimeSettingsOf(target: ClaudianPlugin = plugin): any {
    return (target as any).sessionMetadata.options.runtimeSettings;
  }

  function getConversationPersistence(
    target: ClaudianPlugin,
  ): ConversationPersistenceStore {
    return (
      storageOf(target) as SharedStorageService & {
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
          ? { metadata: item, needsMigration: false, source: 'device' as const }
          : null;
      });
  }

  function deviceMetadataRecords(
    ...metadata: SessionMetadata[]
  ): SessionMetadataReadResult[] {
    return metadata.map(item => ({
      metadata: item,
      needsMigration: false,
      source: 'device',
    }));
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
    pluginInstances = [];
    // Reset mocks
    jest.restoreAllMocks();
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
        layoutReady: true,
        detachLeavesOfType: jest.fn(),
        on: jest.fn().mockReturnValue({ id: 'workspace-event' }),
        offref: jest.fn(),
        onLayoutReady: jest.fn(),
        getLeavesOfType: jest.fn().mockReturnValue([]),
        getMostRecentLeaf: jest.fn().mockReturnValue(null),
        getActiveViewOfType: jest.fn().mockReturnValue(null),
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
    plugin = createPlugin();
    (plugin.loadData as jest.Mock).mockResolvedValue({});
  });

  it('publishes committed presentation settings to every view after persistence', async () => {
    await plugin.onload();
    const views = [0, 1].map(() => ({
      refreshMessageTimestamps: jest.fn(), refreshDualPaneLayout: jest.fn(),
      updateHiddenCommands: jest.fn(), refreshModelSelector: jest.fn(),
    }));
    const viewsSpy = jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue(views as never);
    const zenReconcile = jest.spyOn(ZenModeController.prototype, 'reconcile');
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const persist = jest.spyOn(storageOf(plugin), 'saveClaudianSettings').mockImplementationOnce(async () => {
      started();
      await new Promise<void>(resolve => { finish = resolve; });
    });
    try {
      const change = chatHostOf(plugin).mutateSettings(settings => {
        settings.showMessageTimestamps = !settings.showMessageTimestamps;
        settings.enableDualPane = !settings.enableDualPane;
        settings.hiddenCommands = ['test-command'];
        settings.customContextLimits = { test: 1000 };
        settings.enableZenMode = !settings.enableZenMode;
      });
      await writing;
      for (const view of views) {
        for (const refresh of Object.values(view)) expect(refresh).not.toHaveBeenCalled();
      }
      expect(zenReconcile).not.toHaveBeenCalled();
      finish();
      await change;
      for (const view of views) {
        for (const refresh of Object.values(view)) expect(refresh).toHaveBeenCalledTimes(1);
      }
      expect(zenReconcile).toHaveBeenCalledTimes(1);
      persist.mockRejectedValueOnce(new Error('disk unavailable'));
      await expect(chatHostOf(plugin).mutateSettings(settings => {
        settings.showMessageTimestamps = !settings.showMessageTimestamps;
      })).rejects.toThrow('disk unavailable');
      for (const view of views) expect(view.refreshMessageTimestamps).toHaveBeenCalledTimes(1);
      persist.mockResolvedValueOnce(undefined);
      views[0].refreshModelSelector.mockImplementationOnce(() => { throw new Error('view detached'); });
      await expect(chatHostOf(plugin).mutateSettings(settings => { settings.customContextLimits = { test: 2000 }; }))
        .rejects.toThrow('post-commit');
      expect(views[1].refreshModelSelector).toHaveBeenCalledTimes(2);
      expect(chatHostOf(plugin).getCommittedSettings().customContextLimits).toEqual({ test: 2000 });
    } finally {
      viewsSpy.mockRestore();
      zenReconcile.mockRestore();
      persist.mockRestore();
    }
  });

  afterEach(async () => {
    for (const instance of pluginInstances) {
      instance.onunload();
    }
    await Promise.allSettled(pluginInstances.map(instance => (
      (instance as unknown as { applicationShutdownPromise?: Promise<void> })
        .applicationShutdownPromise
    )));
  });

  describe('onload', () => {
    it.each([true, false])('migrates missing selected effort metadata after layout when enabled: %s', async enabled => {
      const initialize = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined);
      const refresh = jest.fn().mockResolvedValue({ changed: true });
      await plugin.onload();
      plugin.settings.providerConfigs.claude = {
        ...plugin.settings.providerConfigs.claude, enabled, visibleModels: ['sonnet'], discoveredModels: [],
      };
      ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: { refresh } as any });
      expect(refresh).not.toHaveBeenCalled();
      for (const [ready] of mockApp.workspace.onLayoutReady.mock.calls) ready();
      await (plugin as any).modelMetadataMigration;
      expect(initialize.mock.calls.filter(([, id, reason]) => id === 'claude' && reason === 'model-metadata-migration'))
        .toHaveLength(enabled ? 1 : 0);
      expect(refresh).toHaveBeenCalledTimes(enabled ? 1 : 0);
    });

    it.each(['run', 'before-layout', 'before-timer'])('defers obsolete input cleanup until after layout and respects unload: %s', async mode => {
      const inputPath = '.claudian/sessions/old.inputs.json';
      const files = installVaultFiles({ [inputPath]: '{}' });
      await mockApp.vault.adapter.mkdir('.claudian/sessions');
      mockApp.vault.adapter.list.mockResolvedValue({ files: [inputPath], folders: [] });
      await plugin.onload();
      expect(files.has(inputPath)).toBe(true);
      if (mode === 'before-layout') plugin.onunload();
      for (const [ready] of mockApp.workspace.onLayoutReady.mock.calls) { ready(); ready(); }
      if (mode === 'before-timer') plugin.onunload();
      await new Promise(resolve => setTimeout(resolve, 5));
      await (plugin as any).sessionInputCleanup;
      expect(files.has(inputPath)).toBe(mode !== 'run');
    });

    it('defers snapshot maintenance, aborts it on unload, and joins it before shutdown', async () => {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let signal: AbortSignal | undefined;
      const sweep = jest.spyOn(SessionSnapshotStore.prototype, 'sweep').mockImplementation(async received => {
        signal = received;
        entered();
        await gate;
      });
      try {
        await plugin.onload();
        expect(sweep).not.toHaveBeenCalled();
        for (const [ready] of mockApp.workspace.onLayoutReady.mock.calls) ready();
        await started;
        plugin.onunload();
        expect(signal?.aborted).toBe(true);
        let stopped = false;
        const shutdown = (plugin as any).applicationShutdownPromise.then(() => { stopped = true; });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await shutdown;
        expect(stopped).toBe(true);
      } finally { release(); sweep.mockRestore(); }
    });

    it('joins an admitted input deletion on unload and leaves remaining inputs for the next launch', async () => {
      const inputs = ['.claudian/sessions/first.inputs.json', '.claudian/sessions/second.inputs.json'];
      const files = installVaultFiles(Object.fromEntries(inputs.map(file => [file, '{}'])));
      await mockApp.vault.adapter.mkdir('.claudian/sessions');
      mockApp.vault.adapter.list.mockResolvedValue({ files: inputs, folders: [] });
      let entered!: () => void;
      const deleting = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      mockApp.vault.adapter.remove.mockImplementation(async (file: string) => {
        entered();
        await gate;
        files.delete(file);
      });
      await plugin.onload();
      for (const [ready] of mockApp.workspace.onLayoutReady.mock.calls) ready();
      await deleting;
      plugin.onunload();
      let stopped = false;
      const shutdown = (plugin as any).applicationShutdownPromise.then(() => { stopped = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(stopped).toBe(false);
      } finally {
        release();
        await shutdown;
      }
      expect(files.has(inputs[0])).toBe(false);
      expect(files.has(inputs[1])).toBe(true);
      expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(1);
    });

    it('retries a failed deferred input cleanup on the next launch', async () => {
      const inputPath = '.claudian/sessions/old.inputs.json';
      const files = installVaultFiles({ [inputPath]: '{}' });
      await mockApp.vault.adapter.mkdir('.claudian/sessions');
      mockApp.vault.adapter.list.mockResolvedValue({ files: [inputPath], folders: [] });
      mockApp.vault.adapter.remove.mockRejectedValueOnce(new Error('Storage unavailable'));
      await plugin.onload();
      for (const [ready] of mockApp.workspace.onLayoutReady.mock.calls) ready();
      await new Promise(resolve => setTimeout(resolve, 5));
      await (plugin as any).sessionInputCleanup;
      expect(files.has(inputPath)).toBe(true);
      expect(Notice).toHaveBeenCalledWith('Failed to clean up obsolete session files; will retry next launch');
      plugin.onunload();
      await (plugin as any).applicationShutdownPromise;
      mockApp.workspace.onLayoutReady.mockClear();
      const nextPlugin = createPlugin();
      await nextPlugin.onload();
      for (const [ready] of mockApp.workspace.onLayoutReady.mock.calls) ready();
      await new Promise(resolve => setTimeout(resolve, 5));
      await (nextPlugin as any).sessionInputCleanup;
      expect(files.has(inputPath)).toBe(false);
    });

    it('should initialize settings with defaults', async () => {
      await plugin.onload();

      expect(plugin.settings).toBeDefined();
      // A fresh install starts Claude on Auto, which carries to an unsaved provider as Safe.
      expect(plugin.settings.permissionMode).toBe('auto');
      expect(ProviderSettingsCoordinator.getProviderSettingsSnapshot(plugin.settings, 'codex').permissionMode)
        .toBe('auto-review');
      expect(plugin.settings.hiddenCommands).toEqual(DEFAULT_SETTINGS.hiddenCommands);
    });

    // Note: With multi-tab, agentService is per-tab via TabManager, not on plugin

    it('should register the view', async () => {
      await plugin.onload();

      expect((plugin.registerView as jest.Mock)).toHaveBeenCalledWith(
        VIEW_TYPE_CLAUDIAN,
        expect.any(Function)
      );
    });

    it('registers the file explorer context menu', async () => {
      await plugin.onload();

      expect(mockApp.workspace.on).toHaveBeenCalledWith(
        'file-menu',
        expect.any(Function),
      );
      expect(plugin.registerEvent).toHaveBeenCalledWith({ id: 'workspace-event' });
    });

    it('does not preload legacy tab metadata before a view claims migration', async () => {
      type EmptyMetadataScan = {
        records: [];
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockReturnValue(historyScan);
      const loadSourceSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue({
          metadata: restoredMetadata,
          needsMigration: false,
          source: 'device',
        });
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          openTabs: [{ tabId: 'tab-1', conversationId: restoredMetadata.id }],
          activeTabId: 'tab-1',
        },
      });

      const onloadPromise = plugin.onload();
      const completedBeforeHistoryScan = await completesWhilePending(onloadPromise);
      finishHistoryScan({ records: [], complete: true, invalidMetadataCount: 0 });
      await onloadPromise;
      const cachedConversation = chatHostOf(plugin).getCachedConversation(restoredMetadata.id);
      const didLoadRestoredMetadata = loadSourceSpy.mock.calls.some(
        ([id]) => id === restoredMetadata.id,
      );
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();

      expect(completedBeforeHistoryScan).toBe(true);
      expect(didLoadRestoredMetadata).toBe(false);
      expect(cachedConversation).toBeNull();
    });

    it('loads metadata requested by a view-scoped tab workspace', async () => {
      const restoredMetadata = {
        id: 'view-restored-conversation',
        providerId: 'claude' as const,
        title: 'View restored conversation',
        createdAt: 1,
        lastActivityAt: 2,
      };
      const loadSourceSpy = mockMetadataSources(restoredMetadata);

      await plugin.onload();
      expect(chatHostOf(plugin).getCachedConversation(restoredMetadata.id)).toBeNull();

      await chatHostOf(plugin).ensureConversationMetadataLoaded([restoredMetadata.id]);

      expect(chatHostOf(plugin).getCachedConversation(restoredMetadata.id)?.title)
        .toBe(restoredMetadata.title);
      expect(loadSourceSpy).toHaveBeenCalledWith(restoredMetadata.id);
      loadSourceSpy.mockRestore();
    });

    it('discards stale global tab state after a view-scoped restore succeeds', async () => {
      const clearLegacyState = jest.spyOn(
        SharedStorageService.prototype,
        'clearTabManagerState',
      ).mockResolvedValue(undefined);
      (plugin.loadData as jest.Mock).mockResolvedValue({
        tabManagerState: {
          activeTabId: 'legacy-tab',
          openTabs: [{ conversationId: null, tabId: 'legacy-tab' }],
        },
      });
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        getViewState: jest.fn().mockReturnValue({
          state: {
            tabWorkspace: {
              version: 1,
              activeTabId: 'view-tab',
              openTabs: [{ conversationId: null, tabId: 'view-tab' }],
            },
          },
        }),
      }]);
      await plugin.onload();

      expect(clearLegacyState).toHaveBeenCalledTimes(1);
      await expect(chatHostOf(plugin).claimLegacyTabManagerState()).resolves.toBeNull();
      expect(clearLegacyState).toHaveBeenCalledTimes(1);

      await chatHostOf(plugin).completeLegacyTabManagerStateMigration();

      expect(clearLegacyState).toHaveBeenCalledTimes(1);
      clearLegacyState.mockRestore();
    });

    it('publishes the remaining conversation metadata after layout readiness', async () => {
      const layoutCallbacks: Array<() => void> = [];
      const backgroundMetadata = {
        id: 'background-conversation',
        providerId: 'claude' as const,
        title: 'Background conversation',
        createdAt: 1,
        lastActivityAt: 2,
      };
      mockApp.workspace.onLayoutReady = jest.fn((callback: () => void) => {
        layoutCallbacks.push(callback);
      });
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockResolvedValue({
          records: deviceMetadataRecords(backgroundMetadata),
          complete: true,
          invalidMetadataCount: 0,
        });
      const loadSourceSpy = mockMetadataSources(backgroundMetadata);

      await plugin.onload();
      const beforeLayoutReady = chatHostOf(plugin).getCachedConversation(backgroundMetadata.id);
      for (const ready of layoutCallbacks) ready();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (chatHostOf(plugin).getCachedConversation(backgroundMetadata.id)) break;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      const afterBackgroundLoad = chatHostOf(plugin).getCachedConversation(backgroundMetadata.id);
      const listCallCount = listSpy.mock.calls.length;
      listSpy.mockRestore();
      loadSourceSpy.mockRestore();

      expect(beforeLayoutReady).toBeNull();
      expect(listCallCount).toBe(1);
      expect(afterBackgroundLoad?.title).toBe(backgroundMetadata.title);
    });

    it('does not start the background metadata scan when unloaded before the scheduled load runs', async () => {
      const layoutCallbacks: Array<() => void> = [];
      mockApp.workspace.onLayoutReady = jest.fn((callback: () => void) => {
        layoutCallbacks.push(callback);
      });
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 });

      await plugin.onload();
      for (const ready of layoutCallbacks) ready();
      plugin.onunload();
      await new Promise(resolve => setTimeout(resolve, 5));
      const scanCallCount = scanSpy.mock.calls.length;
      scanSpy.mockRestore();

      expect(scanCallCount).toBe(0);
    });

    it('publishes an unavailable Claude selection without silently persisting a fallback', async () => {
      const deferredMetadata = {
        id: 'deferred-retired-model',
        providerId: 'claude' as const,
        title: 'Deferred retired model',
        createdAt: 1,
        lastActivityAt: 2,
        selectedModel: 'claude-code/retired-model',
      };
      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(deferredMetadata));
          return {
            records: deviceMetadataRecords(deferredMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);
      const notifyConversationListChanged = jest.fn();
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([{
        notifyConversationListChanged,
      } as any]);
      const saveSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
      await (plugin as any).sessionMetadata.loadRemaining();
      expect(chatHostOf(plugin).getCachedConversation(deferredMetadata.id)?.selectedModel).toBe('claude-code/retired-model');
      expect(saveSpy).not.toHaveBeenCalled();
      expect(notifyConversationListChanged).toHaveBeenCalledTimes(1);
      scanSpy.mockRestore();
      loadSourceSpy.mockRestore();
      saveSpy.mockRestore();
    });

    it('recovers missing model metadata after the background session scan', async () => {
      await plugin.onload();
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockResolvedValue({
          records: [],
          complete: true,
          invalidMetadataCount: 0,
        });
      const repository = repositoryOf(plugin);
      const recoverySpy = jest.spyOn(repository, 'recoverMissingSelectedModels')
        .mockResolvedValue([]);

      await (plugin as any).sessionMetadata.loadRemaining();

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
      runtimeSettingsOf(plugin).pendingEnvironmentInvalidationGenerations.set('codex', 1);
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockResolvedValue({
          records: deviceMetadataRecords(metadata),
          complete: true,
          invalidMetadataCount: 0,
        });
      const loadSpy = mockMetadataSources(metadata);
      const repository = repositoryOf(plugin);
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
          persistedRecoverySources.push(conversations[0] ? repository.getSync(conversations[0].id)?.modelRecoverySource : undefined);
        });

      await (plugin as any).sessionMetadata.loadRemaining();

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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(restoredMetadata, deferredMetadata));
          return {
            records: deviceMetadataRecords(restoredMetadata, deferredMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(
        restoredMetadata,
        deferredMetadata,
      );

      await plugin.onload();
      await (plugin as any).sessionMetadata.loadRemaining();

      const restored = chatHostOf(plugin).getCachedConversation(restoredMetadata.id);
      const deferred = chatHostOf(plugin).getCachedConversation(deferredMetadata.id);
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(restoredMetadata, deferredMetadata));
          return {
            records: deviceMetadataRecords(restoredMetadata, deferredMetadata),
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
        await (plugin as any).sessionMetadata.loadRemaining();
      } finally {
        delete claudeReconciler.environmentSessionPolicy;
        reconcileSpy.mockRestore();
        loadSpy.mockRestore();
        listSpy.mockRestore();
        loadSourceSpy.mockRestore();
      }

      expect(chatHostOf(plugin).getCachedConversation(restoredMetadata.id)).toEqual(expect.objectContaining({
        sessionId: 'restored-session-id',
        providerState: { providerSessionId: 'restored-provider-session-id' },
      }));
      expect(chatHostOf(plugin).getCachedConversation(deferredMetadata.id)).toEqual(expect.objectContaining({
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(firstMetadata));
          markFirstBatchPublished();
          await laterBatchRelease;
          options?.onBatch?.(deviceMetadataRecords(laterMetadata));
          return {
            records: deviceMetadataRecords(firstMetadata, laterMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(firstMetadata, laterMetadata);

      const load = (plugin as any).sessionMetadata.loadRemaining();
      await firstBatchPublished;
      await plugin.providerHost.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://changed-during-scan.example.com',
      );
      const pendingGeneration = plugin.settings.pendingProviderSessionInvalidations.claude;
      releaseLaterBatch();
      await load;

      const first = chatHostOf(plugin).getCachedConversation(firstMetadata.id);
      const later = chatHostOf(plugin).getCachedConversation(laterMetadata.id);
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
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(firstMetadata));
          markFirstBatchPublished();
          await scanRelease;
          options?.onBatch?.(deviceMetadataRecords(laterMetadata));
          return {
            records: deviceMetadataRecords(firstMetadata, laterMetadata),
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

      const load = (plugin as any).sessionMetadata.loadRemaining();
      await firstBatchPublished;
      const apply = plugin.providerHost.applyEnvironmentVariables(
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
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(deferredMetadata));
          return {
            records: deviceMetadataRecords(deferredMetadata),
            complete: false,
            invalidMetadataCount: 0,
          };
        });
      (plugin as any).sessionMetadata.pendingScan = false;

      await (plugin as any).sessionMetadata.loadRemaining();

      const persistedSettings = JSON.parse(files.get(settingsPath) ?? '{}');
      scanSpy.mockRestore();

      expect(persistedSettings.pendingProviderSessionInvalidations?.claude)
        .toBe(pendingGeneration);
      expect((plugin as any).sessionMetadata.loadedAll).toBe(false);
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan').mockImplementation(async (options) => {
        options?.onBatch?.(deviceMetadataRecords(backgroundMetadata));
        markBatchPublished();
        await scanRelease;
        return {
          records: deviceMetadataRecords(backgroundMetadata),
          complete: true,
          invalidMetadataCount: 0,
        };
      });
      const invalidateSpy = jest.spyOn(
        ProviderSettingsCoordinator,
        'invalidateConversationSessions',
      ).mockImplementation((conversations) => [...conversations]);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');

      const load = (plugin as any).sessionMetadata.loadRemaining();
      await batchPublished;
      await chatHostOf(plugin).deleteConversation(backgroundMetadata.id);
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
      expect(chatHostOf(plugin).getCachedConversation(backgroundMetadata.id)).toBeNull();
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
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(tombstonedMetadata));
          return {
            records: deviceMetadataRecords(tombstonedMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue(null);

      await (plugin as any).sessionMetadata.loadRemaining();

      expect(loadSpy).toHaveBeenCalledWith(tombstonedMetadata.id);
      expect(chatHostOf(plugin).getCachedConversation(tombstonedMetadata.id)).toBeNull();

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
      const shell = (plugin as any).sessionMetadata.createShell(
        tombstonedMetadata,
      );
      repositoryOf(plugin).mergeMetadataConversations([shell]);
      const scanSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(tombstonedMetadata));
          return {
            records: deviceMetadataRecords(tombstonedMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSpy = jest.spyOn(SessionStorage.prototype, 'load')
        .mockResolvedValue(null);

      await (plugin as any).sessionMetadata.loadRemaining();

      expect(chatHostOf(plugin).getCachedConversation(tombstonedMetadata.id)).toBeNull();

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
      const restartedPlugin = createPlugin();
      (restartedPlugin.loadData as jest.Mock).mockResolvedValue({});
      const restartedSaveMetadataSpy = jest.spyOn(
        ConversationPersistenceStore.prototype,
        'saveMetadata',
      );
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(deferredMetadata));
          return {
            records: deviceMetadataRecords(deferredMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);

      await restartedPlugin.onload();
      await (restartedPlugin as any).sessionMetadata.loadRemaining();

      const restartedConversation = chatHostOf(restartedPlugin).getCachedConversation(deferredMetadata.id);
      const persistedMetadata = JSON.parse(
        files.get(
          `${getDeviceSessionsPath(getHostnameKey())}/restart-deferred-session.meta.json`,
        ) ?? '{}',
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
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(deferredMetadata));
          return {
            records: deviceMetadataRecords(deferredMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockRejectedValueOnce(new Error('metadata write failed'));
      (plugin as any).sessionMetadata.pendingScan = false;

      let loadError: unknown;
      try {
        await (plugin as any).sessionMetadata.loadRemaining();
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

      await plugin.providerHost.applyEnvironmentVariables(
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
      await (plugin as any).applicationShutdownPromise;

      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('drains views before disposing execution and workspace resources', async () => {
      await plugin.onload();
      let resolveViewDrain!: () => void;
      const viewDrain = new Promise<void>((resolve) => {
        resolveViewDrain = resolve;
      });
      const prepareForPluginUnload = jest.fn(() => viewDrain);
      mockApp.workspace.getLeavesOfType.mockImplementation((type: string) => type === VIEW_TYPE_CLAUDIAN ? [{
        view: {
          prepareForPluginUnload,
          getTabManager: jest.fn(),
        },
      }] : []);
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
      const focusActiveInput = jest.fn();
      const mockLeaf = {
        id: 'existing-leaf',
        view: {
          getTabManager: jest.fn(),
          focusActiveInput,
        },
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([mockLeaf]);

      await plugin.onload();
      await viewsOf(plugin).activateView();

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
      expect(focusActiveInput).toHaveBeenCalledTimes(1);
    });

    it('focuses a newly revealed right-sidebar chat even when the root editor stays most recent', async () => {
      const focusActiveInput = jest.fn();
      const mockRightLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
        view: {
          getTabManager: jest.fn(),
          focusActiveInput,
        },
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getRightLeaf.mockReturnValue(mockRightLeaf);
      mockApp.workspace.getMostRecentLeaf.mockReturnValue({ id: 'previous-editor-leaf' });

      await plugin.onload();
      await viewsOf(plugin).activateView();

      expect(mockApp.workspace.getRightLeaf).toHaveBeenCalledWith(false);
      expect(mockRightLeaf.setViewState).toHaveBeenCalledWith({
        type: VIEW_TYPE_CLAUDIAN,
        active: true,
      });
      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockRightLeaf);
      expect(focusActiveInput).toHaveBeenCalledTimes(1);
      expect(mockApp.workspace.revealLeaf.mock.invocationCallOrder[0]).toBeLessThan(
        focusActiveInput.mock.invocationCallOrder[0],
      );
    });

    it('does not reclaim focus when another leaf activates during cold view setup', async () => {
      let resolveViewSetup!: () => void;
      const focusActiveInput = jest.fn();
      const mockRightLeaf = {
        setViewState: jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
          resolveViewSetup = resolve;
        })),
        view: {
          getTabManager: jest.fn(),
          focusActiveInput,
        },
      };
      const activeLeafListeners = new Map<object, (leaf: unknown) => void>();
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getRightLeaf.mockReturnValue(mockRightLeaf);
      mockApp.workspace.on.mockImplementation((event: string, listener: (leaf: unknown) => void) => {
        const eventRef = { event, listener };
        if (event === 'active-leaf-change') {
          activeLeafListeners.set(eventRef, listener);
        }
        return eventRef;
      });
      mockApp.workspace.offref = jest.fn((eventRef: object) => {
        activeLeafListeners.delete(eventRef);
      });

      await plugin.onload();
      const activation = viewsOf(plugin).activateView();
      for (const listener of activeLeafListeners.values()) {
        listener({ id: 'newer-editor-leaf' });
      }
      resolveViewSetup();
      await activation;

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockRightLeaf);
      expect(focusActiveInput).not.toHaveBeenCalled();
      expect(activeLeafListeners.size).toBe(0);
    });

    it('should create new leaf in left sidebar when chatViewPlacement is left-sidebar', async () => {
      const mockLeftLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeftLeaf.mockReturnValue(mockLeftLeaf);

      await plugin.onload();
      (plugin.settings as ClaudianSettings).chatViewPlacement = 'left-sidebar';
      await viewsOf(plugin).activateView();

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
      await expect(viewsOf(plugin).activateView()).resolves.not.toThrow();
    });

    it('should create new leaf in main editor area when chatViewPlacement is main-tab', async () => {
      const mockMainLeaf = {
        setViewState: jest.fn().mockResolvedValue(undefined),
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      mockApp.workspace.getLeaf.mockReturnValue(mockMainLeaf);

      await plugin.onload();
      (plugin.settings as ClaudianSettings).chatViewPlacement = 'main-tab';
      await viewsOf(plugin).activateView();

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
      (plugin.settings as ClaudianSettings).chatViewPlacement = 'main-tab';

      await expect(viewsOf(plugin).activateView()).resolves.not.toThrow();
    });
  });

  describe('settings persistence', () => {
    it('should save settings to file', async () => {
      await plugin.onload();

      await chatHostOf(plugin).mutateSettings(() => undefined);

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
      const repository = repositoryOf(plugin);
      jest.spyOn(repository, 'reconcileSelectedModels').mockImplementation(async () => {
        events.push('reconcile');
        return [];
      });
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([{
        refreshModelSelector: jest.fn(() => events.push('refresh')),
      } as any]);

      chatHostOf(plugin).notifyProviderChatOptionsChanged('claude');
      await (plugin as any).providerChatOptions.tail;

      expect(events).toEqual(['reconcile', 'refresh']);
    });

    it('does not refresh model selectors when durable reconciliation fails', async () => {
      await plugin.onload();
      const repository = repositoryOf(plugin);
      jest.spyOn(repository, 'reconcileSelectedModels')
        .mockRejectedValue(new Error('disk full'));
      const refreshModelSelector = jest.fn();
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([{
        refreshModelSelector,
      } as any]);

      chatHostOf(plugin).notifyProviderChatOptionsChanged('claude');
      await (plugin as any).providerChatOptions.tail;

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

      await plugin.providerHost.applyEnvironmentVariables('provider:grok', 'GROK_PROFILE=new');

      expect(events).toEqual(['before', 'write', 'after']);
      expect(plugin.providerHost.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=new');
      unregister();
    });

    it('reconciles affected conversation models before refreshing after environment changes', async () => {
      await plugin.onload();
      const events: string[] = [];
      const repository = repositoryOf(plugin);
      jest.spyOn(repository, 'reconcileSelectedModels').mockImplementation(async () => {
        events.push('reconcile');
        return [];
      });
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([{
        invalidateProviderCommandCaches: jest.fn(() => events.push('invalidate')),
        refreshModelSelector: jest.fn(() => events.push('refresh')),
      } as any]);

      await plugin.providerHost.applyEnvironmentVariables(
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

      await expect(plugin.providerHost.getResolvedProviderCliPath('codex', {
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

      await expect(plugin.providerHost.getResolvedProviderCliPath('grok', {
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
      const service = new GrokModelCatalogService(plugin.providerHost, {
        runner,
        probe: { discover: async () => { throw new Error('Method not found'); } },
      });
      const coordinator = new GrokModelCatalogCoordinator(plugin.providerHost, service);
      const cliResolver = new GrokCLIResolver();
      ProviderWorkspaceRegistry.setServices('grok', {
        cliResolver,
      });

      const refresh = coordinator.refresh({
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
      updateCodexProviderSettings(plugin.settings, { enabled: true });
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
      const coordinator = new CodexModelCatalogCoordinator(plugin.providerHost, discovery);
      const cliResolver = {
        reset: jest.fn(),
        resolveFromSettings: jest.fn().mockReturnValue('/owned/codex'),
      };
      ProviderWorkspaceRegistry.setServices('codex', {
        cliResolver,
      });

      const refresh = coordinator.refresh({
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
        repositoryOf(plugin),
        'invalidateProviderSessions',
      ).mockImplementationOnce(() => {
        throw publicationError;
      });
      const markStale = jest.fn();
      const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('grok', {
        beforeTransition: () => markStale(),
      });
      ProviderWorkspaceRegistry.setServices('grok', {
        modelCatalog: { markStale } as any,
      });
      const invalidateProviderCommandCaches = jest.fn();
      const refreshModelSelector = jest.fn();
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([{
        invalidateProviderCommandCaches,
        refreshModelSelector,
      } as any]);
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('grok');

      try {
        const firstError = await plugin.providerHost.applyEnvironmentVariables(
          'provider:grok',
          'GROK_PROFILE=committed',
        ).catch(error => error);

        expect(plugin.providerHost.getEnvironmentVariablesForScope('provider:grok'))
          .toBe('GROK_PROFILE=committed');
        expect(markStale).toHaveBeenCalledTimes(1);
        expect(markStale).toHaveBeenCalledWith();
        expect(invalidateProviderCommandCaches).toHaveBeenCalledWith(['grok']);
        expect(refreshModelSelector).toHaveBeenCalledTimes(1);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
          .toBe(initialGeneration + 1);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
        expect(firstError).toBe(publicationError);

        await plugin.providerHost.applyEnvironmentVariables('provider:grok', 'GROK_PROFILE=next');

        expect(plugin.providerHost.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=next');
        expect(markStale).toHaveBeenCalledTimes(2);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
          .toBe(initialGeneration + 2);
        expect(invalidateSpy).toHaveBeenCalledTimes(2);
      } finally {
        unregister();
        invalidateSpy.mockRestore();
      }
    });

    it('retains a committed invalidation generation when publication fails before invalidation', async () => {
      await plugin.onload();
      (plugin as any).sessionMetadata.loadedAll = true;
      const conversation = await chatHostOf(plugin).createConversation({
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
        await expect(plugin.providerHost.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://publication-failed.example.com',
        )).rejects.toBe(publicationError);

        const generation = plugin.settings.pendingProviderSessionInvalidations.claude;
        expect(generation).toEqual(expect.any(Number));
        expect(runtimeSettingsOf(plugin).pendingEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        expect(runtimeSettingsOf(plugin).blockedEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        expect(chatHostOf(plugin).getConversationSync(conversation.id)!.sessionId).toBe('pre-invalidation-session');
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

        await plugin.providerHost.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://publication-retry.example.com',
        );

        expect(chatHostOf(plugin).getConversationSync(conversation.id)!.sessionId).toBeNull();
        expect(plugin.settings.pendingProviderSessionInvalidations.claude).toBeUndefined();
        expect(runtimeSettingsOf(plugin).pendingEnvironmentInvalidationGenerations.has('claude')).toBe(false);
        expect(runtimeSettingsOf(plugin).blockedEnvironmentInvalidationGenerations.has('claude')).toBe(false);
        expect(invalidateSpy).toHaveBeenCalledTimes(2);
        expect(plugin.executionLifecycleRegistry.getProviderGeneration('claude'))
          .toBe(initialGeneration + 2);
      } finally {
        invalidateSpy.mockRestore();
      }
    });

    it('keeps invalidation pending until every invalidated metadata write succeeds', async () => {
      await plugin.onload();
      (plugin as any).sessionMetadata.loadedAll = true;
      const first = await chatHostOf(plugin).createConversation({
        providerId: 'claude',
        sessionId: 'partial-write-first',
      });
      const second = await chatHostOf(plugin).createConversation({
        providerId: 'claude',
        sessionId: 'partial-write-second',
      });
      const metadataError = new Error('partial invalidation metadata write failed');
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(metadataError);

      try {
        await expect(plugin.providerHost.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://partial-write.example.com',
        )).rejects.toBe(metadataError);

        const generation = plugin.settings.pendingProviderSessionInvalidations.claude;
        expect(chatHostOf(plugin).getConversationSync(first.id)!.sessionId).toBeNull();
        expect(chatHostOf(plugin).getConversationSync(second.id)!.sessionId).toBeNull();
        expect(generation).toEqual(expect.any(Number));
        expect(runtimeSettingsOf(plugin).pendingEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        expect(runtimeSettingsOf(plugin).blockedEnvironmentInvalidationGenerations.get('claude'))
          .toBe(generation);
        const persistedFailureSettings = JSON.parse(
          [...mockApp.vault.adapter.write.mock.calls]
            .reverse()
            .find(([path]: [string]) => path === '.claudian/claudian-settings.json')?.[1]
            ?? '{}',
        );
        expect(persistedFailureSettings.pendingProviderSessionInvalidations?.claude)
          .toBe(generation);

        await plugin.providerHost.applyEnvironmentVariables(
          'provider:claude',
          'ANTHROPIC_BASE_URL=https://partial-write-retry.example.com',
        );

        const retriedMetadata = saveMetadataSpy.mock.calls.slice(2).map(([metadata]) => metadata);
        expect(retriedMetadata).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id, sessionId: null }),
          expect.objectContaining({ id: second.id, sessionId: null }),
        ]));
        expect(plugin.settings.pendingProviderSessionInvalidations.claude).toBeUndefined();
        expect(runtimeSettingsOf(plugin).pendingEnvironmentInvalidationGenerations.has('claude')).toBe(false);
        expect(runtimeSettingsOf(plugin).blockedEnvironmentInvalidationGenerations.has('claude')).toBe(false);
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

      await expect(plugin.providerHost.applyEnvironmentVariables(
        'provider:grok',
        'GROK_PROFILE=new',
      )).rejects.toBe(writeError);

      expect(mockApp.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(contextAtRelease).toEqual(committed);
      expect(getGrokProviderSettings(plugin.settings)).toEqual(committed);
      expect(plugin.providerHost.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=old');
      expect(getGrokProviderSettings(plugin.settings).currentCatalog).toEqual(
        committed.currentCatalog,
      );

      expect(plugin.providerHost.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=old');

      await plugin.providerHost.applyEnvironmentVariables('provider:grok', 'GROK_PROFILE=new');

      expect(mockApp.vault.adapter.write).toHaveBeenCalledTimes(2);
      expect(plugin.providerHost.getEnvironmentVariablesForScope('provider:grok')).toBe('GROK_PROFILE=new');
      expect(getGrokProviderSettings(plugin.settings).environmentHash)
        .not.toBe(committed.environmentHash);
      expect(getGrokProviderSettings(plugin.settings).currentCatalog?.models[0].rawId).toBe('old-model');
      unregister();
    });

    it('does not leak failed Claude invalidation into live or deferred conversations', async () => {
      await plugin.onload();
      const live = await chatHostOf(plugin).createConversation({
        providerId: 'claude',
        sessionId: 'live-session',
      });
      live.providerState = {
        providerSessionId: 'live-provider-session',
        previousProviderSessionIds: ['live-previous-session'],
      };
      live.resumeAtMessageId = 'live-resume-message';
      await chatHostOf(plugin).updateConversation(live.id, { providerState: live.providerState, resumeAtMessageId: live.resumeAtMessageId });
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
      const scanSpy = jest.spyOn(storageOf(plugin).sessions, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(deferredMetadata));
          markBatchPublished();
          await scanRelease;
          return {
            complete: false,
            invalidMetadataCount: 0,
            records: deviceMetadataRecords(deferredMetadata),
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
          blocked: runtimeSettingsOf(plugin).blockedEnvironmentInvalidationGenerations.has('claude'),
          deferredSessionId: chatHostOf(plugin).getCachedConversation(deferredMetadata.id)?.sessionId,
          liveSessionId: chatHostOf(plugin).getConversationSync(live.id)!.sessionId,
          pending: plugin.settings.pendingProviderSessionInvalidations.claude,
        };
      });
      const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('claude', {
        afterTransition,
      });

      const writeError = new Error('environment settings write failed');
      const apply = plugin.providerHost.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://failed.example.com',
      ).catch(error => error);
      await writeStarted;
      const scan = (plugin as any).sessionMetadata.loadRemaining();
      await batchPublished;
      rejectWrite(writeError);
      expect(await apply).toBe(writeError);
      finishScan();
      await scan;

      const deferred = chatHostOf(plugin).getCachedConversation(deferredMetadata.id);
      expect(afterTransition).toHaveBeenCalledTimes(1);
      expect(stateAtRelease).toEqual({
        blocked: false,
        deferredSessionId: 'deferred-session',
        liveSessionId: 'live-session',
        pending: undefined,
      });
      expect(chatHostOf(plugin).getConversationSync(live.id)).toEqual(expect.objectContaining({
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
      expect(runtimeSettingsOf(plugin).pendingEnvironmentInvalidationGenerations.has('claude')).toBe(false);
      expect(runtimeSettingsOf(plugin).blockedEnvironmentInvalidationGenerations.has('claude')).toBe(false);
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
      await plugin.providerHost.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://retry.example.com',
      );

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(chatHostOf(plugin).getConversationSync(live.id)?.sessionId).toBeNull();
      expect(chatHostOf(plugin).getConversationSync(live.id)?.providerState).toEqual({
        previousProviderSessionIds: [
          'live-previous-session',
          'live-provider-session',
        ],
      });
      expect(live.resumeAtMessageId).toBe('live-resume-message');
      expect(chatHostOf(plugin).getConversationSync(deferredMetadata.id)?.sessionId).toBeNull();
      expect(chatHostOf(plugin).getConversationSync(deferredMetadata.id)?.providerState).toEqual({
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

      await plugin.providerHost.applyEnvironmentVariables('shared', 'A=2');
      expect(plugin.providerHost.getEnvironmentVariablesForScope('shared')).toBe('A=2');

      await plugin.providerHost.applyEnvironmentVariables('shared', 'A=3');
      expect(plugin.providerHost.getEnvironmentVariablesForScope('shared')).toBe('A=3');

      // No change - should not update
      const currentEnv = plugin.providerHost.getEnvironmentVariablesForScope('shared');
      await plugin.providerHost.applyEnvironmentVariables('shared', 'A=3');
      expect(plugin.providerHost.getEnvironmentVariablesForScope('shared')).toBe(currentEnv);
    });

    it('invalidates sessions when env hash changes', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation({ sessionId: 'session-123' });
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
      saveMetadataSpy.mockClear();

      await plugin.providerHost.applyEnvironmentVariables('provider:claude', 'ANTHROPIC_MODEL=claude-sonnet-4-5');

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect(updated?.sessionId).toBeNull();
      expect(saveMetadataSpy).toHaveBeenCalled();
    });

    it('serializes overlapping environment invalidation writes', async () => {
      await plugin.onload();
      (plugin as any).sessionMetadata.loadedAll = true;
      await chatHostOf(plugin).createConversation({ sessionId: 'overlapping-session' });
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

      const firstUpdate = plugin.providerHost.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://first-overlap.example.com',
      );
      await firstWriteStarted;
      let secondUpdateSettled = false;
      const secondUpdate = plugin.providerHost.applyEnvironmentVariables(
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
      (plugin as any).sessionMetadata.loadedAll = true;
      await chatHostOf(plugin).createConversation({ sessionId: 'failed-overlap-session' });
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata')
        .mockRejectedValueOnce(new Error('metadata write failed'));

      await expect(plugin.providerHost.applyEnvironmentVariables(
        'provider:claude',
        'ANTHROPIC_BASE_URL=https://failed-write.example.com',
      )).rejects.toThrow('metadata write failed');
      await plugin.providerHost.applyEnvironmentVariables(
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
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([mockView as any]);

      // Change env but not in a way that affects model
      await plugin.providerHost.applyEnvironmentVariables('shared', 'SOME_VAR=value');

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
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([
        first.view as any,
        second.view as any,
      ]);

      await plugin.providerHost.applyEnvironmentVariables('shared', 'SOME_VAR=value');

      expect(first.getTabManager).not.toHaveBeenCalled();
      expect(second.getTabManager).not.toHaveBeenCalled();
    });

    it('invalidates Claude conversation metadata without inspecting tab execution state', async () => {
      await plugin.onload();

      const conversation = await chatHostOf(plugin).createConversation({
        providerId: 'claude',
        sessionId: 'session-123',
      });
      await chatHostOf(plugin).updateConversation(conversation.id, {
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
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.providerHost.applyEnvironmentVariables('provider:claude', 'ANTHROPIC_MODEL=claude-sonnet-4-5');

      expect(chatHostOf(plugin).getConversationSync(conversation.id)?.sessionId).toBeNull();
      expect(mockView.getTabManager).not.toHaveBeenCalled();
    });

    it('reloads preserved sessions while resetting only invalidation-policy providers', async () => {
      await plugin.onload();

      const reloadConversation = await chatHostOf(plugin).createConversation({
        providerId: 'claude',
        sessionId: 'preserved-session',
      });
      await chatHostOf(plugin).updateConversation(reloadConversation.id, {
        providerState: { providerSessionId: 'preserved-provider-session' },
      });
      const invalidatedConversation = await chatHostOf(plugin).createConversation({
        providerId: 'codex',
        sessionId: 'invalidated-session',
      });
      await chatHostOf(plugin).updateConversation(invalidatedConversation.id, {
        providerState: { threadId: 'invalidated-thread' },
      });

      const claudeReconciler = ProviderRegistry.getSettingsReconciler('claude');
      const reconcileSpy = jest.spyOn(claudeReconciler, 'reconcileModelWithEnvironment')
        .mockReturnValue({ changed: true, invalidatedConversations: [] });
      claudeReconciler.environmentSessionPolicy = 'reload';
      const stagePendingSpy = jest.spyOn(runtimeSettingsOf(plugin), 'stagePendingSessionInvalidations');
      const getTabManager = jest.fn();
      const mockView = {
        getTabManager,
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([mockView as any]);

      try {
        await plugin.providerHost.applyEnvironmentVariables(
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

      const preserved = await chatHostOf(plugin).getConversationById(reloadConversation.id);
      const invalidated = await chatHostOf(plugin).getConversationById(invalidatedConversation.id);
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
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.providerHost.applyEnvironmentVariables(
        'provider:grok',
        'GROK_PROFILE=first-turn-reload',
      );

      expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
        .toBe(initialGeneration + 1);
      expect(mockView.getTabManager).not.toHaveBeenCalled();
    });

    it('does not coordinate environment changes through open Grok tabs', async () => {
      await plugin.onload();
      const conversation = await chatHostOf(plugin).createConversation({ providerId: 'grok' });
      const initialGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration('grok');
      const mockView = {
        getTabManager: jest.fn(),
        invalidateProviderCommandCaches: jest.fn(),
        refreshModelSelector: jest.fn(),
      };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([mockView as any]);

      await plugin.providerHost.applyEnvironmentVariables(
        'provider:grok',
        'GROK_PROFILE=streaming-first-turn',
      );

      expect(plugin.executionLifecycleRegistry.getProviderGeneration('grok'))
        .toBe(initialGeneration + 1);
      expect(mockView.getTabManager).not.toHaveBeenCalled();
      expect(chatHostOf(plugin).getConversationSync(conversation.id)?.sessionId).toBeNull();
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
      (plugin as any).sessionMetadata.loadedAll = false;
      const hostnameKey = getHostnameKey();
      await plugin.providerHost.applyProviderRuntimeSettings(['codex'], (settings) => {
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
      const restartedPlugin = createPlugin();
      (restartedPlugin.loadData as jest.Mock).mockResolvedValue({});
      const saveMetadataSpy = jest.spyOn(
        ConversationPersistenceStore.prototype,
        'saveMetadata',
      );
      const listSpy = jest.spyOn(SessionStorage.prototype, 'scan')
        .mockImplementation(async (options) => {
          options?.onBatch?.(deviceMetadataRecords(deferredMetadata));
          return {
            records: deviceMetadataRecords(deferredMetadata),
            complete: true,
            invalidMetadataCount: 0,
          };
        });
      const loadSourceSpy = mockMetadataSources(deferredMetadata);

      await restartedPlugin.onload();
      await (restartedPlugin as any).sessionMetadata.loadRemaining();

      const restartedConversation = chatHostOf(restartedPlugin).getCachedConversation(deferredMetadata.id);
      const persistedMetadata = JSON.parse(
        files.get(
          `${getDeviceSessionsPath(getHostnameKey())}/runtime-settings-restart-session.meta.json`,
        ) ?? '{}',
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
      const conversation = await chatHostOf(plugin).createConversation({
        providerId: 'grok',
        sessionId: 'grok-session-id',
      });
      await chatHostOf(plugin).updateConversation(conversation.id, {
        providerState: { sessionDirectory: '/tmp/grok/session-id' },
      });
      const hostnameKey = getHostnameKey();

      await plugin.providerHost.applyProviderRuntimeSettings(['grok'], (settings) => {
        updateGrokProviderSettings(settings, {
          cliPathsByHost: { [hostnameKey]: '/custom/grok' },
          enabled: true,
        });
      });

      const grokSettings = getGrokProviderSettings(plugin.settings);
      expect(grokSettings.environmentHash).toBe(computeGrokEnvironmentHash(plugin.settings));
      expect(chatHostOf(plugin).getConversationSync(conversation.id)).toEqual(expect.objectContaining({
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
      (plugin as any).sessionMetadata.loadedAll = true;
      const conversation = await chatHostOf(plugin).createConversation({
        providerId: 'codex',
        sessionId: 'post-commit-thread',
      });
      await chatHostOf(plugin).updateConversation(conversation.id, {
        providerState: { threadId: 'post-commit-thread' },
      });
      const hostnameKey = getHostnameKey();

      await expect(plugin.providerHost.applyProviderRuntimeSettings(
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
      expect(chatHostOf(plugin).getConversationSync(conversation.id)).toEqual(expect.objectContaining({
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

      expect(plugin.addRibbonIcon).toHaveBeenCalledWith(
        'bot',
        'Open Claudian',
        expect.any(Function),
      );
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

      expect(plugin.addCommand).toHaveBeenCalledWith({
        id: 'open-view',
        name: 'Open chat view',
        callback: expect.any(Function),
      });
      const commandConfig = getRegisteredCommand('open-view');
      await commandConfig.callback();

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
    });
  });

  describe('new-tab command', () => {
    it('routes current-tab commands to the focused view when several leaves exist', async () => {
      await plugin.onload();
      const makeView = (id: string) => {
        const manager = {
          getActiveTab: () => ({ state: { isStreaming: false } }),
          getActiveTabId: () => id,
          closeTab: jest.fn().mockResolvedValue(undefined),
          createNewConversation: jest.fn().mockResolvedValue(undefined),
        };
        return {
          getTabManager: () => manager,
          isDualPaneMode: () => false,
          prepareForPluginUnload: async () => undefined,
          manager,
        };
      };
      const first = { view: makeView('first-tab') };
      const focused = { view: makeView('focused-tab') };
      mockApp.workspace.getLeavesOfType.mockReturnValue([first, focused]);
      mockApp.workspace.getActiveViewOfType.mockReturnValue(focused.view);
      expect(getRegisteredCommand('close-current-tab').checkCallback(false)).toBe(true);
      expect(getRegisteredCommand('new-session').checkCallback(false)).toBe(true);
      expect(focused.view.manager.closeTab).toHaveBeenCalledWith('focused-tab');
      expect(focused.view.manager.createNewConversation).toHaveBeenCalledTimes(1);
      expect(first.view.manager.closeTab).not.toHaveBeenCalled();
      expect(first.view.manager.createNewConversation).not.toHaveBeenCalled();
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);
      expect(chatHostOf(plugin).getView()).toBe(first.view);
    });

    it('delegates New to the active dual-pane navigation policy', async () => {
      await plugin.onload();

      const handleNewConversationCommand = jest.fn().mockResolvedValue(true);
      const createNewTab = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(viewsOf(plugin), 'getView').mockReturnValue({
        createNewTab,
        getTabManager: jest.fn().mockReturnValue({}),
        handleNewConversationCommand,
      } as any);

      const command = getRegisteredCommand('new-tab');
      expect(command.name).toBe('New');
      expect(command.checkCallback(false)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(handleNewConversationCommand).toHaveBeenCalledTimes(1);
      expect(createNewTab).not.toHaveBeenCalled();
    });

    it('keeps replace and close tab commands out of dual mode', async () => {
      await plugin.onload();

      jest.spyOn(viewsOf(plugin), 'getView').mockReturnValue({
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
      jest.spyOn(viewsOf(plugin), 'activateView').mockImplementation(async () => {
        viewOpened = true;
      });
      jest.spyOn(viewsOf(plugin), 'getView').mockImplementation(() => (
        viewOpened ? mockView as any : null
      ));

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(true);
      expect(command.checkCallback(false)).toBe(true);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(viewsOf(plugin).activateView).toHaveBeenCalledTimes(1);
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
      jest.spyOn(viewsOf(plugin), 'activateView').mockImplementation(async () => {
        viewOpened = true;
      });
      jest.spyOn(viewsOf(plugin), 'getView').mockImplementation(() => (
        viewOpened ? mockView as any : null
      ));

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(true);
      expect(command.checkCallback(false)).toBe(true);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(viewsOf(plugin).activateView).toHaveBeenCalledTimes(1);
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

      jest.spyOn(viewsOf(plugin), 'getView').mockReturnValue(mockView as any);

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

      jest.spyOn(viewsOf(plugin), 'getView').mockReturnValue(null);

      const command = getRegisteredCommand('new-tab');

      expect(command.checkCallback(true)).toBe(true);
    });
  });

  describe('createConversation', () => {
    it('creates a retrievable blank conversation with a default title', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();

      expect(conv.id).toMatch(/^conv-\d+-[a-z0-9]+$/);
      expect(conv.messages).toEqual([]);
      expect(conv.sessionId).toBeNull();
      expect(conv.title).toBeTruthy();
      expect(conv.title.length).toBeGreaterThan(0);
      const fetched = await chatHostOf(plugin).getConversationById(conv.id);
      expect(fetched?.id).toBe(conv.id);
    });

    it('should store the selected model in conversation metadata', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation({ selectedModel: 'opus' });
      const fetched = await chatHostOf(plugin).getConversationById(conv.id);

      expect(conv.selectedModel).toBe('opus');
      expect(fetched?.selectedModel).toBe('opus');
    });

    it('should preserve custom selected models that are not in picker options', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation({
        providerId: 'codex',
        selectedModel: 'gpt-5.4-experimental',
      });
      const fetched = await chatHostOf(plugin).getConversationById(conv.id);

      expect(conv.selectedModel).toBe('gpt-5.4-experimental');
      expect(fetched?.selectedModel).toBe('gpt-5.4-experimental');
    });

    it('should lazily migrate missing selected model from usage metadata', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      delete (conv as { selectedModel?: string }).selectedModel;
      conv.usage = {
        model: 'opus',
        inputTokens: 1,
        contextTokens: 1,
        contextWindow: 200000,
        percentage: 1,
      };
      repositoryOf(plugin).replaceAll([conv]);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
      saveMetadataSpy.mockClear();

      const fetched = await chatHostOf(plugin).getConversationById(conv.id);

      expect(fetched?.selectedModel).toBe('opus');
      expect(saveMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({
        selectedModel: 'opus',
      }));
    });

    it('should not permanently default legacy conversations with unknown model metadata', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      delete (conv as { selectedModel?: string }).selectedModel;
      repositoryOf(plugin).replaceAll([conv]);
      const saveMetadataSpy = jest.spyOn(getConversationPersistence(plugin), 'saveMetadata');
      saveMetadataSpy.mockClear();

      const fetched = await chatHostOf(plugin).getConversationById(conv.id);

      expect(fetched?.selectedModel).toBeUndefined();
      expect(saveMetadataSpy).not.toHaveBeenCalled();
    });

    // Note: Session management is now per-tab via TabManager
  });

  describe('switchConversation', () => {
    it('should switch to existing conversation', async () => {
      await plugin.onload();

      const conv1 = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).createConversation(); // Create second conversation to switch from

      const result = await chatHostOf(plugin).switchConversation(conv1.id);

      expect(result?.id).toBe(conv1.id);
    });

    // Note: Session ID restoration is now handled per-tab via TabManager

    it('should return null for non-existent conversation', async () => {
      await plugin.onload();

      const result = await chatHostOf(plugin).switchConversation('non-existent-id');

      expect(result).toBeNull();
    });

    it('should preserve a conversation when local Claude history is missing', async () => {
      await plugin.onload();
      const conversation = await chatHostOf(plugin).createConversation({
        sessionId: 'session-removed-after-startup',
      });
      const availabilitySpy = jest.mocked(sdkSession.locateSDKSession)
        .mockResolvedValue({ availability: 'missing' });

      const result = await chatHostOf(plugin).switchConversation(conversation.id);

      expect(result?.id).toBe(conversation.id);
      expect(chatHostOf(plugin).getConversationList()).toHaveLength(1);
      expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
        '.claudian/sessions/session-removed-after-startup.meta.json',
      );
      availabilitySpy.mockRestore();
    });

    it('should preserve a conversation whose Claude session belongs to a previous vault path', async () => {
      await plugin.onload();
      const conversation = await chatHostOf(plugin).createConversation({
        sessionId: 'session-from-previous-vault-path',
      });
      const availabilitySpy = jest.mocked(sdkSession.locateSDKSession)
        .mockResolvedValue({
          availability: 'relocated',
          sessionPath: '/old-project/session-from-previous-vault-path.jsonl',
        });
      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      const result = await chatHostOf(plugin).switchConversation(conversation.id);

      expect(result?.id).toBe(conversation.id);
      expect(chatHostOf(plugin).getConversationList()).toHaveLength(1);
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
      const conversation = await chatHostOf(plugin).createConversation({
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

      const result = await chatHostOf(plugin).switchConversation(conversation.id);

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

      const conv = await chatHostOf(plugin).createConversation();
      const convId = conv.id;

      // Create another so we have at least one left
      await chatHostOf(plugin).createConversation();

      await chatHostOf(plugin).deleteConversation(convId);

      const list = chatHostOf(plugin).getConversationList();
      expect(list.find(c => c.id === convId)).toBeUndefined();
    });

    it('should allow deleting last conversation without recreating', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).deleteConversation(conv.id);

      const list = chatHostOf(plugin).getConversationList();
      expect(list).toEqual([]);
    });

    it('does not expose or invoke provider-native session deletion', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation({ sessionId: 'provider-session-1' });

      await chatHostOf(plugin).deleteConversation(conv.id);

      expect('deleteSDKSession' in sdkSession).toBe(false);
      expect(chatHostOf(plugin).getConversationList().find(item => item.id === conv.id)).toBeUndefined();
    });

    it('resets each view through its tab owner when deleting a conversation', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation();
      const resetConversationTabs = jest.fn().mockResolvedValue(undefined);
      mockApp.workspace.getLeavesOfType.mockReturnValue([{
        view: { notifyConversationListChanged: jest.fn(), getTabManager: () => ({ resetConversationTabs }) },
      }]);
      await chatHostOf(plugin).deleteConversation(conv.id);
      expect(resetConversationTabs).toHaveBeenCalledWith(conv.id);
    });

    it('attempts every view and retries failed deletion associations', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation();
      const first = jest.fn().mockRejectedValueOnce(new Error('first tab failed')).mockResolvedValue(undefined);
      const second = jest.fn().mockResolvedValue(undefined);
      mockApp.workspace.getLeavesOfType.mockReturnValue([first, second].map(resetConversationTabs => ({
        view: { notifyConversationListChanged: jest.fn(), getTabManager: () => ({ resetConversationTabs }) },
      })));
      await expect(chatHostOf(plugin).deleteConversation(conv.id)).rejects.toThrow('first tab failed');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(chatHostOf(plugin).getConversationList().find(item => item.id === conv.id)).toBeUndefined();
      await expect(chatHostOf(plugin).deleteConversation(conv.id)).resolves.toBeUndefined();
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleMissingProviderSession', () => {
    it('preserves the record when the provider cannot verify a safe disposition', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation({
        providerId: 'codex',
        sessionId: 'unverified-provider-session',
      });

      await expect(chatHostOf(plugin).handleMissingProviderSession(
        conv.id,
        'different-reported-session',
      )).resolves.toBe('preserved');
      expect(chatHostOf(plugin).getConversationSync(conv.id)).toEqual(conv);
    });

    it('removes the record when every provider transcript segment is missing', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation({ sessionId: 'missing-current' });
      jest.mocked(sdkSession.locateSDKSessions).mockResolvedValue(new Map([
        ['missing-current', { availability: 'missing' }],
      ]));

      await expect(chatHostOf(plugin).handleMissingProviderSession(
        conv.id,
        'missing-current',
      )).resolves.toBe('deleted');
      expect(chatHostOf(plugin).getConversationList().find(item => item.id === conv.id)).toBeUndefined();
    });

    it('preserves the record and clears resume state when older history is inaccessible', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation({ sessionId: 'missing-current' });
      await chatHostOf(plugin).updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'missing-current',
          previousProviderSessionIds: ['temporarily-inaccessible'],
        },
      });
      jest.mocked(sdkSession.locateSDKSessions).mockResolvedValue(new Map([
        ['temporarily-inaccessible', { availability: 'unknown' }],
        ['missing-current', { availability: 'missing' }],
      ]));

      await expect(chatHostOf(plugin).handleMissingProviderSession(
        conv.id,
        'missing-current',
      )).resolves.toBe('reset');

      const preserved = chatHostOf(plugin).getConversationSync(conv.id);
      expect(preserved?.sessionId).toBeNull();
      expect(preserved?.providerState).toEqual({
        previousProviderSessionIds: ['temporarily-inaccessible'],
      });
    });

    it('preserves metadata when the missing-session disposition cannot be read', async () => {
      await plugin.onload();
      const conv = await chatHostOf(plugin).createConversation({ sessionId: 'missing-current' });
      jest.mocked(sdkSession.locateSDKSessions).mockRejectedValueOnce(new Error('EACCES'));

      await expect(chatHostOf(plugin).handleMissingProviderSession(
        conv.id,
        'missing-current',
      )).resolves.toBe('preserved');
      expect(chatHostOf(plugin).getConversationSync(conv.id)?.sessionId).toBe('missing-current');
    });
  });

  describe('renameConversation', () => {
    it('should rename conversation', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();

      await chatHostOf(plugin).renameConversation(conv.id, 'New Title');

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect(updated?.title).toBe('New Title');
    });

    it('should use default title if empty string provided', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();

      await chatHostOf(plugin).renameConversation(conv.id, 'Before whitespace rename');
      await chatHostOf(plugin).renameConversation(conv.id, '   ');

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect(updated?.title.trim()).toBeTruthy();
      expect(updated?.title).toBe(updated?.title.trim());
      expect(updated?.title).not.toBe('Before whitespace rename');
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
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([
        firstView as any,
        secondView as any,
      ]);

      const conversation = await chatHostOf(plugin).createConversation();
      const other = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).renameConversation(conversation.id, 'Renamed');
      // Batch mutations refresh once regardless of how many sessions they change.
      const batch = [conversation.id, other.id];
      await chatHostOf(plugin).conversationLifecycle.setPinned(batch, true);
      await expect(chatHostOf(plugin).conversationLifecycle.archiveIf(batch, () => true)).resolves.toBe(2);
      await chatHostOf(plugin).conversationLifecycle.restore(batch);
      await chatHostOf(plugin).deleteConversation(conversation.id);

      expect(chatHostOf(plugin).getConversationList().find(({ id }) => id === other.id)).toMatchObject({ isArchived: false });
      expect(firstView.notifyConversationListChanged).toHaveBeenCalledTimes(7);
      expect(secondView.notifyConversationListChanged).toHaveBeenCalledTimes(7);
    });

    it('keeps a committed Conversation when an open view projection fails', async () => {
      await plugin.onload();
      const healthyView = {
        getTabManager: jest.fn().mockReturnValue(null),
        notifyConversationListChanged: jest.fn(),
      };
      const failingView = {
        getTabManager: jest.fn().mockReturnValue(null),
        notifyConversationListChanged: jest.fn(() => {
          throw new Error('detached view');
        }),
      };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([
        failingView as any,
        healthyView as any,
      ]);

      const conversation = await chatHostOf(plugin).createConversation({
        linkedContentPath: 'Projects/Plan.md',
      });

      expect(chatHostOf(plugin).getConversationSync(conversation.id)).toEqual(conversation);
      expect(healthyView.notifyConversationListChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('setConversationArchived', () => {
    const archivedFlags = (mock: jest.Mock) => mock.mock.calls.map(
      ([changes]) => changes.map((change: { isArchived: boolean }) => change.isArchived),
    );

    it('mirrors archive and restore onto the native Codex thread', async () => {
      await plugin.onload();
      const setSessionsArchived = jest.fn().mockResolvedValue(undefined);
      ProviderWorkspaceRegistry.setServices('codex', { sessionArchive: { setSessionsArchived } });
      const conversation = await chatHostOf(plugin).createConversation({ providerId: 'codex', sessionId: 'thread-1' });

      await chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, true);
      await chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, true);
      await chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, false);

      expect(setSessionsArchived.mock.calls).toEqual([
        [[{ conversation: expect.objectContaining({ sessionId: 'thread-1' }), isArchived: true }]],
        [[{ conversation: expect.objectContaining({ sessionId: 'thread-1' }), isArchived: false }]],
      ]);
    });

    it('mirrors bulk archive and restore in one native batch', async () => {
      await plugin.onload();
      const setSessionsArchived = jest.fn().mockResolvedValue(undefined);
      ProviderWorkspaceRegistry.setServices('codex', { sessionArchive: { setSessionsArchived } });
      const first = await chatHostOf(plugin).createConversation({ providerId: 'codex', sessionId: 'thread-1' });
      const second = await chatHostOf(plugin).createConversation({ providerId: 'codex', sessionId: 'thread-2' });

      await expect(chatHostOf(plugin).conversationLifecycle.archiveIf([first.id, second.id], () => true)).resolves.toBe(2);
      await chatHostOf(plugin).conversationLifecycle.restore([first.id, second.id]);

      expect(archivedFlags(setSessionsArchived)).toEqual([[true, true], [false, false]]);
    });

    it('applies native archive operations in local commit order', async () => {
      await plugin.onload();
      let releaseArchive!: () => void;
      const setSessionsArchived = jest.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseArchive = resolve; }))
        .mockResolvedValue(undefined);
      ProviderWorkspaceRegistry.setServices('codex', { sessionArchive: { setSessionsArchived } });
      const conversation = await chatHostOf(plugin).createConversation({ providerId: 'codex', sessionId: 'thread-1' });

      const archive = chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, true);
      await waitForCondition(() => setSessionsArchived.mock.calls.length === 1);
      const restore = chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, false);
      await waitForCondition(() => chatHostOf(plugin).getConversationSync(conversation.id)?.isArchived === false);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(setSessionsArchived).toHaveBeenCalledTimes(1);
      releaseArchive();
      await Promise.all([archive, restore]);
      expect(archivedFlags(setSessionsArchived)).toEqual([[true], [false]]);
    });

    it('finishes admitted native archive work before disposing provider services', async () => {
      await plugin.onload();
      let releaseArchive!: () => void;
      const setSessionsArchived = jest.fn(() => new Promise<void>((resolve) => { releaseArchive = resolve; }));
      ProviderWorkspaceRegistry.setServices('codex', { sessionArchive: { setSessionsArchived } });
      const disposeWorkspaces = jest.spyOn(ProviderWorkspaceRegistry, 'disposeInitialized');
      const conversation = await chatHostOf(plugin).createConversation({ providerId: 'codex', sessionId: 'thread-1' });
      const archive = chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, true);
      await waitForCondition(() => setSessionsArchived.mock.calls.length === 1);

      plugin.onunload();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(disposeWorkspaces).not.toHaveBeenCalled();

      releaseArchive();
      await Promise.all([archive, (plugin as any).applicationShutdownPromise]);
      expect(disposeWorkspaces).toHaveBeenCalledTimes(1);
      expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining('could not archive or restore'));
    });

    it('keeps the local archive when the native archive fails', async () => {
      await plugin.onload();
      ProviderWorkspaceRegistry.setServices('codex', {
        sessionArchive: { setSessionsArchived: jest.fn().mockRejectedValue(new Error('codex unavailable')) },
      });
      const conversation = await chatHostOf(plugin).createConversation({ providerId: 'codex', sessionId: 'thread-1' });

      await chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, true);

      expect(chatHostOf(plugin).getConversationSync(conversation.id)?.isArchived).toBe(true);
      expect(Notice).toHaveBeenCalledWith('Codex CLI could not archive or restore its sessions: codex unavailable');
    });

    it('does not initialize providers without native session archive', async () => {
      await plugin.onload();
      const ensureInitialized = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized');
      const conversation = await chatHostOf(plugin).createConversation({ providerId: 'claude', sessionId: 'session-1' });
      ensureInitialized.mockClear();

      await chatHostOf(plugin).conversationLifecycle.setArchived(conversation.id, true);

      expect(chatHostOf(plugin).getConversationSync(conversation.id)?.isArchived).toBe(true);
      expect(ensureInitialized).not.toHaveBeenCalled();
    });
  });

  describe('Linked content path events', () => {
    it('coalesces vault refreshes while delivering every path event immediately', async () => {
      await plugin.onload();
      const view = { handleLinkedContentCreated: jest.fn(), notifyConversationListChanged: jest.fn() };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([view as any]);
      const listener = mockApp.vault.on.mock.calls.find((call: unknown[]) => call[0] === 'create')![1];
      for (let index = 0; index < 20; index++) listener(new (TFile as any)(`note-${index}.md`));
      expect(view.handleLinkedContentCreated).toHaveBeenCalledTimes(20);
      expect(view.notifyConversationListChanged).not.toHaveBeenCalled();
      await new Promise(resolve => window.setTimeout(resolve, 75));
      expect(view.notifyConversationListChanged).toHaveBeenCalledTimes(1);
    });

    it('registers Vault create, rename, and delete listeners', async () => {
      await plugin.onload();

      expect(mockApp.vault.on).toHaveBeenCalledWith('create', expect.any(Function));
      expect(mockApp.vault.on).toHaveBeenCalledWith('rename', expect.any(Function));
      expect(mockApp.vault.on).toHaveBeenCalledWith('delete', expect.any(Function));
    });

    it('rewrites linked file and folder paths without changing activity timestamps', async () => {
      await plugin.onload();
      const fileConversation = await chatHostOf(plugin).createConversation({
        linkedContentPath: 'Notes/Old.md',
      });
      const folderConversation = await chatHostOf(plugin).createConversation({
        linkedContentPath: 'Projects/Old/Plan.md',
      });
      const fileUpdatedAt = fileConversation.lastActivityAt;
      const folderUpdatedAt = folderConversation.lastActivityAt;
      await chatHostOf(plugin).setLinkedContentPinned('Notes/Old.md', true);
      await chatHostOf(plugin).setLinkedContentPinned('Projects/Old/Plan.md', true);

      await (plugin as any).vaultContentEvents.handleRename(
        new (TFile as any)('Notes/New.md'),
        'Notes/Old.md',
      );
      await (plugin as any).vaultContentEvents.handleRename(
        new (TFolder as any)('Projects/New'),
        'Projects/Old',
      );

      expect(chatHostOf(plugin).getConversationSync(fileConversation.id)).toMatchObject({
        linkedContentPath: 'Notes/New.md',
        lastActivityAt: fileUpdatedAt,
      });
      expect(chatHostOf(plugin).getConversationSync(folderConversation.id)).toMatchObject({
        linkedContentPath: 'Projects/New/Plan.md',
        lastActivityAt: folderUpdatedAt,
      });
      expect(plugin.settings.pinnedLinkedContentPaths).toEqual([
        'Notes/New.md',
        'Projects/New/Plan.md',
      ]);
    });

    it('removes deleted file and folder paths from pinned Linked content', async () => {
      await plugin.onload();
      await chatHostOf(plugin).setLinkedContentPinned('Notes/Plan.md', true);
      await chatHostOf(plugin).setLinkedContentPinned('Projects/Archive/One.md', true);
      await chatHostOf(plugin).setLinkedContentPinned('Projects/Archive/Two.md', true);

      await (plugin as any).vaultContentEvents.handleDelete(
        new (TFile as any)('Notes/Plan.md'),
      );
      await (plugin as any).vaultContentEvents.handleDelete(
        new (TFolder as any)('Projects/Archive'),
      );

      expect(plugin.settings.pinnedLinkedContentPaths).toEqual([]);
    });

    it('invalidates open history projections when unpinned targets disappear or reappear', async () => {
      await plugin.onload();
      const view = {
        handleLinkedContentCreated: jest.fn(),
        handleLinkedContentDeleted: jest.fn(),
        notifyConversationListChanged: jest.fn(),
      };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([view as any]);

      await (plugin as any).vaultContentEvents.handleDelete(
        new (TFile as any)('Notes/Unpinned.md'),
      );

      expect(view.handleLinkedContentDeleted).toHaveBeenCalledWith(
        'Notes/Unpinned.md',
        false,
      );
      await new Promise(resolve => window.setTimeout(resolve, 75));
      expect(view.notifyConversationListChanged).toHaveBeenCalledTimes(1);

      const createListener = mockApp.vault.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'create',
      )?.[1];
      expect(createListener).toEqual(expect.any(Function));
      createListener(new (TFile as any)('Notes/Unpinned.md'));

      expect(view.handleLinkedContentCreated).toHaveBeenCalledWith('Notes/Unpinned.md');
      await new Promise(resolve => window.setTimeout(resolve, 75));
      expect(view.notifyConversationListChanged).toHaveBeenCalledTimes(2);
    });

    it('refreshes a committed rename even when pinned-settings cleanup fails', async () => {
      await plugin.onload();
      const conversation = await chatHostOf(plugin).createConversation({ linkedContentPath: 'Notes/Old.md' });
      const view = { handleLinkedContentRenamed: jest.fn(), notifyConversationListChanged: jest.fn() };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([view as any]);
      jest.spyOn(PinnedLinkedContentPathCoordinator.prototype, 'rewritePaths')
        .mockRejectedValueOnce(new Error('settings unavailable'));
      await expect((plugin as any).vaultContentEvents.handleRename(new (TFile as any)('Notes/New.md'), 'Notes/Old.md'))
        .rejects.toThrow('settings unavailable');
      expect(chatHostOf(plugin).getConversationSync(conversation.id)?.linkedContentPath).toBe('Notes/New.md');
      await new Promise(resolve => window.setTimeout(resolve, 75));
      expect(view.notifyConversationListChanged).toHaveBeenCalledTimes(1);
    });

    it('invalidates deleted targets even when pinned-settings cleanup fails', async () => {
      await plugin.onload();
      const view = {
        handleLinkedContentDeleted: jest.fn(),
        notifyConversationListChanged: jest.fn(),
      };
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([view as any]);
      jest.spyOn(PinnedLinkedContentPathCoordinator.prototype, 'removePaths')
        .mockRejectedValueOnce(new Error('settings unavailable'));

      await expect((plugin as any).vaultContentEvents.handleDelete(
        new (TFile as any)('Notes/Unpinned.md'),
      )).rejects.toThrow('settings unavailable');

      expect(view.handleLinkedContentDeleted).toHaveBeenCalledWith(
        'Notes/Unpinned.md',
        false,
      );
      await new Promise(resolve => window.setTimeout(resolve, 75));
      expect(view.notifyConversationListChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateConversation', () => {
    it('keeps Linked content creation-only and routes Vault renames explicitly', async () => {
      await plugin.onload();
      const notifyConversationListChanged = jest.fn();
      jest.spyOn(viewsOf(plugin), 'getAllViews').mockReturnValue([{
        notifyConversationListChanged,
      } as any]);

      const conv = await chatHostOf(plugin).createConversation({
        linkedContentPath: 'Projects/Initial.md',
      });

      expect(chatHostOf(plugin).getConversationList().find(({ id }) => id === conv.id)?.linkedContentPath)
        .toBe('Projects/Initial.md');
      notifyConversationListChanged.mockClear();

      await expect((chatHostOf(plugin).updateConversation as any)(conv.id, {
        linkedContentPath: 'Projects/Updated.md',
      })).rejects.toThrow('immutable fields');

      await chatHostOf(plugin).rewriteLinkedContentPaths(
        'Projects/Initial.md',
        'Projects/Updated.md',
        false,
      );

      expect(chatHostOf(plugin).getConversationList().find(({ id }) => id === conv.id)?.linkedContentPath)
        .toBe('Projects/Updated.md');
      expect(notifyConversationListChanged).toHaveBeenCalledTimes(1);

      notifyConversationListChanged.mockClear();
      await chatHostOf(plugin).updateConversation(conv.id, {
        lastActivityAt: 1234,
        titleGenerationStatus: 'failed',
      });

      expect(chatHostOf(plugin).getConversationList().find(({ id }) => id === conv.id)).toMatchObject({
        lastActivityAt: 1234,
        titleGenerationStatus: 'failed',
      });
      expect(notifyConversationListChanged).toHaveBeenCalledTimes(1);
    });

    it('should preserve image data when updating conversation messages', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      const messages = [
        { id: 'msg-plain', role: 'user' as const, content: 'Hello', timestamp: Date.now() },
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

      await chatHostOf(plugin).updateConversation(conv.id, { messages });

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect(updated?.messages).toEqual(messages);
      expect(updated?.messages[1].images?.[0].data).toBe('YmFzZTY0');
    });

    it('should update conversation sessionId', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();

      await chatHostOf(plugin).updateConversation(conv.id, { sessionId: 'new-session-id' });

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect(updated?.sessionId).toBe('new-session-id');
    });

    it('should preserve lastActivityAt for metadata-only updates', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      const originalLastActivityAt = conv.lastActivityAt;

      await chatHostOf(plugin).updateConversation(conv.id, { title: 'Changed' });

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect(updated?.lastActivityAt).toBe(originalLastActivityAt);
    });
  });

  describe('getConversationList', () => {
    it('should return preview from first user message', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      const initialList = chatHostOf(plugin).getConversationList();
      expect(initialList.length).toBeGreaterThan(0);
      expect(initialList[0]).toHaveProperty('id');
      expect(initialList[0]).toHaveProperty('title');
      expect(initialList[0]).toHaveProperty('messageCount');
      expect(initialList[0]).toHaveProperty('preview');
      await chatHostOf(plugin).updateConversation(conv.id, {
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello Claude', timestamp: Date.now() },
        ],
      });

      const list = chatHostOf(plugin).getConversationList();
      const meta = list.find(c => c.id === conv.id);

      expect(meta?.preview).toContain('Hello Claude');
    });
  });

  describe('auto-archive inactive sessions', () => {
    const clock = testClock();
    const inactiveFor = (days: number): number => clock().getTime() - days * 86_400_000;
    const sessions = [
      { id: 'stale-session', providerId: 'claude' as const, title: 'Stale', createdAt: inactiveFor(21), lastActivityAt: inactiveFor(20) },
      { id: 'recent-session', providerId: 'claude' as const, title: 'Recent', createdAt: inactiveFor(3), lastActivityAt: inactiveFor(2) },
      { id: 'pinned-stale-session', providerId: 'claude' as const, title: 'Pinned', createdAt: inactiveFor(21), lastActivityAt: inactiveFor(20), isPinned: true },
      { id: 'second-stale-session', providerId: 'claude' as const, title: 'Second stale', createdAt: inactiveFor(31), lastActivityAt: inactiveFor(30) },
    ];

    async function loadAllSessions(settings: Record<string, unknown>): Promise<Map<string, string>> {
      const files = installVaultFiles({ '.claudian/claudian-settings.json': JSON.stringify(settings) });
      jest.spyOn(SessionStorage.prototype, 'scan').mockImplementation(async (options) => {
        options?.onBatch?.(deviceMetadataRecords(...sessions));
        return { records: deviceMetadataRecords(...sessions), complete: true, invalidMetadataCount: 0 };
      });
      mockMetadataSources(...sessions);
      await plugin.onload();
      await (plugin as any).sessionMetadata.loadRemaining();
      await new Promise(resolve => setImmediate(resolve));
      return files;
    }

    const archivedIds = (): string[] => chatHostOf(plugin).getConversationList()
      .filter(conversation => conversation.isArchived)
      .map(conversation => conversation.id);

    it('archives unpinned sessions past the threshold once all metadata has loaded', async () => {
      const files = await loadAllSessions({ sessionAutoArchiveAfter: '14d' });

      expect(archivedIds()).toEqual(['stale-session', 'second-stale-session']);
      const persisted = JSON.parse(
        files.get(`${getDeviceSessionsPath(getHostnameKey())}/stale-session.meta.json`) ?? '{}',
      );
      expect(persisted.isArchived).toBe(true);
      expect(Notice).toHaveBeenCalledWith('Auto-archived 2 inactive sessions');
    });

    it('skips sessions held by a deferred chat pane that has not mounted its view', async () => {
      mockApp.workspace.getLeavesOfType.mockImplementation((type: string) => (
        type === VIEW_TYPE_CLAUDIAN
          ? [{
              view: {},
              getViewState: () => ({
                type: VIEW_TYPE_CLAUDIAN,
                state: {
                  tabWorkspace: {
                    version: 1,
                    openTabs: [{ tabId: 'deferred-tab', conversationId: 'stale-session' }],
                    activeTabId: 'deferred-tab',
                  },
                },
              }),
            }]
          : []
      ));

      await loadAllSessions({ sessionAutoArchiveAfter: '14d' });

      // The unheld stale session proves the scan ran.
      expect(archivedIds()).toEqual(['second-stale-session']);
    });

    it('does not archive a session whose pin was still being saved when the scan ran', async () => {
      const files = await loadAllSessions({});
      const stalePath = `${getDeviceSessionsPath(getHostnameKey())}/stale-session.meta.json`;
      let releasePinWrite!: () => void;
      const pinWriteGate = new Promise<void>((resolve) => { releasePinWrite = resolve; });
      const write = mockApp.vault.adapter.write.getMockImplementation();
      let isFirstStaleWrite = true;
      mockApp.vault.adapter.write.mockImplementation(async (path: string, content: string) => {
        if (path === stalePath && isFirstStaleWrite) {
          isFirstStaleWrite = false;
          await pinWriteGate;
        }
        return write(path, content);
      });

      const pin = chatHostOf(plugin).conversationLifecycle.setPinned(['stale-session'], true);
      await chatHostOf(plugin).mutateSettings((settings) => { settings.sessionAutoArchiveAfter = '7d'; });
      await new Promise(resolve => setImmediate(resolve));
      releasePinWrite();
      await pin;
      await new Promise(resolve => setImmediate(resolve));

      const stale = chatHostOf(plugin).getConversationList().find(({ id }) => id === 'stale-session');
      expect(stale).toMatchObject({ isPinned: true });
      expect(stale?.isArchived).not.toBe(true);
      // The unheld stale session proves the scan ran.
      expect(archivedIds()).toEqual(['second-stale-session']);
      expect(JSON.parse(files.get(stalePath) ?? '{}')).toMatchObject({ isPinned: true });
    });

    it('leaves sessions alone while off and archives when the setting is enabled', async () => {
      await loadAllSessions({});
      expect(archivedIds()).toEqual([]);

      await chatHostOf(plugin).mutateSettings((settings) => { settings.sessionAutoArchiveAfter = '7d'; });
      await new Promise(resolve => setImmediate(resolve));

      expect(archivedIds()).toEqual(['stale-session', 'second-stale-session']);
    });
  });

  describe('Multi-session message loading', () => {
    it('should preserve previousProviderSessionIds through conversation updates', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-B',
          previousProviderSessionIds: ['session-A'],
        },
      });

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect((updated?.providerState as any)?.previousProviderSessionIds).toEqual(['session-A']);
      expect((updated?.providerState as any)?.providerSessionId).toBe('session-B');

      // Further update should preserve previousProviderSessionIds
      await chatHostOf(plugin).updateConversation(conv.id, {
        title: 'Updated Title',
      });

      const afterTitleUpdate = await chatHostOf(plugin).getConversationById(conv.id);
      expect((afterTitleUpdate?.providerState as any)?.previousProviderSessionIds).toEqual(['session-A']);
    });

    it('should handle empty previousProviderSessionIds array', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
        providerState: {
          providerSessionId: 'session-A',
          previousProviderSessionIds: [],
        },
      });

      const updated = await chatHostOf(plugin).getConversationById(conv.id);
      expect((updated?.providerState as any)?.previousProviderSessionIds).toEqual([]);
    });
  });

  describe('loadSdkMessagesForConversation - fork branch', () => {
    it('should repair blank image data from Claude SDK history during hydration', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);

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

      loadSpy.mockRestore();
    });

    it('should load from forkSource.sessionId and truncate at forkSource.resumeAt for pending fork', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
        providerState: {
          forkSource: { sessionId: 'source-session-abc', resumeAt: 'asst-uuid-cutoff' },
          // No providerSessionId → isPendingFork returns true
          providerSessionId: undefined,
        },
        sessionId: null,
      });

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [
          { id: 'sdk-msg-1', role: 'user', content: 'Hello', timestamp: 1000 },
          { id: 'sdk-msg-2', role: 'assistant', content: 'Hi', timestamp: 1001 },
        ],
        skippedLines: 0,
      });

      // Trigger loadSdkMessagesForConversation via public API
      const loaded = await chatHostOf(plugin).getConversationById(conv.id);

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

      loadSpy.mockRestore();
    });

    it('should NOT use fork path when conversation has its own providerSessionId', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
        providerState: {
          forkSource: { sessionId: 'source-session', resumeAt: 'asst-uuid' },
          providerSessionId: 'own-session-id',
        },
      });

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      await chatHostOf(plugin).getConversationById(conv.id);

      // Should load from own session, not forkSource session
      expect(sdkSession.locateSDKSession).toHaveBeenCalledWith(
        expect.any(String),
        'own-session-id',
        expect.any(Object),
      );

      loadSpy.mockRestore();
    });
  });

  describe('loadSdkMessagesForConversation - subagent recovery', () => {
    it('restores subagent data when Agent tool exists but subagent content block is missing', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
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

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
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

      loadSpy.mockRestore();
    });

    it('prefers richer SDK task result over stale cached subagent result', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
                input: { description: 'Do sub task', run_in_background: true },
                status: 'completed',
                result: 'Full SDK result from queue-operation',
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-merge-1', mode: 'async' }] as any,
          } as any,
        ],
      });

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
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

      loadSpy.mockRestore();
    });

    it('keeps the richer cached async result when both SDK and cache are terminal', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
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

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-merge-2');

      expect(taskTool?.status).toBe('completed');
      expect(taskTool?.result).toBe('Recovered final result with full details');
      expect(taskTool?.subagent?.result).toBe('Recovered final result with full details');

      loadSpy.mockRestore();
    });

    it('drops stale asyncStatus from cached sync subagents during recovery', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
                input: { description: 'Do sync task' },
                status: 'completed',
                result: 'Sync result',
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-sync-1', mode: 'sync' }] as any,
          } as any,
        ],
      });

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-sync-1');

      expect(taskTool?.subagent?.mode).toBe('sync');
      expect(taskTool?.subagent?.asyncStatus).toBeUndefined();

      loadSpy.mockRestore();
    });

    it('prefers terminal SDK async status over stale cached running state', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
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

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-async-sdk-terminal');

      expect(taskTool?.status).toBe('completed');
      expect(taskTool?.result).toBe('Full SDK final result');
      expect(taskTool?.subagent?.status).toBe('completed');
      expect(taskTool?.subagent?.asyncStatus).toBe('completed');
      expect(taskTool?.subagent?.result).toBe('Full SDK final result');

      loadSpy.mockRestore();
    });

    it('prefers cached terminal async status over SDK launch-only running state', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
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

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
      const taskTool = loaded?.messages[0].toolCalls?.find(tc => tc.id === 'task-async-cache-terminal');

      expect(taskTool?.status).toBe('completed');
      expect(taskTool?.result).toBe('Recovered final result');
      expect(taskTool?.subagent?.status).toBe('completed');
      expect(taskTool?.subagent?.asyncStatus).toBe('completed');
      expect(taskTool?.subagent?.result).toBe('Recovered final result');

      loadSpy.mockRestore();
    });

    it('restores async subagent data and mode when Agent tool exists but async block is missing', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
                input: { description: 'Do background task', run_in_background: true },
                status: 'completed',
                result: 'Task started',
              } as any,
            ],
            contentBlocks: [{ type: 'text', content: 'Started' }] as any,
          } as any,
        ],
      });

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
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

      loadSpy.mockRestore();
    });

    it('hydrates async subagent tool calls from SDK subagent files on reload', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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
                name: 'Agent',
                input: { description: 'Do background task', run_in_background: true },
                status: 'completed',
                result: 'Task started',
              } as any,
            ],
            contentBlocks: [{ type: 'subagent', subagentId: 'task-async-tools', mode: 'async' }] as any,
          } as any,
        ],
      });

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

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
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

      loadSpy.mockRestore();
      loadSubagentToolsSpy.mockRestore();
    });

    it('keeps async subagent renderer visible when task block and task tool call are both missing', async () => {
      await plugin.onload();

      const conv = await chatHostOf(plugin).createConversation();
      await chatHostOf(plugin).updateConversation(conv.id, {
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

      const loadSpy = jest.spyOn(sdkSession, 'loadSDKSessionMessages').mockResolvedValue({
        messages: [],
        skippedLines: 0,
      });

      const loaded = await chatHostOf(plugin).getConversationById(conv.id);
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

      loadSpy.mockRestore();
    });
  });

});
