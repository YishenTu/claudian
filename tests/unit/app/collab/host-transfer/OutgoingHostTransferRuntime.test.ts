import { OutgoingHostTransferRuntime } from '@/app/collab/host-transfer/OutgoingHostTransferRuntime';

describe('OutgoingHostTransferRuntime', () => {
  it('normalizes non-Error coordinator failures', async () => {
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => ({
        run: () => { throw 'coordinator-failed'; },
      })) as never,
      { load: jest.fn() } as never,
    );

    await expect(runtime.run('project-a', 'transfer-a')).rejects.toMatchObject({
      cause: 'coordinator-failed',
      message: 'coordinator-failed',
    });
  });

  it('aborts and drains accepted background work before closing', async () => {
    let receivedSignal: AbortSignal | undefined;
    const coordinator = {
      run: jest.fn((
        _projectId: string,
        _transferId: string,
        signal?: AbortSignal,
      ) => {
        receivedSignal = signal;
        return new Promise<void>(resolve => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      { load: jest.fn() } as never,
    );

    const running = runtime.run('project-a', 'transfer-a');
    await Promise.resolve();
    const closing = runtime.close();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(closing).resolves.toBeUndefined();
    await expect(running).resolves.toBeUndefined();
    await expect(runtime.run('project-a', 'transfer-a')).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('drains startup recovery that was admitted before close', async () => {
    let releaseLoad!: (record: unknown) => void;
    const recovery = {
      load: jest.fn(() => new Promise(resolve => {
        releaseLoad = resolve;
      })),
    };
    const coordinator = {
      run: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      recovery as never,
    );
    const resuming = runtime.resume();
    const closing = runtime.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();

    expect(closed).toBe(false);
    releaseLoad({
      direction: 'outgoing',
      phase: 'accepted',
      projectId: 'project-a',
      transferId: 'transfer-a',
    });
    await resuming;
    await closing;

    expect(coordinator.run).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
      expect.objectContaining({ aborted: true }),
    );
  });

  it('persists accepted transfer recovery before deferred cutover work', async () => {
    const coordinator = {
      prepareAccepted: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      { load: jest.fn() } as never,
    );

    await runtime.prepareAccepted('project-a', 'transfer-a');

    expect(coordinator.prepareAccepted).toHaveBeenCalledWith('project-a', 'transfer-a');
  });

  it('persists cancellation recovery before the authority clears its receiver credential', async () => {
    const coordinator = {
      prepareCancellation: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      { load: jest.fn() } as never,
    );

    await runtime.prepareCancellation('project-a', 'transfer-a');

    expect(coordinator.prepareCancellation).toHaveBeenCalledWith('project-a', 'transfer-a');
  });

  it('resumes the exact durable outgoing transfer on hosted Project startup', async () => {
    const coordinator = {
      cancelBeforeRelinquishment: jest.fn(),
      run: jest.fn().mockResolvedValue(undefined),
    };
    const recovery = {
      load: jest.fn().mockResolvedValue({
        direction: 'outgoing',
        phase: 'staged',
        projectId: 'project-a',
        transferId: 'transfer-a',
      }),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      recovery as never,
    );

    await runtime.resume();

    expect(recovery.load).toHaveBeenCalledWith('project-a', 'outgoing');
    expect(coordinator.run).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
      expect.any(AbortSignal),
    );
  });

  it('resumes a terminal transfer so target cleanup can finish', async () => {
    const coordinator = {
      cancelBeforeRelinquishment: jest.fn(),
      run: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      { load: jest.fn().mockResolvedValue({
        direction: 'outgoing',
        phase: 'cancelled',
        projectId: 'project-a',
        transferId: 'transfer-a',
      }) } as never,
    );

    await runtime.resume();

    expect(coordinator.run).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
      expect.any(AbortSignal),
    );
  });

  it('classifies and prepares terminal target cleanup before Host startup', async () => {
    const coordinator = {
      inspectStartupRecovery: jest.fn().mockResolvedValue('pre-relinquishment-cleanup'),
      prepareTerminalRecoveryBeforeStartup: jest.fn().mockResolvedValue(undefined),
    };
    const recovery = {
      load: jest.fn().mockResolvedValue({
        direction: 'outgoing',
        phase: 'cancelled',
        projectId: 'project-a',
        transferId: 'transfer-a',
      }),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      recovery as never,
    );

    await expect(runtime.inspectStartupRecovery())
      .resolves.toBe('pre-relinquishment-cleanup');
    await runtime.prepareTerminalRecoveryBeforeStartup();

    expect(coordinator.prepareTerminalRecoveryBeforeStartup).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
    );
  });

  it('classifies post-relinquishment startup before the old Host route opens', async () => {
    const recovery = {
      load: jest.fn().mockResolvedValue({
        direction: 'outgoing',
        phase: 'authority-relinquished',
        projectId: 'project-a',
        transferId: 'transfer-a',
      }),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => ({
        inspectStartupRecovery: jest.fn().mockResolvedValue('post-relinquishment'),
      })) as never,
      recovery as never,
    );

    await expect(runtime.inspectStartupRecovery()).resolves.toBe('post-relinquishment');
  });

  it('uses authority reconciliation when cutover committed before the local checkpoint', async () => {
    const coordinator = {
      cancelBeforeRelinquishment: jest.fn(),
      inspectStartupRecovery: jest.fn().mockResolvedValue('post-relinquishment'),
      run: jest.fn(),
    };
    const recovery = {
      load: jest.fn().mockResolvedValue({
        direction: 'outgoing',
        phase: 'staged',
        projectId: 'project-a',
        transferId: 'transfer-a',
      }),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      recovery as never,
    );

    await expect(runtime.inspectStartupRecovery()).resolves.toBe('post-relinquishment');

    expect(coordinator.inspectStartupRecovery).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
    );
  });

  it('resumes completed recovery so old-authority teardown can finish', async () => {
    const coordinator = {
      cancelBeforeRelinquishment: jest.fn(),
      run: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => coordinator as never),
      { load: jest.fn().mockResolvedValue({
        direction: 'outgoing',
        phase: 'completed',
        projectId: 'project-a',
        transferId: 'transfer-a',
      }) } as never,
    );

    await runtime.resume();

    expect(coordinator.run).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
      expect.any(AbortSignal),
    );
  });

  it('keeps per-Host runtime admission and close ownership isolated', async () => {
    const sourceSignals: AbortSignal[] = [];
    const targetSignals: AbortSignal[] = [];
    const source = new OutgoingHostTransferRuntime(
      'project-a',
      jest.fn(() => ({
        run: jest.fn((_projectId: string, _transferId: string, signal: AbortSignal) => {
          sourceSignals.push(signal);
          return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {
            once: true,
          }));
        }),
      })) as never,
      { load: jest.fn() } as never,
    );
    const target = new OutgoingHostTransferRuntime(
      'project-b',
      jest.fn(() => ({
        run: jest.fn((_projectId: string, _transferId: string, signal: AbortSignal) => {
          targetSignals.push(signal);
          return Promise.resolve();
        }),
      })) as never,
      { load: jest.fn() } as never,
    );

    const sourceRun = source.run('project-a', 'transfer-a');
    await Promise.resolve();
    await source.close();

    expect(sourceSignals).toHaveLength(1);
    expect(sourceSignals[0]?.aborted).toBe(true);
    await expect(sourceRun).resolves.toBeUndefined();
    await expect(target.run('project-b', 'transfer-b')).resolves.toBeUndefined();
    expect(targetSignals).toHaveLength(1);
    expect(targetSignals[0]?.aborted).toBe(false);
    await target.close();
  });
});
