import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { getOpencodeDiscoveryState, updateOpencodeDiscoveryState } from '@/providers/opencode/discoveryState';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';

registerProviderModules([claudeProviderRegistration, opencodeProviderRegistration]);

describe('coordinated OpenCode environment changes', () => {
  it('retains provider-owned discovery state when environment changes', () => {
    const config: Record<string, unknown> = {};
    updateOpencodeDiscoveryState(config, {
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
    });
    const settings: Record<string, unknown> = { providerConfigs: { opencode: config } };

    expect(ProviderSettingsCoordinator.handleEnvironmentChange(settings, ['opencode'])).toBe(false);
    expect(getOpencodeDiscoveryState(getProviderConfig(settings, 'opencode'))).toEqual({
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
      thinkingOptionsByModel: {},
    });
  });
});

describe('opencodeSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('leaves a fresh install without runtime inputs unchanged', () => {
    const settings: Record<string, unknown> = { providerConfigs: { opencode: { enabled: true } } };

    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(getProviderConfig(settings, 'opencode').environmentHash ?? '').toBe('');
  });

  it.each([
    ['OPENCODE_DB moving the database', { environmentVariables: 'OPENCODE_DB=/new/opencode.db\nSOME_CUSTOM_FLAG=1' }],
    ['OPENCODE_DB being removed', { environmentVariables: 'SOME_CUSTOM_FLAG=1' }],
    ['an arbitrary key', { environmentVariables: 'OPENCODE_DB=/old/opencode.db\nSOME_CUSTOM_FLAG=2' }],
    ['the CLI path', { cliPath: '/new/opencode' }],
    ['the host CLI path', { cliPathsByHost: { [getInstallationKey()]: '/host/opencode' } }],
  ])('restarts the runtime when %s changes', (_label, change) => {
    const settings: Record<string, unknown> = { providerConfigs: { opencode: {
      enabled: true, cliPath: '/old/opencode', environmentVariables: 'OPENCODE_DB=/old/opencode.db\nSOME_CUSTOM_FLAG=1',
    } } };
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    setProviderConfig(settings, 'opencode', { ...getProviderConfig(settings, 'opencode'), ...change });

    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
    const fingerprint = getProviderConfig(settings, 'opencode').environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('opencode.db');
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
  });
});

it('restarts the runtime on a vault-inferred distro change', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const key = getInstallationKey();
    const settings = { providerConfigs: { opencode: { enabled: true, installationMethodsByHost: { [key]: 'wsl' } } } };
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Ubuntu\\vault' })).toEqual({ changed: true });
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Ubuntu\\vault' })).toEqual({ changed: false });
    expect(opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: '\\\\wsl$\\Debian\\vault' })).toEqual({ changed: true });
  } finally { Object.defineProperty(process, 'platform', platform); }
});
