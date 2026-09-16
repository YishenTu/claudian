import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabLocalProjectRepository, isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { decodeCloudManagementIntent } from '@/app/collab/membership/CloudManagementIntent';
import { CollabMembershipService } from '@/app/collab/membership/CollabMembershipService';
import { ManagerResponsibilityOperationCoordinator } from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { decodeProjectRecoveryInvitation } from '@/app/collab/project/ProjectRecoveryInvitation';
import type { CollabAuthorityMembershipRouterPort } from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const projectId = 'project-alpha';
const now = '2026-09-02T00:00:00.000Z';
const expiresAt = '2026-09-02T00:15:00.000Z';

let root: string;
let projects: CollabLocalProjectRepository;

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
  root = await mkdtemp(path.join(tmpdir(), 'claudian-invitation-operation-'));
  projects = new CollabLocalProjectRepository(root);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function setup(kind: 'lan' | 'cloud') {
  const shared = {
    schemaVersion: 3 as const, createdAt: now, updatedAt: now,
    lastEventSequence: 0, lifecycle: 'active' as const,
    project: { id: projectId, name: 'Alpha', workspacePath: 'Projects/alpha' },
    member: {
      displayName: 'Alice', id: 'member-alice', role: 'manager' as const,
      personalRef: 'refs/heads/members/member-alice',
    },
  };
  await projects.saveMembership(kind === 'cloud' ? {
    ...shared,
    authority: {
      kind, authorityGeneration: 7, bindingVersion: 10, wireVersion: 15,
      serverUrl: 'https://cloud.example',
      gitRemoteUrl: 'https://cloud.example/v10/projects/project-alpha/repository.git',
    },
  } : {
    ...shared,
    authority: {
      kind, authorityGeneration: 1, endpoint: null,
      gitRemoteUrl: null, hostCaCertificatePem: null, hostCaFingerprint: null,
    },
    member: { ...shared.member, credential: 'A'.repeat(43) },
    hostOwnership: { ownsAuthority: false },
  });
  let count = 0;
  const cloudReplies = new Map<string, unknown>();
  const control = {
    membership: jest.fn(async () => ({ encodedInvitation: `lan-invitation-${++count}`, expiresAt })),
    cloudMembership: jest.fn(async (operation, request) => {
      if (operation === 'listProjectMembers') return {
        projectId, managerSetGeneration: 1, authorityGeneration: 7,
        members: [{
          memberId: 'member-alice', displayName: 'Alice', role: 'manager', status: 'active',
          membershipRevision: 1,
        }],
      };
      if (operation === 'createProjectRecoveryLink') {
        if (!cloudReplies.has(request.idempotencyKey)) cloudReplies.set(request.idempotencyKey, {
          projectId, authorityGeneration: 7, recoveryLinkId: `recovery-${++count}`, token: String(count).padStart(64, '0'),
          expiresAt, secretReplayExpiresAt: '2026-09-02T00:10:00.000Z',
        });
        return cloudReplies.get(request.idempotencyKey);
      }
      if (operation !== 'createProjectInvitation') throw new Error(`Unexpected operation: ${operation}`);
      if (!cloudReplies.has(request.idempotencyKey)) cloudReplies.set(request.idempotencyKey, {
        projectId, invitationId: `invitation-${++count}`, secret: 'A'.repeat(43),
        createdAt: now, expiresAt: '2026-09-03T00:00:00.000Z',
        secretReplayExpiresAt: '2026-10-02T00:00:00.000Z', issuedState: 'active',
      });
      return cloudReplies.get(request.idempotencyKey);
    }),
  } as unknown as jest.Mocked<CollabAuthorityMembershipRouterPort>;
  const createService = () => new CollabMembershipService(control, {
    readAuthoritySnapshot: jest.fn().mockResolvedValue({
      source: 'online', stale: false, snapshot: {
        currentMember: shared.member, project: { authorityKind: 'cloud', authorityGeneration: 7 },
      },
    }), readCoordinationSnapshot: jest.fn(),
  }, {}, {
    projects,
    cloudManagementAdmission: async (_id, run) => run(),
    importedClaimCloudManagementAdmission: async (_id, _identity, run) => run(),
    managerLeaveCloudManagementAdmission: async (_id, run) => run(),
    managerResponsibilityAdmission: async (_id, run) => run(),
    managerResponsibilityOperations: new ManagerResponsibilityOperationCoordinator(),
    managerReceipts: {
      load: async () => null, remove: async () => false,
      save: async () => undefined, saveCloud: async () => undefined,
    },
    pendingLeaves: { load: async () => null },
  });
  return { service: createService(), control, createService };
}

