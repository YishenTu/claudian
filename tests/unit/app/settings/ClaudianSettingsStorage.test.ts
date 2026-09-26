import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import {
  CLAUDIAN_SETTINGS_PATH,
  ClaudianSettingsStorage
} from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS as DEFAULT_SETTINGS } from '@/app/settings/defaultSettings';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
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
    it('retires saved directory selections while preserving current settings and provider configuration', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        ...DEFAULT_SETTINGS,
        persistentExternalContextPaths: ['/old/project'],
        userName: 'Ada',
        providerConfigs: { claude: { loadUserSettings: true } },
      }));

      const loaded = await storage.load();
      const written = JSON.parse(mockAdapter.write.mock.calls.at(-1)![1]);

      expect(loaded.userName).toBe('Ada');
      expect(written.userName).toBe('Ada');
      expect(written.providerConfigs.claude.loadUserSettings).toBe(true);
      expect(loaded).not.toHaveProperty('persistentExternalContextPaths');
      expect(written).not.toHaveProperty('persistentExternalContextPaths');
    });

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
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('ignores retired .claude settings without modifying them', async () => {
      mockAdapter.exists.mockImplementation(async path => path === '.claude/claudian-settings.json');
      mockAdapter.read.mockResolvedValue(JSON.stringify({ userName: 'Retired' }));
      expect((await storage.load()).userName).toBe(DEFAULT_SETTINGS.userName);
      expect(mockAdapter.read).not.toHaveBeenCalled();
      expect(mockAdapter.write).not.toHaveBeenCalled();
      expect(mockAdapter.delete).not.toHaveBeenCalled();
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

    it('ignores retired placement and flat provider settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({ openInMainTab: true, claudeCliPath: '/retired', codexCliPath: '/retired', environmentVariables: 'ANTHROPIC_API_KEY=retired\nHTTP_PROXY=retired', hiddenSlashCommands: ['retired'] }));
      const result = await storage.load();
      expect(result.chatViewPlacement).toBe(DEFAULT_SETTINGS.chatViewPlacement);
      expect(getClaudeProviderSettings(result).cliPath).toBe('');
      expect(getCodexProviderSettings(result).cliPath).toBe('');
      expect(getClaudeProviderSettings(result).environmentVariables).toBe('');
      expect(result.sharedEnvironmentVariables).toBe('');
      expect(result.hiddenProviderCommands).toEqual({});
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

    it('normalizes claude provider CLI paths from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          claude: {
            cliPathsByHost: {
          'host-a': '/custom/path-a',
          'host-b': '/custom/path-b',
        }
        }
        },
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/path-a');
      expect(getClaudeProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/path-b');
    });

    it('normalizes codex provider CLI paths from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            cliPathsByHost: {
          'host-a': '/custom/codex-a',
          'host-b': '/custom/codex-b',
        }
        }
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
      expect(mockAdapter.write).toHaveBeenCalledTimes(1);
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
      expect(writtenContent.providerConfigs.grok.selectedModelsByHost).toEqual(expect.objectContaining({
        'host-a': expect.objectContaining({ fingerprint: 'current' }),
        'host-b': expect.objectContaining({ fingerprint: 'other' }),
      }));
    });

    it('ignores retired Codex installation scalars without rewriting them', async () => {
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
      expect(codexConfig).toHaveProperty('installationMethod');
      expect(codexConfig).toHaveProperty('wslDistroOverride');
      expect(writtenContent.providerConfigs.codex).toHaveProperty('installationMethod');
      expect(writtenContent.providerConfigs.codex).toHaveProperty('wslDistroOverride');
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

    it('leaves retired Claude 1M toggles uninterpreted', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({ providerConfigs: { claude: {
        enableOpus1M: true, enableSonnet1M: true,
      } } }));
      const result = await storage.load();
      expect(result.providerConfigs.claude).toMatchObject({ enableOpus1M: true, enableSonnet1M: true });
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

    it('preserves explicit scope on stored mixed environment snippets', async () => {
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
        scope: 'shared',
        contextLimits: undefined,
        modelAliases: undefined,
      }]);
      expect(writtenContent.envSnippets[0].scope).toBe('shared');
    });

    it('normalizes custom model aliases on load', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          claude: {
            modelAliases: {
          ' custom-model ': '  Friendly model  ',
          empty: '   ',
          ignored: 123,
        }
        }
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

      expect(result).not.toHaveProperty('customModelAliases');
      expect(result.providerConfigs.claude?.modelAliases).toEqual({
        'custom-model': 'Friendly model',
      });
      expect(result.envSnippets[0].modelAliases).toEqual({
        'custom-model': 'Snippet model',
      });
      // The alias remains in runtime discovery, but this model is not selected for persistence.
      expect(writtenContent.providerConfigs.claude.modelAliases).toEqual({});
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

    it('persists only selected Codex metadata with hand-picked model IDs', async () => {
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
      expect(writtenContent.providerConfigs.codex.selectedModels).toEqual([TEST_CODEX_CATALOG[1]]);
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
      expect(persistedSettings.providerConfigs.codex.selectedModels).toEqual(TEST_CODEX_CATALOG);
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

    it('should throw on write error', async () => {
      mockAdapter.write.mockRejectedValue(new Error('Write failed'));

      await expect(storage.save(DEFAULT_SETTINGS)).rejects.toThrow('Write failed');
    });
  });
});

