import { CursorModelDiscoveryService } from '@/providers/cursor/metadata/CursorModelDiscoveryService';

describe('CursorModelDiscoveryService', () => {
  it('discovers models advertised by the Cursor ACP session', async () => {
    const kernel = {
      cancel: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      openSession: jest.fn().mockResolvedValue({
        models: {
          availableModels: [
            { modelId: 'claude-4-sonnet', name: 'Claude 4 Sonnet' },
            { id: 'gpt-5', name: 'GPT-5' },
          ],
          currentModelId: 'claude-4-sonnet',
        },
        sessionId: 'metadata-session',
      }),
      prompt: jest.fn(),
      setConfigOption: jest.fn(),
      setMode: jest.fn(),
      setModel: jest.fn(),
    };
    const plugin = { app: { vault: { adapter: { basePath: '/vault' } } } } as never;
    const service = new CursorModelDiscoveryService(plugin, { createKernel: () => kernel });

    await expect(service.discover()).resolves.toEqual([
      { label: 'Claude 4 Sonnet', rawId: 'claude-4-sonnet' },
      { label: 'GPT-5', rawId: 'gpt-5' },
    ]);
    expect(kernel.dispose).toHaveBeenCalledTimes(1);
  });
});
