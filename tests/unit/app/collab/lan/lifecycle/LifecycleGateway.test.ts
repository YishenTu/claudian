import {
  ActiveLifecycleGateway,
  TerminalLifecycleGateway,
} from '@/app/collab/lan/lifecycle/LifecycleGateway';

const CREDENTIAL = 'A'.repeat(43);

describe('LifecycleGateway', () => {
  it.each([
    ['leaveProject', 'administration', 'leaveProject'],
    ['createManagerResponsibilityOffer', 'lifecycle', 'createManagerResponsibilityOffer'],
    ['getCurrentManagerResponsibilityOffer', 'lifecycle', 'getCurrentManagerResponsibilityOffer'],
    ['getManagerResponsibilityOffer', 'lifecycle', 'getManagerResponsibilityOffer'],
    ['acknowledgeManagerResponsibility', 'lifecycle', 'acknowledgeManagerResponsibility'],
    ['declineManagerResponsibility', 'lifecycle', 'declineManagerResponsibility'],
    ['cancelManagerResponsibilityOffer', 'lifecycle', 'cancelManagerResponsibilityOffer'],
    ['promoteManager', 'administration', 'promoteManager'],
    ['demoteManager', 'administration', 'demoteManager'],
    ['createHostTransfer', 'lifecycle', 'createHostTransfer'],
    ['acceptHostTransfer', 'lifecycle', 'acceptHostTransfer'],
    ['declineHostTransfer', 'lifecycle', 'declineHostTransfer'],
    ['cancelHostTransfer', 'lifecycle', 'cancelHostTransfer'],
    ['retireProject', 'lifecycle', 'retireProject'],
  ] as const)('dispatches active operation %s through its typed owner', async (
    operation,
    owner,
    method,
  ) => {
    const handler = jest.fn().mockResolvedValue({ operation });
    const gateway = new ActiveLifecycleGateway({
      administration: owner === 'administration' ? { [method]: handler } : undefined,
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-a' },
      }),
      lifecycle: owner === 'lifecycle' ? { [method]: handler } : undefined,
    } as never);
    const request = { projectId: 'project-a' };

    await expect(gateway.execute({
      credential: CREDENTIAL,
      operation,
      request,
    } as never)).resolves.toEqual({ data: { operation } });
    expect(handler).toHaveBeenCalledWith('member-a', request);
  });

  it('authenticates Leave as active-or-left while retaining ordinary active admission', async () => {
    const authenticate = jest.fn().mockResolvedValue({ member: { id: 'member-a' } });
    const leaveProject = jest.fn().mockResolvedValue({ status: 'left' });
    const run = jest.fn(async operation => operation());
    const gateway = new ActiveLifecycleGateway({
      admission: { run },
      administration: { leaveProject },
      authenticateMemberCredential: authenticate,
    } as never);
    const request = {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'leave-a',
      idempotencyManagerMemberId: null,
      projectId: 'project-a',
    };

    await expect(gateway.execute({
      credential: CREDENTIAL,
      operation: 'leaveProject',
      request,
    })).resolves.toEqual({ data: { status: 'left' } });

    expect(run).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith(CREDENTIAL, ['active', 'left']);
    expect(leaveProject).toHaveBeenCalledWith('member-a', request);
  });

  it.each([
    ['cancelHostTransfer', 'cancelHostTransfer'],
    ['retireProject', 'retireProject'],
  ] as const)('bypasses active admission for %s only inside the gateway', async (
    operation,
    method,
  ) => {
    const lifecycle = { [method]: jest.fn().mockResolvedValue({ operation }) };
    const run = jest.fn();
    const gateway = new ActiveLifecycleGateway({
      admission: { run },
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-host' },
      }),
      lifecycle,
    } as never);

    await expect(gateway.execute({
      credential: CREDENTIAL,
      operation,
      request: { projectId: 'project-a' },
    } as never)).resolves.toEqual({ data: { operation } });
    expect(run).not.toHaveBeenCalled();
  });

  it('serves public transition proofs without authentication or admission', async () => {
    const getHostTransitions = jest.fn().mockResolvedValue({
      projectId: 'project-a',
      proofs: [],
    });
    const authenticate = jest.fn();
    const run = jest.fn();
    const gateway = new ActiveLifecycleGateway({
      admission: { run },
      authenticateMemberCredential: authenticate,
      lifecycle: { getHostTransitions },
    } as never);

    await expect(gateway.execute({
      credential: null,
      operation: 'getHostTransitions',
      request: { projectId: 'project-a' },
    })).resolves.toEqual({ data: { projectId: 'project-a', proofs: [] } });
    expect(authenticate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves deferred Host-transfer callbacks without invoking them', async () => {
    const afterResponseFlushed = jest.fn();
    const afterResponseSettled = jest.fn();
    const gateway = new ActiveLifecycleGateway({
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-target' },
      }),
      lifecycle: {
        acceptHostTransfer: jest.fn().mockResolvedValue({
          afterResponseFlushed,
          afterResponseSettled,
          response: { phase: 'accepted' },
        }),
      },
    } as never);

    await expect(gateway.execute({
      credential: CREDENTIAL,
      operation: 'acceptHostTransfer',
      request: { projectId: 'project-a' },
    } as never)).resolves.toEqual({
      afterResponseFlushed,
      afterResponseSettled,
      data: { phase: 'accepted' },
    });
    expect(afterResponseFlushed).not.toHaveBeenCalled();
    expect(afterResponseSettled).not.toHaveBeenCalled();
  });

  it('binds terminal acknowledgement and proof operations without an active service bag', async () => {
    const afterResponseFlushed = jest.fn();
    const terminal = {
      acknowledgeRetirement: jest.fn().mockResolvedValue({
        afterResponseFlushed,
        response: { projectId: 'project-a' },
      }),
      getHostTransitions: jest.fn().mockResolvedValue({ projectId: 'project-a', proofs: [] }),
    };
    const gateway = new TerminalLifecycleGateway(terminal as never);

    await expect(gateway.execute({
      credential: CREDENTIAL,
      operation: 'acknowledgeRetirement',
      request: { projectId: 'project-a' },
    } as never)).resolves.toEqual({
      afterResponseFlushed,
      data: { projectId: 'project-a' },
    });
    await expect(gateway.execute({
      credential: null,
      operation: 'getHostTransitions',
      request: { projectId: 'project-a' },
    })).resolves.toEqual({ data: { projectId: 'project-a', proofs: [] } });
    expect(terminal.acknowledgeRetirement).toHaveBeenCalledWith(
      CREDENTIAL,
      { projectId: 'project-a' },
    );
  });
});
