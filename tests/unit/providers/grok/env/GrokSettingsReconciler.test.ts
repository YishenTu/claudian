import { grokEnvironmentHash } from '@test/helpers/providers/grokSettings';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import { grokSettingsReconciler } from '@/providers/grok/env/GrokSettingsReconciler';
import { getGrokProviderSettings } from '@/providers/grok/settings';

describe('GrokSettingsReconciler', () => {
  const catalog = (rawId: string) => ({
    defaultModelId: rawId,
    fingerprint: `${rawId}-fingerprint`,
    models: [{
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 1,
  });

  it('computes a stable SHA-256 digest without exposing raw secret values', () => {
    const first = grokEnvironmentHash({
      providerConfigs: {
        grok: {
          cliPathsByHost: { [getInstallationKey()]: '/bin/grok' },
          environmentVariables: 'XAI_API_KEY=super-secret\nGROK_HOME=/tmp/grok',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });
    const reordered = grokEnvironmentHash({
      providerConfigs: {
        grok: {
          cliPathsByHost: { [getInstallationKey()]: '/bin/grok' },
          environmentVariables: 'GROK_HOME=/tmp/grok\nXAI_API_KEY=super-secret',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });

    expect(isVersionedRuntimeInputFingerprint(first)).toBe(true);
    expect(first).toBe(reordered);
    expect(first).not.toContain('super-secret');
    expect(first).not.toContain('/tmp/grok');
  });

  it('fingerprints the legacy CLI fallback independently from the hostname candidate', () => {
    const createSettings = (legacyCliPath: string): Record<string, unknown> => ({
      providerConfigs: {
        grok: {
          cliPath: legacyCliPath,
          cliPathsByHost: { [getInstallationKey()]: '/missing/hostname-grok' },
          environmentVariables: '',
        },
      },
    });

    expect(grokEnvironmentHash(createSettings('/bin/grok-a'))).not.toBe(
      grokEnvironmentHash(createSettings('/bin/grok-b')),
    );
  });

  it('leaves pristine disabled defaults untouched during startup reconciliation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: {},
          enabled: false,
          environmentHash: '',
          environmentVariables: '',
        },
      },
    };

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(getGrokProviderSettings(settings).environmentHash).toBe('');
  });

  it('retains the current host catalog when construction inputs become stale', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true, marker: 'untouched' },
        grok: {
          catalogsByHost: {
            [getInstallationKey()]: catalog('current-model'),
            'other-host': catalog('other-model'),
          },
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'XAI_API_KEY=new-secret',
        },
      },
    };
    const result = grokSettingsReconciler.reconcileModelWithEnvironment(settings);

    expect(result).toEqual({ changed: true });
    expect(getGrokProviderSettings(settings).catalogsByHost).toEqual({
      [getInstallationKey()]: catalog('current-model'),
      'other-host': catalog('other-model'),
    });
    expect(getGrokProviderSettings(settings).environmentHash)
      .toBe(grokEnvironmentHash(settings));
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('retains the current catalog when the construction digest is current', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        grok: {
          catalogsByHost: { [getInstallationKey()]: catalog('current-model') },
          enabled: true,
          environmentVariables: 'GROK_HOME=/tmp/grok',
        },
      },
    };
    setProviderConfig(settings, 'grok', { ...getProviderConfig(settings, 'grok'), environmentHash: grokEnvironmentHash(settings) });

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    expect(getGrokProviderSettings(settings).currentCatalog).toEqual(catalog('current-model'));
  });

  it('normalizes qualified Grok selections in every shared model slot', () => {
    const settings: Record<string, unknown> = {
      model: '  grok/grok-4.5  ',
      titleGenerationModel: ' grok/grok-3 ',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        grok: ' grok/grok-code-fast-1 ',
      },
    };

    expect(grokSettingsReconciler.normalizeModelVariantSettings!(settings)).toBe(true);
    expect(settings).toEqual({
      model: 'grok/grok-4.5',
      titleGenerationModel: 'grok/grok-3',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        grok: 'grok/grok-code-fast-1',
      },
    });
  });

  it('leaves normalized, unqualified, and unrelated provider selections unchanged', () => {
    const settings: Record<string, unknown> = {
      model: 'grok/grok-4.5',
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        grok: 'grok-3',
      },
    };

    expect(grokSettingsReconciler.normalizeModelVariantSettings!(settings)).toBe(false);
    expect(settings).toEqual({
      model: 'grok/grok-4.5',
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        grok: 'grok-3',
      },
    });
  });
});

describe('Grok runtime input changes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['GROK_HOME moving the store', { environmentVariables: 'GROK_HOME=/other-store\nHOME=/home/a\nSOME_CUSTOM_FLAG=1' }],
    ['GROK_HOME being removed', { environmentVariables: 'HOME=/home/a\nSOME_CUSTOM_FLAG=1' }],
    ['a HOME shadowed by GROK_HOME', { environmentVariables: 'GROK_HOME=/store\nHOME=/home/b\nSOME_CUSTOM_FLAG=1' }],
    ['an arbitrary key', { environmentVariables: 'GROK_HOME=/store\nHOME=/home/a\nSOME_CUSTOM_FLAG=2' }],
    ['the CLI path', { cliPath: 'C:\\new-grok.exe' }],
    ['the host CLI path', { cliPathsByHost: { [getInstallationKey()]: 'C:\\host-grok.exe' } }],
    ['the installation method', { installationMethodsByHost: { [getInstallationKey()]: 'native-windows' } }],
    ['the WSL distro', { wslDistroOverridesByHost: { [getInstallationKey()]: 'Debian' } }],
  ])('restarts the runtime when %s changes', (_label, change) => {
    // Installation entries for this host persist only on Windows.
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const settings = { providerConfigs: { grok: {
      enabled: true,
      environmentVariables: 'GROK_HOME=/store\nHOME=/home/a\nSOME_CUSTOM_FLAG=1',
      installationMethodsByHost: { [getInstallationKey()]: 'wsl' },
      wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' },
    } as Record<string, unknown> } };
    grokSettingsReconciler.reconcileModelWithEnvironment(settings);
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
    Object.assign(settings.providerConfigs.grok, change);

    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: true });
    expect(grokSettingsReconciler.reconcileModelWithEnvironment(settings)).toEqual({ changed: false });
  });
});
