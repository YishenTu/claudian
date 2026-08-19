import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';

describe('ManagerResponsibilityOperationCoordinator', () => {
  it('serializes Manager acknowledgement and Leave work for one Project', async () => {
    const coordinator = new ManagerResponsibilityOperationCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = coordinator.run('project-alpha', async () => {
      order.push('acknowledgement:start');
      await firstGate;
      order.push('acknowledgement:complete');
    });
    const second = coordinator.run('project-alpha', async () => {
      order.push('leave');
    });
    await Promise.resolve();

    expect(order).toEqual(['acknowledgement:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'acknowledgement:start',
      'acknowledgement:complete',
      'leave',
    ]);
  });

  it('does not serialize independent Projects', async () => {
    const coordinator = new ManagerResponsibilityOperationCoordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = coordinator.run('project-alpha', () => firstGate);

    await expect(coordinator.run('project-beta', async () => 'ready')).resolves.toBe('ready');
    releaseFirst();
    await first;
  });

  it('continues the Project queue after an operation fails', async () => {
    const coordinator = new ManagerResponsibilityOperationCoordinator();

    await expect(coordinator.run('project-alpha', async () => {
      throw new Error('failed acknowledgement');
    })).rejects.toThrow('failed acknowledgement');
    await expect(coordinator.run('project-alpha', async () => 'ready')).resolves.toBe('ready');
  });
});
