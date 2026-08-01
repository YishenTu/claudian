import type { ProviderHost } from '@/core/providers/ProviderHost';
import { PiCommandMetadataProbe } from '@/providers/pi/execution/PiCommandMetadataProbe';

describe('PiCommandMetadataProbe', () => {
  it('normalizes a non-Error abort reason while waiting behind a transition fence', async () => {
    const createKernel = jest.fn();
    const probe = new PiCommandMetadataProbe(
      {} as ProviderHost,
      createKernel,
    );
    const controller = new AbortController();
    probe.beginEnvironmentTransition();

    const load = probe.load('/vault', controller.signal);
    controller.abort('caller cancelled');

    await expect(load).rejects.toMatchObject({
      cause: 'caller cancelled',
      message: 'Pi command metadata probe aborted',
    });
    expect(createKernel).not.toHaveBeenCalled();
    await probe.dispose();
  });
});
