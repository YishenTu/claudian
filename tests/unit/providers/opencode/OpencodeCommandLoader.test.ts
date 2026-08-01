import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    externalContextPaths: [],
    plugin: {} as any,
    ...overrides,
  };
}

describe('OpencodeCommandLoader', () => {
  it('uses a ready command snapshot without probing metadata', async () => {
    const metadataService = { discoverCommands: jest.fn() };
    const loader = new OpencodeCommandLoader(metadataService as any);

    await expect(loader.loadCommands(createContext({
      readyCommandSnapshot: [{
        content: '',
        id: 'opencode:test',
        kind: 'command',
        name: 'test',
        source: 'sdk',
      }],
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'test' })],
      status: 'ready',
    });
    expect(metadataService.discoverCommands).not.toHaveBeenCalled();
  });

  it('requires explicit authorization for isolated metadata creation', async () => {
    const metadataService = { discoverCommands: jest.fn() };
    const loader = new OpencodeCommandLoader(metadataService as any);

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(metadataService.discoverCommands).not.toHaveBeenCalled();
  });

  it('loads commands through the metadata service when authorized', async () => {
    const metadataService = {
      discoverCommands: jest.fn().mockResolvedValue({
        commands: [{
          content: '',
          id: 'opencode:skill',
          kind: 'skill',
          name: 'skill',
          source: 'sdk',
        }],
        loaded: true,
      }),
    };
    const loader = new OpencodeCommandLoader(metadataService as any);

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'skill' })],
      status: 'ready',
    });
    expect(metadataService.discoverCommands).toHaveBeenCalledTimes(1);
  });
});
