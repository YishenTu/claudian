import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { PiCommandMetadataProbe } from '@/providers/pi/execution/PiCommandMetadataProbe';

let host: ProviderHost;
let probe: PiCommandMetadataProbe;
const resolveCliPath = vi.fn<() => Promise<string | null>>(() => { throw new Error('Unexpected metadata discovery'); });
beforeEach(async () => {
  resolveCliPath.mockClear();
  ({ host } = await createProviderHostFixture({ overrides: { getResolvedProviderCliPath: resolveCliPath } }));
  probe = new PiCommandMetadataProbe(host.getRuntimeHost('pi'));
});
afterEach(async () => { await probe.dispose(); });

import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { PiCommandLoader } from '@/providers/pi/app/PiCommandLoader';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    plugin: host,
    ...overrides,
  };
}

describe('PiCommandLoader', () => {
  it('uses a ready command snapshot without starting a metadata probe', async () => {
    const loader = new PiCommandLoader(probe);

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
    expect(resolveCliPath).not.toHaveBeenCalled();
  });

  it('does not probe metadata unless isolated creation is allowed', async () => {
    const loader = new PiCommandLoader(probe);

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(resolveCliPath).not.toHaveBeenCalled();
  });
});
