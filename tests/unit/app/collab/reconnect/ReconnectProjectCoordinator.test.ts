import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
} from '@claudian-collab/protocol';

import { AuthorityProjectionTransitionCoordinator } from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import type {
  CollabLocalCloudMembershipRecord,
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { LocalHostTransferProjection } from '@/app/collab/host-transfer/LocalHostTransferProjection';
import type {
  CollabHostTrustStore,
  CollabHttpOperationOptions,
  CollabJsonRequest,
  CollabTrustedHost,
  PinnedCollabHttpClient,
} from '@/app/collab/lan/CollabHttpClient';
import {
  InvitationCodec,
  type LanCollabInvitation,
} from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import {
  decodeCloudRelocationRecord,
} from '@/app/collab/reconnect/CloudRelocationRecord';
import {
  ReconnectProjectCoordinator,
  type ReconnectProjectFoundationPort,
} from '@/app/collab/reconnect/ReconnectProjectCoordinator';

const now = new Date('2026-08-08T00:00:00.000Z');
const oldEndpoint = 'https://192.168.1.10:54545';
const newEndpoint = 'https://192.168.1.20:54545';
const fingerprint = 'ab'.repeat(32);
const credential = Buffer.alloc(32, 9).toString('base64url');
const certificate = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n';

function membership(): CollabLocalMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      endpoint: oldEndpoint,
      gitRemoteUrl: `${oldEndpoint}/v1/git/project-a/repository.git`,
      hostCaCertificatePem: certificate,
      hostCaFingerprint: fingerprint,
      kind: 'lan',
    },
    createdAt: '2026-08-07T00:00:00.000Z',
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 4,
    member: {
      credential,
      displayName: 'Alice',
      id: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      role: 'member',
    },
    project: {
      id: 'project-a',
      name: 'Project A',
      workspacePath: 'workspace/project-a',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
}

function cloudMembership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 4,
      bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
      gitRemoteUrl: 'https://old.example.test/operator/v4/projects/project-a/repository.git',
      kind: 'cloud',
      serverUrl: 'https://old.example.test/operator',
      wireVersion: COLLAB_PROTOCOL_VERSION,
    },
    createdAt: '2026-08-07T00:00:00.000Z',
    lastEventSequence: 4,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      role: 'member',
    },
    project: {
      id: 'project-a',
      name: 'Project A',
      workspacePath: 'workspace/project-a',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
}

function cloudSnapshot(changes: {
  readonly authorityGeneration?: number;
  readonly memberId?: string;
  readonly projectId?: string;
} = {}) {
  const local = cloudMembership();
  return {
    currentMember: {
      activatedAt: local.createdAt,
      createdAt: local.createdAt,
      ...local.member,
      id: changes.memberId ?? local.member.id,
      status: 'active' as const,
    },
    eventSequence: 5,
    members: [],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityGeneration: changes.authorityGeneration ?? 4,
      authorityKind: 'cloud' as const,
      createdAt: local.createdAt,
      id: changes.projectId ?? 'project-a',
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main' as const,
      name: 'Project A',
    },
    ticketHighlights: [],
  };
}

function invitation(
  codec: InvitationCodec,
  changes: Partial<LanCollabInvitation> = {},
): LanCollabInvitation {
  return codec.createInvitation({
    caFingerprint: changes.caFingerprint ?? fingerprint,
    endpoint: changes.endpoint ?? newEndpoint,
    expiresAt: changes.expiresAt ?? '2026-08-08T00:30:00.000Z',
    invitationId: changes.invitationId ?? 'invitation-a',
    invitationSecret: changes.invitationSecret ?? Buffer.alloc(32, 7).toString('base64url'),
    projectId: changes.projectId ?? 'project-a',
  });
}

