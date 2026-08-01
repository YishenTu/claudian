import {
  type ProviderExecutionBackend,
  type ProviderExecutionEvent,
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionRegistryDisposedError,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  ProviderExecutionTransitionError,
  type ProviderExecutionTransitionHook,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
} from '@/core/execution';

class TestSession implements ProviderExecutionSession {
  readonly sessionInstanceId: string;

  cancelCalls = 0;
  disposeCalls = 0;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private disposed = false;

  constructor(
    readonly providerId: string,
    instanceNumber: number,
    private readonly disposeBarrier?: Promise<void>,
  ) {
    this.sessionInstanceId = `${providerId}-session-${instanceNumber}`;
  }

  execute(_request: ProviderExecutionRequest): ProviderExecutionRun {
    throw new Error('Not implemented by registry test session');
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return {
      providerId: this.providerId,
      revision: 0,
      status: this.disposed ? 'disposed' : 'idle',
    };
  }

  getStatus(): ProviderSessionStatus {
    return this.disposed ? 'disposed' : 'idle';
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeBarrier;
    this.disposed = true;
  }
}

class TestBackend implements ProviderExecutionBackend {
  readonly configs: ProviderSessionConfig[] = [];
  readonly sessions: TestSession[] = [];

  constructor(
    readonly providerId: string,
    private readonly disposeBarrier?: Promise<void>,
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    this.configs.push(config);
    const session = new TestSession(
      this.providerId,
      this.sessions.length + 1,
      this.disposeBarrier,
    );
    this.sessions.push(session);
    return session;
  }
}

