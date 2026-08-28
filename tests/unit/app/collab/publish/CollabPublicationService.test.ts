import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
} from '@claudian-collab/protocol';
import {
  completeCollabPublicationOptions,
} from '@test/helpers/collab/CollabFeatureTestHarness';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import type {
  CollabLocalCloudMembershipRecord,
  CollabLocalLanMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import {
  type CollabPublicationFoundationPort,
  CollabPublicationService,
} from '@/app/collab/publish/CollabPublicationService';
import type { CollabRequestDraftRecord } from '@/app/collab/publish/CollabRequestDraftRecord';
import { type CollabUpdateRequestMetadataRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function publicationOptions(
  overrides: Omit<
    Parameters<typeof completeCollabPublicationOptions>[0],
    'vaultRoot'
  > = {},
) {
  return completeCollabPublicationOptions({ ...overrides, vaultRoot: '/vault' });
}

const CLOUD_PROJECT_ID = 'project-cloud';
const CLOUD_MEMBER_ID = 'member-cloud';
const CLOUD_CREATED_AT = '2026-08-24T00:00:00.000Z';
const LAN_PROJECT_ID = 'project-lan-lanes';
const LAN_MEMBER_ID = 'member-lan-lanes';
const LAN_CREDENTIAL = 'A'.repeat(43);
let LAN_CA: string;
let LAN_FINGERPRINT: string;
const LAN_STORED_ENDPOINT = 'https://192.168.1.20:41730';
const LAN_ACTIVE_ENDPOINT = 'https://192.168.1.44:41731';

function cloudMembership(serverUrl: string): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      bindingVersion: 2,
      developmentActorId: CLOUD_MEMBER_ID,
      gitRemoteUrl: `${serverUrl}/v2/projects/${CLOUD_PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl,
      wireVersion: 6,
    },
    createdAt: CLOUD_CREATED_AT,
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      displayName: 'Cloud member',
      id: CLOUD_MEMBER_ID,
      personalRef: `refs/heads/members/${CLOUD_MEMBER_ID}`,
      role: 'manager',
    },
    project: {
      id: CLOUD_PROJECT_ID,
      name: 'Cloud Project',
      workspacePath: `workspace/${CLOUD_PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CLOUD_CREATED_AT,
  };
}

function cloudSnapshot() {
  const currentMember = {
    activatedAt: CLOUD_CREATED_AT,
    createdAt: CLOUD_CREATED_AT,
    displayName: 'Cloud member',
    id: CLOUD_MEMBER_ID,
    personalRef: `refs/heads/members/${CLOUD_MEMBER_ID}`,
    role: 'manager' as const,
    status: 'active' as const,
  };
  return COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse({
    currentMember,
    eventSequence: 1,
    members: [currentMember],
    openRequests: [],
    openTicketCount: 0,
    project: {
      createdAt: CLOUD_CREATED_AT,
      expectedMainOid: 'a'.repeat(40),
      id: CLOUD_PROJECT_ID,
      mainRef: 'refs/heads/main',
      name: 'Cloud Project',
    },
    ticketHighlights: [],
  });
}

function lanMembership(ownsAuthority: boolean): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: LAN_STORED_ENDPOINT,
      gitRemoteUrl: `${LAN_STORED_ENDPOINT}/v1/git/${LAN_PROJECT_ID}/repository.git`,
      hostCaCertificatePem: LAN_CA,
      hostCaFingerprint: LAN_FINGERPRINT,
      kind: 'lan',
    },
    createdAt: CLOUD_CREATED_AT,
    hostOwnership: { ownsAuthority },
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      credential: LAN_CREDENTIAL,
      displayName: 'LAN member',
      id: LAN_MEMBER_ID,
      personalRef: `refs/heads/members/${LAN_MEMBER_ID}`,
      role: 'manager',
    },
    project: {
      id: LAN_PROJECT_ID,
      name: 'LAN Project',
      workspacePath: `workspace/${LAN_PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CLOUD_CREATED_AT,
  };
}

function lanSnapshot() {
  const currentMember = {
    activatedAt: CLOUD_CREATED_AT,
    createdAt: CLOUD_CREATED_AT,
    displayName: 'LAN member',
    id: LAN_MEMBER_ID,
    personalRef: `refs/heads/members/${LAN_MEMBER_ID}`,
    role: 'manager' as const,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 1,
    members: [currentMember],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'lan' as const,
      createdAt: CLOUD_CREATED_AT,
      hostMemberId: LAN_MEMBER_ID,
      id: LAN_PROJECT_ID,
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main' as const,
      managerSetGeneration: 1,
      name: 'LAN Project',
    },
    ticketHighlights: [],
  };
}

const cloudLimits = {
  maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
  maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
  maxCheckpointRepositoryBundleBytes:
    COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
  maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
  maxDevelopmentBootstrapGitBundleBytes: 1_024,
  maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
  maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
  maxEventReplay: 100,
  maxGitReceivePackBytes: 1_024,
  maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
  maxRepositoryBytes: 1_024,
};

describe('CollabPublicationService reconnect', () => {
  let tlsRoot: string;

  beforeAll(async () => {
    tlsRoot = await mkdtemp(path.join(tmpdir(), 'claudian-publication-lanes-'));
    const identity = await new LanTlsIdentity(tlsRoot, {
      installationKey: TEST_INSTALLATION_A,
    }).loadOrCreate();
    LAN_CA = identity.caCertificatePem;
    LAN_FINGERPRINT = identity.caFingerprint;
  });

  afterAll(async () => {
    await rm(tlsRoot, { force: true, recursive: true });
  });

  it.each([
    ['ordinary Member', false, 'absent', null, LAN_STORED_ENDPOINT],
    ['Host Member hosted elsewhere', true, 'hosted-elsewhere', null, LAN_STORED_ENDPOINT],
    ['Host Member hosted here', true, 'hosted-here', LAN_ACTIVE_ENDPOINT, LAN_ACTIVE_ENDPOINT],
  ] as const)(
    'keeps snapshot and mutation on one LAN client seam for the %s lane',
    async (_lane, ownsAuthority, installationStatus, localEndpoint, expectedEndpoint) => {
      const membership = lanMembership(ownsAuthority);
      const requests: Array<{ credential: string; endpoint: string; path: string }> = [];
      const request = jest.spyOn(PinnedCollabHttpClient.prototype, 'requestWithMember')
        .mockImplementation(function (this: PinnedCollabHttpClient, request, credential) {
          requests.push({ credential, endpoint: this.trust.endpoint, path: request.path });
          return Promise.resolve(
            request.path.endsWith('/snapshot')
              ? lanSnapshot()
              : { ticket: { id: 'ticket-lane' } },
          ) as never;
        });
      const projects = {
        loadMembership: jest.fn().mockResolvedValue(membership),
        loadProjectDocument: jest.fn().mockResolvedValue(null),
        removeProjectDocument: jest.fn().mockResolvedValue(false),
        saveProjectDocument: jest.fn().mockResolvedValue(undefined),
        updateMembershipProjection: jest.fn().mockResolvedValue(membership),
      };
      const service = new CollabPublicationService({
        local: { pathPolicy: {}, projects, workspace: {} },
        requireGitFoundation: jest.fn(),
      } as unknown as CollabPublicationFoundationPort, publicationOptions({
        inspectHostInstallation: async () => installationStatus,
        readActiveLocalRoute: () => localEndpoint === null ? null : {
          caCertificatePem: LAN_CA,
          caFingerprint: LAN_FINGERPRINT,
          endpoint: localEndpoint,
          projectId: LAN_PROJECT_ID,
        },
      }));

      try {
        await expect(service.readSnapshot(LAN_PROJECT_ID)).resolves.toMatchObject({
          currentMember: {
            id: LAN_MEMBER_ID,
            personalRef: membership.member.personalRef,
            role: membership.member.role,
          },
          project: { id: LAN_PROJECT_ID },
        });
        await expect(service.createTicket({
          body: 'Body',
          projectId: LAN_PROJECT_ID,
          title: 'Title',
        }, {}, 'ticket-lane-intent')).resolves.toMatchObject({
          ticket: { id: 'ticket-lane' },
        });
        expect(requests).toEqual([
          { credential: LAN_CREDENTIAL, endpoint: expectedEndpoint, path: expect.any(String) },
          { credential: LAN_CREDENTIAL, endpoint: expectedEndpoint, path: expect.any(String) },
        ]);
        expect(membership.member).toMatchObject({
          credential: LAN_CREDENTIAL,
          id: LAN_MEMBER_ID,
          role: 'manager',
        });
      } finally {
        request.mockRestore();
        await service.close();
      }
    },
  );

  it('reads an authoritative lifecycle snapshot without re-entering projection reconciliation', async () => {
    const membership = lanMembership(false);
    const request = jest.spyOn(PinnedCollabHttpClient.prototype, 'requestWithMember')
      .mockResolvedValue(lanSnapshot() as never);
    const projects = {
      loadMembership: jest.fn().mockResolvedValue(membership),
      loadProjectDocument: jest.fn().mockResolvedValue(null),
      removeProjectDocument: jest.fn().mockResolvedValue(false),
      saveProjectDocument: jest.fn().mockResolvedValue(undefined),
      updateMembershipProjection: jest.fn().mockResolvedValue(membership),
    };
    const reconcileSnapshot = jest.fn().mockRejectedValue(
      new Error('lifecycle re-entry must not be attempted'),
    );
    const service = new CollabPublicationService({
      local: { pathPolicy: {}, projects, workspace: {} },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      managerResponsibility: { reconcileSnapshot },
      inspectHostInstallation: async () => 'absent',
      readActiveLocalRoute: () => null,
    }));

    try {
      await expect(
        service.transferSnapshot(LAN_PROJECT_ID),
      ).resolves.toMatchObject({
        snapshot: {
          currentMember: { id: LAN_MEMBER_ID },
          project: { id: LAN_PROJECT_ID },
        },
        source: 'online',
        stale: false,
        syncState: {
          eventSequence: 1,
          projectId: LAN_PROJECT_ID,
          status: 'synchronized',
        },
      });
      expect(reconcileSnapshot).not.toHaveBeenCalled();
      expect(projects.saveProjectDocument).not.toHaveBeenCalled();
      expect(projects.updateMembershipProjection).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      await service.close();
    }
  });

  it('reconnects a direct LAN mutation after stale endpoint failure without a prior snapshot', async () => {
    let currentMembership = lanMembership(false);
    const requests: string[] = [];
    const request = jest.spyOn(PinnedCollabHttpClient.prototype, 'requestWithMember')
      .mockImplementation(function (this: PinnedCollabHttpClient, input) {
        requests.push(this.trust.endpoint);
        if (this.trust.endpoint === LAN_STORED_ENDPOINT) {
          return Promise.reject(new CollabError({ code: 'endpoint-unreachable' }));
        }
        return Promise.resolve({ ticket: { id: 'ticket-after-reconnect' } }) as never;
      });
    const projects = {
      loadMembership: jest.fn(async () => currentMembership),
      loadProjectDocument: jest.fn().mockResolvedValue(null),
      removeProjectDocument: jest.fn().mockResolvedValue(false),
      saveProjectDocument: jest.fn().mockResolvedValue(undefined),
      updateMembershipProjection: jest.fn().mockResolvedValue(undefined),
    };
    const candidate = {
      caFingerprint: LAN_FINGERPRINT,
      endpoint: LAN_ACTIVE_ENDPOINT,
      projectId: LAN_PROJECT_ID,
    };
    const reconnectDiscoveredProject = jest.fn(async () => {
      currentMembership = {
        ...currentMembership,
        authority: {
          ...currentMembership.authority,
          endpoint: LAN_ACTIVE_ENDPOINT,
          gitRemoteUrl: `${LAN_ACTIVE_ENDPOINT}/v1/git/${LAN_PROJECT_ID}/repository.git`,
        },
      };
      return { status: 'success' as const, value: {} as never };
    });
    const service = new CollabPublicationService({
      local: { pathPolicy: {}, projects, workspace: {} },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      discovery: {
        discoverProjectCandidates: jest.fn().mockResolvedValue([candidate]),
      },
      inspectHostInstallation: async () => 'hosted-elsewhere',
      reconnect: {
        reconnectDiscoveredProject,
        reconnectProject: jest.fn(),
      },
    }));

    try {
      await expect(service.createTicket({
        body: 'Body',
        projectId: LAN_PROJECT_ID,
        title: 'Title',
      }, {}, 'ticket-stale-endpoint')).resolves.toMatchObject({
        ticket: { id: 'ticket-after-reconnect' },
      });
      expect(requests).toEqual([LAN_STORED_ENDPOINT, LAN_ACTIVE_ENDPOINT]);
      expect(reconnectDiscoveredProject).toHaveBeenCalledWith({
        candidates: [candidate],
        projectId: LAN_PROJECT_ID,
      }, {});
    } finally {
      request.mockRestore();
      await service.close();
    }
  });

  it('uses the production Cloud adapter composition without renderer fetch', async () => {
    const routes: string[] = [];
    const server = createServer((request, response) => {
      routes.push(request.url ?? '');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      if (request.method === 'GET') {
        response.end(JSON.stringify(collabCloudCapabilityDocument([
          'project-snapshot',
        ], cloudLimits)));
        return;
      }
      response.end(JSON.stringify(collabCloudSuccessEnvelope(
        'response-snapshot',
        cloudSnapshot(),
      )));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const membership = cloudMembership(`http://127.0.0.1:${address.port}`);
    const projects = {
      loadMembership: jest.fn().mockResolvedValue(membership),
      loadProjectDocument: jest.fn().mockResolvedValue(null),
      removeProjectDocument: jest.fn().mockResolvedValue(false),
      saveProjectDocument: jest.fn().mockResolvedValue(undefined),
      updateMembershipProjection: jest.fn().mockResolvedValue(membership),
    };
    const service = new CollabPublicationService({
      local: { pathPolicy: {}, projects, workspace: {} },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions());
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('renderer fetch is disabled'),
    );

    try {
      await expect(service.readSnapshot(CLOUD_PROJECT_ID)).resolves.toMatchObject({
        currentMember: { id: CLOUD_MEMBER_ID },
        project: { authorityKind: 'cloud', id: CLOUD_PROJECT_ID },
      });
      expect(routes).toEqual([
        '/collab/capabilities',
        `/v2/projects/${CLOUD_PROJECT_ID}/operations/getProjectSnapshot`,
      ]);
    } finally {
      fetchMock.mockRestore();
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it('forwards terminal fallback delivery to the configured retirement handler', async () => {
    const retirement = { handle: jest.fn().mockResolvedValue(undefined) };
    const service = new CollabPublicationService({
      local: { pathPolicy: {}, projects: {} },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      retirement,
    }));
    const projection = (service as unknown as {
      projection: {
        handleRetirement(
          result: { readonly projectId: string; readonly retiredAt: string },
          source: 'response' | 'terminal-fallback',
        ): Promise<void>;
      };
    }).projection;
    const result = {
      projectId: 'project-a',
      retiredAt: '2026-08-13T00:00:00.000Z',
    };

    await projection.handleRetirement(result, 'terminal-fallback');

    expect(retirement.handle).toHaveBeenCalledWith(result, 'terminal-fallback');
  });

  it('discovers and reconnects an offline Member under its stored CA', async () => {
    const candidate = {
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
      projectId: 'project-a',
    };
    const discovery = {
      discoverProjectCandidates: jest.fn().mockResolvedValue([candidate]),
    };
    const reconnect = {
      reconnectDiscoveredProject: jest.fn().mockResolvedValue({
        status: 'success',
        value: {
          authorityKind: 'lan',
          connectionStatus: 'connected',
          health: 'healthy',
          hostStatus: 'not-host',
          id: 'project-a',
          name: 'Alpha',
          role: 'member',
          workspacePath: 'workspace/project-a',
        },
      }),
      reconnectProject: jest.fn(),
    };
    const service = new CollabPublicationService({
      local: {
        pathPolicy: {},
        projects: {
          loadMembership: jest.fn().mockResolvedValue({
            authority: { hostCaFingerprint: 'ab'.repeat(32), kind: 'lan' },
            hostOwnership: { ownsAuthority: false },
          }),
        },
      },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      discovery,
      reconnect,
    }));

    await expect(service.tryAutoReconnect('project-a')).resolves.toBe(true);

    expect(discovery.discoverProjectCandidates).toHaveBeenCalledWith(
      'project-a',
      'ab'.repeat(32),
      {},
    );
    expect(reconnect.reconnectDiscoveredProject).toHaveBeenCalledWith({
      candidates: [candidate],
      projectId: 'project-a',
    }, {});
  });

  it('uses ordinary trusted discovery for a hosted-here Host Member', async () => {
    const candidate = {
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.21:54545',
      projectId: 'project-a',
    };
    const discovery = {
      discoverProjectCandidates: jest.fn().mockResolvedValue([candidate]),
    };
    const reconnectDiscoveredProject = jest.fn().mockResolvedValue({
      status: 'success',
      value: {},
    });
    const service = new CollabPublicationService({
      local: {
        pathPolicy: {},
        projects: {
          loadMembership: jest.fn().mockResolvedValue({
            authority: { hostCaFingerprint: 'ab'.repeat(32), kind: 'lan' },
            hostOwnership: { ownsAuthority: true },
          }),
        },
      },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      discovery,
      inspectHostInstallation: async () => 'hosted-here',
      reconnect: {
        reconnectDiscoveredProject,
        reconnectProject: jest.fn(),
      },
    }));

    await expect(service.tryAutoReconnect('project-a')).resolves.toBe(true);
    expect(discovery.discoverProjectCandidates).toHaveBeenCalled();
    expect(reconnectDiscoveredProject).toHaveBeenCalledWith({
      candidates: [candidate],
      projectId: 'project-a',
    }, {});
  });

  it('coalesces concurrent automatic reconnect attempts for one Project', async () => {
    const candidate = deferred<readonly {
      caFingerprint: string;
      endpoint: string;
      projectId: string;
    }[]>();
    const discovery = {
      discoverProjectCandidates: jest.fn().mockReturnValue(candidate.promise),
    };
    const reconnect = {
      reconnectDiscoveredProject: jest.fn().mockResolvedValue({
        status: 'success',
        value: {
          authorityKind: 'lan',
          connectionStatus: 'connected',
          health: 'healthy',
          hostStatus: 'not-host',
          id: 'project-a',
          name: 'Alpha',
          role: 'member',
          workspacePath: 'workspace/project-a',
        },
      }),
      reconnectProject: jest.fn(),
    };
    const service = new CollabPublicationService({
      local: {
        pathPolicy: {},
        projects: {
          loadMembership: jest.fn().mockResolvedValue({
            authority: { hostCaFingerprint: 'ab'.repeat(32), kind: 'lan' },
            hostOwnership: { ownsAuthority: false },
          }),
        },
      },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      discovery,
      reconnect,
    }));

    const first = service.tryAutoReconnect('project-a');
    const second = service.tryAutoReconnect('project-a');

    candidate.resolve([{
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
      projectId: 'project-a',
    }]);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(discovery.discoverProjectCandidates).toHaveBeenCalledTimes(1);
    expect(reconnect.reconnectDiscoveredProject).toHaveBeenCalledTimes(1);
  });

  it('surfaces a discovered authority split instead of hiding it as offline', async () => {
    const discovery = {
      discoverProjectCandidates: jest.fn().mockResolvedValue([{
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
        projectId: 'project-a',
      }]),
    };
    const integrityError = new CollabError({
      code: 'authority-integrity-error',
      recoveryActions: ['open-diagnostics'],
    });
    const reconnect = {
      reconnectDiscoveredProject: jest.fn().mockResolvedValue({
        error: integrityError,
        status: 'failure',
      }),
      reconnectProject: jest.fn(),
    };
    const service = new CollabPublicationService({
      local: {
        pathPolicy: {},
        projects: {
          loadMembership: jest.fn().mockResolvedValue({
            authority: { hostCaFingerprint: 'ab'.repeat(32), kind: 'lan' },
            hostOwnership: { ownsAuthority: false },
          }),
        },
      },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      discovery,
      reconnect,
    }));

    await expect(service.tryAutoReconnect('project-a')).rejects.toBe(integrityError);
  });

  it('serializes same-Project reconnect transactions behind its mutation queue', async () => {
    const first = deferred<{
      status: 'success';
      value: {
        authorityKind: 'lan';
        connectionStatus: 'connected';
        health: 'healthy';
        hostStatus: 'not-host';
        id: string;
        name: string;
        role: 'member';
        workspacePath: string;
      };
    }>();
    const reconnect = {
      reconnectProject: jest.fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({
          status: 'success',
          value: {
            authorityKind: 'lan',
            connectionStatus: 'connected',
            health: 'healthy',
            hostStatus: 'not-host',
            id: 'project-a',
            name: 'Alpha',
            role: 'member',
            workspacePath: 'workspace/project-a',
          },
        }),
    };
    const service = new CollabPublicationService({
      local: {
        pathPolicy: {},
        projects: {},
      },
      requireGitFoundation: jest.fn(),
    } as unknown as CollabPublicationFoundationPort, publicationOptions({
      reconnect,
    }));
    const request = {
      encodedInvitation: 'claudian-collab:v2:payload',
      projectId: 'project-a',
    };

    const firstResult = service.reconnectProject(request);
    const secondResult = service.reconnectProject(request);
    await Promise.resolve();
    expect(reconnect.reconnectProject).toHaveBeenCalledTimes(1);

    first.resolve({
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'connected',
        health: 'healthy',
        hostStatus: 'not-host',
        id: 'project-a',
        name: 'Alpha',
        role: 'member',
        workspacePath: 'workspace/project-a',
      },
    });
    await expect(firstResult).resolves.toMatchObject({ status: 'success' });
    await expect(secondResult).resolves.toMatchObject({ status: 'success' });
    expect(reconnect.reconnectProject).toHaveBeenCalledTimes(2);
  });

  it('serializes same-Project request metadata writes and preserves the failed newer draft', async () => {
    const first = deferred<ReturnType<typeof changeRequest>>();
    const second = deferred<ReturnType<typeof changeRequest>>();
    const control = {
      updateRequestMetadata: jest.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const draftStore = memoryDraftStore();
    const service = publicationServiceHarness(control, draftStore);
    const firstRequest = metadataRequest('First description', 1, 'intent-first');
    const secondRequest = metadataRequest('Second description', 2, 'intent-second');

    const firstSave = service.updateRequestMetadata(firstRequest, {}, 'metadata-first');
    const secondSave = service.updateRequestMetadata(secondRequest, {}, 'metadata-second');
    await nextTurn();
    expect(control.updateRequestMetadata).toHaveBeenCalledTimes(1);

    first.resolve(changeRequest('First description', 2));
    await expect(firstSave).resolves.toMatchObject({ description: 'First description' });
    await nextTurn();
    expect(control.updateRequestMetadata).toHaveBeenCalledTimes(2);
    second.reject(new Error('network failed'));
    await expect(secondSave).rejects.toThrow('network failed');

    await expect(draftStore.load('project-a')).resolves.toMatchObject({
      description: 'Second description',
      syncState: 'needs-attention',
    });
  });

  it('does not remove a newer exact draft when an older metadata acknowledgement arrives', async () => {
    const draftStore = memoryDraftStore();
    const newerDraft = requestDraft('Newer local description', 'local');
    const control = {
      updateRequestMetadata: jest.fn(async () => {
        await draftStore.save(newerDraft);
        return changeRequest('Older acknowledged description', 2);
      }),
    };
    const service = publicationServiceHarness(control, draftStore);

    await expect(service.updateRequestMetadata(
      metadataRequest('Older acknowledged description', 1, 'intent-older'),
      {},
      'metadata-older',
    )).resolves.toMatchObject({ description: 'Older acknowledged description' });

    await expect(draftStore.load('project-a')).resolves.toEqual(newerDraft);
  });

  it('fails closed when a suspended work session was terminally drained', async () => {
    const service = publicationServiceForClose();
    const suspension = await service.suspendProject('project-a');
    await service.drainProject('project-a');

    await expect(service.resumeProject(suspension)).rejects.toMatchObject({
      safeContext: { reason: 'collab-project-work-session-resume-failed' },
    });
  });

  it('shares an overlapping close and tears down local projection after sessions settle', async () => {
    const sessionClose = deferred<void>();
    const service = publicationServiceForClose();
    const harness = service as unknown as {
      coordinationListeners: Set<unknown>;
      projection: { dispose(): void };
      sessions: { close(): Promise<void> };
    };
    const closeSessions = jest.spyOn(harness.sessions, 'close')
      .mockReturnValue(sessionClose.promise);
    const disposeProjection = jest.spyOn(harness.projection, 'dispose');
    service.subscribeCoordination(jest.fn());

    const first = service.close();
    const overlapping = service.close();

    expect(overlapping).toBe(first);
    expect(closeSessions).toHaveBeenCalledTimes(1);
    expect(disposeProjection).not.toHaveBeenCalled();
    expect(harness.coordinationListeners.size).toBe(1);

    sessionClose.resolve();
    await expect(Promise.all([first, overlapping])).resolves.toEqual([undefined, undefined]);
    expect(disposeProjection).toHaveBeenCalledTimes(1);
    expect(harness.coordinationListeners.size).toBe(0);
    expect(service).not.toHaveProperty('dispose');
  });

  it('shares a rejected close and tears down local projection exactly once', async () => {
    const sessionClose = deferred<void>();
    const service = publicationServiceForClose();
    const harness = service as unknown as {
      coordinationListeners: Set<unknown>;
      projection: { dispose(): void };
      sessions: { close(): Promise<void> };
    };
    const closeSessions = jest.spyOn(harness.sessions, 'close')
      .mockReturnValue(sessionClose.promise);
    const disposeProjection = jest.spyOn(harness.projection, 'dispose');
    service.subscribeCoordination(jest.fn());

    const first = service.close();
    const overlapping = service.close();
    const failure = new Error('session close failed');
    const outcomes = Promise.allSettled([first, overlapping]);

    expect(overlapping).toBe(first);
    sessionClose.reject(failure);
    await expect(outcomes).resolves.toEqual([
      { reason: failure, status: 'rejected' },
      { reason: failure, status: 'rejected' },
    ]);
    expect(closeSessions).toHaveBeenCalledTimes(1);
    expect(disposeProjection).toHaveBeenCalledTimes(1);
    expect(harness.coordinationListeners.size).toBe(0);
  });
});

