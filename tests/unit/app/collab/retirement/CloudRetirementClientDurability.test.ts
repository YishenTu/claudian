import type { CollabProjectRetirementResult } from '@claudian-collab/protocol';

import type {
  CollabLocalCloudMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import {
  type CloudRetirementActivityPort,
  type CloudRetirementAuthorityClientPort,
  CloudRetirementClient,
  type CloudRetirementIntentStore,
} from '@/app/collab/retirement/CloudRetirementClient';
import type { CloudRetirementIntent } from '@/app/collab/retirement/CloudRetirementIntent';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-cloud-retire';
const RETIRED_AT = '2026-08-27T00:00:10.000Z';

function membership(role: 'manager' | 'member' = 'manager'): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 3,
      bindingVersion: 4,
      gitRemoteUrl: `https://cloud.example.test/operator/v4/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test/operator',
      wireVersion: 8,
    },
    createdAt: '2026-08-27T00:00:00.000Z',
    lastEventSequence: 4,
    lifecycle: 'active',
    member: {
      displayName: 'Manager',
      id: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      role,
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Retire',
      workspacePath: 'workspace/cloud-retire',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function result(): CollabProjectRetirementResult {
  return {
    acknowledgementRequired: true,
    kind: 'project-retired',
    projectId: PROJECT_ID,
    retiredAt: RETIRED_AT,
    retirementId: 'retirement-cloud',
    terminalExpiresAt: '2026-09-26T00:00:10.000Z',
  };
}

class MemoryIntentStore implements CloudRetirementIntentStore {
  failRejectedSave = false;
  intent: CloudRetirementIntent | null = null;
  terminal = false;

  async listProjectIds(): Promise<readonly CloudRetirementIntent['projectId'][]> {
    return this.intent ? [this.intent.projectId] : [];
  }

  async load(projectId: CloudRetirementIntent['projectId']): Promise<CloudRetirementIntent | null> {
    return this.intent?.projectId === projectId ? this.intent : null;
  }

  async loadRetirementRecord(): Promise<{
    readonly projectId: CloudRetirementIntent['projectId'];
  } | null> {
    return this.terminal ? { projectId: PROJECT_ID } : null;
  }

  async remove(projectId: CloudRetirementIntent['projectId']): Promise<boolean> {
    if (this.intent?.projectId !== projectId) return false;
    this.intent = null;
    return true;
  }

  async save(intent: CloudRetirementIntent): Promise<void> {
    if (this.failRejectedSave && intent.phase === 'rejected') {
      throw new Error('rejected marker write failed');
    }
    this.intent = intent;
  }
}

function authorityClient(): jest.Mocked<CloudRetirementAuthorityClientPort> {
  return {
    dispose: jest.fn(),
    listProjectMembers: jest.fn(async (
      ..._args: Parameters<CloudRetirementAuthorityClientPort['listProjectMembers']>
    ): Promise<Awaited<ReturnType<CloudRetirementAuthorityClientPort['listProjectMembers']>>> => ({
      managerSetGeneration: 7,
      members: [{
        bindingState: 'bound',
        displayName: 'Manager',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable',
        memberId: 'member-manager',
        membershipRevision: 9,
        role: 'manager',
      }],
      projectId: PROJECT_ID,
    })),
    readSnapshot: jest.fn(async (
      ..._args: Parameters<CloudRetirementAuthorityClientPort['readSnapshot']>
    ): Promise<Awaited<ReturnType<CloudRetirementAuthorityClientPort['readSnapshot']>>> => ({
      currentMember: {
        activatedAt: '2026-08-27T00:00:00.000Z',
        createdAt: '2026-08-27T00:00:00.000Z',
        ...membership().member,
        status: 'active',
      },
      eventSequence: 4,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 3,
        authorityKind: 'cloud',
        createdAt: '2026-08-27T00:00:00.000Z',
        id: PROJECT_ID,
        mainOid: 'a'.repeat(40),
        mainRef: 'refs/heads/main',
        name: 'Cloud Retire',
      },
      ticketHighlights: [],
    })),
    retireProject: jest.fn(async (
      ..._args: Parameters<CloudRetirementAuthorityClientPort['retireProject']>
    ) => result()),
  };
}

function activity(): jest.Mocked<CloudRetirementActivityPort> {
  return {
    complete: jest.fn(async (
      ..._args: Parameters<CloudRetirementActivityPort['complete']>
    ) => undefined),
    resume: jest.fn(async (
      ..._args: Parameters<CloudRetirementActivityPort['resume']>
    ) => undefined),
    suspend: jest.fn(async (
      ..._args: Parameters<CloudRetirementActivityPort['suspend']>
    ) => undefined),
  };
}

function createClient(
  store: MemoryIntentStore,
  authority: CloudRetirementAuthorityClientPort,
  localActivity = activity(),
  terminal = jest.fn(async () => { store.terminal = true; }),
  createIdempotencyKey = () => 'retire-request-one',
  terminalResume = jest.fn(async () => undefined),
): {
  client: CloudRetirementClient;
  terminal: jest.Mock;
  terminalResume: jest.Mock;
  activity: jest.Mocked<CloudRetirementActivityPort>;
} {
  return {
    activity: localActivity,
    client: new CloudRetirementClient({
      activity: localActivity,
      connect: async () => { throw new Error('acknowledgement not expected'); },
      connectRetirement: async () => authority,
      createIdempotencyKey,
      intents: store,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      terminal: { handle: terminal, resume: terminalResume },
    }),
    terminal,
    terminalResume,
  };
}

describe('CloudRetirementClient durability', () => {
  it('replays the frozen request after restart without active preparation reads', async () => {
    const store = new MemoryIntentStore();
    const firstAuthority = authorityClient();
    firstAuthority.retireProject.mockRejectedValueOnce(new CollabError({
      code: 'operation-timeout',
    }));
    const first = createClient(store, firstAuthority);

    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'operation-timeout' });
    expect(store.intent).toMatchObject({
      phase: 'submitted',
      request: {
        expectedAuthorityGeneration: 3,
        expectedMainOid: 'a'.repeat(40),
        idempotencyKey: 'retire-request-one',
        projectId: PROJECT_ID,
      },
    });

    const replayAuthority = authorityClient();
    replayAuthority.readSnapshot.mockRejectedValue(new Error('active snapshot unavailable'));
    replayAuthority.listProjectMembers.mockRejectedValue(new Error('membership unavailable'));
    const restarted = createClient(store, replayAuthority);

    await restarted.client.resume(PROJECT_ID);

    expect(replayAuthority.retireProject).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'retire-request-one' }),
      {},
    );
    expect(replayAuthority.readSnapshot).not.toHaveBeenCalled();
    expect(replayAuthority.listProjectMembers).not.toHaveBeenCalled();
    expect(restarted.terminal).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      retiredAt: RETIRED_AT,
      retirementId: 'retirement-cloud',
    }, 'terminal-fallback');
    expect(store.intent).toBeNull();
  });

  it('persists a terminal reply before handing it to local retirement adoption', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    const terminal = jest.fn()
      .mockRejectedValueOnce(new Error('retirement record write failed'))
      .mockImplementationOnce(async () => { store.terminal = true; });
    const first = createClient(store, authority, activity(), terminal);

    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toThrow('retirement record write failed');
    expect(store.intent).toMatchObject({ phase: 'terminal-retained', result: result() });

    authority.retireProject.mockClear();
    authority.readSnapshot.mockClear();
    await first.client.resume(PROJECT_ID);

    expect(authority.retireProject).not.toHaveBeenCalled();
    expect(authority.readSnapshot).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      retiredAt: RETIRED_AT,
      retirementId: 'retirement-cloud',
    }, 'terminal-fallback');
    expect(store.intent).toBeNull();
  });

  it('durably rejects only after a completed rejection and same-actor recovery barrier', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CloudAuthorityRejection({
      code: 'authority-not-synchronized',
    }));
    authority.readSnapshot
      .mockResolvedValueOnce(await authorityClient().readSnapshot(PROJECT_ID))
      .mockResolvedValueOnce({
        ...await authorityClient().readSnapshot(PROJECT_ID),
        project: {
          ...(await authorityClient().readSnapshot(PROJECT_ID)).project,
          mainOid: 'b'.repeat(40),
        },
      });
    const ownerActivity = activity();
    const { client } = createClient(store, authority, ownerActivity);

    await expect(client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toBeInstanceOf(CloudAuthorityRejection);

    expect(store.intent).toMatchObject({
      phase: 'rejected',
      request: { expectedMainOid: 'a'.repeat(40) },
    });
    expect(authority.readSnapshot).toHaveBeenCalledTimes(2);
    expect(ownerActivity.resume).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('keeps the submitted request and suspension when the rejection barrier is unavailable', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CloudAuthorityRejection({
      code: 'authorization-denied',
    }));
    authority.readSnapshot
      .mockResolvedValueOnce(await authorityClient().readSnapshot(PROJECT_ID))
      .mockRejectedValueOnce(new CollabError({ code: 'authorization-denied' }));
    const ownerActivity = activity();
    const { client } = createClient(store, authority, ownerActivity);

    await expect(client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'authorization-denied' });

    expect(store.intent).toMatchObject({ phase: 'submitted' });
    expect(ownerActivity.resume).not.toHaveBeenCalled();
  });

  it('does not reuse the conclusively rejected request key for an explicit retry', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CloudAuthorityRejection({
      code: 'authority-not-synchronized',
    }));
    const first = createClient(store, authority);
    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toBeInstanceOf(CloudAuthorityRejection);
    expect(store.intent).toMatchObject({
      phase: 'rejected',
      request: { idempotencyKey: 'retire-request-one' },
    });

    const retryAuthority = authorityClient();
    const retry = createClient(
      store,
      retryAuthority,
      activity(),
      jest.fn(async () => { store.terminal = true; }),
      () => 'retire-request-one',
    );

    await expect(retry.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'cloud-retirement-idempotency-key-reused' },
      });
    expect(retryAuthority.retireProject).not.toHaveBeenCalled();
  });

  it('retires with a fresh key after an explicit retry of a durable rejection', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CloudAuthorityRejection({
      code: 'authority-not-synchronized',
    }));
    const first = createClient(store, authority);
    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toBeInstanceOf(CloudAuthorityRejection);

    const retryAuthority = authorityClient();
    const retry = createClient(
      store,
      retryAuthority,
      activity(),
      jest.fn(async () => { store.terminal = true; }),
      () => 'retire-request-two',
    );

    await retry.client.retire(membership(), { projectId: PROJECT_ID });

    expect(retryAuthority.retireProject).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'retire-request-two' }),
      {},
    );
  });

  it('converges an event-won terminal race without replaying the submitted request', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CollabError({ code: 'operation-timeout' }));
    const first = createClient(store, authority);
    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'operation-timeout' });

    store.terminal = true;
    const restartedActivity = activity();
    const replayAuthority = authorityClient();
    const restarted = createClient(store, replayAuthority, restartedActivity);
    await restarted.client.resume(PROJECT_ID);

    expect(replayAuthority.retireProject).not.toHaveBeenCalled();
    expect(restarted.terminalResume).toHaveBeenCalledWith(PROJECT_ID);
    expect(store.intent).toBeNull();
    expect(restartedActivity.complete).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('retains its intent until event-won local retirement adoption has converged', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CollabError({ code: 'operation-timeout' }));
    const first = createClient(store, authority);
    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'operation-timeout' });
    store.terminal = true;

    const terminalResume = jest.fn()
      .mockRejectedValueOnce(new Error('projection convergence interrupted'))
      .mockResolvedValueOnce(undefined);
    const restartedActivity = activity();
    const restarted = createClient(
      store,
      authorityClient(),
      restartedActivity,
      jest.fn(),
      () => 'unused',
      terminalResume,
    );

    await expect(restarted.client.resume(PROJECT_ID))
      .rejects.toThrow('projection convergence interrupted');
    expect(store.intent).not.toBeNull();
    expect(restartedActivity.complete).not.toHaveBeenCalled();

    await restarted.client.resume(PROJECT_ID);
    expect(terminalResume).toHaveBeenCalledTimes(2);
    expect(store.intent).toBeNull();
    expect(restartedActivity.complete).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('keeps the submitted request frozen when the rejected marker write is interrupted', async () => {
    const store = new MemoryIntentStore();
    store.failRejectedSave = true;
    const authority = authorityClient();
    authority.retireProject.mockRejectedValueOnce(new CloudAuthorityRejection({
      code: 'authority-not-synchronized',
    }));
    const ownerActivity = activity();
    const first = createClient(store, authority, ownerActivity);

    await expect(first.client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toThrow('rejected marker write failed');
    expect(store.intent).toMatchObject({
      phase: 'submitted',
      request: { idempotencyKey: 'retire-request-one' },
    });
    expect(ownerActivity.resume).not.toHaveBeenCalled();

    store.failRejectedSave = false;
    const restartedAuthority = authorityClient();
    restartedAuthority.retireProject.mockRejectedValueOnce(new CloudAuthorityRejection({
      code: 'authority-not-synchronized',
    }));
    const restartedActivity = activity();
    const restarted = createClient(store, restartedAuthority, restartedActivity);
    await expect(restarted.client.resume(PROJECT_ID))
      .rejects.toBeInstanceOf(CloudAuthorityRejection);
    expect(store.intent).toMatchObject({ phase: 'rejected' });
    expect(restartedActivity.resume).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('fails closed before persistence when the active Manager binding was demoted', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.listProjectMembers.mockResolvedValueOnce({
      managerSetGeneration: 8,
      members: [{
        bindingState: 'bound',
        displayName: 'Manager',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable',
        memberId: 'member-manager',
        membershipRevision: 10,
        role: 'member',
      }],
      projectId: PROJECT_ID,
    });
    const { client } = createClient(store, authority);

    await expect(client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'cloud-retirement-snapshot-mismatch' },
      });
    expect(store.intent).toBeNull();
    expect(authority.retireProject).not.toHaveBeenCalled();
  });

  it('retains the submitted request when the terminal reply names another Project', async () => {
    const store = new MemoryIntentStore();
    const authority = authorityClient();
    authority.retireProject.mockResolvedValueOnce({
      ...result(),
      projectId: 'project-other',
    });
    const ownerActivity = activity();
    const { client } = createClient(store, authority, ownerActivity);

    await expect(client.retire(membership(), { projectId: PROJECT_ID }))
      .rejects.toMatchObject({
        code: 'authority-integrity-error',
        safeContext: { reason: 'cloud-retirement-result-mismatch' },
      });
    expect(store.intent).toMatchObject({ phase: 'submitted' });
    expect(ownerActivity.complete).not.toHaveBeenCalled();
    expect(ownerActivity.resume).not.toHaveBeenCalled();
  });
});
