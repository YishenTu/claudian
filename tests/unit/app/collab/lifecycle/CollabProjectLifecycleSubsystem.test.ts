import {
  type CollabProjectLifecycleRecoveryStage,
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';

function ports() {
  return {
    closeRecovery: jest.fn().mockResolvedValue(undefined),
    hostTransfer: {} as never,
    localExit: {} as never,
    retirement: {} as never,
  };
}

describe('CollabProjectLifecycleSubsystem', () => {
  it('isolates recovery stages and reports the first failure after later stages run', async () => {
    const order: string[] = [];
    const firstError = new Error('terminal responder unavailable');
    const stages: readonly CollabProjectLifecycleRecoveryStage[] = [
      {
        name: 'responders',
        run: async () => {
          order.push('responders');
          throw firstError;
        },
      },
      {
        name: 'pending-leaves',
        run: async () => {
          order.push('pending-leaves');
        },
      },
    ];
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      recoveryStages: stages,
    });

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toBe(firstError);
    expect(order).toEqual(['responders', 'pending-leaves']);
  });

  it('stops recovery between stages after cancellation', async () => {
    const controller = new AbortController();
    const later = jest.fn();
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      recoveryStages: [
        {
          name: 'first',
          run: async () => {
            controller.abort();
          },
        },
        { name: 'later', run: later },
      ],
    });

    await expect(subsystem.lifecycleRecovery.resume({ signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(later).not.toHaveBeenCalled();
  });

  it('binds one feature projection and forwards lifecycle invalidation', async () => {
    const closeProjectAdmission = jest.fn();
    const refreshLifecycleProjection = jest.fn().mockResolvedValue(undefined);
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      recoveryStages: [],
    });

    subsystem.bindProjection({ closeProjectAdmission, refreshLifecycleProjection });
    subsystem.closeProjectAdmission('project-alpha');
    await subsystem.refreshLifecycleProjection();

    expect(closeProjectAdmission).toHaveBeenCalledWith('project-alpha');
    expect(refreshLifecycleProjection).toHaveBeenCalledTimes(1);
    expect(() => subsystem.bindProjection({
      closeProjectAdmission: jest.fn(),
      refreshLifecycleProjection: jest.fn(),
    })).toThrow('Collab lifecycle projection is already bound');
  });

  it('delegates recovery close without closing independent feature ports', async () => {
    const closeRecovery = jest.fn().mockResolvedValue(undefined);
    const hostClose = jest.fn();
    const retirementClose = jest.fn();
    const subsystem = new CollabProjectLifecycleSubsystem({
      closeRecovery,
      hostTransfer: { close: hostClose } as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: { close: retirementClose } as never,
    });

    await subsystem.lifecycleRecovery.close();

    expect(closeRecovery).toHaveBeenCalledTimes(1);
    expect(hostClose).not.toHaveBeenCalled();
    expect(retirementClose).not.toHaveBeenCalled();
  });
});
