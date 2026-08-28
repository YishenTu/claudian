import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
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
import { LanAuthorityProjectionTransitionCoordinator } from '@/app/collab/LanAuthorityProjectionTransitionCoordinator';
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
          loadMembership: jest.fn(async () => currentMembership),
          saveMembership,
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
      authorityProjectionTransitions: new LanAuthorityProjectionTransitionCoordinator(),
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
    const transitions = new LanAuthorityProjectionTransitionCoordinator();
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
