import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { type ApplicationDomains, startApplication } from '@/app/startup/ApplicationStartup';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import * as sdkSession from '@/providers/claude/history/ClaudeHistoryStore';
import { getCodexProviderSettings } from '@/providers/codex/settings';

// Provider history readers touch the filesystem through Node's fs.
jest.mock('fs');

import '@/providers';

describe('startApplication', () => {
  let mockApp: any;
  let plugin: { app: any; loadData: jest.Mock; saveData: jest.Mock };
  const disposals: Array<() => Promise<void>> = [];

  async function loadApplication(
    overrides: { providers?: typeof ProviderRegistry } = {},
  ): Promise<ApplicationDomains> {
    const domains = await startApplication({
      plugin: plugin as never,
      defaultSettings: DEFAULT_CLAUDIAN_SETTINGS,
      providers: overrides.providers ?? ProviderRegistry,
      providerSettings: ProviderSettingsCoordinator,
      deferNonRestoredSessionMetadata: false,
      isChatView: () => false,
      isUnloading: () => false,
      publishCommittedSettings: async () => undefined,
      onConversationDeleted: async () => undefined,
      onConversationListChanged: () => undefined,
      onAllMetadataLoaded: () => undefined,
      ensureProviderWorkspace: async () => undefined,
      getSessionArchive: async () => null,
    });
    disposals.push(async () => {
      await domains.sessionMetadata.dispose();
      await domains.nativeSessionArchives.dispose();
    });
    return domains;
  }

  beforeEach(() => {
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
        onLayoutReady: jest.fn(),
        getLeavesOfType: jest.fn().mockReturnValue([]),
      },
    };
    plugin = {
      app: mockApp,
      loadData: jest.fn().mockResolvedValue({}),
      saveData: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await Promise.allSettled(disposals.splice(0).map(dispose => dispose()));
  });

  describe('settings', () => {
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

      const domains = await loadApplication();

      expect(domains.settings.getCommittedSettings().userName).toBe('TestUser');
      expect(domains.settings.getCommittedSettings().hiddenCommands).toEqual(DEFAULT_CLAUDIAN_SETTINGS.hiddenCommands);
    });

    it('should use defaults when no saved data', async () => {
      // No settings file exists
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      plugin.loadData.mockResolvedValue(null);

      const domains = await loadApplication();

      // Compare persisted values; provider discovery may attach transient symbol metadata.
      expect(JSON.parse(JSON.stringify(domains.settings.getCommittedSettings()))).toEqual(DEFAULT_CLAUDIAN_SETTINGS);
    });

    it('should use defaults when loadData returns empty object', async () => {
      // No settings file exists
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      plugin.loadData.mockResolvedValue({});

      const domains = await loadApplication();

      // Compare persisted values; provider discovery may attach transient symbol metadata.
      expect(JSON.parse(JSON.stringify(domains.settings.getCommittedSettings()))).toEqual(DEFAULT_CLAUDIAN_SETTINGS);
    });

    it('preserves the saved model while applying environment configuration', async () => {
      // Mock claudian-settings.json with environment variables
      mockApp.vault.adapter.exists.mockImplementation(async (path: string) => {
        return path === '.claudian/claudian-settings.json';
      });
      mockApp.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === '.claudian/claudian-settings.json') {
          return JSON.stringify({
            providerConfigs: { claude: { environmentVariables: 'ANTHROPIC_MODEL=custom-model' } },
            lastEnvHash: '',
          });
        }
        return '';
      });

      const saveSpy = jest.spyOn(SettingsCoordinator.prototype, 'persistCurrent');
      const domains = await loadApplication();

      expect(domains.settings.getCommittedSettings().model).toBe(DEFAULT_CLAUDIAN_SETTINGS.model);
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  describe('session metadata', () => {
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

      const domains = await loadApplication();

      expect(domains.conversations.getCachedConversation(sessionMetadata.id)).toMatchObject({
        sessionId: sessionMetadata.sessionId,
        providerState: sessionMetadata.providerState,
      });
      expect(isVersionedRuntimeInputFingerprint(
        getCodexProviderSettings(domains.settings.getCommittedSettings()).environmentHash,
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

      const domains = await loadApplication();

      expect(domains.conversations.getConversationList()).toHaveLength(1);
      expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
        '.claudian/sessions/conv-stale-1.meta.json',
      );
    });

    it('should load saved conversations from metadata files', async () => {
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
      plugin.loadData.mockResolvedValue({});

      const domains = await loadApplication();

      const loaded = await domains.conversations.getConversationById('conv-saved-1');
      expect(loaded?.id).toBe('conv-saved-1');
      expect(loaded?.title).toBe('Saved Chat');
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
            providerConfigs: { claude: { environmentHash: 'old-hash', environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com' } },
          });
        }
        if (path === '.claudian/sessions/conv-saved-1.meta.json') {
          return sessionMeta;
        }
        return '';
      });

      // data.json is minimal (already migrated)
      plugin.loadData.mockResolvedValue({});

      const domains = await loadApplication();

      const loaded = await domains.conversations.getConversationById('conv-saved-1');
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

      plugin.loadData.mockResolvedValue({
        activeConversationId: 'non-existent',
        migrationVersion: 2,
      });

      const domains = await loadApplication();

      expect(domains.conversations.getConversationList()).toHaveLength(0);
    });

    it('should load messages from previousProviderSessionIds when present', async () => {
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

      plugin.loadData.mockResolvedValue({});

      const domains = await loadApplication();

      const loaded = await domains.conversations.getConversationById('conv-multi-session');
      expect((loaded?.providerState as any)?.previousProviderSessionIds).toEqual(['session-A']);
      expect((loaded?.providerState as any)?.providerSessionId).toBe('session-B');
    });
  });
});
