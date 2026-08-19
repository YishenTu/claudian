import { HostedProjectAdmissionGate } from '@/app/collab/lan/lifecycle/HostedProjectAdmissionGate';

describe('HostedProjectAdmissionGate', () => {
  it('drains work admitted before quiescence and rejects later work', async () => {
    const gate = new HostedProjectAdmissionGate({ drainTimeoutMs: 250 });
    let release!: () => void;
    const running = gate.run(() => new Promise<void>(resolve => {
      release = resolve;
    }));

    const draining = gate.quiesceAndDrain();
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: 'project-retired',
    });

    let drained = false;
    void draining.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await expect(running).resolves.toBeUndefined();
    await expect(draining).resolves.toBeUndefined();
    expect(gate.mode).toBe('quiescing');
  });

  it('reopens only before a terminal transition', async () => {
    const gate = new HostedProjectAdmissionGate();

    await gate.quiesceAndDrain();
    gate.reopen();
    await expect(gate.run(async () => 'active')).resolves.toBe('active');

    await gate.quiesceAndDrain('transferred');
    gate.commitTerminal('transferred');
    expect(() => gate.reopen()).toThrow(expect.objectContaining({
      code: 'durable-progress-recovery-required',
    }));
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: 'host-transfer-pending',
    });
  });

  it('bounds a drain without forgetting admitted work', async () => {
    jest.useFakeTimers();
    try {
      const gate = new HostedProjectAdmissionGate({ drainTimeoutMs: 50 });
      let release!: () => void;
      const running = gate.run(() => new Promise<void>(resolve => {
        release = resolve;
      }));

      const draining = gate.quiesceAndDrain();
      const result = draining.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toMatchObject({ code: 'operation-timeout' });
      expect(gate.admittedCount).toBe(1);

      release();
      await running;
      expect(gate.admittedCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('supports idempotent terminal commits after a completed drain', async () => {
    const gate = new HostedProjectAdmissionGate();

    await gate.quiesceAndDrain();
    gate.commitTerminal('retired');
    gate.commitTerminal('retired');

    expect(gate.mode).toBe('retired');
    expect(() => gate.commitTerminal('transferred')).toThrow(expect.objectContaining({
      code: 'durable-progress-recovery-required',
    }));
  });

  it('does not mix retirement and Host-transfer quiescence', async () => {
    const gate = new HostedProjectAdmissionGate();

    await gate.quiesceAndDrain('transferred');

    await expect(gate.quiesceAndDrain('retired')).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
  });
});
