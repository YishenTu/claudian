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
      dispose: jest.fn(),
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
    expect(metadataService.dispose).not.toHaveBeenCalled();
  });

  it('disposes a loader-owned ephemeral service after discovery', async () => {
    const metadataService = {
      discoverCommands: jest.fn().mockResolvedValue({
        commands: [],
        loaded: true,
      }),
      dispose: jest.fn(async () => undefined),
    };
    const createMetadataService = jest.fn(() => metadataService as any);
    const loader = new OpencodeCommandLoader(undefined, createMetadataService);
    const context = createContext({ allowIsolatedMetadataCreation: true });

    await expect(loader.loadCommands(context)).resolves.toEqual({ status: 'empty' });
    expect(createMetadataService).toHaveBeenCalledWith(context.plugin);
    expect(metadataService.dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves caller cancellation while disposing an ephemeral service', async () => {
    const controller = new AbortController();
    const failure = new Error('caller cancelled');
    const metadataService = {
      discoverCommands: jest.fn(async () => {
        controller.abort(failure);
        return { commands: [], loaded: true };
      }),
      dispose: jest.fn(async () => undefined),
    };
    const loader = new OpencodeCommandLoader(
      undefined,
      () => metadataService as any,
    );

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
      signal: controller.signal,
    }))).rejects.toBe(failure);
    expect(metadataService.dispose).toHaveBeenCalledTimes(1);
  });
});
