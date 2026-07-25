import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { KIMI_PROVIDER_CAPABILITIES } from '@/providers/kimi/capabilities';
import { KIMI_ENVIRONMENT_KEY_PATTERNS } from '@/providers/kimi/env/KimiSettingsReconciler';
import { kimiProviderRegistration } from '@/providers/kimi/registration';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
}));

function createPlugin(): any {
  return {
    app: { vault: { adapter: { basePath: '/tmp/kimi-registration' } } },
    manifest: { version: 'test' },
    settings: {
      model: '',
      providerConfigs: { kimi: { enabled: true } },
    },
    storage: { getAdapter: jest.fn(() => ({})) },
  };
}

describe('Kimi provider registration', () => {
  it('registers the complete provider surface with the locked environment boundary', () => {
    expect(kimiProviderRegistration).toMatchObject({
      id: 'kimi',
      displayName: 'Kimi',
      blankTabOrder: 13,
    });
    expect(kimiProviderRegistration.capabilities).toBe(KIMI_PROVIDER_CAPABILITIES);
    expect(kimiProviderRegistration.environmentKeyPatterns).toBe(KIMI_ENVIRONMENT_KEY_PATTERNS);
    expect(kimiProviderRegistration.environmentKeyPatterns?.some(
      pattern => pattern.test('KIMI_API_KEY'),
    )).toBe(true);
    expect(kimiProviderRegistration.environmentKeyPatterns?.some(
      pattern => pattern.test('MOONSHOT_API_KEY'),
    )).toBe(true);
    expect(kimiProviderRegistration.environmentKeyPatterns?.some(
      pattern => pattern.test('OPENAI_API_KEY'),
    )).toBe(false);
    expect(kimiProviderRegistration).not.toHaveProperty('subagentAdapter');
    expect(kimiProviderRegistration.settingsReconciler?.environmentSessionPolicy).toBe('reload');
    expect(kimiProviderRegistration.historyService).toHaveProperty('hydrateConversationHistory');
    expect(kimiProviderRegistration.taskResultInterpreter).toHaveProperty('resolveTerminalStatus');
  });

  it('is disabled by default, mutates enablement through Kimi settings, and routes model ids', () => {
    const settings: Record<string, unknown> = {};
    expect(kimiProviderRegistration.isEnabled(settings)).toBe(false);
    kimiProviderRegistration.setEnabled?.(settings, true);
    expect(getKimiProviderSettings(settings).enabled).toBe(true);
    expect(ProviderRegistry.resolveProviderForModel('kimi:kimi-k2', settings)).toBe('kimi');
    expect(ProviderRegistry.resolveProviderForModel('kimi', settings)).toBe('claude');
  });

  it('constructs runtime and auxiliary factories against a plain plugin host', () => {
    const plugin = createPlugin();

    const runtime = kimiProviderRegistration.createRuntime({ plugin });
    expect(runtime.providerId).toBe('kimi');
    expect(runtime.getCapabilities()).toBe(kimiProviderRegistration.capabilities);
    expect(kimiProviderRegistration.createTitleGenerationService(plugin)).toBeDefined();
    expect(kimiProviderRegistration.createInstructionRefineService(plugin)).toBeDefined();
    expect(kimiProviderRegistration.createInlineEditService(plugin)).toBeDefined();
    runtime.cleanup();
  });

  it('host-scopes CLI paths and drops unknown fields during storage normalization', () => {
    expect(kimiProviderRegistration.settingsStorage.hostScopedFields).toEqual([
      'cliPathsByHost',
    ]);
    const target: Record<string, unknown> = {};
    const stored = {
      providerConfigs: {
        kimi: {
          cliPathsByHost: {
            'device:current': '/opt/kimi/bin/kimi',
            'device:other': '/other/kimi',
            'legacy-host': '/legacy/kimi',
          },
          enabled: true,
          runtimeAuthToken: 'must-not-persist',
        },
      },
    };

    expect(kimiProviderRegistration.settingsStorage.normalizeStored(target, stored)).toBe(false);

    expect(getKimiProviderSettings(target)).toMatchObject({
      cliPathsByHost: {
        'device:current': '/opt/kimi/bin/kimi',
        'device:other': '/other/kimi',
      },
      enabled: true,
    });
    expect((target.providerConfigs as Record<string, Record<string, unknown>>).kimi)
      .not.toHaveProperty('runtimeAuthToken');
  });
});
