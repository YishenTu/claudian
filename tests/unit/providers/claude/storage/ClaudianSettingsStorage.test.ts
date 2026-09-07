import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import {
  CLAUDIAN_SETTINGS_PATH,
  ClaudianSettingsStorage,
  LEGACY_CLAUDIAN_SETTINGS_PATH,
} from '@/providers/claude/storage/ClaudianSettingsStorage';
import { DEFAULT_SETTINGS } from '@/providers/claude/types/settings';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '@/providers/codex/settings';
import { getGrokProviderSettings } from '@/providers/grok/settings';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';
import { getPiProviderSettings } from '@/providers/pi/settings';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockGetLegacyDeviceSettingsKey = jest.fn<string | null, []>(() => null);
const originalPlatform = process.platform;

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyDeviceSettingsKey: () => mockGetLegacyDeviceSettingsKey(),
}));

const mockAdapter = {
  exists: jest.fn(),
  read: jest.fn(),
  write: jest.fn(),
  delete: jest.fn(),
} as unknown as jest.Mocked<VaultFileAdapter>;

describe('ClaudianSettingsStorage', () => {
  let storage: ClaudianSettingsStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    // Reset mock implementations to default resolved values
    mockAdapter.exists.mockResolvedValue(false);
    mockAdapter.read.mockResolvedValue('{}');
    mockAdapter.write.mockResolvedValue(undefined);
    mockAdapter.delete.mockResolvedValue(undefined);
    mockGetHostnameKey.mockReturnValue('host-a');
    mockGetLegacyDeviceSettingsKey.mockReturnValue(null);
    storage = new ClaudianSettingsStorage(mockAdapter);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('load', () => {
    it('should return defaults when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.load();

      expect(result.model).toBe(DEFAULT_SETTINGS.model);
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
      expect(result.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
      expect(result.requireCommandOrControlEnterToSend).toBe(false);
      expect(result.titleGenerationLocale).toBe('');
      expect(result.lastSelectedChatModel).toBeNull();
      expect(result.enableDualPane).toBe(true);
      expect(result.dualPaneSide).toBe('right');
      expect(result.restoreTabsOnStartup).toBe(true);
      expect(result.collabEnabled).toBe(false);
      expect(result.collabProjectsFolder).toBe('workspace');
      expect(result.collabGitPath).toBe('');
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('normalizes stored Collab enablement and Projects folder settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        collabEnabled: true,
        collabProjectsFolder: '  Shared/Collab Projects  ',
        lastSelectedChatModel: null,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.collabEnabled).toBe(true);
      expect(result.collabProjectsFolder).toBe('Shared/Collab Projects');
      expect(writtenContent.collabEnabled).toBe(true);
      expect(writtenContent.collabProjectsFolder).toBe('Shared/Collab Projects');
    });

    it('falls back for malformed stored Collab foundation settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        collabEnabled: 'yes',
        collabProjectsFolder: '../outside',
        lastSelectedChatModel: null,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.collabEnabled).toBe(false);
      expect(result.collabProjectsFolder).toBe('workspace');
      expect(writtenContent.collabEnabled).toBe(false);
      expect(writtenContent.collabProjectsFolder).toBe('workspace');
    });

    it('normalizes the Vault-scoped advanced Git path', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        collabGitPath: '  /opt/homebrew/bin/git  ',
      }));

      const result = await storage.load();

      expect(result.collabGitPath).toBe('/opt/homebrew/bin/git');
      expect(JSON.parse(mockAdapter.write.mock.calls[0][1]).collabGitPath)
        .toBe('/opt/homebrew/bin/git');
    });

    it('loads legacy .claude settings and migrates them to .claudian', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === LEGACY_CLAUDIAN_SETTINGS_PATH
      ));
      mockAdapter.read.mockImplementation(async (path: string) => {
        if (path === LEGACY_CLAUDIAN_SETTINGS_PATH) {
          return JSON.stringify({
            model: 'claude-opus-4-5',
            userName: 'MigratedUser',
          });
        }
        return '{}';
      });

      const result = await storage.load();

      expect(result.model).toBe('claude-opus-4-5');
      expect(result.userName).toBe('MigratedUser');
      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String),
      );
      expect(mockAdapter.delete).toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
    });

    it('should parse valid JSON and merge with defaults', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'claude-opus-4-5',
        userName: 'TestUser',
      }));

      const result = await storage.load();

      expect(result.model).toBe('claude-opus-4-5');
      expect(result.userName).toBe('TestUser');
      // Defaults should still be present for unspecified fields
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
    });

    it('preserves an explicitly stored provider-qualified chat model selection', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        lastSelectedChatModel: {
          providerId: 'codex',
          model: 'codex/gpt-5',
        },
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toEqual({
        providerId: 'codex',
        model: 'codex/gpt-5',
      });
    });

    it('preserves an explicitly stored null chat model selection', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        lastSelectedChatModel: null,
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toBeNull();
      expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it('normalizes a malformed stored chat model selection to null', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        lastSelectedChatModel: {
          providerId: 'codex',
          model: 42,
        },
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.lastSelectedChatModel).toBeNull();
      expect(writtenContent.lastSelectedChatModel).toBeNull();
    });

    it('migrates the live top-level model for the stored settings provider', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        settingsProvider: 'codex',
        model: 'codex/gpt-5.7',
        savedProviderModel: {
          codex: 'codex/gpt-5.6',
        },
        providerConfigs: {
          codex: { enabled: true },
        },
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toEqual({
        providerId: 'codex',
        model: 'codex/gpt-5.7',
      });
      expect(mockAdapter.write).toHaveBeenCalled();
    });

    it('uses the saved provider model when the legacy live projection is empty', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        settingsProvider: 'codex',
        model: '',
        savedProviderModel: {
          codex: 'codex/gpt-5.6',
        },
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toEqual({
        providerId: 'codex',
        model: 'codex/gpt-5.6',
      });
    });

    it('preserves a legacy seed for a disabled registered provider', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        settingsProvider: 'grok',
        model: 'grok/kimi-coding',
        providerConfigs: {
          grok: { enabled: false },
        },
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toEqual({
        providerId: 'grok',
        model: 'grok/kimi-coding',
      });
    });

    it('preserves a Claude environment-tier alias during legacy migration', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        settingsProvider: 'claude',
        model: 'opus',
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toEqual({
        providerId: 'claude',
        model: 'opus',
      });
    });

    it('uses Claude for an unknown legacy provider only when a top-level model exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        settingsProvider: 'unknown-provider',
        model: 'haiku',
      }));

      const result = await storage.load();

      expect(result.lastSelectedChatModel).toEqual({
        providerId: 'claude',
        model: 'haiku',
      });
    });

    it('migrates legacy openInMainTab true to main-tab placement', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        openInMainTab: true,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.chatViewPlacement).toBe('main-tab');
      expect(writtenContent.chatViewPlacement).toBe('main-tab');
      expect(writtenContent).not.toHaveProperty('openInMainTab');
    });

    it('migrates legacy openInMainTab false to right-sidebar placement', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        openInMainTab: false,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.chatViewPlacement).toBe('right-sidebar');
      expect(writtenContent.chatViewPlacement).toBe('right-sidebar');
      expect(writtenContent).not.toHaveProperty('openInMainTab');
    });

    it('normalizes invalid chatViewPlacement values', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        chatViewPlacement: 'floating-window',
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.chatViewPlacement).toBe('right-sidebar');
      expect(writtenContent.chatViewPlacement).toBe('right-sidebar');
    });

    it('normalizes dual-pane preferences and removes the legacy file pane setting', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        enableDualPane: 'yes',
        enableFilePane: 'yes',
        dualPaneSide: 'top',
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.enableDualPane).toBe(true);
      expect(result.dualPaneSide).toBe('right');
      expect(result).not.toHaveProperty('enableFilePane');
      expect(writtenContent.enableDualPane).toBe(true);
      expect(writtenContent.dualPaneSide).toBe('right');
      expect(writtenContent).not.toHaveProperty('enableFilePane');
    });

    it('normalizes invalid startup tab restore values', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        restoreTabsOnStartup: 'yes',
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.restoreTabsOnStartup).toBe(true);
      expect(writtenContent.restoreTabsOnStartup).toBe(true);
    });

    it('preserves a disabled startup tab restore toggle', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        restoreTabsOnStartup: false,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.restoreTabsOnStartup).toBe(false);
      expect(writtenContent.restoreTabsOnStartup).toBe(false);
    });

    it('should strip legacy blocklist fields from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        enableBlocklist: false,
        blockedCommands: {
          unix: ['custom-unix-cmd'],
          windows: ['custom-win-cmd'],
        },
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect('enableBlocklist' in result).toBe(false);
      expect('blockedCommands' in result).toBe(false);
      expect(writtenContent).not.toHaveProperty('enableBlocklist');
      expect(writtenContent).not.toHaveProperty('blockedCommands');
    });

    it('should normalize claudeCliPathsByHost from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        claudeCliPathsByHost: {
          'host-a': '/custom/path-a',
          'host-b': '/custom/path-b',
        },
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/path-a');
      expect(getClaudeProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/path-b');
    });

    it('should preserve legacy claudeCliPath field', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        claudeCliPath: '/legacy/path',
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPath).toBe('/legacy/path');
    });

    it('should normalize codexCliPathsByHost from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        codexCliPathsByHost: {
          'host-a': '/custom/codex-a',
          'host-b': '/custom/codex-b',
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/codex-a');
      expect(getCodexProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/codex-b');
    });

    it('preserves hostname-scoped provider settings without assigning them to the current device', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockGetHostnameKey.mockReturnValue('device:current');
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        lastSelectedChatModel: null,
        providerConfigs: {
          claude: {
            cliPathsByHost: {
              'host-a': '/custom/claude-a',
              'host-b': '/custom/claude-b',
            },
          },
          codex: {
            cliPathsByHost: {
              'host-a': '/custom/codex-a',
              'host-b': '/custom/codex-b',
            },
            installationMethodsByHost: {
              'host-a': 'wsl',
              'host-b': 'native-windows',
            },
            wslDistroOverridesByHost: {
              'host-a': 'Ubuntu',
              'host-b': 'Debian',
            },
          },
          opencode: {
            cliPathsByHost: {
              'host-a': '/custom/opencode-a',
              'host-b': '/custom/opencode-b',
            },
          },
          pi: {
            cliPathsByHost: {
              'host-a': '/custom/pi-a',
              'host-b': '/custom/pi-b',
            },
          },
        },
      }));

      const result = await storage.load();
      const claudeSettings = getClaudeProviderSettings(result);
      const codexSettings = getCodexProviderSettings(result);
      const opencodeSettings = getOpencodeProviderSettings(result);
      const piSettings = getPiProviderSettings(result);
      const persistedOpencodeConfig = result.providerConfigs.opencode as Record<string, unknown>;
      const persistedPiConfig = result.providerConfigs.pi as Record<string, unknown>;

      expect(claudeSettings.cliPathsByHost).toEqual({
        'host-a': '/custom/claude-a',
        'host-b': '/custom/claude-b',
      });
      expect(codexSettings.cliPathsByHost).toEqual({
        'host-a': '/custom/codex-a',
        'host-b': '/custom/codex-b',
      });
      expect(codexSettings.installationMethod).toBe('native-windows');
      expect(codexSettings.installationMethodsByHost).toEqual({
        'host-a': 'wsl',
        'host-b': 'native-windows',
      });
      expect(codexSettings.wslDistroOverride).toBe('');
      expect(codexSettings.wslDistroOverridesByHost).toEqual({
        'host-a': 'Ubuntu',
        'host-b': 'Debian',
      });
      expect(opencodeSettings.cliPathsByHost).toEqual({
        'host-a': '/custom/opencode-a',
        'host-b': '/custom/opencode-b',
      });
      expect(piSettings.cliPathsByHost).toEqual({
        'host-a': '/custom/pi-a',
        'host-b': '/custom/pi-b',
      });
      expect(persistedOpencodeConfig.cliPathsByHost).toEqual({
        'host-a': '/custom/opencode-a',
        'host-b': '/custom/opencode-b',
      });
      expect(persistedPiConfig.cliPathsByHost).toEqual({
        'host-a': '/custom/pi-a',
        'host-b': '/custom/pi-b',
      });
      expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it('migrates current-device provider maps from the colon key to the portable key', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockGetHostnameKey.mockReturnValue('device-portable');
      mockGetLegacyDeviceSettingsKey.mockReturnValue('device:legacy');
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        lastSelectedChatModel: null,
        providerConfigs: {
          claude: {
            cliPathsByHost: {
              'device:legacy': '/legacy/claude',
              'device:other': '/other/claude',
            },
          },
          codex: {
            cliPathsByHost: {
              'device:legacy': '/legacy/codex',
              'device-portable': '/portable/codex',
            },
            installationMethodsByHost: {
              'device:legacy': 'wsl',
            },
          },
        },
      }));

      const result = await storage.load();
      const claudeSettings = getClaudeProviderSettings(result);
      const codexSettings = getCodexProviderSettings(result);
      const persisted = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(claudeSettings.cliPathsByHost).toEqual({
        'device-portable': '/legacy/claude',
        'device:other': '/other/claude',
      });
      expect(codexSettings.cliPathsByHost).toEqual({
        'device-portable': '/portable/codex',
      });
      expect(codexSettings.installationMethodsByHost).toEqual({
        'device-portable': 'wsl',
      });
      expect(persisted.providerConfigs.claude.cliPathsByHost)
        .toEqual(claudeSettings.cliPathsByHost);
      expect(persisted.providerConfigs.codex.cliPathsByHost)
        .toEqual(codexSettings.cliPathsByHost);
    });

    it('clears Codex Windows installation settings on non-Windows hosts during normalization', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            cliPathsByHost: {
              'host-a': '/opt/homebrew/bin/codex',
            },
            installationMethodsByHost: {
              'host-a': 'native-windows',
              'host-b': 'wsl',
            },
            wslDistroOverridesByHost: {
              'host-a': 'Ubuntu',
              'host-b': 'Debian',
            },
          },
        },
      }));

      const result = await storage.load();
      const codexSettings = getCodexProviderSettings(result);
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(codexSettings.cliPathsByHost).toEqual({
        'host-a': '/opt/homebrew/bin/codex',
      });
      expect(codexSettings.installationMethodsByHost).toEqual({
        'host-b': 'wsl',
      });
      expect(codexSettings.wslDistroOverridesByHost).toEqual({
        'host-b': 'Debian',
      });
      expect(writtenContent.providerConfigs.codex.installationMethodsByHost).toEqual({
        'host-b': 'wsl',
      });
      expect(writtenContent.providerConfigs.codex.wslDistroOverridesByHost).toEqual({
        'host-b': 'Debian',
      });
    });

    it('preserves Grok hostname-scoped CLI and catalog maps', async () => {
      mockGetHostnameKey.mockReturnValue('device:current');
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          grok: {
            catalogsByHost: {
              'host-a': {
                defaultModelId: 'grok-4.5',
                fingerprint: 'current',
                models: [{ displayName: 'Grok 4.5', rawId: 'grok-4.5' }],
                refreshedAt: 1,
              },
              'host-b': {
                defaultModelId: null,
                fingerprint: 'other',
                models: [],
                refreshedAt: 2,
              },
            },
            cliPathsByHost: {
              'host-a': '/custom/grok-a',
              'host-b': '/custom/grok-b',
            },
            enabled: true,
          },
        },
      }));

      const result = await storage.load();
      const grokSettings = getGrokProviderSettings(result);
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(grokSettings.cliPathsByHost).toEqual({
        'host-a': '/custom/grok-a',
        'host-b': '/custom/grok-b',
      });
      expect(grokSettings.catalogsByHost).toEqual(expect.objectContaining({
        'host-a': expect.objectContaining({ fingerprint: 'current' }),
        'host-b': expect.objectContaining({ fingerprint: 'other' }),
      }));
      expect(writtenContent.providerConfigs.grok.cliPathsByHost).toEqual({
        'host-a': '/custom/grok-a',
        'host-b': '/custom/grok-b',
      });
      expect(writtenContent.providerConfigs.grok.catalogsByHost).toEqual(expect.objectContaining({
        'host-a': expect.objectContaining({ fingerprint: 'current' }),
        'host-b': expect.objectContaining({ fingerprint: 'other' }),
      }));
    });

    it('strips legacy Codex installation scalar fields from non-Windows provider config', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            enabled: true,
            installationMethod: 'wsl',
            wslDistroOverride: 'Ubuntu',
            cliPathsByHost: {
              'host-a': '/opt/homebrew/bin/codex',
            },
          },
        },
      }));

      const result = await storage.load();
      const codexConfig = result.providerConfigs.codex as Record<string, unknown>;
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
      expect(codexConfig).not.toHaveProperty('installationMethod');
      expect(codexConfig).not.toHaveProperty('wslDistroOverride');
      expect(writtenContent.providerConfigs.codex).not.toHaveProperty('installationMethod');
      expect(writtenContent.providerConfigs.codex).not.toHaveProperty('wslDistroOverride');
    });

    it('should preserve legacy codexCliPath field', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        codexCliPath: '/legacy/codex',
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).cliPath).toBe('/legacy/codex');
    });

    it('defaults Codex installation method and WSL distro override when missing', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
    });

    it('loads a persisted Codex model catalog with hand-picked model IDs', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
            visibleModels: ['gpt-5.4-mini'],
          },
        },
      }));

      const result = await storage.load();
      const codexSettings = getCodexProviderSettings(result);

      expect(codexSettings.discoveredModels).toEqual(TEST_CODEX_CATALOG);
      expect(codexSettings.visibleModels).toEqual(['gpt-5.4-mini']);
    });

    it('normalizes invalid Codex installation fields from provider config', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            installationMethod: 'auto',
            wslDistroOverride: 42,
          },
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
    });

    it('does not inherit another host WSL selection from host-scoped provider config', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            installationMethodsByHost: {
              'host-b': 'wsl',
            },
            wslDistroOverridesByHost: {
              'host-b': 'Ubuntu',
            },
          },
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
    });

    it('should remove legacy show1MModel from the stored file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        show1MModel: true,
      }));

      await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(writtenContent.model).toBe('sonnet');
      expect(writtenContent.hiddenProviderCommands).toEqual({});
      expect(writtenContent).not.toHaveProperty('show1MModel');
    });

    it('should remove legacy Claude 1M toggles from top-level settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        enableOpus1M: true,
        enableSonnet1M: true,
      }));

      await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(writtenContent).not.toHaveProperty('enableOpus1M');
      expect(writtenContent).not.toHaveProperty('enableSonnet1M');
    });

    it('should remove legacy Claude 1M toggles from provider settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          claude: {
            enableOpus1M: true,
            enableSonnet1M: true,
          },
        },
      }));

      await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(writtenContent.providerConfigs.claude).not.toHaveProperty('enableOpus1M');
      expect(writtenContent.providerConfigs.claude).not.toHaveProperty('enableSonnet1M');
    });

    it('should remove legacy slashCommands from the stored file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        slashCommands: [{ id: 'cmd-review', name: 'review', content: 'Review' }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect('slashCommands' in result).toBe(false);
      expect(writtenContent.model).toBe('sonnet');
      expect(writtenContent.hiddenProviderCommands).toEqual({});
      expect(writtenContent).not.toHaveProperty('slashCommands');
    });

    it('should migrate legacy hiddenSlashCommands into Claude hiddenProviderCommands', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        hiddenSlashCommands: ['commit', '/review'],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.hiddenProviderCommands).toEqual({
        claude: ['commit', 'review'],
      });
      expect(writtenContent.hiddenProviderCommands).toEqual({
        claude: ['commit', 'review'],
      });
    });

    it('should not override explicit provider hidden commands with legacy hiddenSlashCommands', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        hiddenProviderCommands: {
          claude: ['existing'],
        },
        hiddenSlashCommands: ['commit', '/review'],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.hiddenProviderCommands).toEqual({
        claude: ['existing'],
      });
      expect(writtenContent.hiddenProviderCommands).toEqual({
        claude: ['existing'],
      });
    });

    it('normalizes stale scoped mixed env snippets back to unscoped on load', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        envSnippets: [{
          id: 'snippet-1',
          name: 'Mixed snippet',
          description: '',
          envVars: 'PATH=/usr/local/bin\nANTHROPIC_MODEL=claude-custom',
          scope: 'shared',
        }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.envSnippets).toEqual([{
        id: 'snippet-1',
        name: 'Mixed snippet',
        description: '',
        envVars: 'PATH=/usr/local/bin\nANTHROPIC_MODEL=claude-custom',
        scope: undefined,
        contextLimits: undefined,
        modelAliases: undefined,
      }]);
      expect(writtenContent.envSnippets[0].scope).toBeUndefined();
    });

    it('normalizes custom model aliases on load', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        customModelAliases: {
          ' custom-model ': '  Friendly model  ',
          empty: '   ',
          ignored: 123,
        },
        envSnippets: [{
          id: 'snippet-1',
          name: 'Aliased snippet',
          description: '',
          envVars: 'ANTHROPIC_MODEL=custom-model',
          modelAliases: {
            ' custom-model ': '  Snippet model  ',
            ignored: 123,
          },
        }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.customModelAliases).toEqual({
        'custom-model': 'Friendly model',
      });
      expect(result.envSnippets[0].modelAliases).toEqual({
        'custom-model': 'Snippet model',
      });
      expect(writtenContent.customModelAliases).toEqual({
        'custom-model': 'Friendly model',
      });
      expect(writtenContent.envSnippets[0].modelAliases).toEqual({
        'custom-model': 'Snippet model',
      });
    });

    it('should throw on JSON parse error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('invalid json');

      await expect(storage.load()).rejects.toThrow();
    });

    it('should throw on read error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockRejectedValue(new Error('Read failed'));

      await expect(storage.load()).rejects.toThrow('Read failed');
    });
  });

  describe('save', () => {
    it('should write settings to file', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
      };

      await storage.save(settings);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String)
      );
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent.providerConfigs.codex).not.toHaveProperty('installationMethod');
      expect(writtenContent.providerConfigs.codex.installationMethodsByHost).toEqual({});
      expect(writtenContent.providerConfigs.codex).not.toHaveProperty('wslDistroOverride');
      expect(writtenContent.providerConfigs.codex.wslDistroOverridesByHost).toEqual({});
    });

    it('should strip legacy slashCommands before writing', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
        slashCommands: [{ id: 'cmd-review', name: 'review', content: 'Review' }],
      } as typeof DEFAULT_SETTINGS & { slashCommands: unknown[] };

      await storage.save(settings as any);

      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent).not.toHaveProperty('slashCommands');
    });

    it('persists the Codex catalog with hand-picked model IDs', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        providerConfigs: {
          ...DEFAULT_SETTINGS.providerConfigs,
          codex: {
            ...DEFAULT_SETTINGS.providerConfigs.codex,
            discoveredModels: TEST_CODEX_CATALOG,
            visibleModels: ['gpt-5.4-mini'],
          },
        },
      };

      await storage.save(settings);

      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.providerConfigs.codex.discoveredModels).toEqual(TEST_CODEX_CATALOG);
      expect(writtenContent.providerConfigs.codex.visibleModels).toEqual(['gpt-5.4-mini']);
      expect(getCodexProviderSettings(settings).discoveredModels).toEqual(TEST_CODEX_CATALOG);
    });

    it('preserves Codex model aliases and catalog across restart', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        providerConfigs: {
          ...DEFAULT_SETTINGS.providerConfigs,
          codex: {
            ...DEFAULT_SETTINGS.providerConfigs.codex,
            discoveredModels: TEST_CODEX_CATALOG,
            modelAliases: {
              'gpt-5.5': 'Primary',
            },
            visibleModels: null,
          },
        },
      };

      await storage.save(settings);
      const persistedContent = mockAdapter.write.mock.calls[0][1];
      const persistedSettings = JSON.parse(persistedContent);
      expect(persistedSettings.providerConfigs.codex.discoveredModels).toEqual(TEST_CODEX_CATALOG);
      expect(persistedSettings.providerConfigs.codex.modelAliases).toEqual({
        'gpt-5.5': 'Primary',
      });

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(persistedContent);
      const reloaded = await storage.load();

      expect(getCodexProviderSettings(reloaded).modelAliases).toEqual({
        'gpt-5.5': 'Primary',
      });
      expect(getCodexProviderSettings(reloaded).discoveredModels).toEqual(TEST_CODEX_CATALOG);
      updateCodexProviderSettings(reloaded, { discoveredModels: TEST_CODEX_CATALOG as any });
      expect(getCodexProviderSettings(reloaded).modelAliases).toEqual({
        'gpt-5.5': 'Primary',
      });
    });

    it('deletes the legacy settings file after writing the new path', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === LEGACY_CLAUDIAN_SETTINGS_PATH
      ));

      await storage.save(DEFAULT_SETTINGS);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String),
      );
      expect(mockAdapter.delete).toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
    });

    it('should throw on write error', async () => {
      mockAdapter.write.mockRejectedValue(new Error('Write failed'));

      await expect(storage.save(DEFAULT_SETTINGS)).rejects.toThrow('Write failed');
    });
  });

  describe('exists', () => {
    it('should return true when the new file exists', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === CLAUDIAN_SETTINGS_PATH
      ));

      const result = await storage.exists();

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    });

    it('should return true when only the legacy file exists', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === LEGACY_CLAUDIAN_SETTINGS_PATH
      ));

      const result = await storage.exists();

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
      expect(mockAdapter.exists).toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
    });

    it('should return false when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.exists();

      expect(result).toBe(false);
    });
  });

  describe('update', () => {
    it('should merge updates with existing settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        lastSelectedChatModel: null,
        model: 'claude-haiku-4-5',
        userName: 'ExistingUser',
      }));

      await storage.update({ model: 'claude-opus-4-5' });

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent.userName).toBe('ExistingUser');
    });
  });

});