function createSessionConfig(
  lifecycle: ProviderSessionConfig['lifecycle'] = 'persistent',
): ProviderSessionConfig {
  return {
    lifecycle,
    nativePersistence: 'provider-default',
    vaultWorkingDirectory: '/vault',
    interactionPort: {
      requestApproval: jest.fn(),
      askUserQuestion: jest.fn(),
      requestPlanDecision: jest.fn(),
      dismissInteraction: jest.fn(),
    },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushTransitionStart(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('ProviderExecutionLifecycleRegistry', () => {
  it('acquires persistent and ephemeral sessions with independent leases', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('claude');
    const persistentConfig = createSessionConfig('persistent');
    const ephemeralConfig = createSessionConfig('ephemeral');

    const persistent = registry.acquire(backend, persistentConfig, 'chat');
    const ephemeral = registry.acquire(backend, ephemeralConfig, 'title');

    expect(backend.configs).toEqual([persistentConfig, ephemeralConfig]);
    expect(persistent.session).not.toBe(ephemeral.session);
    expect(persistent.generation).toBe(0);
    expect(ephemeral.generation).toBe(0);
    expect(persistent.isCurrent()).toBe(true);
    expect(ephemeral.isCurrent()).toBe(true);

    await Promise.all([persistent.release(), ephemeral.release()]);
    await registry.dispose();
  });

  it('releases a lease idempotently and makes it non-current before disposal completes', async () => {
    const barrier = deferred();
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('claude', barrier.promise);
    const lease = registry.acquire(backend, createSessionConfig(), 'chat');

    const firstRelease = lease.release();
    const secondRelease = lease.release();

    expect(lease.isCurrent()).toBe(false);
    expect(backend.sessions[0].disposeCalls).toBe(1);

    let settled = false;
    void secondRelease.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    barrier.resolve();
    await Promise.all([firstRelease, secondRelease]);
    expect(backend.sessions[0].disposeCalls).toBe(1);
    await registry.dispose();
  });

  it('normalizes a synchronous non-Error session disposal failure', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('claude');
    const lease = registry.acquire(backend, createSessionConfig(), 'chat');
    const failure = { code: 'dispose-failed' };
    jest.spyOn(lease.session, 'dispose').mockImplementation(() => {
      throw failure;
    });

    await expect(lease.release()).rejects.toMatchObject({
      cause: failure,
      message: 'Provider execution session disposal failed',
    });
    await registry.dispose();
  });

  it('waits for a manually-started in-progress release before a transition mutation', async () => {
    const barrier = deferred();
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('claude', barrier.promise);
    const lease = registry.acquire(backend, createSessionConfig(), 'chat');
    const mutation = jest.fn(async () => undefined);

    const release = lease.release();
    const transition = registry.runTransition(['claude'], mutation);
    await flushTransitionStart();

    expect(lease.isCurrent()).toBe(false);
    expect(backend.sessions[0].disposeCalls).toBe(1);
    expect(mutation).not.toHaveBeenCalled();

    barrier.resolve();
    await Promise.all([release, transition]);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(backend.sessions[0].disposeCalls).toBe(1);
    await registry.dispose();
  });

  it('waits for a manually-started in-progress release during registry disposal', async () => {
    const barrier = deferred();
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('pi', barrier.promise);
    const lease = registry.acquire(backend, createSessionConfig(), 'instruction');

    const release = lease.release();
    const disposal = registry.dispose();
    let disposalSettled = false;
    void disposal.then(() => {
      disposalSettled = true;
    });
    await flushTransitionStart();

    expect(lease.isCurrent()).toBe(false);
    expect(disposalSettled).toBe(false);
    expect(backend.sessions[0].disposeCalls).toBe(1);

    barrier.resolve();
    await Promise.all([release, disposal]);
    expect(disposalSettled).toBe(true);
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('closes acquisition before quiescence and rejects acquire with a retryable error', async () => {
    const barrier = deferred();
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('codex', barrier.promise);
    const lease = registry.acquire(backend, createSessionConfig(), 'chat');
    const mutation = jest.fn(async () => undefined);

    const transition = registry.runTransition(['codex'], mutation);
    expect(() => registry.acquire(backend, createSessionConfig(), 'title')).toThrow(
      ProviderExecutionTransitionError,
    );
    await flushTransitionStart();

    expect(lease.isCurrent()).toBe(false);
    expect(() => registry.acquire(backend, createSessionConfig(), 'title')).toThrow(
      ProviderExecutionTransitionError,
    );
    let transitionError: unknown;
    try {
      registry.acquire(backend, createSessionConfig(), 'title');
    } catch (error) {
      transitionError = error;
    }
    expect(transitionError).toMatchObject({
      providerId: 'codex',
      retryable: true,
    });
    expect(mutation).not.toHaveBeenCalled();

    barrier.resolve();
    await transition;
    expect(mutation).toHaveBeenCalledTimes(1);

    const replacement = registry.acquire(backend, createSessionConfig(), 'chat');
    expect(replacement.generation).toBe(1);
    expect(replacement.isCurrent()).toBe(true);
    await replacement.release();
    await registry.dispose();
  });

  it('invalidates synchronously before forced disposal and isolates listener failures', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('grok');
    const first = registry.acquire(backend, createSessionConfig(), 'chat');
    const second = registry.acquire(backend, createSessionConfig('ephemeral'), 'instruction');
    const observations: Array<{ current: boolean; kind: string; generation: number }> = [];

    first.onInvalidated((reason) => {
      observations.push({
        current: first.isCurrent(),
        kind: reason.kind,
        generation: reason.generation,
      });
      throw new Error('UI listener failure');
    });
    second.onInvalidated((reason) => {
      observations.push({
        current: second.isCurrent(),
        kind: reason.kind,
        generation: reason.generation,
      });
    });

    await expect(
      registry.runTransition(['grok'], async () => undefined),
    ).resolves.toBeUndefined();

    expect(observations).toEqual([
      { current: false, kind: 'provider-transition', generation: 1 },
      { current: false, kind: 'provider-transition', generation: 1 },
    ]);
    expect(backend.sessions.map((session) => session.disposeCalls)).toEqual([1, 1]);
    await registry.dispose();
  });

  it('immediately informs a late invalidation subscriber by identity-preserving reason', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('opencode');
    const lease = registry.acquire(backend, createSessionConfig(), 'chat');
    const transitionBarrier = deferred();

    const transition = registry.runTransition(['opencode'], async () => {
      await transitionBarrier.promise;
    });
    await flushTransitionStart();

    const listener = jest.fn();
    lease.onInvalidated(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      kind: 'provider-transition',
      providerId: 'opencode',
      generation: 1,
    });

    transitionBarrier.resolve();
    await transition;
    await registry.dispose();
  });

  it('runs transition hooks around the mutation after every old lease is disposed', async () => {
    const calls: string[] = [];
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('pi');
    const lease = registry.acquire(backend, createSessionConfig(), 'chat');
    const hook: ProviderExecutionTransitionHook = {
      beforeTransition: async () => {
        calls.push(`before:${lease.isCurrent()}:${backend.sessions[0].disposeCalls}`);
      },
      afterTransition: async () => {
        calls.push('after');
      },
    };
    const unregister = registry.registerTransitionHook('pi', hook);

    await registry.runTransition(['pi'], async () => {
      calls.push('mutation');
    });

    expect(calls).toEqual(['before:false:1', 'mutation', 'after']);

    unregister();
    unregister();
    await registry.runTransition(['pi'], async () => {
      calls.push('second-mutation');
    });
    expect(calls).toEqual([
      'before:false:1',
      'mutation',
      'after',
      'second-mutation',
    ]);
    await registry.dispose();
  });

  it('runs after hooks and reopens the gate when the mutation fails', async () => {
    const calls: string[] = [];
    const registry = new ProviderExecutionLifecycleRegistry();
    const backend = new TestBackend('claude');
    registry.registerTransitionHook('claude', {
      beforeTransition: () => {
        calls.push('before');
      },
      afterTransition: () => {
        calls.push('after');
      },
    });

    await expect(
      registry.runTransition(['claude'], async () => {
        calls.push('mutation');
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');

    expect(calls).toEqual(['before', 'mutation', 'after']);
    const replacement = registry.acquire(backend, createSessionConfig(), 'chat');
    expect(replacement.generation).toBe(1);
    await replacement.release();
    await registry.dispose();
  });

  it('rejects a nested same-provider transition instead of deadlocking', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const nestedMutation = jest.fn(async () => undefined);

    const transition = registry.runTransition(['claude'], async () => {
      await registry.runTransition(['claude'], nestedMutation);
    });
    const outcome = await Promise.race([
      transition.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: {
        providerId: 'claude',
        retryable: true,
      },
    });
    expect(nestedMutation).not.toHaveBeenCalled();

    await expect(
      registry.runTransition(['claude'], async () => undefined),
    ).resolves.toBeUndefined();
    await registry.dispose();
  });

  it('rejects inherited disjoint transitions before they can form a lock cycle', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const outerMutationStarted = deferred();
    const beginNestedTransition = deferred();
    const nestedMutation = jest.fn(async () => undefined);
    const independentMutation = jest.fn(async () => undefined);

    const outer = registry.runTransition(['pi'], async () => {
      outerMutationStarted.resolve();
      await beginNestedTransition.promise;
      await registry.runTransition(['claude'], nestedMutation);
    });
    await outerMutationStarted.promise;

    const independent = registry.runTransition(
      ['claude', 'pi'],
      independentMutation,
    );
    await flushTransitionStart();
    beginNestedTransition.resolve();

    const outcome = await Promise.race([
      outer.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: {
        providerId: 'claude',
        retryable: true,
      },
    });
    expect(nestedMutation).not.toHaveBeenCalled();

    await independent;
    expect(independentMutation).toHaveBeenCalledTimes(1);
    expect(registry.getProviderGeneration('claude')).toBe(1);
    expect(registry.getProviderGeneration('pi')).toBe(2);
    await registry.dispose();
  });

  it('serializes overlapping transitions for the same provider', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const firstBarrier = deferred();
    const calls: string[] = [];

    const first = registry.runTransition(['claude'], async () => {
      calls.push('first:start');
      await firstBarrier.promise;
      calls.push('first:end');
    });
    await flushTransitionStart();
    const second = registry.runTransition(['claude'], async () => {
      calls.push('second');
    });
    await flushTransitionStart();

    expect(calls).toEqual(['first:start']);
    firstBarrier.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
    expect(registry.getProviderGeneration('claude')).toBe(2);
    await registry.dispose();
  });

  it('acquires multi-provider transition locks in sorted provider-ID order without deadlock', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const firstBarrier = deferred();
    const calls: string[] = [];

    const first = registry.runTransition(['pi', 'claude'], async () => {
      calls.push('first:start');
      await firstBarrier.promise;
      calls.push('first:end');
    });
    await flushTransitionStart();
    const second = registry.runTransition(['claude', 'pi'], async () => {
      calls.push('second');
    });
    await flushTransitionStart();

    expect(calls).toEqual(['first:start']);
    firstBarrier.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
    expect(registry.getProviderGeneration('claude')).toBe(2);
    expect(registry.getProviderGeneration('pi')).toBe(2);
    await registry.dispose();
  });

  it('deduplicates provider IDs and invokes the mutation only once', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const mutation = jest.fn(async () => 'result');

    await expect(
      registry.runTransition(['claude', 'claude'], mutation),
    ).resolves.toBe('result');
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(registry.getProviderGeneration('claude')).toBe(1);
    await registry.dispose();
  });

  it('disposes every lease once and rejects future acquisition after registry disposal', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const claude = new TestBackend('claude');
    const codex = new TestBackend('codex');
    const first = registry.acquire(claude, createSessionConfig(), 'chat');
    const second = registry.acquire(codex, createSessionConfig('ephemeral'), 'inline-edit');
    const invalidations: string[] = [];
    first.onInvalidated((reason) => invalidations.push(reason.kind));
    second.onInvalidated((reason) => invalidations.push(reason.kind));

    await Promise.all([registry.dispose(), registry.dispose()]);

    expect(invalidations).toEqual(['registry-disposed', 'registry-disposed']);
    expect(claude.sessions[0].disposeCalls).toBe(1);
    expect(codex.sessions[0].disposeCalls).toBe(1);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    expect(() => registry.acquire(claude, createSessionConfig(), 'chat')).toThrow(
      ProviderExecutionRegistryDisposedError,
    );
    expect(() =>
      registry.registerTransitionHook('claude', {
        beforeTransition: jest.fn(),
        afterTransition: jest.fn(),
      }),
    ).toThrow(ProviderExecutionRegistryDisposedError);
  });

  it('keeps requested-run events out of the session listener contract', () => {
    const requested: ProviderExecutionEvent = {
      type: 'text_delta',
      scope: {
        kind: 'requested',
        sessionInstanceId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        sequence: 1,
      },
      text: 'hello',
    };
    const sessionListener = (_event: ProviderSessionEvent): void => undefined;

    // The compile-time contracts are distinct even though requested and session
    // events share normalized payloads.
    expect(requested.scope.kind).toBe('requested');
    expect(sessionListener).toBeDefined();
  });
});