function createAdapter(
  stored: Record<string, unknown>,
): jest.Mocked<VaultFileAdapter> {
  return {
    exists: jest.fn().mockImplementation(async (path: string) => (
      path === CLAUDIAN_SETTINGS_PATH
    )),
    read: jest.fn().mockResolvedValue(JSON.stringify(stored)),
    write: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<VaultFileAdapter>;
}

describe('ClaudianSettingsStorage Linked content migration', () => {
  it('imports legacy organization and pinned paths before defaults and awaits canonical persistence', async () => {
    const adapter = createAdapter({
      sessionManagerOrganization: 'linked-note',
      pinnedLinkedNotePaths: [
        'Notes\\Plan.md',
        './Notes/Plan.md',
        'Projects//Research',
        '../outside',
      ],
    });
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    adapter.write.mockImplementation(() => new Promise<void>((resolve) => {
      signalWriteStarted();
      releaseWrite = resolve;
    }));
    const storage = new ClaudianSettingsStorage(adapter);

    let resolved = false;
    const load = storage.load().then((settings) => {
      resolved = true;
      return settings;
    });
    await writeStarted;

    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);
    releaseWrite();

    await expect(load).resolves.toMatchObject({
      sessionManagerOrganization: 'linked-content',
      pinnedLinkedContentPaths: [
        'Notes/Plan.md',
        'Projects/Research',
      ],
    });
    const persisted = JSON.parse(adapter.write.mock.calls[0][1]);
    expect(persisted.sessionManagerOrganization).toBe('linked-content');
    expect(persisted.pinnedLinkedContentPaths).toEqual([
      'Notes/Plan.md',
      'Projects/Research',
    ]);
    expect(persisted).not.toHaveProperty('pinnedLinkedNotePaths');
  });

  it('lets an explicitly stored canonical empty list win over legacy pins', async () => {
    const adapter = createAdapter({
      pinnedLinkedContentPaths: [],
      pinnedLinkedNotePaths: ['Notes/Legacy.md'],
    });
    const storage = new ClaudianSettingsStorage(adapter);

    const settings = await storage.load();

    expect(settings.pinnedLinkedContentPaths).toEqual([]);
    expect(adapter.write).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(adapter.write.mock.calls[0][1]);
    expect(persisted.pinnedLinkedContentPaths).toEqual([]);
    expect(persisted).not.toHaveProperty('pinnedLinkedNotePaths');
  });

  it('normalizes canonical pins without falling back to the legacy field', async () => {
    const adapter = createAdapter({
      pinnedLinkedContentPaths: [
        'Projects\\Current',
        './Projects/Current',
        '../invalid',
      ],
      pinnedLinkedNotePaths: ['Notes/Legacy.md'],
    });
    const storage = new ClaudianSettingsStorage(adapter);

    const settings = await storage.load();

    expect(settings.pinnedLinkedContentPaths).toEqual(['Projects/Current']);
    const persisted = JSON.parse(adapter.write.mock.calls[0][1]);
    expect(persisted.pinnedLinkedContentPaths).toEqual(['Projects/Current']);
    expect(persisted).not.toHaveProperty('pinnedLinkedNotePaths');
  });

  it('omits legacy pinned paths from future writes', async () => {
    const adapter = createAdapter({});
    const storage = new ClaudianSettingsStorage(adapter);

    await storage.save({
      ...await storage.load(),
      pinnedLinkedContentPaths: ['Projects/Current'],
      pinnedLinkedNotePaths: ['Notes/Legacy.md'],
    });

    const persisted = JSON.parse(adapter.write.mock.calls.at(-1)![1]);
    expect(persisted.pinnedLinkedContentPaths).toEqual(['Projects/Current']);
    expect(persisted).not.toHaveProperty('pinnedLinkedNotePaths');
  });
});