function publicationServiceForClose(): CollabPublicationService {
  return new CollabPublicationService({
    local: { pathPolicy: {}, projects: {} },
    requireGitFoundation: jest.fn(),
  } as unknown as CollabPublicationFoundationPort, publicationOptions());
}

function publicationServiceHarness(
  control: { updateRequestMetadata: jest.Mock },
  requestDrafts: ReturnType<typeof memoryDraftStore>,
): CollabPublicationService {
  const service = new CollabPublicationService({
    local: { pathPolicy: {}, projects: {} },
    requireGitFoundation: jest.fn(),
  } as unknown as CollabPublicationFoundationPort, publicationOptions());
  const harness = service as unknown as {
    control: typeof control;
    runtime: () => Promise<{ requestDrafts: typeof requestDrafts }>;
  };
  harness.control = control;
  harness.runtime = jest.fn().mockResolvedValue({ requestDrafts });
  return service;
}

function memoryDraftStore() {
  let draft: CollabRequestDraftRecord | null = null;
  return {
    load: jest.fn(async (_projectId: string) => draft),
    remove: jest.fn(async (_projectId: string) => {
      const existed = draft !== null;
      draft = null;
      return existed;
    }),
    save: jest.fn(async (record: CollabRequestDraftRecord) => {
      draft = record;
    }),
  };
}

function metadataRequest(
  description: string,
  expectedRequestRevision: number,
  intentId: string,
): CollabUpdateRequestMetadataRequest {
  return {
    description,
    expectedHeadOid: '2'.repeat(40),
    expectedRequestRevision,
    intentId,
    projectId: 'project-a',
    requestId: 'request-a',
  };
}

function changeRequest(description: string, revision: number) {
  return {
    commentCount: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
    description,
    firstBaseOid: '1'.repeat(40),
    id: 'request-a',
    latestHeadOid: '2'.repeat(40),
    memberId: 'member-a',
    revision,
    status: 'open' as const,
    ticketRelations: [],
    updatedAt: '2026-08-08T00:01:00.000Z',
  };
}

function requestDraft(
  description: string,
  syncState: CollabRequestDraftRecord['syncState'],
): CollabRequestDraftRecord {
  return {
    createdAt: '2026-08-08T00:00:00.000Z',
    description,
    projectId: 'project-a',
    schemaVersion: 1,
    syncState,
    updatedAt: '2026-08-08T00:01:00.000Z',
  };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
