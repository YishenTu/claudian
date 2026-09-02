import type { CollabAuthorityTransferStatus } from '@claudian-collab/protocol';

import { AuthorityTransferEntryService } from '@/app/collab/authority-transfer/AuthorityTransferEntryService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-entry-service';
const SERVER_URL = 'http://cloud.example.test:4400/base';

function status(
  state: 'active' | 'cancelled' | 'completed' = 'active',
): CollabAuthorityTransferStatus {
  return {
    batchRevision: state === 'completed' ? 1 : null,
    batchSha256: state === 'completed' ? 'b'.repeat(64) : null,
    checkpointSha256: state === 'completed' ? 'a'.repeat(64) : null,
    createdAt: '2026-09-02T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: '2026-10-02T00:00:00.000Z',
    phase: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'collecting-readiness',
    projectId: PROJECT_ID,
    relinquishmentProof: null,
    sourceAuthority: { generation: 7, kind: 'lan' },
    state,
    targetAuthority: { generation: 8, kind: 'cloud' },
    targetUrl: SERVER_URL,
    transferId: 'transfer-entry-service',
    updatedAt: '2026-09-02T00:00:01.000Z',
  } as CollabAuthorityTransferStatus;
}

function lanMembership() {
  return {
    authority: {
      authorityGeneration: 7,
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: `https://192.168.1.10:54545/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: 'test-ca',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan' as const,
    },
    createdAt: '2026-09-02T00:00:00.000Z',
    hostOwnership: { ownsAuthority: true },
    lastEventSequence: 1,
    member: {
      credential: Buffer.alloc(32, 1).toString('base64url'),
      displayName: 'Host',
      id: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      role: 'manager' as const,
    },
    project: { id: PROJECT_ID, name: 'Entry', workspacePath: 'workspace/entry' },
    schemaVersion: 3 as const,
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

function createSubject(options: Readonly<{
  loadMembership?: () => Promise<ReturnType<typeof lanMembership>>;
}> = {}) {
  const requester = {
    propose: jest.fn(async () => status()),
    resumeMatching: jest.fn(async () => null),
    resume: jest.fn(async () => {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-requester-entry-missing' },
      });
    }),
  };
  const sourceBinding = { dispose: jest.fn(async () => undefined) };
  const module = {
    acceptCloudToLanTransfer: jest.fn(),
    acceptLanToCloudTransferTarget: jest.fn(async () => status('completed')),
    assertLanToCloudSourceInstallationOwner: jest.fn(async () => undefined),
    beginCloudToLanTransfer: jest.fn(),
    bindLanToCloudSource: jest.fn(async () => sourceBinding),
    cancelCloudToLanTransfer: jest.fn(),
    cancelLanToCloudTransfer: jest.fn(async () => status('cancelled')),
    close: jest.fn(async () => undefined),
    createLanToCloudRequester: jest.fn(() => requester),
    observeCloudToLanTransfer: jest.fn(),
    prepareCloudToLanTarget: jest.fn(),
    readLanToCloudTransfer: jest.fn(async () => ({
      entryRole: 'source',
      proposedByMemberId: 'member-host',
      request: {
        expectedAuthorityGeneration: 7,
        idempotencyKey: 'intent-proposal',
        projectId: PROJECT_ID,
        targetUrl: SERVER_URL,
      },
      status: status(),
    })),
    readLanToCloudSourceProposal: jest.fn(async () => ({
      proposedByMemberId: 'member-host',
      request: {
        expectedAuthorityGeneration: 7,
        idempotencyKey: 'intent-proposal',
        projectId: PROJECT_ID,
        targetUrl: SERVER_URL,
      },
      status: status(),
    })),
    redeemManagerReissuedClaim: jest.fn(),
    withdrawCloudToLanTarget: jest.fn(),
  };
  const connection = {
    dispose: jest.fn(),
    projectId: PROJECT_ID,
    serverUrl: SERVER_URL,
    supports: jest.fn(() => true),
  };
  const createLanClient = jest.fn(() => ({ kind: 'lan-client' }));
  const connectCloud = jest.fn(async (
    _input?: unknown,
    _options?: { readonly signal?: AbortSignal },
  ) => connection);
  const service = new AuthorityTransferEntryService({
    connectCloud: connectCloud as never,
    createIdempotencyKey: () => 'intent-new',
    createLanClient: createLanClient as never,
    loadMembership: options.loadMembership ?? (async () => lanMembership()),
    module: module as never,
  });
  return {
    connection,
    connectCloud,
    createLanClient,
    module,
    requester,
    service,
    sourceBinding,
  };
}

describe('AuthorityTransferEntryService', () => {
  it('derives LAN trust and generation while preserving the entered Cloud URL', async () => {
    const subject = createSubject();

    await expect(subject.service.proposeLanToCloudTransfer({
      projectId: PROJECT_ID,
      serverUrl: SERVER_URL,
    })).resolves.toEqual(status());

    expect(subject.createLanClient).toHaveBeenCalledWith({
      caCertificatePem: 'test-ca',
      caFingerprint: 'a'.repeat(64),
      endpoint: 'https://192.168.1.10:54545',
      projectId: PROJECT_ID,
    });
    expect(subject.module.createLanToCloudRequester).toHaveBeenCalledWith({
      lanClient: { kind: 'lan-client' },
      memberCredential: lanMembership().member.credential,
      memberId: 'member-host',
      projectId: PROJECT_ID,
    });
    expect(subject.requester.resumeMatching).toHaveBeenCalledWith({
      expectedAuthorityGeneration: 7,
      projectId: PROJECT_ID,
      targetUrl: SERVER_URL,
    }, {});
    expect(subject.requester.propose).toHaveBeenCalledWith({
      expectedAuthorityGeneration: 7,
      idempotencyKey: 'intent-new',
      projectId: PROJECT_ID,
      targetUrl: SERVER_URL,
    }, {});
  });

  it('reconciles a stale cancelled requester before proposing a different target', async () => {
    const subject = createSubject();
    subject.requester.resumeMatching.mockResolvedValue(null);

    await subject.service.proposeLanToCloudTransfer({
      projectId: PROJECT_ID,
      serverUrl: 'https://replacement.example.test/',
    });

    expect(subject.requester.resume).not.toHaveBeenCalled();
    expect(subject.requester.propose).toHaveBeenCalledWith(expect.objectContaining({
      targetUrl: 'https://replacement.example.test/',
    }), {});
  });

  it('maps the durable source proposal to the UI-safe view', async () => {
    const { service } = createSubject();

    await expect(service.readLanToCloudTransfer(PROJECT_ID)).resolves.toEqual({
      proposedByMemberId: 'member-host',
      serverUrl: SERVER_URL,
      sourceOwned: true,
      status: status(),
    });
  });

  it('projects a requester intent before the LAN Host response is known', async () => {
    const subject = createSubject();
    subject.module.readLanToCloudTransfer.mockResolvedValue({
      entryRole: 'requester',
      proposedByMemberId: 'member-host',
      request: {
        expectedAuthorityGeneration: 7,
        idempotencyKey: 'intent-proposal',
        projectId: PROJECT_ID,
        targetUrl: SERVER_URL,
      },
      status: null,
    } as never);

    await expect(subject.service.readLanToCloudTransfer(PROJECT_ID)).resolves.toEqual({
      proposedByMemberId: 'member-host',
      serverUrl: SERVER_URL,
      sourceOwned: false,
      status: null,
    });
  });

  it('retains and reuses the exact Cloud binding after an ambiguous accept', async () => {
    const subject = createSubject();
    subject.module.acceptLanToCloudTransferTarget
      .mockRejectedValueOnce(new CollabError({ code: 'operation-failed' }))
      .mockResolvedValueOnce(status('completed'));

    const selection = { projectId: PROJECT_ID, transferId: 'transfer-entry-service' };
    await expect(subject.service.acceptLanToCloudTransfer(selection)).rejects.toBeInstanceOf(
      CollabError,
    );
    expect(subject.connection.dispose).not.toHaveBeenCalled();
    expect(subject.sourceBinding.dispose).not.toHaveBeenCalled();

    await expect(subject.service.acceptLanToCloudTransfer(selection)).resolves.toEqual(
      status('completed'),
    );
    expect(subject.connectCloud).toHaveBeenCalledTimes(1);
    expect(subject.module.bindLanToCloudSource).not.toHaveBeenCalled();
    expect(subject.module.acceptLanToCloudTransferTarget).toHaveBeenLastCalledWith(
      {
        expectedAuthorityGeneration: 7,
        idempotencyKey: expect.stringMatching(/^authority-transfer-accept-/u),
        projectId: PROJECT_ID,
        targetUrl: SERVER_URL,
        transferId: 'transfer-entry-service',
      },
      {
        cloudSession: subject.connection,
        expectedSourceEndpoint: 'https://192.168.1.10:54545',
        expectedTargetUrl: SERVER_URL,
        projectId: PROJECT_ID,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(subject.sourceBinding.dispose).not.toHaveBeenCalled();
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a copied foreign Host installation before opening a Cloud session', async () => {
    const subject = createSubject();
    subject.module.assertLanToCloudSourceInstallationOwner.mockRejectedValue(
      new CollabError({ code: 'authorization-denied' }),
    );

    await expect(subject.service.acceptLanToCloudTransfer({
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    })).rejects.toMatchObject({ code: 'authorization-denied' });

    expect(subject.connectCloud).not.toHaveBeenCalled();
    expect(subject.module.acceptLanToCloudTransferTarget).not.toHaveBeenCalled();
  });

  it('coalesces concurrent source acceptance onto one retained Cloud session', async () => {
    const subject = createSubject();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enteredCloud = new Promise<void>(resolve => { entered = resolve; });
    subject.connectCloud.mockImplementation(async () => {
      entered();
      await gate;
      return subject.connection;
    });
    subject.module.acceptLanToCloudTransferTarget.mockResolvedValue(status());
    const selection = { projectId: PROJECT_ID, transferId: 'transfer-entry-service' };

    const first = subject.service.acceptLanToCloudTransfer(selection);
    const second = subject.service.acceptLanToCloudTransfer(selection);
    await enteredCloud;
    expect(subject.connectCloud).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([status(), status()]);
    expect(subject.module.acceptLanToCloudTransferTarget).toHaveBeenCalledTimes(1);
    await subject.service.close();
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancels only a follower wait without cancelling the shared acceptance', async () => {
    const subject = createSubject();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enteredCloud = new Promise<void>(resolve => { entered = resolve; });
    subject.connectCloud.mockImplementation(async () => {
      entered();
      await gate;
      return subject.connection;
    });
    subject.module.acceptLanToCloudTransferTarget.mockResolvedValue(status());
    const selection = { projectId: PROJECT_ID, transferId: 'transfer-entry-service' };
    const first = subject.service.acceptLanToCloudTransfer(selection);
    await enteredCloud;
    const controller = new AbortController();
    const follower = subject.service.acceptLanToCloudTransfer(
      selection,
      { signal: controller.signal },
    );

    controller.abort();
    await expect(follower).rejects.toMatchObject({ code: 'cancelled' });
    expect(subject.module.acceptLanToCloudTransferTarget).not.toHaveBeenCalled();

    release();
    await expect(first).resolves.toEqual(status());
    expect(subject.module.acceptLanToCloudTransferTarget).toHaveBeenCalledTimes(1);
  });

  it('aborts the shared acceptance lifetime on close without borrowing caller cancellation', async () => {
    const subject = createSubject();
    let entered!: () => void;
    const enteredAcceptance = new Promise<void>(resolve => { entered = resolve; });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let underlyingQuiesced = false;
    subject.module.acceptLanToCloudTransferTarget.mockImplementation((...args: readonly unknown[]) => {
      const options = args[2] as { readonly signal?: AbortSignal } | undefined;
      entered();
      return new Promise<CollabAuthorityTransferStatus>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          void cleanupGate.then(() => {
            underlyingQuiesced = true;
            reject(new CollabError({ code: 'cancelled' }));
          });
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const accepting = subject.service.acceptLanToCloudTransfer(
      { projectId: PROJECT_ID, transferId: 'transfer-entry-service' },
      { signal: controller.signal },
    );
    await enteredAcceptance;

    const serviceSignal = subject.connectCloud.mock.calls[0]?.[1]?.signal;
    expect(serviceSignal).toBeDefined();
    expect(serviceSignal).not.toBe(controller.signal);
    controller.abort();
    await expect(accepting).rejects.toMatchObject({ code: 'cancelled' });
    expect(serviceSignal?.aborted).toBe(false);

    const closing = subject.service.close();
    expect(serviceSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(subject.module.close).not.toHaveBeenCalled();
    releaseCleanup();
    await expect(closing).resolves.toBeUndefined();
    expect(underlyingQuiesced).toBe(true);
    expect(subject.module.close).toHaveBeenCalledTimes(1);
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not cross the preflight read fence after close begins', async () => {
    let releaseMembership!: () => void;
    let enteredMembership!: () => void;
    const membershipGate = new Promise<void>(resolve => { releaseMembership = resolve; });
    const membershipStarted = new Promise<void>(resolve => { enteredMembership = resolve; });
    const subject = createSubject({
      loadMembership: async () => {
        enteredMembership();
        await membershipGate;
        return lanMembership();
      },
    });
    const accepting = subject.service.acceptLanToCloudTransfer({
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    });
    await membershipStarted;

    const closing = subject.service.close();
    releaseMembership();

    await expect(accepting).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-entry-service-closed' },
    });
    await expect(closing).resolves.toBeUndefined();
    expect(subject.module.assertLanToCloudSourceInstallationOwner).not.toHaveBeenCalled();
    expect(subject.connectCloud).not.toHaveBeenCalled();
    expect(subject.module.acceptLanToCloudTransferTarget).not.toHaveBeenCalled();
  });

  it('closes a source session that finishes connecting during shutdown', async () => {
    const subject = createSubject();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enteredCloud = new Promise<void>(resolve => { entered = resolve; });
    subject.connectCloud.mockImplementation(async () => {
      entered();
      await gate;
      return subject.connection;
    });
    const accepting = subject.service.acceptLanToCloudTransfer({
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    });
    await enteredCloud;

    const closing = subject.service.close();
    release();

    await expect(accepting).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-entry-service-closed' },
    });
    await expect(closing).resolves.toBeUndefined();
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
    expect(subject.module.acceptLanToCloudTransferTarget).not.toHaveBeenCalled();
  });

  it('rejects an accept when the displayed proposal was replaced before the click', async () => {
    const subject = createSubject();
    subject.module.readLanToCloudSourceProposal.mockResolvedValue({
      proposedByMemberId: 'member-other',
      request: {
        expectedAuthorityGeneration: 7,
        idempotencyKey: 'intent-replacement',
        projectId: PROJECT_ID,
        targetUrl: 'https://replacement.example.test/',
      },
      status: {
        ...status(),
        targetUrl: 'https://replacement.example.test/',
        transferId: 'transfer-replacement',
      },
    });

    await expect(subject.service.acceptLanToCloudTransfer({
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    } as never)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-source-proposal-stale' },
    });

    expect(subject.connectCloud).not.toHaveBeenCalled();
    expect(subject.module.acceptLanToCloudTransferTarget).not.toHaveBeenCalled();
  });

  it('cancels the exact durable proposal and releases a retained binding', async () => {
    const subject = createSubject();
    subject.module.acceptLanToCloudTransferTarget.mockRejectedValue(
      new CollabError({ code: 'operation-failed' }),
    );
    const selection = { projectId: PROJECT_ID, transferId: 'transfer-entry-service' };
    await expect(subject.service.acceptLanToCloudTransfer(selection)).rejects.toBeDefined();

    await expect(subject.service.cancelLanToCloudTransfer(selection)).resolves.toEqual(
      status('cancelled'),
    );

    expect(subject.module.cancelLanToCloudTransfer).toHaveBeenCalledWith({
      expectedAuthorityGeneration: 7,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: expect.stringMatching(/^authority-transfer-cancel-/u),
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    });
    expect(subject.sourceBinding.dispose).not.toHaveBeenCalled();
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the Cloud endpoint did not negotiate authority transfer', async () => {
    const subject = createSubject();
    subject.connection.supports.mockReturnValue(false);

    await expect(subject.service.acceptLanToCloudTransfer({
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-cloud-capability-unavailable' },
    });
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
    expect(subject.module.bindLanToCloudSource).not.toHaveBeenCalled();
  });

  it('closes the durable module before releasing retained Cloud sessions', async () => {
    const subject = createSubject();
    subject.module.acceptLanToCloudTransferTarget.mockRejectedValue(
      new CollabError({ code: 'operation-failed' }),
    );
    await expect(subject.service.acceptLanToCloudTransfer({
      projectId: PROJECT_ID,
      transferId: 'transfer-entry-service',
    })).rejects.toBeDefined();

    await subject.service.close();

    expect(subject.module.close).toHaveBeenCalledTimes(1);
    expect(subject.connection.dispose).toHaveBeenCalledTimes(1);
  });
});