async function storePending() {
  await projects.saveProjectDocument(projectId, 'cloud-management-intent', decodeCloudManagementIntent({
    schemaVersion: 1, kind: 'cloud-management-intent', projectId,
    authorityGeneration: 7, memberId: 'member-alice', serverUrl: 'https://cloud.example',
    response: null, completionId: 'completion-existing', operation: 'createProjectInvitation', phase: 'submitted',
    createdAt: now, updatedAt: now,
    request: { projectId, expectedManagerSetGeneration: 1, idempotencyKey: 'existing-key' },
  }));
}

describe('application-owned invitation operation', () => {
  it('creates a fresh generic recovery link after close while retaining an exact result for clipboard retry', async () => {
    const { service, createService } = await setup('cloud');
    const first = service.openInvitation({ projectId, intent: 'create', purpose: 'recovery' });
    const initial = await first.run();
    expect(initial.status).toBe('ready');
    expect(await first.read()).toEqual(initial);
    first.dispose();
    const resumed = createService().openInvitation({ projectId, intent: 'resume', purpose: 'recovery' });
    expect(await resumed.run()).toEqual(initial);
    await resumed.acknowledge();
    resumed.dispose();
    const next = service.openInvitation({ projectId, intent: 'create', purpose: 'recovery' });
    const result = await next.run();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready' || initial.status !== 'ready') throw new Error('Expected links');
    expect(result.invitation.encodedInvitation).not.toBe(initial.invitation.encodedInvitation);
    expect(decodeProjectRecoveryInvitation(result.invitation.encodedInvitation)).toMatchObject({
      target: { kind: 'cloud', serverUrl: 'https://cloud.example' }, link: { projectId, authorityGeneration: 7 },
    });
    next.dispose();
  });
  it.each(['lan', 'cloud'] as const)('creates independent %s links across closed operations', async kind => {
    const { service } = await setup(kind);
    const first = service.openInvitation({ projectId, intent: 'create' });
    const initial = await first.run();
    expect(initial.status).toBe('ready');
    first.dispose();
    const second = service.openInvitation({ projectId, intent: 'create' });
    const next = await second.run();
    expect(next.status).toBe('ready');
    expect(next).not.toEqual(initial);
    second.dispose();
  });

  it('retains the LAN request key across response loss', async () => {
    const { service, control } = await setup('lan');
    control.membership.mockRejectedValueOnce(new Error('response lost'));
    const operation = service.openInvitation({ projectId, intent: 'create' });
    await expect(operation.run()).rejects.toThrow();
    await expect(operation.run()).resolves.toMatchObject({ status: 'ready' });
    const requests = control.membership.mock.calls.map(([, request]) => request);
    expect(requests[1]).toEqual(requests[0]);
    operation.dispose();
  });

  it('resumes persisted Cloud creation and completes only after acknowledgement', async () => {
    const { service } = await setup('cloud');
    await storePending();
    const operation = service.openInvitation({ projectId, intent: 'resume' });
    const ready = await operation.run();
    expect(ready.status).toBe('ready');
    await expect(service.readManagementOperation(projectId)).resolves.toMatchObject({ status: 'result-retained' });
    await expect(operation.read()).resolves.toEqual(ready);
    await operation.acknowledge();
    await expect(service.readManagementOperation(projectId)).resolves.toBeNull();
    await expect(operation.read()).resolves.toEqual(ready);
    operation.dispose();
  });

  it('offers explicit creation when Resume no longer has a request', async () => {
    const { service, control } = await setup('cloud');
    const operation = service.openInvitation({ projectId, intent: 'resume' });
    await expect(operation.run()).resolves.toEqual({ status: 'unavailable', reason: 'unavailable' });
    expect(control.cloudMembership).not.toHaveBeenCalled();
    operation.dispose();
  });

  it('does not expose or act on a disposed operation', async () => {
    const { service } = await setup('cloud');
    const operation = service.openInvitation({ projectId, intent: 'create' });
    operation.dispose();
    await expect(operation.run()).rejects.toBeInstanceOf(CollabError);
    await expect(operation.read()).rejects.toBeInstanceOf(CollabError);
  });
  it('recovers a lost Cloud response after recreating the application owner', async () => {
    const { service, control, createService } = await setup('cloud');
    const execute = control.cloudMembership.getMockImplementation()!;
    let loseResponse = true;
    control.cloudMembership.mockImplementation(async (...args) => {
      const response = await execute(...args);
      if (args[0] === 'createProjectInvitation' && loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return response;
    });
    const first = service.openInvitation({ projectId, intent: 'create' });
    await expect(first.run()).rejects.toThrow();
    first.dispose();
    const restored = createService().openInvitation({ projectId, intent: 'resume' });
    await expect(restored.run()).resolves.toMatchObject({ status: 'ready' });
    const requests = control.cloudMembership.mock.calls.filter(([name]) => name === 'createProjectInvitation');
    expect(requests).toHaveLength(2);
    expect(requests[1][1]).toEqual(requests[0][1]);
    restored.dispose();
  });

  it.each(['create', 'resume'] as const)('does not redirect a failed Cloud %s retry to a replacement request', async intent => {
    const { service, control } = await setup('cloud');
    if (intent === 'resume') await storePending();
    const execute = control.cloudMembership.getMockImplementation()!;
    let loseResponse = true;
    control.cloudMembership.mockImplementation(async (...args) => {
      const response = await execute(...args);
      if (args[0] === 'createProjectInvitation' && loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return response;
    });
    const older = service.openInvitation({ projectId, intent });
    await expect(older.run()).rejects.toThrow();
    const recovery = service.openInvitation({ projectId, intent: 'resume' });
    await recovery.run();
    await recovery.acknowledge();
    const newer = service.openInvitation({ projectId, intent: 'create' });
    const next = await newer.run();
    const retained = await service.readManagementOperation(projectId);

    await expect(older.run()).resolves.toEqual({ status: 'unavailable', reason: 'unavailable' });
    await older.acknowledge();
    await expect(service.readManagementOperation(projectId)).resolves.toEqual(retained);
    await expect(newer.read()).resolves.toEqual(next);
    older.dispose();
    recovery.dispose();
    newer.dispose();
  });

  it('preserves Resume when the retained request finishes before execution', async () => {
    const { service, control } = await setup('cloud');
    await storePending();
    const resumed = service.openInvitation({ projectId, intent: 'resume' });
    const finished = await service.resumeManagementOperation(projectId);
    await expect(resumed.run()).resolves.toMatchObject({ status: 'ready', invitation: finished.invitation });
    await expect(service.readManagementOperation(projectId)).resolves.toMatchObject({ completionId: finished.completionId });
    expect(control.cloudMembership.mock.calls.filter(([name]) => name === 'createProjectInvitation')).toHaveLength(1);
    resumed.dispose();
  });

  it('cannot acknowledge a newer Cloud result from an older operation', async () => {
    const { service } = await setup('cloud');
    const older = service.openInvitation({ projectId, intent: 'create' });
    await older.run();
    const newer = service.openInvitation({ projectId, intent: 'create' });
    const next = await newer.run();
    await expect(older.acknowledge()).rejects.toMatchObject({
      safeContext: { reason: 'cloud-management-completion-mismatch' },
    });
    await expect(newer.read()).resolves.toEqual(next);
    await expect(older.read()).resolves.toEqual({ status: 'unavailable', reason: 'unavailable' });
    older.dispose();
    newer.dispose();
  });

  it.each(['lan', 'cloud'] as const)('stops exposing %s secrets after their deadline, including after acknowledgement', async kind => {
    const { service } = await setup(kind);
    const operation = service.openInvitation({ projectId, intent: 'create' });
    await operation.run();
    await operation.acknowledge();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-04T00:00:00.000Z'));
    await expect(operation.read()).resolves.toEqual({ status: 'unavailable', reason: 'expired' });
    operation.dispose();
  });

  it('fences an operation when the selected Project authority changes', async () => {
    const { service } = await setup('cloud');
    const operation = service.openInvitation({ projectId, intent: 'create' });
    await operation.run();
    const membership = (await projects.loadMembership(projectId))!;
    if (!isCollabLocalCloudMembership(membership)) throw new Error('Expected Cloud membership');
    await projects.saveMembership({
      ...membership, authority: { ...membership.authority, authorityGeneration: 8 },
    });
    await expect(operation.read()).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(operation.acknowledge()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('leaves an in-flight Cloud mutation recoverable after disposing its presentation', async () => {
    const { service, control } = await setup('cloud');
    const execute = control.cloudMembership.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    control.cloudMembership.mockImplementation(async (...args) => {
      if (args[0] === 'createProjectInvitation') {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
      }
      return execute(...args);
    });
    const operation = service.openInvitation({ projectId, intent: 'create' });
    const running = operation.run();
    await started;
    operation.dispose();
    release();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    const restored = service.openInvitation({ projectId, intent: 'resume' });
    await expect(restored.run()).resolves.toMatchObject({ status: 'ready' });
    restored.dispose();
  });

  it('aborts LAN transport on dispose while preserving the operation fence', async () => {
    const { service, control } = await setup('lan');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    control.membership.mockImplementation(async (_operation, _request, options) => {
      entered();
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve()));
      throw new CollabError({ code: 'cancelled' });
    });
    const operation = service.openInvitation({ projectId, intent: 'create' });
    const running = operation.run();
    await started;
    operation.dispose();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await expect(operation.run()).rejects.toMatchObject({ code: 'cancelled' });
  });

});
