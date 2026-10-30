import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { PiCommandLoader } from '@/providers/pi/app/PiCommandLoader';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    plugin: {
      workingDirectory: '/vault',
    } as any,
    ...overrides,
  };
}

describe('PiCommandLoader', () => {
  it('uses a ready command snapshot without starting a metadata probe', async () => {
    const metadataProbe = { load: vi.fn() };
    const loader = new PiCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext({
      readyCommandSnapshot: [{
        content: '',
        id: 'pi:test',
        kind: 'command',
        name: 'test',
        source: 'sdk',
      }],
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'test' })],
      status: 'ready',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('does not probe metadata unless isolated creation is allowed', async () => {
    const metadataProbe = { load: vi.fn() };
    const loader = new PiCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });
});
