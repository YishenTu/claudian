import { getInstallationKey } from '@/core/device/InstallationKey';
import { antigravitySettingsReconciler } from '@/providers/antigravity/env/AntigravitySettingsReconciler';

type AntigravitySettingsDocument = Record<string, unknown> & { providerConfigs: { antigravity: Record<string, unknown> } };

function settingsWith(config: Record<string, unknown>): AntigravitySettingsDocument {
  return { providerConfigs: { antigravity: config } };
}

const reconcile = (settings: Record<string, unknown>) => (
  antigravitySettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: null })
);

describe('antigravitySettingsReconciler', () => {
  it('leaves a disabled install unchanged', () => {
    const settings = settingsWith({ enabled: false, environmentVariables: 'HOME=/home/first' });

    expect(reconcile(settings)).toEqual({ changed: false });
    expect(settings.providerConfigs.antigravity).not.toHaveProperty('environmentHash');
  });

  it.each([
    // agy's store follows HOME (USERPROFILE on Windows).
    ['HOME moving the store', { environmentVariables: 'HOME=/home/second\nSOME_CUSTOM_FLAG=1' }],
    ['HOME being removed', { environmentVariables: 'SOME_CUSTOM_FLAG=1' }],
    ['an arbitrary key', { environmentVariables: 'HOME=/home/first\nSOME_CUSTOM_FLAG=2' }],
    ['the CLI path', { cliPath: '/new/agy' }],
    ['the host CLI path', { cliPathsByHost: { [getInstallationKey()]: '/host/agy' } }],
  ])('restarts the runtime when %s changes', (_label, change) => {
    const settings = settingsWith({ enabled: true, cliPath: '/old/agy', environmentVariables: 'HOME=/home/first\nSOME_CUSTOM_FLAG=1' });
    expect(reconcile(settings)).toEqual({ changed: true });
    expect(reconcile(settings)).toEqual({ changed: false });
    Object.assign(settings.providerConfigs.antigravity, change);

    expect(reconcile(settings)).toEqual({ changed: true });
    expect(reconcile(settings)).toEqual({ changed: false });
  });
});
