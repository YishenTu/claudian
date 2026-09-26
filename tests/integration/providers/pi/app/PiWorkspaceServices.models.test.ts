import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { createPiWorkspaceServices } from '@/providers/pi/app/PiWorkspaceServices';
import { PiModelDiscoveryService } from '@/providers/pi/runtime/PiModelDiscoveryService';

it('drains canceled model discovery before the provider transition mutation', async () => {
  const registry = new ProviderExecutionLifecycleRegistry();
  const host = {
    executionLifecycleRegistry: registry,
    settings: { providerConfigs: { pi: { enabled: true, visibleModels: [] } } },
  } as unknown as ProviderHost;
  let release!: () => void;
  let canceled!: () => void;
  const cancellation = new Promise<void>(resolve => { canceled = resolve; });
  const probe = jest.spyOn(PiModelDiscoveryService.prototype, 'discoverModels').mockImplementation(signal => {
    signal!.addEventListener('abort', canceled, { once: true });
    return new Promise(resolve => { release = () => resolve({ kind: 'completed', models: [] }); });
  });
  const services = await createPiWorkspaceServices(host);
  const discovery = services.modelCatalog!.refresh();
  const mutation = jest.fn(async () => undefined);
  const transition = registry.runTransition(['pi'], mutation);
  await cancellation;
  // Let a transition which fails to join discovery reach its mutation.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  try {
    expect(mutation).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.all([transition, discovery]);
    await services.dispose();
    await registry.dispose();
    probe.mockRestore();
  }
  expect(mutation).toHaveBeenCalledTimes(1);
});
