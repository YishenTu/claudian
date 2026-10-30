import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { PiNativeProcess } from '@test/helpers/providers/pi/PiNativeProcess';
import spawn from 'cross-spawn';

import { createPiWorkspaceServices } from '@/providers/pi/app/PiWorkspaceServices';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

it('drains canceled model discovery before the provider transition mutation', async () => {
  const { host, lifecycle } = await createProviderHostFixture({
    settings: { providerConfigs: { pi: { enabled: true, visibleModels: [] } } },
    overrides: { getResolvedProviderCliPath: async () => 'pi' },
  });
  const native = new PiNativeProcess({}, new Map(), () => new Promise(() => undefined));
  vi.mocked(spawn).mockReturnValue(native.child);
  let canceled!: () => void;
  const cancellation = new Promise<void>(resolve => { canceled = resolve; });
  vi.spyOn(native.child, 'kill').mockImplementation(() => { canceled(); return true; });
  const services = await createPiWorkspaceServices(host);
  // Hold the shutdown grace timer: only the native exit below can release discovery.
  vi.useFakeTimers();
  const discovery = services.modelCatalog!.refresh();
  await native.whenRequest('get_available_models');
  const mutation = vi.fn(async () => undefined);
  const transition = lifecycle.runTransition(['pi'], mutation);
  try {
    await cancellation;
    await vi.advanceTimersByTimeAsync(0);
    expect(mutation).not.toHaveBeenCalled();
    native.close();
    await Promise.all([transition, discovery]);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(native.child.stdout.listenerCount('data')).toBe(0);
  } finally {
    native.close();
    await services.dispose();
    native.child.stdin.destroy(); native.child.stdout.destroy(); native.child.stderr.destroy();
    vi.mocked(spawn).mockReset();
    vi.useRealTimers();
  }
});
