import {
  type ProjectRetirementActiveResourcesPort,
  type ProjectRetirementAdmissionPort,
  type ProjectRetirementAuthorityPort,
  ProjectRetirementCoordinator,
  type ProjectRetirementDeliveryPort,
  type ProjectRetirementTerminalPort,
} from '@/app/collab/retirement/ProjectRetirementCoordinator';

const RETIRED_AT = '2026-08-13T00:00:00.000Z';
const admitProjectLifecycle = <T>(
  _projectId: string,
  operation: () => Promise<T>,
): Promise<T> => operation();

describe('ProjectRetirementCoordinator', () => {
  it('acquires authority lifecycle ownership before quiescing the Project', async () => {
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    const authority: jest.Mocked<ProjectRetirementAuthorityPort> = {
      inspectDurableResult: jest.fn().mockResolvedValue(null),
      retire: jest.fn().mockResolvedValue({ projectId: 'project-a', retiredAt: RETIRED_AT }),
    };
    const projectLifecycleAdmission = async <T>(): Promise<T> => {
      throw new Error('competing lifecycle owner');
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      authority,
      { activate: jest.fn().mockResolvedValue(undefined) },
      { deliver: jest.fn().mockResolvedValue(undefined) },
      { teardown: jest.fn().mockResolvedValue(undefined) },
      projectLifecycleAdmission,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).rejects.toThrow('competing lifecycle owner');

    expect(admission.quiesceAndDrain).not.toHaveBeenCalled();
    expect(authority.retire).not.toHaveBeenCalled();
  });

  it('drains before terminal commit and exposes the tombstone before delivery or teardown', async () => {
    const order: string[] = [];
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn(async (_projectId: string) => { order.push('drain'); }),
      resume: jest.fn(async (_projectId: string) => undefined),
    };
    const authority: jest.Mocked<ProjectRetirementAuthorityPort> = {
      inspectDurableResult: jest.fn(async (_actorMemberId, _request) => null),
      retire: jest.fn(async (_actorMemberId, _request) => {
        order.push('commit');
        return { projectId: 'project-a', retiredAt: RETIRED_AT };
      }),
    };
    const terminal: jest.Mocked<ProjectRetirementTerminalPort> = {
      activate: jest.fn(async (_result) => { order.push('terminal'); }),
    };
    const delivery: jest.Mocked<ProjectRetirementDeliveryPort> = {
      deliver: jest.fn(async (_result) => { order.push('deliver'); }),
    };
    const active: jest.Mocked<ProjectRetirementActiveResourcesPort> = {
      teardown: jest.fn(async (_projectId) => { order.push('teardown'); }),
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      authority,
      terminal,
      delivery,
      active,
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).resolves.toEqual({ projectId: 'project-a', retiredAt: RETIRED_AT });

    expect(order).toEqual(['drain', 'commit', 'terminal', 'deliver', 'teardown']);
  });

  it('reopens admission only when authority retirement has not committed', async () => {
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn(async (_projectId) => undefined),
      resume: jest.fn(async (_projectId) => undefined),
    };
    const authority: jest.Mocked<ProjectRetirementAuthorityPort> = {
      inspectDurableResult: jest.fn(async (_actorMemberId, _request) => null),
      retire: jest.fn(async (_actorMemberId, _request) => {
        throw new Error('preflight failed');
      }),
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      authority,
      { activate: jest.fn(async (_result) => undefined) },
      { deliver: jest.fn(async (_result) => undefined) },
      { teardown: jest.fn(async (_projectId) => undefined) },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).rejects.toThrow('preflight failed');
    expect(admission.resume).toHaveBeenCalledWith('project-a');
  });

  it('never reopens active admission after a durable terminal tombstone', async () => {
    const result = { projectId: 'project-a', retiredAt: RETIRED_AT } as const;
    const order: string[] = [];
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn(async (_projectId) => { order.push('drain'); }),
      resume: jest.fn(async (_projectId) => { order.push('resume'); }),
    };
    const authority: jest.Mocked<ProjectRetirementAuthorityPort> = {
      inspectDurableResult: jest.fn(async (_actorMemberId, _request) => {
        order.push('inspect-terminal');
        return { matchesRequest: true, result };
      }),
      retire: jest.fn(async (_actorMemberId, _request) => {
        order.push('tombstone-written');
        throw new Error('authority checkpoint failed');
      }),
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      authority,
      { activate: jest.fn(async (_result) => { order.push('terminal'); }) },
      { deliver: jest.fn(async (_result) => { order.push('deliver'); }) },
      { teardown: jest.fn(async (_projectId) => { order.push('teardown'); }) },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).resolves.toEqual(result);

    expect(order).toEqual([
      'drain',
      'tombstone-written',
      'inspect-terminal',
      'terminal',
      'deliver',
      'teardown',
    ]);
    expect(admission.resume).not.toHaveBeenCalled();
  });

  it('tears down active authority even when local retirement delivery needs recovery', async () => {
    const result = { projectId: 'project-a', retiredAt: RETIRED_AT } as const;
    const teardown = jest.fn(async (_projectId: string) => undefined);
    const coordinator = new ProjectRetirementCoordinator(
      {
        quiesceAndDrain: jest.fn(async (_projectId: string) => undefined),
        resume: jest.fn(async (_projectId: string) => undefined),
      },
      {
        inspectDurableResult: jest.fn(async () => null),
        retire: jest.fn(async () => result),
      },
      { activate: jest.fn(async () => undefined) },
      { deliver: jest.fn(async () => { throw new Error('local cleanup failed'); }) },
      { teardown },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).resolves.toEqual(result);
    expect(teardown).toHaveBeenCalledWith('project-a');
  });

  it('does not wait for non-settling local delivery before active teardown', async () => {
    const result = { projectId: 'project-a', retiredAt: RETIRED_AT } as const;
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>(resolve => {
      releaseDelivery = resolve;
    });
    const teardown = jest.fn().mockResolvedValue(undefined);
    const coordinator = new ProjectRetirementCoordinator(
      {
        quiesceAndDrain: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
      },
      {
        inspectDurableResult: jest.fn().mockResolvedValue(null),
        retire: jest.fn().mockResolvedValue(result),
      },
      { activate: jest.fn().mockResolvedValue(undefined) },
      { deliver: jest.fn(() => delivery) },
      { teardown },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).resolves.toEqual(result);

    expect(teardown).toHaveBeenCalledWith('project-a');
    releaseDelivery();
    await delivery;
  });

  it('fails closed when terminal durability cannot be determined', async () => {
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn(async (_projectId) => undefined),
      resume: jest.fn(async (_projectId) => undefined),
    };
    const authority: jest.Mocked<ProjectRetirementAuthorityPort> = {
      inspectDurableResult: jest.fn(async (_actorMemberId, _request) => {
        throw new Error('terminal storage unavailable');
      }),
      retire: jest.fn(async (_actorMemberId, _request) => {
        throw new Error('retirement failed');
      }),
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      authority,
      { activate: jest.fn(async (_result) => undefined) },
      { deliver: jest.fn(async (_result) => undefined) },
      { teardown: jest.fn(async (_projectId) => undefined) },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).rejects.toThrow('terminal storage unavailable');
    expect(admission.resume).not.toHaveBeenCalled();
  });

  it('terminalizes a competing durable Retire without replaying it as this caller\'s result', async () => {
    const result = { projectId: 'project-a', retiredAt: RETIRED_AT } as const;
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn(async (_projectId) => undefined),
      resume: jest.fn(async (_projectId) => undefined),
    };
    const terminal: jest.Mocked<ProjectRetirementTerminalPort> = {
      activate: jest.fn(async (_result) => undefined),
    };
    const authority: jest.Mocked<ProjectRetirementAuthorityPort> = {
      inspectDurableResult: jest.fn(async (_actorMemberId, _request) => ({ matchesRequest: false, result })),
      retire: jest.fn(async (_actorMemberId, _request) => {
        throw new Error('retired by another operation');
      }),
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      authority,
      terminal,
      { deliver: jest.fn(async (_result) => undefined) },
      { teardown: jest.fn(async (_projectId) => undefined) },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).rejects.toThrow('retired by another operation');
    expect(terminal.activate).toHaveBeenCalledWith(result);
    expect(admission.resume).not.toHaveBeenCalled();
  });

  it('keeps admission closed when terminal activation itself needs retry', async () => {
    const result = { projectId: 'project-a', retiredAt: RETIRED_AT } as const;
    const admission: jest.Mocked<ProjectRetirementAdmissionPort> = {
      quiesceAndDrain: jest.fn(async (_projectId) => undefined),
      resume: jest.fn(async (_projectId) => undefined),
    };
    const coordinator = new ProjectRetirementCoordinator(
      admission,
      {
        inspectDurableResult: jest.fn(async (_actorMemberId, _request) => ({
          matchesRequest: true,
          result,
        })),
        retire: jest.fn(async (_actorMemberId, _request) => result),
      },
      { activate: jest.fn(async (_result) => { throw new Error('terminal bind failed'); }) },
      { deliver: jest.fn(async (_result) => undefined) },
      { teardown: jest.fn(async (_projectId) => undefined) },
      admitProjectLifecycle,
    );

    await expect(coordinator.retire('member-manager', {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      idempotencyKey: 'retire-one',
      operationId: 'retire-one',
      projectId: 'project-a',
      requestFingerprint: 'a'.repeat(64),
    })).rejects.toThrow('terminal bind failed');
    expect(admission.resume).not.toHaveBeenCalled();
  });
});
