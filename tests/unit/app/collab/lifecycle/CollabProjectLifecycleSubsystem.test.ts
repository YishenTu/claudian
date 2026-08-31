import {
  type CollabProjectLifecycleRecoveryStage,
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';

function ports() {
  return {
    closeRecovery: jest.fn().mockResolvedValue(undefined),
    durableOwners: [],
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

  it('fails closed before a recovery handler when durable owners are ambiguous', async () => {
    const resumeHost = jest.fn().mockResolvedValue(undefined);
    const holder: { subsystem?: CollabProjectLifecycleSubsystem } = {};
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      durableOwners: [
        { inspect: async () => 'nonterminal', name: 'authority-transfer' },
        { inspect: async () => 'nonterminal', name: 'host-transfer' },
      ],
      recoveryStages: [{
        name: 'host-transfers',
        run: () => holder.subsystem!.runExclusive(
          'project-alpha',
          'host-transfer',
          'recovery',
          resumeHost,
        ),
      }],
    });
    holder.subsystem = subsystem;

    await expect(subsystem.lifecycleRecovery.resume()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-owner-ambiguous' },
    });
    expect(resumeHost).not.toHaveBeenCalled();
  });

  it('blocks a fresh same-owner operation but admits explicit continuation and recovery', async () => {
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      durableOwners: [{ inspect: async () => 'nonterminal', name: 'host-transfer' }],
      recoveryStages: [],
    });
    const fresh = jest.fn().mockResolvedValue('fresh');

    await expect(subsystem.runExclusive(
      'project-alpha',
      'host-transfer',
      'operation',
      fresh,
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-owner-recovery-required' },
    });
    expect(fresh).not.toHaveBeenCalled();
    await expect(subsystem.runExclusive(
      'project-alpha',
      'host-transfer',
      'continuation',
      async () => 'continued',
    )).resolves.toBe('continued');
    await expect(subsystem.runExclusive(
      'project-alpha',
      'host-transfer',
      'recovery',
      async () => 'recovered',
    )).resolves.toBe('recovered');
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
      durableOwners: [],
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

  it('serializes one Project while allowing a different Project to proceed', async () => {
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      recoveryStages: [],
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = subsystem.runExclusive(
      'project-alpha',
      'authority-transfer',
      'operation',
      async () => {
        order.push('alpha-first-start');
        await firstBlocked;
        order.push('alpha-first-end');
      },
    );
    const second = subsystem.runExclusive(
      'project-alpha',
      'retirement',
      'operation',
      async () => {
        order.push('alpha-second');
      },
    );
    const otherProject = subsystem.runExclusive(
      'project-beta',
      'retirement',
      'operation',
      async () => {
        order.push('beta');
      },
    );

    await otherProject;
    expect(order).toEqual(['alpha-first-start', 'beta']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'alpha-first-start',
      'beta',
      'alpha-first-end',
      'alpha-second',
    ]);
  });

  it('serializes same-owner authority entries and closes their alternate admission path', async () => {
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      recoveryStages: [],
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = subsystem.runExclusive(
      'project-alpha',
      'retirement',
      'operation',
      async () => {
        entered();
        await blocked;
      },
    );
    await started;
    const authorityMutation = jest.fn().mockResolvedValue('retired');
    const second = subsystem.runExclusive(
      'project-alpha',
      'retirement',
      'operation',
      authorityMutation,
    );
    await Promise.resolve();
    expect(authorityMutation).not.toHaveBeenCalled();

    const closing = subsystem.lifecycleRecovery.close();
    await expect(subsystem.runExclusive(
      'project-alpha',
      'retirement',
      'operation',
      async () => 'must-not-run',
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-subsystem-closed' },
    });

    release();
    await expect(second).resolves.toBe('retired');
    await first;
    await closing;
    expect(authorityMutation).toHaveBeenCalledTimes(1);
  });

  it('admits only the declared durable predecessor into an owner handoff', async () => {
    const localExit = { leaveProject: jest.fn().mockResolvedValue(undefined) };
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      durableOwners: [{
        inspect: async () => 'nonterminal',
        name: 'manager-responsibility',
      }],
      localExit: localExit as never,
      recoveryStages: [],
    });

    await expect(subsystem.localExit.leaveProject({
      cleanupChoice: 'keep-files',
      managerResponsibilityOfferId: 'offer-one',
      projectId: 'project-alpha',
    })).resolves.toBeUndefined();
    expect(localExit.leaveProject).toHaveBeenCalledTimes(1);

    const blockedRetirement = jest.fn().mockResolvedValue('retired');
    await expect(subsystem.runRetirementAdoption(
      'project-alpha',
      blockedRetirement,
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-owner-pending' },
    });
    expect(blockedRetirement).not.toHaveBeenCalled();

    const localExitOwner = new CollabProjectLifecycleSubsystem({
      ...ports(),
      durableOwners: [{ inspect: async () => 'nonterminal', name: 'local-exit' }],
      recoveryStages: [],
    });
    const retirement = jest.fn().mockResolvedValue('retired');
    await expect(localExitOwner.runRetirementAdoption(
      'project-alpha',
      retirement,
    )).resolves.toBe('retired');
    expect(retirement).toHaveBeenCalledTimes(1);
  });

  it('routes every locally stateful lifecycle mutation through the Project arbiter', async () => {
    const hostTransfer = {
      acceptHostTransfer: jest.fn().mockResolvedValue(undefined),
      cancelHostTransfer: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      createHostTransfer: jest.fn().mockResolvedValue(undefined),
      declineHostTransfer: jest.fn().mockResolvedValue(undefined),
    };
    const localExit = { leaveProject: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      cancelManagerResponsibilityOffer: jest.fn().mockResolvedValue({}),
      createInvitation: jest.fn().mockResolvedValue({}),
      createManagerResponsibilityOffer: jest.fn().mockResolvedValue({}),
      demoteManager: jest.fn().mockResolvedValue(undefined),
      promoteManager: jest.fn().mockResolvedValue(undefined),
      removeMember: jest.fn().mockResolvedValue(undefined),
      revokeInvitation: jest.fn().mockResolvedValue(undefined),
    };
    const cloudBootstrap = {
      cancel: jest.fn().mockResolvedValue({}),
      close: jest.fn().mockResolvedValue(undefined),
      prepareLocalRecovery: jest.fn().mockResolvedValue(undefined),
      recoverPending: jest.fn().mockResolvedValue(undefined),
      startFormerHost: jest.fn().mockResolvedValue({}),
      submitParticipant: jest.fn().mockResolvedValue({}),
    };
    const retirement = {
      close: jest.fn().mockResolvedValue(undefined),
      finalizeRetiredProject: jest.fn().mockResolvedValue(undefined),
      retireProject: jest.fn().mockResolvedValue(undefined),
      retryProjectCleanup: jest.fn().mockResolvedValue(undefined),
    };
    const subsystem = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn().mockResolvedValue(undefined),
      durableOwners: [],
      hostTransfer,
      localExit,
      recoveryStages: [],
      retirement,
    });
    const guardedCloudBootstrap = subsystem.bindCloudBootstrap(cloudBootstrap as never);
    const guardedMembership = subsystem.bindMembership(membership as never);
    subsystem.registerDurableOwner({
      inspect: async () => 'nonterminal',
      name: 'authority-transfer',
    });

    const blocked = [
      subsystem.hostTransfer.createHostTransfer({
        projectId: 'project-alpha',
        targetMemberId: 'member-target',
      }),
      subsystem.hostTransfer.acceptHostTransfer({
        projectId: 'project-alpha',
        transferId: 'transfer-one',
      }),
      subsystem.hostTransfer.declineHostTransfer({
        projectId: 'project-alpha',
        transferId: 'transfer-one',
      }),
      subsystem.localExit.leaveProject({
        cleanupChoice: 'keep-files',
        projectId: 'project-alpha',
      }),
      subsystem.retirement.finalizeRetiredProject({
        cleanupChoice: 'keep-files',
        projectId: 'project-alpha',
      }),
      subsystem.retirement.retryProjectCleanup('project-alpha'),
      guardedCloudBootstrap.startFormerHost({
        memberId: 'member-host',
        projectId: 'project-alpha',
        serverUrl: 'https://cloud.example.test/',
      }),
      guardedCloudBootstrap.submitParticipant({
        memberId: 'member-host',
        projectId: 'project-alpha',
        serverUrl: 'https://cloud.example.test/',
      } as never),
      guardedCloudBootstrap.cancel('project-alpha'),
      guardedMembership.createManagerResponsibilityOffer({
        projectId: 'project-alpha',
        purpose: 'manager-promotion',
        targetMemberId: 'member-target',
      }),
      guardedMembership.cancelManagerResponsibilityOffer({
        offerId: 'offer-one',
        projectId: 'project-alpha',
      }),
    ];
    for (const operation of blocked) {
      await expect(operation).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'lifecycle-owner-pending' },
      });
    }
    await expect(subsystem.hostTransfer.cancelHostTransfer({
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    })).resolves.toBeUndefined();
    await expect(subsystem.retirement.retireProject({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      projectId: 'project-alpha',
    })).resolves.toBeUndefined();
    expect(hostTransfer.createHostTransfer).not.toHaveBeenCalled();
    expect(hostTransfer.acceptHostTransfer).not.toHaveBeenCalled();
    expect(hostTransfer.declineHostTransfer).not.toHaveBeenCalled();
    expect(hostTransfer.cancelHostTransfer).toHaveBeenCalledTimes(1);
    expect(localExit.leaveProject).not.toHaveBeenCalled();
    expect(retirement.retireProject).toHaveBeenCalledTimes(1);
    expect(retirement.finalizeRetiredProject).not.toHaveBeenCalled();
    expect(retirement.retryProjectCleanup).not.toHaveBeenCalled();
    expect(cloudBootstrap.startFormerHost).not.toHaveBeenCalled();
    expect(cloudBootstrap.submitParticipant).not.toHaveBeenCalled();
    expect(cloudBootstrap.cancel).not.toHaveBeenCalled();
    expect(membership.createManagerResponsibilityOffer).not.toHaveBeenCalled();
    expect(membership.cancelManagerResponsibilityOffer).not.toHaveBeenCalled();
  });

  it('closes recovery producers before draining admitted Project operations', async () => {
    const closeRecovery = jest.fn().mockResolvedValue(undefined);
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      closeRecovery,
      recoveryStages: [],
    });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const admitted = subsystem.runExclusive(
      'project-alpha',
      'authority-transfer',
      'operation',
      () => blocked,
    );
    const queuedOperation = jest.fn().mockResolvedValue(undefined);
    const queued = subsystem.runExclusive(
      'project-alpha',
      'authority-transfer',
      'operation',
      queuedOperation,
    );
    await Promise.resolve();

    const closing = subsystem.lifecycleRecovery.close();
    await expect(subsystem.runExclusive(
      'project-beta',
      'retirement',
      'operation',
      async () => undefined,
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'lifecycle-subsystem-closed' },
    });
    expect(closeRecovery).toHaveBeenCalledTimes(1);
    release();
    await admitted;
    await queued;
    await closing;
    expect(queuedOperation).toHaveBeenCalledTimes(1);
    expect(closeRecovery).toHaveBeenCalledTimes(1);
  });

  it('closes recovery resources before draining an active recovery run', async () => {
    const closeRecovery = jest.fn().mockResolvedValue(undefined);
    let release!: () => void;
    let entered!: () => void;
    const stageEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const subsystem = new CollabProjectLifecycleSubsystem({
      ...ports(),
      closeRecovery,
      recoveryStages: [{
        name: 'authority-transfers',
        run: async () => {
          entered();
          await blocked;
        },
      }],
    });
    const recovering = subsystem.lifecycleRecovery.resume();
    await stageEntered;

    const closing = subsystem.lifecycleRecovery.close();
    await Promise.resolve();
    expect(closeRecovery).toHaveBeenCalledTimes(1);
    release();
    await recovering;
    await closing;

    expect(closeRecovery).toHaveBeenCalledTimes(1);
  });
});