describe('ReconnectProjectCoordinator', () => {
  let vaultRoot: string;
  let codec: InvitationCodec;
  let currentMembership: CollabLocalMembershipRecord;
  let originUrls: string[];
  let saveMembership: jest.Mock;
  let addRemote: jest.Mock;
  let assertLocalRepositoryIdentity: jest.Mock;
  let listRemoteUrls: jest.Mock;
  let requestWithMember: jest.Mock;
  let createHttpClient: jest.Mock;
  let observedStoredTrust: CollabTrustedHost | null;
  let stagedSaveResult: 'ca-mismatch' | 'saved' | null;
  let foundation: ReconnectProjectFoundationPort;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'claudian-reconnect-'));
    await mkdir(path.join(vaultRoot, 'workspace/project-a'), { recursive: true });
    codec = new InvitationCodec({ now: () => now });
    currentMembership = membership();
    originUrls = [currentMembership.authority.gitRemoteUrl!];
    saveMembership = jest.fn(async value => {
      currentMembership = value;
    });
    addRemote = jest.fn(async (_repositoryPath, _remote, url) => {
      originUrls = [url];
    });
    assertLocalRepositoryIdentity = jest.fn().mockResolvedValue(undefined);
    listRemoteUrls = jest.fn(async () => originUrls);
    requestWithMember = jest.fn(async (
      request,
      memberCredential,
      options,
      confirmedEndpoint = newEndpoint,
    ) => {
      void memberCredential;
      void options;
      return request.decode({
        data: {
          caFingerprint: fingerprint,
          endpoint: confirmedEndpoint,
        },
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: 'refresh-a',
      });
    });
    observedStoredTrust = null;
    stagedSaveResult = null;
    createHttpClient = jest.fn((store: CollabHostTrustStore) => ({
      bootstrapInvitation: async (candidate: LanCollabInvitation) => {
        const stored = await store.read(candidate.projectId);
        observedStoredTrust = stored;
        const staged: CollabTrustedHost = { ...stored!, endpoint: candidate.endpoint };
        stagedSaveResult = await store.save(staged);
        return {
          requestWithMember: <T>(
            request: CollabJsonRequest<T>,
            memberCredential: string,
            options: CollabHttpOperationOptions = {},
          ) => (
            requestWithMember(request, memberCredential, options, candidate.endpoint)
          ),
        } as unknown as PinnedCollabHttpClient;
      },
      bootstrapTrustedEndpoint: async (candidate: {
        caFingerprint: string;
        endpoint: string;
        projectId: string;
      }) => {
        const stored = await store.read(candidate.projectId);
        observedStoredTrust = stored;
        const staged: CollabTrustedHost = { ...stored!, endpoint: candidate.endpoint };
        stagedSaveResult = await store.save(staged);
        return {
          requestWithMember: <T>(
            request: CollabJsonRequest<T>,
            memberCredential: string,
            options: CollabHttpOperationOptions = {},
          ) => (
            requestWithMember(request, memberCredential, options, candidate.endpoint)
          ),
        } as unknown as PinnedCollabHttpClient;
      },
    }));
    foundation = {
      local: {
        projects: {
          listPendingOperationProjectIds: jest.fn(async () => []),
          loadMembership: jest.fn(async () => currentMembership),
          loadProjectDocument: jest.fn(async () => null),
          removeProjectDocument: jest.fn(async () => false),
          saveMembership,
          saveProjectDocument: jest.fn(async () => undefined),
        },
        workspace: {
          resolveManagedProjectPath: jest.fn(async workspacePath => (
            path.join(vaultRoot, ...workspacePath.split('/'))
          )),
        },
      },
      requireGitFoundation: jest.fn(async () => ({
        repositories: { addRemote, assertLocalRepositoryIdentity, listRemoteUrls },
      } as unknown as CollabGitFoundation)),
    };
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  function coordinator(overrides: Readonly<Record<string, unknown>> = {}): ReconnectProjectCoordinator {
    return new ReconnectProjectCoordinator(foundation, {
      authorityProjectionTransitions: new AuthorityProjectionTransitionCoordinator(),
      createHttpClient,
      hostInstallation: {
        inspect: jest.fn().mockResolvedValue('hosted-here'),
      },
      invitationCodec: codec,
      now: () => now,
      vaultRoot,
      ...overrides,
    });
  }

  it('moves one existing membership to a same-CA endpoint without rejoining', async () => {
    const encodedInvitation = codec.encode(invitation(codec));

    await expect(coordinator().reconnectProject({
      encodedInvitation,
      projectId: 'project-a',
    })).resolves.toEqual({
      status: 'success',
      value: expect.objectContaining({
        connectionStatus: 'connected',
        id: 'project-a',
        name: 'Project A',
      }),
    });

    expect(requestWithMember).toHaveBeenCalledTimes(1);
    expect(requestWithMember.mock.calls[0]?.[1]).toBe(credential);
    expect(requestWithMember.mock.calls[0]?.[2]).toEqual({});
    expect(observedStoredTrust).toEqual({
      caCertificatePem: certificate,
      caFingerprint: fingerprint,
      endpoint: oldEndpoint,
      projectId: 'project-a',
    });
    expect(stagedSaveResult).toBe('saved');
    expect(addRemote).toHaveBeenCalledWith(
      path.join(vaultRoot, 'workspace/project-a'),
      'origin',
      `${newEndpoint}/v1/git/project-a/repository.git`,
    );
    expect(assertLocalRepositoryIdentity).toHaveBeenCalledWith(
      path.join(vaultRoot, 'workspace/project-a'),
      {
        memberId: 'member-a',
        personalRef: 'refs/heads/members/member-a',
        projectId: 'project-a',
      },
    );
    expect(saveMembership).toHaveBeenCalledWith({
      ...membership(),
      authority: {
        ...membership().authority,
        endpoint: newEndpoint,
        gitRemoteUrl: `${newEndpoint}/v1/git/project-a/repository.git`,
      },
      updatedAt: now.toISOString(),
    });
  });

  it('validates and durably relocates one exact Cloud Project binding', async () => {
    currentMembership = cloudMembership();
    originUrls = [currentMembership.authority.gitRemoteUrl!];
    const order: string[] = [];
    let pending: unknown = null;
    Object.assign(foundation.local.projects, {
      listPendingOperationProjectIds: jest.fn(async () => pending ? ['project-a'] : []),
      loadProjectDocument: jest.fn(async (_projectId, _kind, decode) => (
        pending ? decode(pending) : null
      )),
      removeProjectDocument: jest.fn(async () => {
        order.push('remove-intent');
        pending = null;
        return true;
      }),
      saveProjectDocument: jest.fn(async (_projectId, _kind, value) => {
        order.push(`save-${(value as { phase: string }).phase}`);
        pending = value;
      }),
    });
    listRemoteUrls.mockImplementation(async () => originUrls);
    addRemote.mockImplementation(async (_repositoryPath, _remote, url) => {
      order.push('origin');
      originUrls = [url];
    });
    saveMembership.mockImplementation(async value => {
      order.push('membership');
      currentMembership = value;
    });
    const dispose = jest.fn();
    const readSnapshot = jest.fn(async () => {
      order.push('validate');
      return cloudSnapshot();
    });
    const activity = {
      activate: jest.fn(async () => { order.push('activate'); }),
      resume: jest.fn(async () => { order.push('resume'); }),
      suspend: jest.fn(async () => { order.push('suspend'); }),
    };
    const cloudRelocation = {
      activity,
      connect: jest.fn(async () => ({
        dispose,
        git: {
          headers: [],
          remoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
        },
        projectId: 'project-a',
        readSnapshot,
        serverUrl: 'http://new.example.test/proxy/cloud',
        supports: () => true,
      })),
      createOperationId: () => 'relocate-cloud-one',
    };

    const relocationResult = await coordinator({ cloudRelocation }).reconnectProject({
      authority: {
        kind: 'cloud',
        serverUrl: 'http://new.example.test/proxy/cloud',
      },
      projectId: 'project-a',
    } as never);
    expect(relocationResult).toEqual({
      status: 'success',
      value: expect.objectContaining({
        authorityKind: 'cloud',
        id: 'project-a',
      }),
    });

    expect(order).toEqual([
      'validate',
      'suspend',
      'save-prepared',
      'origin',
      'save-origin-updated',
      'membership',
      'save-membership-updated',
      'activate',
      'resume',
      'remove-intent',
    ]);
    expect(currentMembership).toMatchObject({
      authority: {
        authorityGeneration: 4,
        gitRemoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
        kind: 'cloud',
        serverUrl: 'http://new.example.test/proxy/cloud',
      },
      member: cloudMembership().member,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Project', { projectId: 'project-b' }],
    ['Member', { memberId: 'member-b' }],
    ['authority generation', { authorityGeneration: 5 }],
  ])('rejects a Cloud candidate with a different %s before local effects', async (
    _identity,
    snapshotChanges,
  ) => {
    currentMembership = cloudMembership();
    originUrls = [currentMembership.authority.gitRemoteUrl!];
    const activity = {
      activate: jest.fn(async () => undefined),
      resume: jest.fn(async () => undefined),
      suspend: jest.fn(async () => undefined),
    };
    const dispose = jest.fn();
    const saveProjectDocument = jest.fn(async () => undefined);
    Object.assign(foundation.local.projects, { saveProjectDocument });

    await expect(coordinator({
      cloudRelocation: {
        activity,
        connect: jest.fn(async () => ({
          dispose,
          git: {
            headers: [],
            remoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
          },
          projectId: 'project-a',
          readSnapshot: jest.fn(async () => cloudSnapshot(snapshotChanges)),
          serverUrl: 'http://new.example.test/proxy/cloud',
          supports: () => true,
        })),
      },
    }).reconnectProject({
      authority: { kind: 'cloud', serverUrl: 'http://new.example.test/proxy/cloud' },
      projectId: 'project-a',
    })).resolves.toMatchObject({
      error: expect.objectContaining({ code: 'authority-integrity-error' }),
      status: 'failure',
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(activity.suspend).not.toHaveBeenCalled();
    expect(saveProjectDocument).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('restores old activity when the initial Cloud relocation journal write fails', async () => {
    currentMembership = cloudMembership();
    originUrls = [currentMembership.authority.gitRemoteUrl!];
    const activity = {
      activate: jest.fn(async () => undefined),
      resume: jest.fn(async () => undefined),
      suspend: jest.fn(async () => undefined),
    };
    Object.assign(foundation.local.projects, {
      saveProjectDocument: jest.fn(async () => {
        throw new Error('journal unavailable');
      }),
    });

    await expect(coordinator({
      cloudRelocation: {
        activity,
        connect: jest.fn(async () => ({
          dispose: jest.fn(),
          git: {
            headers: [],
            remoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
          },
          projectId: 'project-a',
          readSnapshot: jest.fn(async () => cloudSnapshot()),
          serverUrl: 'http://new.example.test/proxy/cloud',
          supports: () => true,
        })),
      },
    }).reconnectProject({
      authority: { kind: 'cloud', serverUrl: 'http://new.example.test/proxy/cloud' },
      projectId: 'project-a',
    })).resolves.toMatchObject({ status: 'failure' });

    expect(activity.suspend).toHaveBeenCalledWith('project-a');
    expect(activity.resume).toHaveBeenCalledWith('project-a');
    expect(activity.activate).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('blocks Cloud relocation while an endpoint-bound management intent is unresolved', async () => {
    currentMembership = cloudMembership();
    originUrls = [currentMembership.authority.gitRemoteUrl!];
    const activity = {
      activate: jest.fn(async () => undefined),
      resume: jest.fn(async () => undefined),
      suspend: jest.fn(async () => undefined),
    };
    const saveProjectDocument = jest.fn(async () => undefined);
    Object.assign(foundation.local.projects, {
      loadProjectDocument: jest.fn(async (_projectId, kind) => (
        kind === 'cloud-management-intent'
          ? { kind: 'cloud-management-intent', projectId: 'project-a' }
          : null
      )),
      saveProjectDocument,
    });

    await expect(coordinator({
      cloudRelocation: {
        activity,
        connect: jest.fn(async () => ({
          dispose: jest.fn(),
          git: {
            headers: [],
            remoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
          },
          projectId: 'project-a',
          readSnapshot: jest.fn(async () => cloudSnapshot()),
          serverUrl: 'http://new.example.test/proxy/cloud',
          supports: () => true,
        })),
      },
    }).reconnectProject({
      authority: { kind: 'cloud', serverUrl: 'http://new.example.test/proxy/cloud' },
      projectId: 'project-a',
    })).resolves.toMatchObject({
      error: expect.objectContaining({
        code: 'operation-failed',
        safeContext: { reason: 'cloud-relocation-management-pending' },
      }),
      status: 'failure',
    });

    expect(activity.suspend).toHaveBeenCalledWith('project-a');
    expect(activity.resume).toHaveBeenCalledWith('project-a');
    expect(activity.activate).not.toHaveBeenCalled();
    expect(saveProjectDocument).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('continues later Cloud relocation recovery after an earlier Project record fails', async () => {
    const original = cloudMembership();
    const newAuthority = {
      bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
      gitRemoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
      serverUrl: 'http://new.example.test/proxy/cloud',
      wireVersion: COLLAB_PROTOCOL_VERSION,
    };
    currentMembership = {
      ...original,
      authority: {
        authorityGeneration: original.authority.authorityGeneration,
        ...newAuthority,
        kind: 'cloud',
      },
    };
    originUrls = [newAuthority.gitRemoteUrl];
    const pending = decodeCloudRelocationRecord({
      authorityGeneration: original.authority.authorityGeneration,
      createdAt: now.toISOString(),
      memberId: original.member.id,
      newAuthority,
      oldAuthority: {
        bindingVersion: original.authority.bindingVersion,
        gitRemoteUrl: original.authority.gitRemoteUrl,
        serverUrl: original.authority.serverUrl,
        wireVersion: original.authority.wireVersion,
      },
      operationId: 'relocate-cloud-recovery',
      operationKind: 'cloud-relocation',
      personalRef: original.member.personalRef,
      phase: 'membership-updated',
      projectId: original.project.id,
      schemaVersion: 1,
      updatedAt: now.toISOString(),
    });
    const firstFailure = new Error('corrupt first relocation');
    const removeProjectDocument = jest.fn(async () => true);
    Object.assign(foundation.local.projects, {
      listPendingOperationProjectIds: jest.fn(async () => ['project-corrupt', 'project-a']),
      loadProjectDocument: jest.fn(async (projectId, _kind, decode) => {
        if (projectId === 'project-corrupt') throw firstFailure;
        return decode(pending);
      }),
      removeProjectDocument,
    });
    const activity = {
      activate: jest.fn(async () => undefined),
      resume: jest.fn(async () => undefined),
      suspend: jest.fn(async () => undefined),
    };

    await expect(coordinator({
      cloudRelocation: {
        activity,
        connect: jest.fn(async () => { throw new Error('reconnect not expected'); }),
      },
    }).resumeCloudRelocations()).rejects.toBe(firstFailure);

    expect(activity.activate).toHaveBeenCalledWith('project-a', {});
    expect(activity.resume).toHaveBeenCalledWith('project-a');
    expect(removeProjectDocument).toHaveBeenCalledWith('project-a', 'pending-operation');
  });

  it('retains a prepared relocation and fails closed on an unexpected existing origin', async () => {
    currentMembership = cloudMembership();
    originUrls = ['https://unexpected.example.test/v4/projects/project-a/repository.git'];
    let pending: unknown = null;
    const activity = {
      activate: jest.fn(async () => undefined),
      resume: jest.fn(async () => undefined),
      suspend: jest.fn(async () => undefined),
    };
    Object.assign(foundation.local.projects, {
      loadProjectDocument: jest.fn(async (_projectId, _kind, decode) => (
        pending ? decode(pending) : null
      )),
      saveProjectDocument: jest.fn(async (_projectId, _kind, value) => {
        pending = value;
      }),
    });

    await expect(coordinator({
      cloudRelocation: {
        activity,
        connect: jest.fn(async () => ({
          dispose: jest.fn(),
          git: {
            headers: [],
            remoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
          },
          projectId: 'project-a',
          readSnapshot: jest.fn(async () => cloudSnapshot()),
          serverUrl: 'http://new.example.test/proxy/cloud',
          supports: () => true,
        })),
      },
    }).reconnectProject({
      authority: { kind: 'cloud', serverUrl: 'http://new.example.test/proxy/cloud' },
      projectId: 'project-a',
    })).resolves.toMatchObject({
      durableProgress: true,
      status: 'recovery-required',
    });

    expect(pending).toMatchObject({ phase: 'prepared' });
    expect(activity.resume).not.toHaveBeenCalled();
    expect(activity.activate).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('resumes a membership-updated relocation without candidate reconnection', async () => {
    const old = cloudMembership();
    const newBinding = {
      bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
      gitRemoteUrl: 'http://new.example.test/proxy/cloud/v4/projects/project-a/repository.git',
      serverUrl: 'http://new.example.test/proxy/cloud',
      wireVersion: COLLAB_PROTOCOL_VERSION,
    };
    currentMembership = {
      ...old,
      authority: {
        authorityGeneration: 4,
        ...newBinding,
        kind: 'cloud',
      },
    };
    originUrls = [newBinding.gitRemoteUrl];
    let pending: unknown = decodeCloudRelocationRecord({
      authorityGeneration: 4,
      createdAt: now.toISOString(),
      memberId: old.member.id,
      newAuthority: newBinding,
      oldAuthority: {
        bindingVersion: old.authority.bindingVersion,
        gitRemoteUrl: old.authority.gitRemoteUrl,
        serverUrl: old.authority.serverUrl,
        wireVersion: old.authority.wireVersion,
      },
      operationId: 'relocate-cloud-resume',
      operationKind: 'cloud-relocation',
      personalRef: old.member.personalRef,
      phase: 'membership-updated',
      projectId: old.project.id,
      schemaVersion: 1,
      updatedAt: now.toISOString(),
    });
    const activity = {
      activate: jest.fn(async () => undefined),
      resume: jest.fn(async () => undefined),
      suspend: jest.fn(async () => undefined),
    };
    const connect = jest.fn(async () => {
      throw new Error('durable recovery must not reconnect');
    });
    Object.assign(foundation.local.projects, {
      loadProjectDocument: jest.fn(async (_projectId, _kind, decode) => (
        pending ? decode(pending) : null
      )),
      removeProjectDocument: jest.fn(async () => {
        pending = null;
        return true;
      }),
    });

    await expect(coordinator({
      cloudRelocation: { activity, connect },
    }).reconnectProject({
      authority: { kind: 'cloud', serverUrl: 'http://new.example.test/proxy/cloud' },
      projectId: 'project-a',
    })).resolves.toMatchObject({ status: 'success' });

    expect(connect).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
    expect(activity.suspend).toHaveBeenCalledWith('project-a');
    expect(activity.activate).toHaveBeenCalledWith('project-a', {});
    expect(activity.resume).toHaveBeenCalledWith('project-a');
    expect(pending).toBeNull();
  });

  it('moves to an automatically discovered endpoint under stored CA trust', async () => {
    await expect(coordinator().reconnectDiscoveredProject({
      candidates: [{
        caFingerprint: fingerprint,
        endpoint: newEndpoint,
        projectId: 'project-a',
      }],
      projectId: 'project-a',
    })).resolves.toEqual({
      status: 'success',
      value: expect.objectContaining({
        connectionStatus: 'connected',
        id: 'project-a',
      }),
    });

    expect(requestWithMember).toHaveBeenCalledTimes(1);
    expect(requestWithMember.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      method: 'GET',
      path: '/v9/projects/project-a/endpoint',
    }));
    expect(requestWithMember.mock.calls[0]?.[1]).toBe(credential);
    expect(requestWithMember.mock.calls[0]?.[2]).toEqual({ timeoutMs: 2_000 });
    expect(observedStoredTrust).toEqual({
      caCertificatePem: certificate,
      caFingerprint: fingerprint,
      endpoint: oldEndpoint,
      projectId: 'project-a',
    });
    expect(stagedSaveResult).toBe('saved');
    expect(addRemote).toHaveBeenCalledWith(
      path.join(vaultRoot, 'workspace/project-a'),
      'origin',
      `${newEndpoint}/v1/git/project-a/repository.git`,
    );
    expect(saveMembership).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({
        endpoint: newEndpoint,
        gitRemoteUrl: `${newEndpoint}/v1/git/project-a/repository.git`,
      }),
    }));
  });

  it('blocks a discovered different CA before creating a client or sending a credential', async () => {
    await expect(coordinator().reconnectDiscoveredProject({
      candidates: [{
        caFingerprint: 'cd'.repeat(32),
        endpoint: newEndpoint,
        projectId: 'project-a',
      }],
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'tls-ca-mismatch' }),
      status: 'failure',
    }));

    expect(createHttpClient).not.toHaveBeenCalled();
    expect(requestWithMember).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('verifies a multi-hop public Host proof chain before sending a Member credential', async () => {
    const nextFingerprint = 'cd'.repeat(32);
    const nextCertificate = '-----BEGIN CERTIFICATE-----\nNEXT CA\n-----END CERTIFICATE-----\n';
    const ordering: string[] = [];
    const hostTransitionProofClient = {
      fetchHostTransitions: jest.fn(async () => {
        ordering.push('proof');
        return [{ transferId: 'transfer-a' }, { transferId: 'transfer-b' }];
      }),
    };
    const hostTrustTransitionVerifier = {
      verifyChain: jest.fn(() => {
        ordering.push('verify');
        return nextCertificate;
      }),
    };
    requestWithMember.mockImplementation(async (request, _credential, _options) => {
      ordering.push('credential');
      return request.decode({
        data: { caFingerprint: nextFingerprint, endpoint: newEndpoint },
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: 'refresh-transition',
      });
    });

    await expect(coordinator({
      hostTransitionProofClient,
      hostTrustTransitionVerifier,
    }).reconnectDiscoveredProject({
      candidates: [{
        caFingerprint: nextFingerprint,
        endpoint: newEndpoint,
        projectId: 'project-a',
      }],
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({ status: 'success' }));

    expect(ordering).toEqual(['proof', 'verify', 'credential']);
    expect(hostTrustTransitionVerifier.verifyChain).toHaveBeenCalledWith({
      expectedCurrentCaFingerprint: nextFingerprint,
      pinnedCaCertificatePem: certificate,
      projectId: 'project-a',
      proofs: [{ transferId: 'transfer-a' }, { transferId: 'transfer-b' }],
    });
    expect(observedStoredTrust).toEqual({
      caCertificatePem: nextCertificate,
      caFingerprint: nextFingerprint,
      endpoint: oldEndpoint,
      projectId: 'project-a',
    });
    expect(saveMembership).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({
        endpoint: newEndpoint,
        hostCaCertificatePem: nextCertificate,
        hostCaFingerprint: nextFingerprint,
      }),
    }));
  });

  it('rejects an invalid Host transition chain before sending a credential', async () => {
    const hostTransitionProofClient = {
      fetchHostTransitions: jest.fn(async () => [{ transferId: 'forked' }]),
    };
    const hostTrustTransitionVerifier = {
      verifyChain: jest.fn(() => {
        throw new Error('fork');
      }),
    };

    await expect(coordinator({
      hostTransitionProofClient,
      hostTrustTransitionVerifier,
    }).reconnectDiscoveredProject({
      candidates: [{
        caFingerprint: 'cd'.repeat(32),
        endpoint: newEndpoint,
        projectId: 'project-a',
      }],
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({ status: 'failure' }));
    expect(requestWithMember).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
  });

  it('blocks automatic reconnect when multiple same-CA Hosts confirm authority', async () => {
    const secondEndpoint = 'https://192.168.1.30:54545';

    await expect(coordinator().reconnectDiscoveredProject({
      candidates: [
        {
          caFingerprint: fingerprint,
          endpoint: newEndpoint,
          projectId: 'project-a',
        },
        {
          caFingerprint: fingerprint,
          endpoint: secondEndpoint,
          projectId: 'project-a',
        },
      ],
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'authority-integrity-error' }),
      status: 'failure',
    }));

    expect(requestWithMember).toHaveBeenCalledTimes(2);
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('blocks a different CA before creating a client or exposing a credential', async () => {
    const encodedInvitation = codec.encode(invitation(codec, {
      caFingerprint: 'cd'.repeat(32),
    }));

    await expect(coordinator().reconnectProject({
      encodedInvitation,
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'tls-ca-mismatch' }),
      status: 'failure',
    }));

    expect(createHttpClient).not.toHaveBeenCalled();
    expect(requestWithMember).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('blocks an invitation for a Project other than the selected Project', async () => {
    const encodedInvitation = codec.encode(invitation(codec, { projectId: 'project-b' }));

    await expect(coordinator().reconnectProject({
      encodedInvitation,
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'project-not-found' }),
      status: 'failure',
    }));
    expect(foundation.local.projects.loadMembership).not.toHaveBeenCalled();
  });

  it('reconnects the hosted-here Host Member through the ordinary trusted LAN path', async () => {
    currentMembership = {
      ...currentMembership,
      hostOwnership: { ownsAuthority: true },
    };

    await expect(coordinator().reconnectProject({
      encodedInvitation: codec.encode(invitation(codec)),
      projectId: 'project-a',
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'not-host',
        role: currentMembership.member.role,
      },
    });
    expect(createHttpClient).toHaveBeenCalled();
  });

  it('reconnects a foreign-bound Host Member as an ordinary trusted LAN client', async () => {
    currentMembership = {
      ...currentMembership,
      hostOwnership: { ownsAuthority: true },
    };

    await expect(coordinator({
      hostInstallation: {
        inspect: jest.fn().mockResolvedValue('hosted-elsewhere'),
      },
    }).reconnectProject({
      encodedInvitation: codec.encode(invitation(codec)),
      projectId: 'project-a',
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        hostInstallationStatus: 'hosted-elsewhere',
        hostStatus: 'not-host',
        role: currentMembership.member.role,
      },
    });
    expect(requestWithMember).toHaveBeenCalled();
    expect(saveMembership).toHaveBeenCalledWith(expect.objectContaining({
      hostOwnership: { ownsAuthority: true },
      member: currentMembership.member,
    }));
  });

  it('preserves origin and membership when pinned bootstrap fails', async () => {
    createHttpClient.mockReturnValue({
      bootstrapInvitation: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(coordinator().reconnectProject({
      encodedInvitation: codec.encode(invitation(codec)),
      projectId: 'project-a',
    })).resolves.toEqual(expect.objectContaining({ status: 'failure' }));
    expect(requestWithMember).not.toHaveBeenCalled();
    expect(addRemote).not.toHaveBeenCalled();
    expect(saveMembership).not.toHaveBeenCalled();
  });

  it('recovers when origin rotation succeeds but membership persistence fails once', async () => {
    saveMembership.mockRejectedValueOnce(new Error('write failed'));
    const request = {
      encodedInvitation: codec.encode(invitation(codec)),
      projectId: 'project-a',
    };

    await expect(coordinator().reconnectProject(request)).resolves.toEqual(
      expect.objectContaining({ status: 'failure' }),
    );
    expect(originUrls).toEqual([
      `${newEndpoint}/v1/git/project-a/repository.git`,
    ]);
    await expect(coordinator().reconnectProject(request)).resolves.toEqual(
      expect.objectContaining({ status: 'success' }),
    );
    expect(addRemote).toHaveBeenCalledTimes(1);
    expect(saveMembership).toHaveBeenCalledTimes(2);
  });

  it('cannot resurrect a stale Host route after Host Transfer promotes a new authority', async () => {
    const transitions = new AuthorityProjectionTransitionCoordinator();
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>(resolve => {
      requestWithMember.mockImplementation(async request => {
        resolve();
        await new Promise<void>(release => { releaseRefresh = release; });
        return request.decode({
          data: { caFingerprint: fingerprint, endpoint: newEndpoint },
          protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
          requestId: 'refresh-racing-transfer',
        });
      });
    });
    const reconnect = coordinator({ authorityProjectionTransitions: transitions });
    const pendingReconnect = reconnect.reconnectProject({
      encodedInvitation: codec.encode(invitation(codec)),
      projectId: 'project-a',
    });
    await refreshStarted;

    const transferredEndpoint = 'https://192.168.1.30:54545';
    const transferredFingerprint = 'cd'.repeat(32);
    const projection = new LocalHostTransferProjection({
      authorityProjectionTransitions: transitions,
      loadMembership: jest.fn(async () => currentMembership),
      now: () => new Date('2026-08-08T00:02:00.000Z'),
      resolveWorkspace: jest.fn(async () => path.join(vaultRoot, 'workspace/project-a')),
      rotateOrigin: async transition => {
        originUrls = [transition.newRemoteUrl];
      },
      saveMembership,
    });
    await projection.promoteTargetHost({
      autoStart: true,
      endpoint: transferredEndpoint,
      eventSequence: 8,
      ownsAuthority: true,
      projectId: 'project-a',
      targetCaCertificatePem: 'transferred-ca',
      targetCaFingerprint: transferredFingerprint,
      targetHostMemberId: 'member-a',
      transferId: 'transfer-a',
    });
    releaseRefresh();

    await expect(pendingReconnect).resolves.toMatchObject({ status: 'failure' });
    expect(currentMembership).toMatchObject({
      authority: {
        endpoint: transferredEndpoint,
        gitRemoteUrl: `${transferredEndpoint}/v1/git/project-a/repository.git`,
        hostCaFingerprint: transferredFingerprint,
      },
      hostOwnership: { autoStart: true, ownsAuthority: true },
    });
    expect(originUrls).toEqual([
      `${transferredEndpoint}/v1/git/project-a/repository.git`,
    ]);
  });
});
