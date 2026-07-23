import type { ProviderHost } from '@/core/providers/ProviderHost';
import { loadQoderSdkModule } from '@/providers/qoder/runtime/loadQoderSdk';
import { buildQoderBaseOptions } from '@/providers/qoder/runtime/QoderSdkBridge';

function createContext(overrides: {
  model?: string | null;
  reasoningEffort?: string | null;
}) {
  const plugin = {
    app: { vault: { adapter: { basePath: '/vault' } } },
    settings: {},
  } as unknown as ProviderHost;
  return {
    cliResolver: { resolveFromSettings: () => '/bin/qodercli' } as never,
    plugin,
    ...overrides,
  };
}

describe('buildQoderBaseOptions reasoning effort', () => {
  beforeAll(async () => {
    // resolveQoderAuth reads the loaded SDK synchronously.
    await loadQoderSdkModule();
  });

  it('forwards reasoning effort through pull-mode resolveModel', () => {
    const options = buildQoderBaseOptions(createContext({
      model: 'qoder/reasoner',
      reasoningEffort: 'high',
    }));

    expect(options.model).toBe('reasoner');
    expect(typeof options.resolveModel).toBe('function');
    expect(options.resolveModel?.({} as never)).toEqual({
      model: 'reasoner',
      parameters: { reasoningEffort: 'high' },
    });
  });

  it('omits resolveModel when no reasoning effort is selected', () => {
    const options = buildQoderBaseOptions(createContext({
      model: 'qoder/reasoner',
    }));

    expect(options.model).toBe('reasoner');
    expect(options.resolveModel).toBeUndefined();
  });

  it('omits resolveModel when no model is selected', () => {
    const options = buildQoderBaseOptions(createContext({
      reasoningEffort: 'high',
    }));

    expect(options.model).toBeUndefined();
    expect(options.resolveModel).toBeUndefined();
  });
});
