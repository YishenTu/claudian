import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { codexSettingsReconciler } from '@/providers/codex/env/CodexSettingsReconciler';
import { computeCodexEnvHash } from '@/providers/codex/runtime/codexEnvironmentHash';

type CodexSettingsDocument = Record<string, unknown> & { providerConfigs: { codex: Record<string, unknown> } };

function codexSettings(inputs: Record<string, unknown> = {}): CodexSettingsDocument {
  return {
    model: TEST_CODEX_MODEL,
    providerConfigs: {
      codex: {
        enabled: true,
        discoveredModels: TEST_CODEX_CATALOG,
        environmentVariables: 'CODEX_HOME=/data/codex\nSOME_CUSTOM_FLAG=1',
        environmentHash: '',
        ...inputs,
      },
    },
  };
}

describe('codexSettingsReconciler', () => {
  it('leaves a fresh install without runtime inputs unchanged', () => {
    const settings = codexSettings({ environmentVariables: '' });

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(settings.providerConfigs.codex.environmentHash).toBe('');
  });

  it.each([
    ['CODEX_HOME moving the store', { environmentVariables: 'CODEX_HOME=/other/codex\nSOME_CUSTOM_FLAG=1' }],
    ['CODEX_HOME being removed', { environmentVariables: 'SOME_CUSTOM_FLAG=1' }],
    ['HOME moving the default store', { environmentVariables: 'CODEX_HOME=/data/codex\nSOME_CUSTOM_FLAG=1\nHOME=/home/other' }],
    ['an arbitrary key', { environmentVariables: 'CODEX_HOME=/data/codex\nSOME_CUSTOM_FLAG=2' }],
    ['the CLI path', { cliPath: '/opt/codex/bin/codex' }],
    ['the host CLI path', { cliPathsByHost: { [getInstallationKey()]: '/opt/host/codex' } }],
    ['the installation method', { installationMethodsByHost: { [getInstallationKey()]: 'wsl' } }],
    ['the WSL distro', { wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' } }],
  ])('restarts the runtime when %s changes', (_input, change) => {
    // Installation entries for this host persist only on Windows.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const settings = codexSettings();
      expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
      expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
      const saved = settings.providerConfigs.codex.environmentHash;

      Object.assign(settings.providerConfigs.codex, change);

      expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
      expect(settings.providerConfigs.codex.environmentHash).not.toBe(saved);
      expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  it.each([
    ['OPENAI_MODEL', { environmentVariables: `OPENAI_MODEL=${TEST_CODEX_MODEL}` }],
    ['CLI path', { cliPath: '/opt/codex/bin/codex' }],
  ])('re-resolves the model selection on a first %s input', (_input, inputs) => {
    const settings = codexSettings({ environmentVariables: '', ...inputs });

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
    expect(settings.model).toBe(`openai-codex/${TEST_CODEX_MODEL}`);
  });

  it('preserves the selected model when OPENAI_MODEL changes', () => {
    const settings: CodexSettingsDocument = {
      model: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: {
          enabled: true,
          environmentVariables: 'OPENAI_MODEL=deepseek-v4-pro',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe(TEST_CODEX_MODEL);
  });

  it('preserves an active settings-defined custom model across non-model env changes', () => {
    const settings: CodexSettingsDocument = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          enabled: true,
          customModels: 'my-custom-model',
          environmentVariables: 'OPENAI_BASE_URL=https://api.example.com/v1',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result).toEqual({ changed: true });
    expect(settings.model).toBe('my-custom-model');
    const fingerprint = settings.providerConfigs.codex.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('https://api.example.com/v1');
  });

  it('preserves the selected custom model after its configuration is removed', () => {
    const settings: CodexSettingsDocument = {
      model: 'my-custom-model',
      providerConfigs: {
        codex: {
          enabled: true,
          customModels: '',
          discoveredModels: TEST_CODEX_CATALOG,
          environmentVariables: 'OPENAI_BASE_URL=https://api.example.com/v1',
          environmentHash: '',
        },
      },
    };

    const result = codexSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result.changed).toBe(true);
    expect(settings.model).toBe('my-custom-model');
    expect(isVersionedRuntimeInputFingerprint(
      settings.providerConfigs.codex.environmentHash,
    )).toBe(true);
  });

  it('persists an opaque API-key-sensitive fingerprint without exposing the key', () => {
    const secret = 'codex-test-secret-value';
    const fingerprint = computeCodexEnvHash(`OPENAI_API_KEY=${secret}`);

    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain(secret);
    expect(fingerprint).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));
    expect(fingerprint).not.toContain(Buffer.from(secret, 'utf8').toString('hex'));
    expect(computeCodexEnvHash('OPENAI_API_KEY=other-test-secret')).not.toBe(fingerprint);
  });
});
