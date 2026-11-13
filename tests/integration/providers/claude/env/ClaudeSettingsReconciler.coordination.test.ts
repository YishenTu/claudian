import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { claudeSettingsReconciler } from '@/providers/claude/env/ClaudeSettingsReconciler';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

registerProviderModules([claudeProviderRegistration]);

type ClaudeSettingsDocument = Record<string, unknown> & { providerConfigs: { claude: Record<string, unknown> } };

describe('claudeSettingsReconciler', () => {
  it('leaves a fresh install without runtime inputs unchanged', () => {
    const settings: ClaudeSettingsDocument = { settingsProvider: 'claude', providerConfigs: { claude: { enabled: true } } };

    expect(ProviderSettingsCoordinator.reconcileProviders(settings, ['claude']))
      .toEqual({ changed: false, environmentChangedProviderIds: [] });
    expect(getClaudeProviderSettings(settings).environmentHash).toBe('');
  });

  it.each([
    ['CLAUDE_CONFIG_DIR moving the store', { environmentVariables: 'CLAUDE_CONFIG_DIR=/other/claude\nSOME_CUSTOM_FLAG=1' }],
    ['CLAUDE_CONFIG_DIR being removed', { environmentVariables: 'SOME_CUSTOM_FLAG=1' }],
    ['HOME moving the default store', { environmentVariables: 'CLAUDE_CONFIG_DIR=/data/claude\nSOME_CUSTOM_FLAG=1\nHOME=/home/other' }],
    ['an arbitrary key', { environmentVariables: 'CLAUDE_CONFIG_DIR=/data/claude\nSOME_CUSTOM_FLAG=2' }],
    ['the CLI path', { cliPath: '/new/claude' }],
    ['the host CLI path', { cliPathsByHost: { [getInstallationKey()]: '/host/claude' } }],
  ])('restarts the runtime when %s changes', (_label, change) => {
    const settings: ClaudeSettingsDocument = {
      settingsProvider: 'claude',
      providerConfigs: {
        claude: { enabled: true, cliPath: '/old/claude', environmentVariables: 'CLAUDE_CONFIG_DIR=/data/claude\nSOME_CUSTOM_FLAG=1' },
      },
    };
    ProviderSettingsCoordinator.reconcileProviders(settings, ['claude']);
    expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    Object.assign(settings.providerConfigs.claude, change);

    expect(ProviderSettingsCoordinator.reconcileProviders(settings, ['claude']))
      .toEqual({ changed: true, environmentChangedProviderIds: ['claude'] });
    expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
  });

  it('restarts the runtime on WSL target and distro changes', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const key = getInstallationKey();
      const config = {
        cliPath: '/home/me/claude',
        installationMethodsByHost: { [key]: 'native-windows' },
        wslDistroOverridesByHost: { [key]: 'Ubuntu' },
      };
      const settings = { providerConfigs: { claude: config } };
      claudeSettingsReconciler.reconcileModelWithEnvironment(settings);
      settings.providerConfigs.claude.installationMethodsByHost[key] = 'wsl';
      expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
      expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
      settings.providerConfigs.claude.wslDistroOverridesByHost[key] = 'Debian';
      expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
      expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  describe('reconcileModelWithEnvironment', () => {
    it('preserves an active settings-defined custom model across non-model env changes', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            customModels: 'claude-opus-4-6',
            environmentVariables: 'ANTHROPIC_BASE_URL=https://api.example.com',
            environmentHash: '',
          },
        },
      };

      const result = claudeSettingsReconciler.reconcileModelWithEnvironment(settings);

      expect(result).toEqual({ changed: true });
      expect(settings.model).toBe('claude-opus-4-6');
      const fingerprint = getClaudeProviderSettings(settings).environmentHash;
      expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
      expect(fingerprint).not.toContain('https://api.example.com');
    });
  });
});
