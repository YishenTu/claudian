import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { piFamilyProfile } from '@/providers/pi/profile';
import { PiCommandLoader } from '@/providers/pi-rpc/app/PiCommandLoader';
import type { PiCommandMetadataProbe } from '@/providers/pi-rpc/execution/PiCommandMetadataProbe';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    plugin: {
      app: { vault: { adapter: { basePath: '/vault' } } },
    } as unknown as ProviderCommandLoaderContext['plugin'],
    ...overrides,
  };
}

describe('PiCommandLoader', () => {
  it('uses a ready command snapshot without starting a metadata probe', async () => {
    // Load-only probe stub: the loader only calls load() on this path.
    const metadataProbe = { load: jest.fn() } as unknown as PiCommandMetadataProbe;
    const loader = new PiCommandLoader(piFamilyProfile, metadataProbe);

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
    // Load-only probe stub: the loader never reaches load() without a session.
    const metadataProbe = { load: jest.fn() } as unknown as PiCommandMetadataProbe;
    const loader = new PiCommandLoader(piFamilyProfile, metadataProbe);

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('loads commands through a no-session metadata probe', async () => {
    // Load-only probe stub returning one skill command.
    const metadataProbe = {
      load: jest.fn().mockResolvedValue([{
        content: '',
        id: 'pi:skill',
        kind: 'skill',
        name: 'skill',
        source: 'sdk',
      }]),
    } as unknown as PiCommandMetadataProbe;
    const loader = new PiCommandLoader(piFamilyProfile, metadataProbe);

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'skill' })],
      status: 'ready',
    });
    expect(metadataProbe.load).toHaveBeenCalledWith('/vault', undefined);
  });
});
