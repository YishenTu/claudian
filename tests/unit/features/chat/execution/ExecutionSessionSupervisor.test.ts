import {
  type ProviderExecutionBackend,
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderInteractionPort,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
} from '@/core/execution';
import {
  ExecutionSessionSupervisor,
} from '@/features/chat/execution/ExecutionSessionSupervisor';

class SupervisorSession implements ProviderExecutionSession {
  readonly providerId = 'claude';
  readonly sessionInstanceId = 'session-1';
  disposeCalls = 0;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();

  execute(_request: ProviderExecutionRequest): ProviderExecutionRun {
    throw new Error('Not used');
  }

  cancel(): void {}

  getSnapshot(): ProviderSessionSnapshot {
    return { providerId: 'claude', revision: 0, status: 'idle' };
  }

  getStatus(): ProviderSessionStatus {
    return 'idle';
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

describe('ExecutionSessionSupervisor', () => {
  it('acquires once, fences before release, and observes registry invalidation', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const session = new SupervisorSession();
    const backend: ProviderExecutionBackend = {
      providerId: 'claude',
      createSession: jest.fn(() => session),
    };
    const interactionPort = {} as ProviderInteractionPort;
    const config: ProviderSessionConfig = {
      lifecycle: 'persistent',
      nativePersistence: 'enabled',
      vaultWorkingDirectory: '/vault',
      interactionPort,
    };
    const invalidated = jest.fn();
    const supervisor = new ExecutionSessionSupervisor(registry);

    const first = supervisor.acquire(backend, config, invalidated);
    const second = supervisor.acquire(backend, config, invalidated);

    expect(first).toBe(second);
    expect(supervisor.isCurrent(session, first.generation)).toBe(true);

    const transition = registry.runTransition(['claude'], async () => undefined);
    for (let attempt = 0; attempt < 10 && supervisor.current; attempt += 1) {
      await Promise.resolve();
    }
    expect(supervisor.current).toBeNull();
    expect(supervisor.isCurrent(session, first.generation)).toBe(false);
    await transition;
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(session.disposeCalls).toBe(1);

    const replacement = supervisor.acquire(backend, config, invalidated);
    expect(replacement.generation).toBe(1);
    await supervisor.release();
    expect(supervisor.current).toBeNull();
    await registry.dispose();
  });
});
