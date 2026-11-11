import { antigravitySettingsReconciler } from '@/providers/antigravity/env/AntigravitySettingsReconciler';

function settingsWith(environmentVariables: string): Record<string, unknown> {
  return { providerConfigs: { antigravity: { enabled: true, environmentVariables } } };
}

function reconcile(settings: Record<string, unknown>, environmentVariables: string) {
  (settings.providerConfigs as { antigravity: Record<string, unknown> }).antigravity.environmentVariables = environmentVariables;
  return antigravitySettingsReconciler.reconcileModelWithEnvironment(settings, { vaultPath: null });
}

describe('antigravitySettingsReconciler', () => {
  it('reloads sessions for launch-only changes and retires them when the native store moves', () => {
    const settings = settingsWith('');
    // agy's store follows HOME (USERPROFILE on Windows). The first fingerprint is a backfill and must not strand existing bindings.
    expect(reconcile(settings, 'HOME=/home/first\nUSERPROFILE=/home/first')).toEqual({ changed: true, sessionPolicy: 'reload' });
    expect(reconcile(settings, 'HOME=/home/first\nUSERPROFILE=/home/first')).toEqual({ changed: false });
    expect(reconcile(settings, 'HOME=/home/first\nUSERPROFILE=/home/first\nHTTPS_PROXY=http://proxy.test')).toEqual({ changed: true, sessionPolicy: 'reload' });
    expect(reconcile(settings, 'HOME=/home/second\nUSERPROFILE=/home/second\nHTTPS_PROXY=http://proxy.test')).toEqual({ changed: true, sessionPolicy: 'invalidate' });
  });
});
