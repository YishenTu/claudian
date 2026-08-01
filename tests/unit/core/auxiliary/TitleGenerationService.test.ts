import { TitleGenerationService } from '@/core/auxiliary/TitleGenerationService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

import {
  FakeAuxiliaryBackend,
  waitFor,
} from './AuxiliaryExecutionTestHarness';

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new TitleGenerationService({
    backend,
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
      requestPlanDecision: jest.fn(),
    },
    lifecycleRegistry,
    resolveLocale: () => 'ja',
    resolveModel: () => 'title-model',
    vaultWorkingDirectory: '/vault',
  });
  return { backend, lifecycleRegistry, service };
}

describe('TitleGenerationService', () => {
  it('uses independent one-shot passive sessions and preserves prompt parsing', async () => {
    const { backend, service } = createService();
    const firstCallback = jest.fn();
    const secondCallback = jest.fn();
    const first = service.generateTitle('conversation-1', 'First request', firstCallback);
    const second = service.generateTitle('conversation-2', 'Second request', secondCallback);
    await waitFor(() => backend.sessions.length === 2
      && backend.sessions.every(session => session.requests.length === 1));

    expect(backend.sessions).toHaveLength(2);
    for (const session of backend.sessions) {
      expect(session.requests[0]).toMatchObject({
        configuration: {
          model: 'title-model',
          systemInstructions: {
            instructions: expect.stringContaining('Write the title in Japanese'),
            kind: 'explicit',
          },
        },
        toolPolicy: { kind: 'passive' },
      });
    }
    expect(backend.configs).toEqual([
      expect.objectContaining({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
      expect.objectContaining({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    ]);

    backend.sessions[0].emitText('First title');
    backend.sessions[0].complete();
    backend.sessions[1].emitText('Second title');
    backend.sessions[1].complete();
    await Promise.all([first, second]);

    expect(firstCallback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'First title',
    });
    expect(secondCallback).toHaveBeenCalledWith('conversation-2', {
      success: true,
      title: 'Second title',
    });
    expect(backend.sessions.map(session => session.disposeCalls)).toEqual([1, 1]);
  });

  it('cancels only the matching active generation and releases its lease', async () => {
    const { backend, service } = createService();
    const callback = jest.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    service.cancel();
    await generation;

    expect(backend.sessions[0].cancelCalls).toBeGreaterThan(0);
    expect(backend.sessions[0].disposeCalls).toBe(1);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
  });

  it('completes an in-flight title call when a provider transition invalidates it', async () => {
    const { backend, lifecycleRegistry, service } = createService();
    const callback = jest.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    await lifecycleRegistry.runTransition(['claude'], async () => undefined);
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('does not acquire a session when cancelled during asynchronous startup', async () => {
    const { backend, service } = createService();
    const callback = jest.fn();

    const generation = service.generateTitle('conversation-1', 'Request', callback);
    service.cancel();
    await generation;

    expect(backend.sessions).toHaveLength(0);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
  });
});
