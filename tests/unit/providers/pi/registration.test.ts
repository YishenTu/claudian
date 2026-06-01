import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { piProviderRegistration } from '@/providers/pi/registration';

function createPlugin(): any {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/pi-vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn(() => 'pi'),
    settings: {
      mediaFolder: 'media',
      providerConfigs: {
        pi: {
          enabled: true,
        },
      },
      systemPrompt: '',
      userName: '',
    },
  };
}

describe('Pi provider registration', () => {
  it('registers Pi metadata and runtime factories', () => {
    expect(piProviderRegistration.displayName).toBe('Pi');
    expect(piProviderRegistration.blankTabOrder).toBeGreaterThan(opencodeProviderRegistration.blankTabOrder);
    expect(piProviderRegistration.isEnabled({ providerConfigs: { pi: { enabled: true } } })).toBe(true);
    expect(piProviderRegistration.isEnabled({ providerConfigs: { pi: { enabled: false } } })).toBe(false);
    expect(piProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('PI_CODING_AGENT_DIR'))).toBe(true);

    const runtime = piProviderRegistration.createRuntime({ plugin: createPlugin() });
    expect(runtime.providerId).toBe('pi');
    runtime.cleanup();
  });

  it('routes Pi model ids through the provider registry', () => {
    const settings = {
      providerConfigs: {
        pi: { enabled: true },
      },
    };

    expect(ProviderRegistry.resolveProviderForModel('pi:anthropic/claude-sonnet-4', settings)).toBe('pi');
    expect(ProviderRegistry.getEnabledProviderIds(settings)).toContain('pi');
    expect(ProviderRegistry.getEnabledProviderIds({ providerConfigs: { pi: { enabled: false } } })).not.toContain('pi');
  });
});
