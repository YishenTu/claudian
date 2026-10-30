import { DesktopVault } from '@test/helpers/core/DesktopVault';

const CLAUDIAN_SETTINGS_PATH = '.claudian/claudian-settings.json';
let vault: DesktopVault;
const platform = process.platform;
let originalSeed: string | null;

beforeEach(async () => {
  originalSeed = window.localStorage.getItem('claudian.deviceSettingsKey');
  window.localStorage.setItem('claudian.deviceSettingsKey', 'device:legacy');
  vi.resetModules();
  vault = await DesktopVault.create();
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform });
  if (originalSeed === null) window.localStorage.removeItem('claudian.deviceSettingsKey');
  else window.localStorage.setItem('claudian.deviceSettingsKey', originalSeed);
  vi.resetModules();
  await vault.dispose();
});

async function migrationFixture() {
  await import('@/providers');
  const identity = await import('@/core/device/InstallationKey');
  const { ClaudianSettingsStorage } = await import('@/app/settings/ClaudianSettingsStorage');
  const { DEFAULT_CLAUDIAN_SETTINGS } = await import('@test/helpers/defaultSettings');
  const { getClaudeProviderSettings } = await import('@/providers/claude/settings');
  const { getCodexProviderSettings } = await import('@/providers/codex/settings');
  return { identity, storage: new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS), getClaudeProviderSettings, getCodexProviderSettings };
}

it('migrates the real persisted legacy seed to its portable key without overwriting existing settings', async () => {
  const { identity, storage, getClaudeProviderSettings, getCodexProviderSettings } = await migrationFixture();
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const portableKey = identity.getInstallationKey();
      expect(portableKey).toBe('device-4f4ce3d74445ceee8c159e76a40da475ce1db9742019ba1d6f35f0142b99671b');
      expect(identity.getLegacyDeviceSettingsKey()).toBe('device:legacy');
      await vault.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({
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
              [portableKey]: '/portable/codex',
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
      const persisted = JSON.parse(await vault.read(CLAUDIAN_SETTINGS_PATH));

      expect(claudeSettings.cliPathsByHost).toEqual({
        [portableKey]: '/legacy/claude',
        'device:other': '/other/claude',
      });
      expect(codexSettings.cliPathsByHost).toEqual({
        [portableKey]: '/portable/codex',
      });
      expect(codexSettings.installationMethodsByHost).toEqual({
        [portableKey]: 'wsl',
      });
      expect(persisted.providerConfigs.claude.cliPathsByHost)
        .toEqual(claudeSettings.cliPathsByHost);
      expect(persisted.providerConfigs.codex.cliPathsByHost)
        .toEqual(codexSettings.cliPathsByHost);
    });
