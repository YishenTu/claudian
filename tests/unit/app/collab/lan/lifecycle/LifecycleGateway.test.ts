import { COLLAB_CONTROL_OPERATION_BINDINGS } from '@/app/collab/lan/CollabControlOperationBindings';
import { LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS } from '@/app/collab/lan/LanCollabControlOperations';
import {
  ActiveLifecycleGateway,
  LIFECYCLE_OPERATION_POLICIES,
  TerminalLifecycleGateway,
} from '@/app/collab/lan/lifecycle/LifecycleGateway';

const CREDENTIAL = 'A'.repeat(43);

describe('LifecycleGateway', () => {
  it('declares one exhaustive security and admission policy for all operations', () => {
    expect(Object.keys(LIFECYCLE_OPERATION_POLICIES)).toEqual(
      LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS,
    );
    expect(LIFECYCLE_OPERATION_POLICIES).toEqual(Object.fromEntries(
      LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS.map(operation => [operation, {
        admission: COLLAB_CONTROL_OPERATION_BINDINGS[operation].admission,
        authentication: COLLAB_CONTROL_OPERATION_BINDINGS[operation].authentication,
      }]),
    ));
    expect(LIFECYCLE_OPERATION_POLICIES).toMatchObject({
      acknowledgeRetirement: { admission: 'terminal', authentication: 'terminal-member' },
      cancelHostTransfer: { admission: 'bypass', authentication: 'active-member' },
      getHostTransitions: { admission: 'bypass', authentication: 'public' },
      leaveProject: { admission: 'active', authentication: 'active-or-left' },
      retireProject: { admission: 'bypass', authentication: 'active-member' },
    });
  });

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

  it('fails closed when an operation is unavailable in the selected binding', async () => {
    const gateway = new ActiveLifecycleGateway({
      authenticateMemberCredential: jest.fn().mockResolvedValue({
        member: { id: 'member-a' },
      }),
    } as never);

    await expect(gateway.execute({
      credential: CREDENTIAL,
      operation: 'createHostTransfer',
      request: { projectId: 'project-a' },
    } as never)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'lifecycle-service-unavailable' },
    });
  });
});
