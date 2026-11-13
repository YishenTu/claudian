import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { piSettingsReconciler } from '@/providers/pi/env/PiSettingsReconciler';
import { piProviderRegistration } from '@/providers/pi/registration';
import { getPiProviderSettings } from '@/providers/pi/settings';

registerProviderModules([claudeProviderRegistration, piProviderRegistration]);

type PiSettingsDocument = Record<string, unknown> & { providerConfigs: { pi: Record<string, unknown> } };

function piSettings(inputs: Record<string, unknown> = {}): PiSettingsDocument {
  return {
    settingsProvider: 'pi',
    providerConfigs: {
      pi: {
        enabled: true,
        cliPath: '/old/pi',
        cliPathsByHost: {},
        environmentVariables: 'PI_CODING_AGENT_DIR=/agent\nSOME_CUSTOM_FLAG=1',
        ...inputs,
      },
    },
  };
}

describe('piSettingsReconciler', () => {
  it('leaves a fresh install without runtime inputs unchanged', () => {
    const settings = piSettings({ cliPath: '', environmentVariables: '' });

    expect(ProviderSettingsCoordinator.reconcileProviders(settings, ['pi']))
      .toEqual({ changed: false, environmentChangedProviderIds: [] });
    expect(getPiProviderSettings(settings).environmentHash).toBe('');
  });

  it.each([
    ['PI_CODING_AGENT_DIR moving the store', { environmentVariables: 'PI_CODING_AGENT_DIR=/other\nSOME_CUSTOM_FLAG=1' }],
    ['PI_CODING_AGENT_DIR being removed', { environmentVariables: 'SOME_CUSTOM_FLAG=1' }],
    ['PI_CODING_AGENT_SESSION_DIR moving sessions', { environmentVariables: 'PI_CODING_AGENT_DIR=/agent\nSOME_CUSTOM_FLAG=1\nPI_CODING_AGENT_SESSION_DIR=/sessions' }],
    ['an arbitrary key', { environmentVariables: 'PI_CODING_AGENT_DIR=/agent\nSOME_CUSTOM_FLAG=2' }],
    ['the CLI path', { cliPath: '/new/pi' }],
    ['the host CLI path', { cliPathsByHost: { [getInstallationKey()]: '/host/pi' } }],
  ])('restarts the runtime when %s changes', (_label, change) => {
    const settings = piSettings();
    ProviderSettingsCoordinator.reconcileProviders(settings, ['pi']);
    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    const saved = getPiProviderSettings(settings).environmentHash;
    Object.assign(settings.providerConfigs.pi, change);

    expect(ProviderSettingsCoordinator.reconcileProviders(settings, ['pi']))
      .toEqual({ changed: true, environmentChangedProviderIds: ['pi'] });
    const fingerprint = getPiProviderSettings(settings).environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toBe(saved);
    expect(fingerprint).not.toContain('/agent');
    expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
  });

  it('restarts the runtime on WSL target and distro changes', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const key = getInstallationKey();
      const settings = piSettings({ installationMethodsByHost: { [key]: 'native-windows' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } });
      piSettingsReconciler.reconcileModelWithEnvironment(settings);
      Object.assign(settings.providerConfigs.pi, { installationMethodsByHost: { [key]: 'wsl' } });
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
      Object.assign(settings.providerConfigs.pi, { wslDistroOverridesByHost: { [key]: 'Debian' } });
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
      expect(piSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
