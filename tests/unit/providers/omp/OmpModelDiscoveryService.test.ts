import { OmpModelDiscoveryService } from '@/providers/omp/metadata/OmpModelDiscoveryService';

describe('OmpModelDiscoveryService', () => {
  it('discovers OMP thinking choices alongside models', async () => {
    const kernel = {
      cancel: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      openSession: jest.fn().mockResolvedValue({
        configOptions: [{
          category: 'mode', currentValue: 'default', id: 'mode', name: 'Mode', options: [
            { name: 'Default', value: 'default' },
            { name: 'Plan', value: 'plan' },
          ], type: 'select',
        }, {
          category: 'thought_level', currentValue: 'auto', id: 'thinking', name: 'Thinking', options: [
            { name: 'Off', value: 'off' },
            { name: 'Auto', value: 'auto' },
          ], type: 'select',
        }, {
          category: 'model', currentValue: 'openai/gpt-5-mini', id: 'model', name: 'Model', options: [
            { name: 'GPT-5 mini', value: 'openai/gpt-5-mini' },
          ], type: 'select',
        }],
        sessionId: 'metadata-session',
      }),
      prompt: jest.fn(),
      setModel: jest.fn(),
      setConfigOption: jest.fn(),
    };
    const plugin = { app: { vault: { adapter: { basePath: '/vault' } } } } as never;
    const service = new OmpModelDiscoveryService(plugin, { createKernel: () => kernel });

    await expect(service.discoverCatalog()).resolves.toEqual({
      models: [{ label: 'GPT-5 mini', rawId: 'openai/gpt-5-mini' }],
      thinking: {
        configId: 'thinking',
        currentValue: 'auto',
        options: [
          { id: 'off', name: 'Off' },
          { id: 'auto', name: 'Auto' },
        ],
      },
    });
  });

  it('returns models advertised through OMP ACP config options', async () => {
    const kernel = {
      cancel: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      openSession: jest.fn().mockResolvedValue({
        configOptions: [{
          category: 'model',
          currentValue: 'openai/gpt-5-mini',
          id: 'model',
          name: 'Model',
          options: [{
            description: 'OpenAI/gpt-5-mini',
            name: 'GPT-5 mini',
            value: 'openai/gpt-5-mini',
          }, {
            description: 'Anthropic/claude-sonnet',
            name: 'Claude Sonnet',
            value: 'anthropic/claude-sonnet',
          }],
          type: 'select',
        }],
        sessionId: 'metadata-session',
      }),
      prompt: jest.fn(),
      setModel: jest.fn(),
      setConfigOption: jest.fn(),
    };
    const plugin = {
      app: { vault: { adapter: { basePath: '/vault' } } },
    } as never;

    const service = new OmpModelDiscoveryService(plugin, {
      createKernel: () => kernel,
    });

    await expect(service.discover()).resolves.toEqual([
      {
        description: 'OpenAI/gpt-5-mini',
        label: 'GPT-5 mini',
        rawId: 'openai/gpt-5-mini',
      },
      {
        description: 'Anthropic/claude-sonnet',
        label: 'Claude Sonnet',
        rawId: 'anthropic/claude-sonnet',
      },
    ]);
    expect(kernel.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns every model that OMP ACP marks available', async () => {
    const kernel = {
      cancel: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      openSession: jest.fn().mockResolvedValue({
        configOptions: [{
          currentValue: 'openai/gpt-5-mini', id: 'model', name: 'Model', options: [
            { name: 'GPT-5 mini', value: 'openai/gpt-5-mini' },
            { name: 'Claude Sonnet', value: 'anthropic/claude-sonnet' },
          ], type: 'select',
        }], sessionId: 'metadata-session',
      }),
      prompt: jest.fn(),
      setModel: jest.fn(),
      setConfigOption: jest.fn(),
    };
    const plugin = {
      app: { vault: { adapter: { basePath: '/vault' } } },
    } as never;

    const service = new OmpModelDiscoveryService(plugin, {
      createKernel: () => kernel,
    });

    await expect(service.discover()).resolves.toEqual([
      { label: 'GPT-5 mini', rawId: 'openai/gpt-5-mini' },
      { label: 'Claude Sonnet', rawId: 'anthropic/claude-sonnet' },
    ]);
  });
});
