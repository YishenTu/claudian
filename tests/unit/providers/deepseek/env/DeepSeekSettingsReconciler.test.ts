import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { deepseekSettingsReconciler } from '@/providers/deepseek/env/DeepSeekSettingsReconciler';
import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '@/providers/deepseek/settings';

const reconcile = (settings: Record<string, unknown>) => deepseekSettingsReconciler.reconcileModelWithEnvironment(settings);
const unchanged = { changed: false };
const changed = { changed: true, sessionPolicy: 'reload' };

describe('DeepSeekSettingsReconciler', () => {
  it('leaves pristine defaults untouched during startup reconciliation', () => {
    const settings: Record<string, unknown> = { providerConfigs: { deepseek: { enabled: false } } };

    expect(reconcile(settings)).toEqual(unchanged);
    expect(settings).toEqual({ providerConfigs: { deepseek: { enabled: false } } });
  });

  it('records a secret-free runtime fingerprint once and reports only later input changes', () => {
    const settings: Record<string, unknown> = {
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
      providerConfigs: { deepseek: { enabled: true, environmentVariables: 'DSH_API_KEY=super-secret' } },
    };

    expect(reconcile(settings)).toEqual(changed);
    const first = getDeepSeekProviderSettings(settings).environmentHash;
    expect(isVersionedRuntimeInputFingerprint(first)).toBe(true);
    expect(first).not.toContain('super-secret');
    expect(reconcile(settings)).toEqual(unchanged);

    settings.sharedEnvironmentVariables = 'HTTPS_PROXY=https://other.example.com';
    expect(reconcile(settings)).toEqual(changed);
    expect(getDeepSeekProviderSettings(settings).environmentHash).not.toBe(first);
    expect(reconcile(settings)).toEqual(unchanged);
  });

  it('treats the CLI path for this computer, or the legacy fallback, as a runtime input', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { deepseek: { cliPath: '/legacy/dsh', cliPathsByHost: { 'device:other': '/other/dsh' } } },
    };
    expect(reconcile(settings)).toEqual(changed);
    const legacy = getDeepSeekProviderSettings(settings).environmentHash;

    setProviderConfig(settings, 'deepseek', { ...getProviderConfig(settings, 'deepseek'), cliPath: '/legacy/dsh-2' });
    expect(reconcile(settings)).toEqual(changed);
    const legacyChanged = getDeepSeekProviderSettings(settings).environmentHash;
    expect(legacyChanged).not.toBe(legacy);

    setProviderConfig(settings, 'deepseek', { ...getProviderConfig(settings, 'deepseek'), cliPathsByHost: { 'device:other': '/other/dsh-2' } });
    expect(reconcile(settings)).toEqual(unchanged);

    updateDeepSeekProviderSettings(settings, { cliPath: '/opt/dsh' });
    expect(reconcile(settings)).toEqual(changed);
    expect(getDeepSeekProviderSettings(settings).environmentHash).not.toBe(legacyChanged);
    expect(reconcile(settings)).toEqual(unchanged);

    updateDeepSeekProviderSettings(settings, { cliPath: '' });
    expect(reconcile(settings)).toEqual(changed);
  });

  it('declares reload and preserves every conversation binding', () => {
    const conversation = conversationRecord('conversation', {
      messages: [], providerId: 'deepseek', sessionId: 'session-1',
      providerState: { schemaVersion: 1, home: '/home', profile: 'web', preset: 'claudian' },
    });
    const settings: Record<string, unknown> = {
      providerConfigs: { deepseek: { environmentHash: 'stale', environmentVariables: 'DSH_HOME=/home' } },
    };

    expect(deepseekSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);
    expect(deepseekSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual(changed);
    expect(conversation).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      providerState: { schemaVersion: 1, home: '/home', profile: 'web', preset: 'claudian' },
    }));
  });
});

it('reloads on a vault-inferred WSL distro change even without an explicit distro override', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const settings = { providerConfigs: { deepseek: { enabled: true, installationMethodsByHost: { [getInstallationKey()]: 'wsl' } } } };
    const run = (distro: string) => deepseekSettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: `\\\\wsl$\\${distro}\\home\\me\\vault` });
    expect(run('Ubuntu')).toEqual(changed);
    expect(run('Ubuntu')).toEqual(unchanged);
    expect(run('Debian')).toEqual(changed);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
