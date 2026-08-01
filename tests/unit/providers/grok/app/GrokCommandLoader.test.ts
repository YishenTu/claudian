import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { GrokCommandLoader } from '@/providers/grok/app/GrokCommandLoader';

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

describe('GrokCommandLoader', () => {
  it('uses a ready command snapshot without starting metadata discovery', async () => {
    const metadataProbe = { load: jest.fn() };
    const loader = new GrokCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext({
      readyCommandSnapshot: [{
        content: '',
        id: 'grok:test',
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

  it('does not create isolated metadata unless explicitly allowed', async () => {
    const metadataProbe = { load: jest.fn() };
    const loader = new GrokCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('loads commands through the provider-owned metadata probe', async () => {
    const metadataProbe = {
      load: jest.fn().mockResolvedValue([{
        content: '',
        id: 'grok:skill',
        kind: 'skill',
        name: 'skill',
        source: 'sdk',
      }]),
    };
    const loader = new GrokCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'skill' })],
      status: 'ready',
    });
    expect(metadataProbe.load).toHaveBeenCalledTimes(1);
  });
});
