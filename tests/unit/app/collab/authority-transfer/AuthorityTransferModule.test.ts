import { createHash } from 'node:crypto';

import type {
  CollabAuthorityTransferStatus,
  CollabCloudCapability,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  AuthorityTransferModule,
} from '@/app/collab/authority-transfer/AuthorityTransferModule';
import type {
  AuthorityTransferRecord} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  createAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  AuthorityTransferClaimantBindingResolver,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantBindingResolver';
import {
  type AuthorityTransferClaimantPhase,
  type AuthorityTransferClaimantRecord,
  decodeAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type {
  AuthorityTransferClaimantRecovery,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecovery';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type {
  CloudAuthorityLifecycleSession,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';

const PROJECT_ID = 'project-authority-transfer-module';
const TRANSFER_ID = 'transfer-authority-transfer-module';

function recoverableClaimantRecord(input: Readonly<{
  direction?: 'cloud-to-lan' | 'lan-to-cloud';
  expiresAt?: string;
  phase?: AuthorityTransferClaimantPhase;
}> = {}): AuthorityTransferClaimantRecord {
  const direction = input.direction ?? 'lan-to-cloud';
  const phase = input.phase ?? 'source-acknowledged';
  const phaseIndex = [
    'prepared',
    'claim-retained',
    'credential-persisted',
    'target-claimed',
    'source-acknowledged',
    'membership-converged',
    'completed',
  ].indexOf(phase);
  const claimValue = Buffer.alloc(32, 4).toString('base64url');
  const checkpointSha256 = 'a'.repeat(64);
  const sourceAuthority = direction === 'lan-to-cloud'
    ? { generation: 1, kind: 'lan' as const }
    : { generation: 1, kind: 'cloud' as const };
  const targetAuthority = direction === 'lan-to-cloud'
    ? { generation: 2, kind: 'cloud' as const }
    : { generation: 2, kind: 'lan' as const };
  const targetUrl = direction === 'lan-to-cloud'
    ? 'https://cloud.example.test/'
    : 'https://192.168.1.20:54545';
  const status: CollabAuthorityTransferStatus = {
    batchRevision: 1,
    batchSha256: 'b'.repeat(64),
    checkpointSha256,
    createdAt: '2026-08-27T00:00:00.000Z',
    direction,
    expiresAt: input.expiresAt ?? '2026-09-26T00:00:00.000Z',
    phase: 'completed',
    projectId: PROJECT_ID,
    relinquishmentProof: {
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
      certificate: Buffer.alloc(64, 2).toString('base64url'),
      certificateAlgorithm: 'ed25519',
      checkpointSha256,
      committedAt: '2026-08-27T00:00:08.000Z',
      operationIntentId: 'intent-transfer-owner',
      projectId: PROJECT_ID,
      sourceAuthority,
      sourceHostMemberId: direction === 'lan-to-cloud' ? 'member-host' : null,
      targetAuthority,
      transferId: TRANSFER_ID,
    } as never,
    sourceAuthority,
    state: 'completed',
    targetAuthority,
    targetUrl,
    transferId: TRANSFER_ID,
    updatedAt: '2026-08-27T00:00:10.000Z',
  };
  return decodeAuthorityTransferClaimantRecord({
    claim: phaseIndex >= 1
      ? {
          claim: claimValue,
          expiresAt: status.expiresAt,
          memberId: 'member-host',
          projectId: PROJECT_ID,
          targetAuthorityGeneration: 2,
          transferId: TRANSFER_ID,
        }
      : null,
    createdAt: status.createdAt,
    kind: 'authority-transfer-claimant',
    lanTarget: direction === 'cloud-to-lan'
      ? {
          caCertificatePem: [
            '-----BEGIN CERTIFICATE-----',
            'authority-transfer-test',
            '-----END CERTIFICATE-----',
          ].join('\n'),
          caFingerprint: 'c'.repeat(64),
          endpoint: targetUrl,
        }
      : null,
    memberId: 'member-host',
    operationIntentId: 'intent-claimant-recovery',
    phase,
    projectId: PROJECT_ID,
    redemptionReceipt: phaseIndex >= 3
      ? {
          checkpointSha256,
          claimSha256: createHash('sha256').update(claimValue, 'utf8').digest('hex'),
          memberId: 'member-host',
          operationIntentId: 'intent-claimant-recovery',
          projectId: PROJECT_ID,
          receiptId: 'receipt-claimant-recovery',
          receiptKeyId: 'receipt-key-recovery',
          redeemedAt: '2026-08-27T00:01:00.000Z',
          signature: Buffer.alloc(64, 3).toString('base64url'),
          signatureAlgorithm: 'ed25519',
          targetAuthorityGeneration: 2,
          transferId: TRANSFER_ID,
        }
      : null,
    schemaVersion: 1,
    status,
    targetCredential: direction === 'cloud-to-lan' && phaseIndex >= 2
      ? Buffer.alloc(32, 5).toString('base64url')
      : null,
    transferId: TRANSFER_ID,
    updatedAt: '2026-08-27T00:01:01.000Z',
  });
}

function proposal(): CollabAuthorityTransferStatus {
  return {
    batchRevision: null,
    batchSha256: null,
    checkpointSha256: null,
    createdAt: '2026-08-27T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: '2026-09-26T00:00:00.000Z',
    phase: 'collecting-readiness',
    projectId: PROJECT_ID,
    relinquishmentProof: null,
    sourceAuthority: { generation: 1, kind: 'lan' },
    state: 'active',
    targetAuthority: { generation: 2, kind: 'cloud' },
    targetUrl: 'https://cloud.example.test/',
    transferId: TRANSFER_ID,
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

describe('AuthorityTransferModule', () => {
  it('resolves an expired Cloud-to-LAN redemption without the relinquished Cloud source', async () => {
    const createCloudLifecycle = jest.fn(async () => {
      throw new Error('Cloud source must remain unavailable');
    });
    const record = recoverableClaimantRecord({
      direction: 'cloud-to-lan',
      expiresAt: '2026-08-27T01:00:00.000Z',
      phase: 'target-claimed',
    });
    const resolver = new AuthorityTransferClaimantBindingResolver({
      createCloudLifecycle,
      loadMembership: async () => ({
        authority: {
          authorityGeneration: 1,
          bindingVersion: 2,
          developmentActorId: 'member-host',
          gitRemoteUrl: `https://cloud.example.test/v2/projects/${PROJECT_ID}/repository.git`,
          kind: 'cloud',
          serverUrl: 'https://cloud.example.test/',
          wireVersion: 6,
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        lastEventSequence: 1,
        member: {
          displayName: 'Host',
          id: 'member-host',
          personalRef: 'refs/heads/members/member-host',
          role: 'manager',
        },
        project: {
          id: PROJECT_ID,
          name: 'Recovery',
          workspacePath: 'workspace/recovery',
        },
        schemaVersion: 3,
        updatedAt: '2026-08-27T00:00:00.000Z',
      }),
      now: () => new Date('2026-08-27T01:00:00.000Z'),
    });

    await expect(resolver.resolve(record)).resolves.toEqual({
      direction: 'cloud-to-lan',
      mode: 'target-only',
      targetHost: record.lanTarget,
    });
    expect(createCloudLifecycle).not.toHaveBeenCalled();
  });

  it('registers both durable recovery owners and installs a bound LAN source service', async () => {
    let record: AuthorityTransferRecord | null = null;
    const registeredOwners: string[] = [];
    const registeredStages: string[] = [];
    const lifecycle = {
      registerDurableOwner: (owner: { readonly name: string }) => {
        registeredOwners.push(owner.name);
      },
      registerRecoveryStage: (stage: { readonly name: string }) => {
        registeredStages.push(stage.name);
      },
      runExclusive: async <Result>(
        _projectId: string,
        _owner: string,
        _mode: string,
        operation: () => Promise<Result>,
      ) => operation(),
    } as unknown as CollabProjectLifecycleSubsystem;
    const persistence = {
      create: async (created: AuthorityTransferRecord) => {
        record = created;
      },
      load: async () => record,
    } as unknown as AuthorityTransferPersistence;
    const module = new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource: (_projectId, session) => ({
        acceptanceRequest: jest.fn(),
        acceptProposal: jest.fn(),
        activateTerminal: jest.fn(),
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(),
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn((request) => session.lifecycle.authorityTransfer(
          'requestLanToCloudTransfer',
          request,
        )),
      }),
      lifecycle,
      persistence,
    });
    const binding = await module.bindLanToCloudSource({
      cloudSession: {
        developmentActorId: 'member-host',
        dispose: jest.fn(),
        lifecycle: {
          authorityTransfer: jest.fn(async () => proposal()),
        },
        projectId: PROJECT_ID,
        readSnapshot: jest.fn(),
        serverUrl: 'https://cloud.example.test/',
        supports: (capability: CollabCloudCapability) => (
          capability === 'authority-transfer' || capability === 'project-snapshot'
        ),
      } as unknown as CloudAuthorityLifecycleSession,
      projectId: PROJECT_ID,
    });
    const service = module.sourceActiveService({
      authenticateMemberCredential: async () => ({ memberId: 'member-host' }),
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
    });

    expect(registeredOwners).toEqual([
      'authority-transfer',
      'authority-transfer-claimant',
    ]);
    expect(registeredStages).toEqual([
      'authority-transfers',
      'authority-transfer-claimants',
    ]);
    await expect(service!.requestLanToCloudTransfer(
      { memberId: 'member-any' },
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-authority-transfer-module',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test/',
      },
    )).resolves.toMatchObject({ transferId: TRANSFER_ID });
    await expect(service!.getProjectAuthorityTransfer(
      { memberId: 'member-any' },
      { projectId: PROJECT_ID, transferId: TRANSFER_ID },
    )).resolves.toMatchObject({ phase: 'collecting-readiness' });
    await expect(service!.acceptLanToCloudTransferTarget(
      { memberId: 'member-not-host' },
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-host-acceptance',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test/',
        transferId: TRANSFER_ID,
      },
    )).rejects.toMatchObject({ code: 'authorization-denied' });

    await binding.dispose();
    expect(module.sourceActiveService({
      authenticateMemberCredential: async () => ({ memberId: 'member-host' }),
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
    })).toBeNull();
  });

  it('prepares a product-owned Cloud-to-LAN target without exposing raw effects', async () => {
    const dispose = jest.fn();
    const prepareTarget = jest.fn(async () => ({
      targetUrl: 'https://192.168.1.20:54545',
    }));
    const lifecycle = {
      registerDurableOwner: jest.fn(),
      registerRecoveryStage: jest.fn(),
    } as unknown as CollabProjectLifecycleSubsystem;
    const module = new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        dispose,
        prepareTarget,
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      lifecycle,
      persistence: {} as AuthorityTransferPersistence,
    });
    const cloudSession = {
      projectId: PROJECT_ID,
      supports: (capability: CollabCloudCapability) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityLifecycleSession;

    const binding = await module.bindCloudToLanTarget({
      cloudSession,
      expectedTargetUrl: 'https://192.168.1.20:54545',
      projectId: PROJECT_ID,
    });

    expect(binding.targetUrl).toBe('https://192.168.1.20:54545');
    expect(prepareTarget).not.toHaveBeenCalled();
    binding.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reconstructs a Cloud-to-LAN target on its durable endpoint', async () => {
    const targetUrl = 'https://192.168.1.20:54545';
    const prepareTarget = jest.fn(async (expectedEndpoint?: string) => ({
      targetUrl: expectedEndpoint ?? targetUrl,
    }));
    const cloudSession = {
      developmentActorId: 'member-host',
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(),
      serverUrl: 'https://cloud.example.test/',
      supports: (capability: CollabCloudCapability) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityLifecycleSession;
    const module = new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        prepareTarget,
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {} as AuthorityTransferPersistence,
      recoverCloudSession: jest.fn(async () => cloudSession),
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-authority-transfer-module',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...proposal(),
        direction: 'cloud-to-lan',
        sourceAuthority: { generation: 1, kind: 'cloud' },
        targetAuthority: { generation: 2, kind: 'lan' },
        targetUrl,
      },
    });

    await module.runtimes.prepare(record);

    expect(prepareTarget).not.toHaveBeenCalled();
  });

  it('reconstructs an accepted source route on its durable endpoint', async () => {
    const activateRoute = jest.fn(async () => async () => undefined);
    const cloudSession = {
      developmentActorId: 'member-host',
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(),
      serverUrl: 'https://cloud.example.test/',
      supports: (capability: CollabCloudCapability) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityLifecycleSession;
    const recoverCloudSession = jest.fn(async () => cloudSession);
    const module = new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      activateLanToCloudSourceRoute: activateRoute,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource: () => ({
        acceptanceRequest: jest.fn(),
        acceptProposal: jest.fn(),
        activateTerminal: jest.fn(),
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(),
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn(),
      }),
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {} as AuthorityTransferPersistence,
      recoverCloudSession,
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-authority-transfer-module',
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: proposal(),
    });

    await module.runtimes.prepare(record);

    expect(recoverCloudSession).toHaveBeenCalledWith(record);
    expect(activateRoute).toHaveBeenCalledWith(PROJECT_ID, 'https://127.0.0.1:54545');
    expect(module.sourceActiveService({
      authenticateMemberCredential: async () => ({ memberId: 'member-host' }),
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
    })).not.toBeNull();
  });

  it('reconstructs a crash-surviving claimant in a fresh module', async () => {
    let record: AuthorityTransferClaimantRecord | null = recoverableClaimantRecord();
    let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
    const convergence = { lanToCloudMember: jest.fn(async () => undefined) };
    const cloudSession = {
      developmentActorId: 'member-host',
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => ({ project: { id: PROJECT_ID } })),
      serverUrl: 'https://cloud.example.test/',
      supports: (capability: CollabCloudCapability) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityLifecycleSession;
    const recoverClaimant = jest.fn(async () => ({
      cloudSession,
      direction: 'lan-to-cloud' as const,
      lanClient: { requestWithMember: jest.fn(async () => undefined) } as never,
      memberCredential: Buffer.alloc(32, 1).toString('base64url'),
      mode: 'full' as const,
    }));
    new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: async () => record ? [PROJECT_ID] : [],
        load: async () => record,
        remove: async () => {
          const existed = record !== null;
          record = null;
          return existed;
        },
        save: async current => { record = current; },
      },
      convergence: convergence as never,
      createLanToCloudSource: jest.fn() as never,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: (stage: AuthorityTransferClaimantRecovery) => {
          if (stage.name === 'authority-transfer-claimants') claimantRecovery = stage;
        },
        runExclusive: async <Result>(
          _projectId: string,
          _owner: string,
          _mode: string,
          operation: () => Promise<Result>,
        ) => operation(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {} as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await claimantRecovery!.run();

    expect(recoverClaimant).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'source-acknowledged',
      projectId: PROJECT_ID,
    }));
    expect(convergence.lanToCloudMember).toHaveBeenCalledTimes(1);
    expect(record).toBeNull();
    expect(cloudSession.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['lan-to-cloud', 'cloud-to-lan'] as const)(
    'finishes a converted %s claimant from source-acknowledged progress locally',
    async (direction) => {
      let record: AuthorityTransferClaimantRecord | null = recoverableClaimantRecord({
        direction,
        phase: 'source-acknowledged',
      });
      let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
      const recoverConvertedClaimant = jest.fn(async () => undefined);
      const recoverClaimant = jest.fn(async () => ({
        direction,
        mode: 'local-only' as const,
      }));
      new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
        claimantStore: {
          listProjectIds: async () => record ? [PROJECT_ID] : [],
          load: async () => record,
          remove: async () => {
            const existed = record !== null;
            record = null;
            return existed;
          },
          save: async current => { record = current; },
        },
        convergence: { recoverConvertedClaimant } as never,
        createLanToCloudSource: jest.fn() as never,
        lifecycle: {
          registerDurableOwner: jest.fn(),
          registerRecoveryStage: (stage: AuthorityTransferClaimantRecovery) => {
            if (stage.name === 'authority-transfer-claimants') claimantRecovery = stage;
          },
          runExclusive: async <Result>(
            _projectId: string,
            _owner: string,
            _mode: string,
            operation: () => Promise<Result>,
          ) => operation(),
        } as unknown as CollabProjectLifecycleSubsystem,
        persistence: {} as AuthorityTransferPersistence,
        recoverClaimant,
      });

      await claimantRecovery!.run();

      expect(recoverClaimant).toHaveBeenCalledTimes(1);
      expect(recoverConvertedClaimant).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'source-acknowledged',
        projectId: PROJECT_ID,
      }));
      expect(record).toBeNull();
    },
  );

  it('recovers an expired Cloud-to-LAN redemption from the LAN target only', async () => {
    let record: AuthorityTransferClaimantRecord | null = recoverableClaimantRecord({
      direction: 'cloud-to-lan',
      expiresAt: '2026-08-27T01:00:00.000Z',
      phase: 'target-claimed',
    });
    const targetHost = record.lanTarget!;
    let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
    const readSnapshot = jest.fn(async () => ({ project: { id: PROJECT_ID } } as never));
    const cloudToLanMember = jest.fn(async () => undefined);
    const recoverClaimant = jest.fn(async () => ({
      direction: 'cloud-to-lan' as const,
      mode: 'target-only' as const,
      targetHost,
    }));
    new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: async () => record ? [PROJECT_ID] : [],
        load: async () => record,
        remove: async () => {
          const existed = record !== null;
          record = null;
          return existed;
        },
        save: async current => { record = current; },
      },
      convergence: { cloudToLanMember } as never,
      createLanTargetSnapshotReader: () => ({ readSnapshot }),
      createLanToCloudSource: jest.fn() as never,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: (stage: AuthorityTransferClaimantRecovery) => {
          if (stage.name === 'authority-transfer-claimants') claimantRecovery = stage;
        },
        runExclusive: async <Result>(
          _projectId: string,
          _owner: string,
          _mode: string,
          operation: () => Promise<Result>,
        ) => operation(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {} as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await claimantRecovery!.run();

    expect(recoverClaimant).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.any(String),
      expect.any(Object),
    );
    expect(cloudToLanMember).toHaveBeenCalledTimes(1);
    expect(record).toBeNull();
  });

  it.each(['lan-to-cloud', 'cloud-to-lan'] as const)(
    'finishes a %s claimant after local membership convergence without rebuilding transports',
    async (direction) => {
      let record: AuthorityTransferClaimantRecord | null = recoverableClaimantRecord({
        direction,
        phase: 'membership-converged',
      });
      let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
      const recoverClaimant = jest.fn(async () => {
        throw new Error('transport must remain unavailable');
      });
      new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
        claimantStore: {
          listProjectIds: async () => record ? [PROJECT_ID] : [],
          load: async () => record,
          remove: async () => {
            const existed = record !== null;
            record = null;
            return existed;
          },
          save: async current => { record = current; },
        },
        convergence: {} as never,
        createLanToCloudSource: jest.fn() as never,
        lifecycle: {
          registerDurableOwner: jest.fn(),
          registerRecoveryStage: (stage: AuthorityTransferClaimantRecovery) => {
            if (stage.name === 'authority-transfer-claimants') claimantRecovery = stage;
          },
          runExclusive: async <Result>(
            _projectId: string,
            _owner: string,
            _mode: string,
            operation: () => Promise<Result>,
          ) => operation(),
        } as unknown as CollabProjectLifecycleSubsystem,
        persistence: {} as AuthorityTransferPersistence,
        recoverClaimant,
      });

      await claimantRecovery!.run();

      expect(record).toBeNull();
      expect(recoverClaimant).not.toHaveBeenCalled();
    },
  );

  it('scrubs an expired pre-redemption claimant without rebuilding transports', async () => {
    let record: AuthorityTransferClaimantRecord | null = recoverableClaimantRecord({
      expiresAt: '2026-08-27T01:00:00.000Z',
      phase: 'credential-persisted',
    });
    let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
    const recoverClaimant = jest.fn(async () => {
      throw new Error('transport must remain unavailable');
    });
    new AuthorityTransferModule({
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: async () => record ? [PROJECT_ID] : [],
        load: async () => record,
        remove: async () => {
          const existed = record !== null;
          record = null;
          return existed;
        },
        save: async current => { record = current; },
      },
      convergence: {} as never,
      createLanToCloudSource: jest.fn() as never,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: (stage: AuthorityTransferClaimantRecovery) => {
          if (stage.name === 'authority-transfer-claimants') claimantRecovery = stage;
        },
        runExclusive: async <Result>(
          _projectId: string,
          _owner: string,
          _mode: string,
          operation: () => Promise<Result>,
        ) => operation(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {} as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await claimantRecovery!.run();

    expect(record).toBeNull();
    expect(recoverClaimant).not.toHaveBeenCalled();
  });
});
