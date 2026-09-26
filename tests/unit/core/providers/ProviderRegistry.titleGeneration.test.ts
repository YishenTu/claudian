import { FakeAuxiliaryBackend, waitFor } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderRegistration } from '@/core/providers/types';

function createReadyService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.setServices('claude', {});
  ProviderRegistry.register('claude', {
    isEnabled: () => true,
    modelPolicy: { getModelOptions: () => [{ value: 'test-title', label: 'Test title' }] },
    capabilities: { supportsEphemeralSessions: true },
    createExecutionBackend: () => backend,
  } as unknown as ProviderRegistration);
  const host = {
    settings: { titleGenerationModel: 'test-title' },
    app: { vault: { adapter: { basePath: '/vault' } } },
    executionLifecycleRegistry: lifecycle,
  } as unknown as ProviderHost;
  return { backend, lifecycle, service: ProviderRegistry.createTitleGenerationService(host) };
}

it('does not submit a title request after cancellation during provider initialization', async () => {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  let releaseInitialization!: () => void;
  let initializing = false;
  const initialization = new Promise<void>(resolve => { releaseInitialization = resolve; });
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.register('claude', {
    async initialize() {
      initializing = true;
      await initialization;
      return {};
    },
  });
  ProviderRegistry.register('claude', {
    isEnabled: () => true,
    modelPolicy: { getModelOptions: () => [{ value: 'test-title', label: 'Test title' }] },
    capabilities: { supportsEphemeralSessions: true },
    createExecutionBackend: () => backend,
  } as unknown as ProviderRegistration);
  const host = {
    settings: { titleGenerationModel: 'test-title' },
    app: { vault: { adapter: { basePath: '/vault' } } },
    storage: { getAdapter: () => ({}) },
    executionLifecycleRegistry: lifecycle,
    runProviderExecutionTransition: lifecycle.runTransition.bind(lifecycle),
  } as unknown as ProviderHost;
  const service = ProviderRegistry.createTitleGenerationService(host);
  const callback = jest.fn();
  const generation = service.generateTitle('conversation', 'Explain ownership', callback);
  await waitFor(() => initializing);
  service.cancel();
  releaseInitialization();
  await new Promise(resolve => setImmediate(resolve));
  const submittedRequests = backend.sessions.flatMap(session => session.requests);
  for (const session of backend.sessions) {
    session.emitText('Ownership explained');
    session.complete();
  }
  await generation;
  await lifecycle.dispose();
  await ProviderWorkspaceRegistry.disposeInitialized();
  expect({ requests: submittedRequests.length, results: callback.mock.calls })
    .toEqual({ requests: 0, results: [] });
});

it('replaces a running title without publishing its cancellation or affecting another conversation', async () => {
  const { backend, lifecycle, service } = createReadyService();
  const results = jest.fn();
  const first = service.generateTitle('conversation', 'first request', results);
  const other = service.generateTitle('other', 'other request', results);
  await waitFor(() => backend.sessions.length === 2 && backend.sessions.every(session => session.requests.length > 0));
  const replacement = service.generateTitle('conversation', 'replacement request', results);
  await waitFor(() => backend.sessions[2]?.requests.length === 1);
  expect(backend.sessions[0].getStatus()).toBe('disposed');
  expect(backend.sessions[1].getStatus()).toBe('executing');
  backend.sessions[1].emitText('Other title');
  backend.sessions[1].complete();
  backend.sessions[2].emitText('Replacement title');
  backend.sessions[2].complete();
  await Promise.all([first, other, replacement]);
  await lifecycle.dispose();
  expect(results.mock.calls).toEqual([
    ['other', { success: true, title: 'Other title' }],
    ['conversation', { success: true, title: 'Replacement title' }],
  ]);
});

it('supersedes a preparing request and permits a fresh request after cancellation', async () => {
  const { backend, lifecycle, service } = createReadyService();
  const results = jest.fn();
  const first = service.generateTitle('conversation', 'first request', results);
  const second = service.generateTitle('conversation', 'second request', results);
  service.cancel();
  const fresh = service.generateTitle('conversation', 'fresh request', results);
  await waitFor(() => backend.sessions[0]?.requests.length === 1);
  expect(backend.sessions.flatMap(session => session.requests).map(request => request.input))
    .toEqual([[{ type: 'text', text: expect.stringContaining('fresh request') }]]);
  backend.sessions[0].emitText('Fresh title');
  backend.sessions[0].complete();
  await Promise.all([first, second, fresh]);
  await lifecycle.dispose();
  expect(results.mock.calls).toEqual([['conversation', { success: true, title: 'Fresh title' }]]);
});
