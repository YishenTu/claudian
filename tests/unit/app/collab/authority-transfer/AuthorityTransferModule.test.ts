import { createHash } from 'node:crypto';

import type {
  CollabAuthorityTransferStatus,
  CollabCloudCapability,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';

import {
  createAuthorityTransferEntryRecord,
  createAuthorityTransferRequesterEntry,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import {
  AuthorityTransferModule as ProductionAuthorityTransferModule,
  type AuthorityTransferModuleOptions,
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
  advanceAuthorityTransferClaimantRecord,
  type AuthorityTransferClaimantRecord,
  createManagerReissuedAuthorityTransferClaimantRecord,
  decodeAuthorityTransferClaimantRecord,
  type SourceIssuedAuthorityTransferClaimantPhase,
  type SourceIssuedAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type {
  AuthorityTransferClaimantRecovery,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecovery';
import {
  type CloudToLanManagerEntryRecord,
  type CloudToLanTargetEntryRecord,
  cloudToLanTransferHandle,
  createCloudToLanManagerEntry,
  createCloudToLanTargetEntry,
  handoffCloudToLanTargetEntry,
  markCloudToLanManagerBeginPossiblySent,
  publishCloudToLanTargetEntry,
  recordCloudToLanManagerStatus,
  rejectCloudToLanManagerEntry,
  withdrawCloudToLanTargetEntry,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import {
  LanToCloudRequesterCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudRequesterCoordinator';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  LanAuthorityTransferClient,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';

const PROJECT_ID = 'project-authority-transfer-module';
const TRANSFER_ID = 'transfer-authority-transfer-module';

type TestAuthorityTransferModuleOptions = Omit<
  AuthorityTransferModuleOptions,
  'createCloudToLanConnection' | 'createCloudToLanTarget'
> & Partial<Pick<
  AuthorityTransferModuleOptions,
  'createCloudToLanConnection' | 'createCloudToLanTarget'
>>;

class AuthorityTransferModule extends ProductionAuthorityTransferModule {
  constructor(options: TestAuthorityTransferModuleOptions) {
    super({
      createCloudToLanConnection: async () => {
        throw new Error('Unexpected Cloud-to-LAN connection');
      },
      createCloudToLanTarget: () => {
        throw new Error('Unexpected Cloud-to-LAN target');
      },
      ...options,
    });
  }
}

function recoverableClaimantRecord(input: Readonly<{
  direction?: 'cloud-to-lan' | 'lan-to-cloud';
  expiresAt?: string;
  phase?: SourceIssuedAuthorityTransferClaimantPhase;
}> = {}): SourceIssuedAuthorityTransferClaimantRecord {
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
    variant: 'source-issued',
  }) as SourceIssuedAuthorityTransferClaimantRecord;
}

function proposal(
  overrides: Partial<CollabAuthorityTransferStatus> = {},
): CollabAuthorityTransferStatus {
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
    ...overrides,
  };
}

function managerReissuedDescriptor() {
  return {
    claim: Buffer.alloc(32, 4).toString('base64url'),
    claimGeneration: 4,
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
    memberId: 'member-host',
    projectId: PROJECT_ID,
    secretReplayExpiresAt: '2026-10-31T00:00:00.000Z',
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  };
}

function managerClaimantMembership() {
  return {
    authority: {
      authorityGeneration: 1,
      endpoint: 'https://192.168.1.10:54545',
      gitRemoteUrl: `https://192.168.1.10:54545/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nsource\n-----END CERTIFICATE-----\n',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan' as const,
    },
    createdAt: '2026-08-27T00:00:00.000Z',
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 1,
    member: {
      credential: Buffer.alloc(32, 1).toString('base64url'),
      displayName: 'Host',
      id: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      role: 'manager' as const,
    },
    project: { id: PROJECT_ID, name: 'Recovery', workspacePath: 'workspace/recovery' },
    schemaVersion: 3 as const,
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function managerClaimantSnapshot() {
  return {
    currentMember: {
      displayName: 'Host',
      id: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      role: 'manager' as const,
    },
    eventSequence: 9,
    project: {
      authorityGeneration: 2,
      authorityKind: 'cloud' as const,
      id: PROJECT_ID,
      name: 'Recovery',
    },
  };
}

describe('AuthorityTransferModule', () => {
  it('retains a bounded requester intent and replays it through the dedicated LAN client', async () => {
    let entry: Readonly<Record<string, unknown>> | null = null;
    const replacementStatus = proposal({
      transferId: 'transfer-requester-replacement',
    });
    const cancelledStatus = proposal({
      phase: 'cancelled',
      state: 'cancelled',
      updatedAt: '2026-08-27T00:01:00.000Z',
    });
    const requestWithMember = jest.fn(async (operation: string, value: unknown) => {
      if (operation === 'getProjectAuthorityTransfer') return cancelledStatus;
      return (value as { idempotencyKey: string }).idempotencyKey === 'intent-requester-replacement'
        ? replacementStatus
        : proposal();
    });
    const persistence = {
      completeRequesterEntry: async (
        submitted: Readonly<Record<string, unknown>>,
        status: CollabAuthorityTransferStatus,
      ) => {
        entry = { ...submitted, phase: 'proposed', status };
        return entry;
      },
      loadObservedSourceEntry: async () => null,
      loadRequesterEntry: async () => entry,
      settleRequesterCancellation: async () => {
        entry = null;
      },
      submitRequesterEntry: async (submitted: Readonly<Record<string, unknown>>) => {
        if (entry && JSON.stringify(entry.request) !== JSON.stringify(submitted.request)) {
          throw new Error('requester entry conflict');
        }
        entry ??= submitted;
        return entry;
      },
    } as unknown as AuthorityTransferPersistence;
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence,
    });
    const requester = module.createLanToCloudRequester({
      lanClient: { requestWithMember } as unknown as LanAuthorityTransferClient,
      memberCredential: Buffer.alloc(32, 9).toString('base64url'),
      memberId: 'member-requester',
      projectId: PROJECT_ID,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-requester-local',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test/',
    };

    await expect(requester.propose(request)).resolves.toEqual(proposal());
    await expect(requester.propose(request)).resolves.toEqual(proposal());

    expect(entry).toMatchObject({
      entryRole: 'requester',
      phase: 'proposed',
      proposedByMemberId: 'member-requester',
      request,
      status: proposal(),
      successor: null,
    });
    expect(requestWithMember).toHaveBeenCalledTimes(1);

    await expect(requester.propose({
      ...request,
      targetUrl: 'https://different-cloud.example.test/',
    })).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
    expect(requestWithMember).toHaveBeenCalledTimes(1);

    const replacementRequest = {
      ...request,
      idempotencyKey: 'intent-requester-replacement',
    };
    await expect(requester.propose(replacementRequest)).resolves.toEqual(replacementStatus);
    expect(entry).toMatchObject({
      request: replacementRequest,
      status: replacementStatus,
    });
    expect(requestWithMember.mock.calls.map(([operation]) => operation)).toEqual([
      'requestLanToCloudTransfer',
      'getProjectAuthorityTransfer',
      'requestLanToCloudTransfer',
    ]);
  });

  it('adopts an exact synchronized source after the requester loses the proposal response', async () => {
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-requester-lost-response',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test/',
    };
    const requesterEntry = createAuthorityTransferRequesterEntry({
      installationKey: TEST_INSTALLATION_A,
      proposedAt: '2026-08-27T00:00:00.000Z',
      proposedByMemberId: 'member-requester',
      request,
    });
    const sourceEntry = createAuthorityTransferEntryRecord({
      ownerInstallationKey: TEST_INSTALLATION_B,
      proposedByMemberId: 'member-requester',
      request,
      status: proposal(),
    });
    let requester = requesterEntry;
    const requestWithMember = jest.fn(async () => {
      throw new Error('terminal source no longer admits proposal replay');
    });
    const persistence = {
      completeRequesterEntry: async (
        _entry: typeof requesterEntry,
        status: CollabAuthorityTransferStatus,
      ) => {
        requester = { ...requester, status };
        return requester;
      },
      loadObservedSourceEntry: async () => sourceEntry,
      loadRequesterEntry: async () => requester,
    } as unknown as AuthorityTransferPersistence;
    const coordinator = new LanToCloudRequesterCoordinator({
      client: { requestWithMember } as unknown as LanAuthorityTransferClient,
      installationKey: TEST_INSTALLATION_A,
      memberCredential: Buffer.alloc(32, 9).toString('base64url'),
      memberId: 'member-requester',
      persistence,
      projectId: PROJECT_ID,
    });

    await expect(coordinator.resume()).resolves.toEqual(proposal());
    expect(requester.status).toEqual(proposal());
    expect(requestWithMember).not.toHaveBeenCalled();
  });

  it('persists a LAN source proposal for an active non-Host Member before Cloud is bound', async () => {
    let entry: Readonly<Record<string, unknown>> | null = null;
    const createLanToCloudSource = jest.fn();
    const lifecycle = {
      registerDurableOwner: jest.fn(),
      registerRecoveryStage: jest.fn(),
      runExclusive: async <Result>(
        _projectId: string,
        _owner: string,
        _mode: string,
        operation: () => Promise<Result>,
      ) => operation(),
    } as unknown as CollabProjectLifecycleSubsystem;
    const persistence = {
      cancelSourceEntry: async () => {
        entry = {
          ...entry!,
          phase: 'cancelled',
          status: { ...(entry!.status as object), phase: 'cancelled', state: 'cancelled' },
        };
        return entry;
      },
      proposeEntry: async (created: Readonly<Record<string, unknown>>) => {
        if (entry) {
          if (
            entry.proposedByMemberId !== created.proposedByMemberId
            || JSON.stringify(entry.request) !== JSON.stringify(created.request)
          ) throw new Error('conflicting proposal');
          return entry;
        }
        entry = created;
        return created;
      },
      load: async () => null,
      loadSourceEntry: async () => entry,
    } as unknown as AuthorityTransferPersistence;
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: jest.fn(async () => undefined),
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      persistence,
    });
    const service = module.sourceActiveService({
      authorityGeneration: 1,
      authenticateMemberCredential: async () => ({ memberId: 'member-requester' }),
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-source-local-proposal',
      projectId: PROJECT_ID,
      targetUrl: 'http://cloud.example.test:8787',
    };

    await expect(service!.requestLanToCloudTransfer(
      { memberId: 'member-requester' },
      { ...request, expectedAuthorityGeneration: 2 },
    )).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'lan-to-cloud-source-generation-stale' },
    });
    expect(entry).toBeNull();

    const proposed = await service!.requestLanToCloudTransfer(
      { memberId: 'member-requester' },
      request,
    );
    const replayed = await service!.requestLanToCloudTransfer(
      { memberId: 'member-requester' },
      request,
    );

    expect(proposed).toMatchObject({
      direction: 'lan-to-cloud',
      phase: 'collecting-readiness',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 1, kind: 'lan' },
      targetAuthority: { generation: 2, kind: 'cloud' },
      targetUrl: request.targetUrl,
    });
    expect(replayed).toEqual(proposed);
    expect(entry).toMatchObject({
      phase: 'proposed',
      projectId: PROJECT_ID,
      proposedByMemberId: 'member-requester',
      request,
      status: proposed,
    });
    await expect(service!.getProjectAuthorityTransfer(
      { memberId: 'member-requester' },
      { projectId: PROJECT_ID, transferId: proposed.transferId },
    )).resolves.toEqual(proposed);
    await expect(module.cancelLanToCloudTransfer({
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: 'intent-source-local-cancel',
      projectId: PROJECT_ID,
      transferId: proposed.transferId,
    })).resolves.toMatchObject({
      phase: 'cancelled',
      state: 'cancelled',
    });
    expect(createLanToCloudSource).not.toHaveBeenCalled();
  });

  it('resolves an expired Cloud-to-LAN redemption without the relinquished Cloud source', async () => {
    const createCloudConnection = jest.fn(async () => {
      throw new Error('Cloud source must remain unavailable');
    });
    const record = recoverableClaimantRecord({
      direction: 'cloud-to-lan',
      expiresAt: '2026-08-27T01:00:00.000Z',
      phase: 'target-claimed',
    });
    const resolver = new AuthorityTransferClaimantBindingResolver({
      createCloudConnection,
      loadMembership: async () => ({
        authority: {
          authorityGeneration: 1,
          bindingVersion: 3,
          developmentActorId: 'member-host',
          gitRemoteUrl: `https://cloud.example.test/v3/projects/${PROJECT_ID}/repository.git`,
          kind: 'cloud',
          serverUrl: 'https://cloud.example.test/',
          wireVersion: 7,
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
    expect(createCloudConnection).not.toHaveBeenCalled();
  });

  it('reconstructs a Manager-reissued claimant with only its frozen Cloud target', async () => {
    const descriptor = managerReissuedDescriptor();
    const record = createManagerReissuedAuthorityTransferClaimantRecord({
      descriptor,
      memberPersonalRef: 'refs/heads/members/member-host',
      operationIntentId: 'intent-manager-reissued',
      serverUrl: 'https://cloud.example.test/',
    });
    const cloudSession = { projectId: PROJECT_ID } as CloudAuthorityConnection;
    const createCloudConnection = jest.fn(async () => cloudSession);
    const createLanClient = jest.fn();
    const resolver = new AuthorityTransferClaimantBindingResolver({
      createCloudConnection,
      createLanClient,
      loadMembership: async () => ({
        authority: {
          authorityGeneration: 1,
          endpoint: 'https://192.168.1.10:54545',
          gitRemoteUrl: `https://192.168.1.10:54545/v1/git/${PROJECT_ID}/repository.git`,
          hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nsource\n-----END CERTIFICATE-----\n',
          hostCaFingerprint: 'a'.repeat(64),
          kind: 'lan',
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        hostOwnership: { ownsAuthority: false },
        lastEventSequence: 1,
        member: {
          credential: Buffer.alloc(32, 1).toString('base64url'),
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
    });

    await expect(resolver.resolve(record)).resolves.toEqual({
      cloudSession,
      direction: 'lan-to-cloud',
      mode: 'manager-reissued',
    });
    expect(createCloudConnection).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test/',
    });
    expect(createLanClient).not.toHaveBeenCalled();
  });

  it('registers both durable recovery owners and installs a bound LAN source service', async () => {
    let record: AuthorityTransferRecord | null = null;
    let entry: Readonly<Record<string, unknown>> | null = null;
    let ownsHostInstallation = true;
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
      loadSourceEntry: async () => entry,
      load: async () => record,
      proposeEntry: async (created: Readonly<Record<string, unknown>>) => {
        entry ??= created;
        return entry;
      },
    } as unknown as AuthorityTransferPersistence;
    const createLanToCloudSource = jest.fn(() => ({
      activateTerminal: jest.fn(),
      capture: jest.fn(),
      commitRelinquishmentFence: jest.fn(),
      reopenAfterCancellation: jest.fn(),
    }));
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => {
        if (!ownsHostInstallation) throw new Error('foreign Host installation');
      },
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource,
      lifecycle,
      persistence,
    });
    const cloudSession = {
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
    } as unknown as CloudAuthorityConnection;
    const service = module.sourceActiveService({
      authorityGeneration: 1,
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
    const proposed = await service!.requestLanToCloudTransfer(
      { memberId: 'member-any' },
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-authority-transfer-module',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test/',
      },
    );
    expect(proposed).toMatchObject({ phase: 'collecting-readiness' });
    await expect(module.readLanToCloudSourceProposal(PROJECT_ID)).resolves.toEqual({
      proposedByMemberId: 'member-any',
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-authority-transfer-module',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test/',
      },
      status: proposed,
    });
    const wrongCloudSession = {
      ...cloudSession,
      serverUrl: 'https://wrong-cloud.example.test/',
    } as CloudAuthorityConnection;
    await expect(module.bindLanToCloudSource({
      cloudSession: wrongCloudSession,
      expectedTargetUrl: wrongCloudSession.serverUrl,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-cloud-target-mismatch' },
    });
    expect(createLanToCloudSource).not.toHaveBeenCalled();
    const binding = await module.bindLanToCloudSource({
      cloudSession,
      projectId: PROJECT_ID,
    });
    await expect(service!.getProjectAuthorityTransfer(
      { memberId: 'member-any' },
      { projectId: PROJECT_ID, transferId: proposed.transferId },
    )).resolves.toMatchObject({ phase: 'collecting-readiness' });
    await expect(service!.acceptLanToCloudTransferTarget(
      { memberId: 'member-host' },
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-host-acceptance',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test/',
        transferId: TRANSFER_ID,
      },
    )).rejects.toMatchObject({ code: 'authorization-denied' });
    ownsHostInstallation = false;
    await expect(module.acceptLanToCloudTransferTarget({
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-authority-transfer-module-accept',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test/',
      transferId: proposed.transferId,
    })).rejects.toThrow('foreign Host installation');

    await binding.dispose();
    await expect(module.bindLanToCloudSource({
      cloudSession,
      projectId: PROJECT_ID,
    })).rejects.toThrow('foreign Host installation');
    expect(createLanToCloudSource).toHaveBeenCalledTimes(1);
    expect(module.sourceActiveService({
      authorityGeneration: 1,
      authenticateMemberCredential: async () => ({ memberId: 'member-host' }),
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
    })).not.toBeNull();
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
      assertLanToCloudSourceOwner: () => undefined,
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
    } as unknown as CloudAuthorityConnection;

    const binding = await module.bindCloudToLanTarget({
      cloudSession,
      expectedTargetUrl: 'https://192.168.1.20:54545',
      projectId: PROJECT_ID,
    });

    expect(binding.targetUrl).toBe('https://192.168.1.20:54545');
    expect(prepareTarget).toHaveBeenCalledWith('https://192.168.1.20:54545');
    binding.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('persists a selected non-Manager target before listener effects and freezes Manager begin before send', async () => {
    const order: string[] = [];
    let targetEntry: Readonly<Record<string, unknown>> | null = null;
    let managerEntry: Readonly<Record<string, unknown>> | null = null;
    const targetUrl = 'https://192.168.1.20:54545';
    const sourceUrl = 'https://cloud.example.test/';
    const targetDispose = jest.fn(() => { order.push('listener-released'); });
    const begun = {
      ...proposal(),
      direction: 'cloud-to-lan' as const,
      sourceAuthority: { generation: 1, kind: 'cloud' as const },
      targetAuthority: { generation: 2, kind: 'lan' as const },
      targetUrl,
    };
    const persistence = {
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      loadCloudToLanTargetEntry: jest.fn(async () => targetEntry),
      markCloudToLanManagerBeginPossiblySent: jest.fn(async (entry: never) => {
        order.push('begin-frozen');
        managerEntry = { ...(entry as object), phase: 'submitted' };
        return managerEntry;
      }),
      markCloudToLanManagerCancellationPossiblySent: jest.fn(async (entry: never) => {
        order.push('cancel-marked');
        const current = entry as unknown as Readonly<Record<string, unknown>>;
        managerEntry = {
          ...current,
          cancellation: {
            ...current.cancellation as object,
            submission: 'possibly-sent',
          },
        };
        return managerEntry;
      }),
      prepareCloudToLanManagerCancellation: jest.fn(async (entry: never, request: never) => {
        order.push('cancel-frozen');
        managerEntry = {
          ...(entry as object),
          cancellation: { request, submission: 'not-sent' },
        };
        return managerEntry;
      }),
      prepareCloudToLanManagerEntry: jest.fn(async (entry: never) => {
        managerEntry = entry;
        return entry;
      }),
      prepareCloudToLanTargetEntry: jest.fn(async (entry: never) => {
        order.push('target-persisted');
        targetEntry = entry;
        return entry;
      }),
      publishCloudToLanTargetEntry: jest.fn(async (_entry: never, descriptor: never) => {
        order.push('descriptor-persisted');
        const entry = _entry as unknown as Readonly<Record<string, unknown>>;
        targetEntry = {
          ...entry,
          descriptor: {
            ...(descriptor as object),
            preparationId: entry.operationIntentId,
            projectId: entry.projectId,
            schemaVersion: 1,
            selectedTargetMemberId: entry.selectedTargetMemberId,
            sourceAuthorityGeneration: entry.sourceAuthorityGeneration,
            sourceCloudUrl: entry.sourceCloudUrl,
          },
          phase: 'published',
        };
        return targetEntry;
      }),
      recordCloudToLanManagerStatus: jest.fn(async (_entry: never, status: never) => {
        order.push('status-persisted');
        const statusRecord = status as unknown as CollabAuthorityTransferStatus;
        managerEntry = {
          ...(_entry as object),
          cancellation: null,
          phase: statusRecord.state === 'cancelled' || statusRecord.state === 'completed'
            ? 'settled'
            : 'observing',
          status,
        };
        return managerEntry;
      }),
      settleCloudToLanManagerEntry: jest.fn(async () => {
        order.push('observer-settled');
        managerEntry = null;
      }),
      withdrawCloudToLanTargetEntry: jest.fn(async (entry: never) => {
        order.push('withdrawal-persisted');
        targetEntry = {
          ...(entry as object),
          phase: 'withdrawn',
          withdrawnAt: '2026-08-27T00:05:00.000Z',
        };
        return targetEntry;
      }),
    } as unknown as AuthorityTransferPersistence;
    const lifecycle = {
      registerDurableOwner: jest.fn(),
      registerRecoveryStage: jest.fn(),
      runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
    } as unknown as CollabProjectLifecycleSubsystem;
    const targetCloud = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      listProjectMembers: jest.fn(async () => ({
        authorityGeneration: 1,
        managerSetGeneration: 1,
        members: [{
          bindingState: 'bound',
          displayName: 'Target',
          importedClaimGeneration: null,
          importedClaimState: 'not-applicable',
          memberId: 'member-target',
          membershipRevision: 1,
          role: 'member',
        }],
        projectId: PROJECT_ID,
      })),
      memberId: 'member-target',
      personalRef: 'refs/heads/members/member-target',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => ({
        currentMember: {
          activatedAt: '2026-08-27T00:00:00.000Z',
          createdAt: '2026-08-27T00:00:00.000Z',
          displayName: 'Target',
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
          status: 'active',
        },
        eventSequence: 3,
        members: [],
        openRequests: [],
        openTicketCount: 0,
        project: {
          authorityGeneration: 1,
          createdAt: '2026-08-27T00:00:00.000Z',
          expectedMainOid: 'a'.repeat(40),
          id: PROJECT_ID,
          mainRef: 'refs/heads/main',
          name: 'Transfer Project',
        },
        ticketHighlights: [],
      })),
      serverUrl: sourceUrl,
    };
    const managerCloud = {
      ...targetCloud,
      dispose: jest.fn(),
      lifecycle: {
        authorityTransfer: jest.fn(async (operation: string) => {
          if (operation === 'beginCloudToLanTransfer') {
            order.push('begin-sent');
            return begun;
          }
          if (operation === 'getProjectAuthorityTransfer') {
            order.push('status-read');
            return begun;
          }
          if (operation === 'cancelProjectAuthorityTransfer') {
            order.push('cancel-sent');
            return {
              ...begun,
              phase: 'cancelled',
              state: 'cancelled',
              updatedAt: '2026-08-27T00:05:00.000Z',
            };
          }
          throw new Error(`unexpected ${operation}`);
        }),
      },
      listProjectMembers: jest.fn(async () => ({
        authorityGeneration: 1,
        managerSetGeneration: 1,
        members: [
          {
            bindingState: 'bound',
            displayName: 'Manager',
            importedClaimGeneration: null,
            importedClaimState: 'not-applicable',
            memberId: 'member-manager',
            membershipRevision: 1,
            role: 'manager',
          },
          {
            bindingState: 'bound',
            displayName: 'Target',
            importedClaimGeneration: null,
            importedClaimState: 'not-applicable',
            memberId: 'member-target',
            membershipRevision: 1,
            role: 'member',
          },
        ],
        projectId: PROJECT_ID,
      })),
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      readSnapshot: jest.fn(async () => ({
        ...(await targetCloud.readSnapshot()),
        currentMember: {
          activatedAt: '2026-08-27T00:00:00.000Z',
          createdAt: '2026-08-27T00:00:00.000Z',
          displayName: 'Manager',
          id: 'member-manager',
          personalRef: 'refs/heads/members/member-manager',
          role: 'manager',
          status: 'active',
        },
      })),
    };
    const createManagerConnection = jest.fn(async () => managerCloud as never);
    const targetModule = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => targetCloud as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        dispose: targetDispose,
        prepareTarget: jest.fn(async () => {
          order.push('listener-prepared');
          return {
            caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
            caFingerprint: 'c'.repeat(64),
            targetUrl,
          };
        }),
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_B,
      lifecycle,
      persistence,
    });
    const managerModule = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: createManagerConnection,
      createCloudToLanTarget: jest.fn() as never,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      persistence,
    });

    const descriptor = await targetModule.prepareCloudToLanTarget({
      operationIntentId: 'intent-target-preparation',
      projectId: PROJECT_ID,
    });
    await expect(targetModule.prepareCloudToLanTarget({
      operationIntentId: 'intent-new-facade-preparation-retry',
      projectId: PROJECT_ID,
    })).resolves.toEqual(descriptor);
    const handle = await managerModule.beginCloudToLanTransfer({
      descriptor,
      operationIntentId: 'intent-manager-begin',
    });

    expect(descriptor).toMatchObject({
      projectId: PROJECT_ID,
      selectedTargetMemberId: 'member-target',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: sourceUrl,
      targetUrl,
    });
    expect(handle).toMatchObject({
      operationIntentId: 'intent-manager-begin',
      preparationId: 'intent-target-preparation',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });
    expect(order).toEqual([
      'target-persisted',
      'listener-prepared',
      'descriptor-persisted',
      'begin-frozen',
      'begin-sent',
      'status-persisted',
    ]);
    await expect(targetModule.acceptCloudToLanTransfer({
      handle: { ...handle, sourceAuthorityGeneration: 2 },
    })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-handle-mismatch' },
    });
    expect(targetCloud.lifecycle.authorityTransfer).not.toHaveBeenCalled();

    await expect(targetModule.withdrawCloudToLanTarget({
      preparationId: 'intent-stale-target-preparation',
      projectId: PROJECT_ID,
    } as never)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-preparation-mismatch' },
    });
    expect(order).not.toContain('withdrawal-persisted');
    expect(targetDispose).not.toHaveBeenCalled();
    await targetModule.withdrawCloudToLanTarget({
      preparationId: descriptor.preparationId,
      projectId: PROJECT_ID,
    } as never);
    expect(order.slice(-2)).toEqual(['withdrawal-persisted', 'listener-released']);
    await expect(targetModule.acceptCloudToLanTransfer({ handle })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-handle-mismatch' },
    });
    expect(targetCloud.lifecycle.authorityTransfer).not.toHaveBeenCalled();
    await expect(managerModule.prepareCloudToLanTarget({
      operationIntentId: descriptor.preparationId,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({
      safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
    });
    expect(createManagerConnection).toHaveBeenCalledTimes(1);

    await expect(targetModule.cancelCloudToLanTransfer(handle as never)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-cloud-binding-mismatch' },
    });
    const authorityTransferCallCount = managerCloud.lifecycle.authorityTransfer.mock.calls.length;
    await expect(managerModule.cancelCloudToLanTransfer({
      ...handle,
      operationIntentId: 'intent-stale-manager-begin',
    } as never)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-manager-handle-mismatch' },
    });
    expect(managerCloud.lifecycle.authorityTransfer).toHaveBeenCalledTimes(
      authorityTransferCallCount,
    );
    (managerCloud.lifecycle.authorityTransfer as jest.Mock)
      .mockImplementationOnce(async () => {
        order.push('status-read');
        return begun;
      })
      .mockImplementationOnce(async () => {
        order.push('cancel-sent');
        throw new Error('ambiguous-cancel-network-loss');
      });
    await expect(managerModule.cancelCloudToLanTransfer(handle as never)).rejects.toMatchObject({
      result: {
        durablePhase: 'committed',
        durableProgress: true,
        operationId: 'intent-manager-begin',
        status: 'recovery-required',
      },
    });
    await expect(managerModule.cancelCloudToLanTransfer(handle as never)).resolves.toMatchObject({
      state: 'cancelled',
    });
    expect(order.slice(-9)).toEqual([
      'status-read',
      'status-persisted',
      'cancel-frozen',
      'cancel-marked',
      'cancel-sent',
      'cancel-marked',
      'cancel-sent',
      'status-persisted',
      'observer-settled',
    ]);
  });

  it('releases the Cloud session and preserves the durable outcome when preparation cleanup fails', async () => {
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      listProjectMembers: jest.fn(),
      memberId: 'member-target',
      personalRef: 'refs/heads/members/member-target',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => ({
        currentMember: {
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
        },
        project: { authorityGeneration: 1, id: PROJECT_ID },
      })),
      serverUrl: 'https://cloud.example.test/',
    };
    const disposeTarget = jest.fn(async () => {
      throw new Error('listener-dispose-failed');
    });
    const persistence = {
      loadCloudToLanTargetEntry: jest.fn(async () => null),
      prepareCloudToLanTargetEntry: jest.fn(async (entry: CloudToLanTargetEntryRecord) => entry),
      publishCloudToLanTargetEntry: jest.fn(async () => {
        throw new Error('simulated descriptor persistence failure');
      }),
    } as unknown as AuthorityTransferPersistence;
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        dispose: disposeTarget,
        prepareTarget: jest.fn(async () => ({
          caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
          caFingerprint: 'c'.repeat(64),
          targetUrl: 'https://192.168.1.20:54545',
        })),
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      persistence,
    });

    await expect(module.prepareCloudToLanTarget({
      operationIntentId: 'intent-failed-target-preparation',
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({
      result: {
        durableProgress: true,
        operationId: 'intent-failed-target-preparation',
        status: 'recovery-required',
      },
    });

    expect(disposeTarget).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('settles a definitive pre-ID begin rejection only after the bound recovery barrier', async () => {
    let managerEntry: CloudToLanManagerEntryRecord | null = null;
    const persistence = {
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      markCloudToLanManagerBeginPossiblySent: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = markCloudToLanManagerBeginPossiblySent(entry);
        return managerEntry;
      }),
      prepareCloudToLanManagerEntry: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = entry;
        return entry;
      }),
      rejectCloudToLanManagerEntry: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = rejectCloudToLanManagerEntry(entry);
        return managerEntry;
      }),
      settleCloudToLanManagerEntry: jest.fn(async (entry: CloudToLanManagerEntryRecord) => {
        expect(entry.phase).toBe('rejected');
        managerEntry = null;
      }),
    } as unknown as AuthorityTransferPersistence;
    const snapshot = (role: 'manager' | 'member') => ({
      currentMember: {
        activatedAt: '2026-08-27T00:00:00.000Z',
        createdAt: '2026-08-27T00:00:00.000Z',
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role,
        status: 'active',
      },
      eventSequence: 3,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 1,
        createdAt: '2026-08-27T00:00:00.000Z',
        expectedMainOid: 'a'.repeat(40),
        id: PROJECT_ID,
        mainRef: 'refs/heads/main',
        name: 'Transfer Project',
      },
      ticketHighlights: [],
    });
    const readSnapshot = jest.fn()
      .mockResolvedValueOnce(snapshot('manager'))
      .mockResolvedValueOnce(snapshot('member'));
    const listProjectMembers = jest.fn()
      .mockResolvedValueOnce({
        authorityGeneration: 1,
        managerSetGeneration: 1,
        members: [{
          bindingState: 'bound',
          displayName: 'Target',
          importedClaimGeneration: null,
          importedClaimState: 'not-applicable',
          memberId: 'member-target',
          membershipRevision: 1,
          role: 'member',
        }],
        projectId: PROJECT_ID,
      })
      .mockResolvedValueOnce({
        authorityGeneration: 1,
        managerSetGeneration: 2,
        members: [{
          bindingState: 'hidden',
          displayName: 'Manager',
          importedClaimGeneration: null,
          importedClaimState: 'hidden',
          memberId: 'member-manager',
          membershipRevision: 2,
          role: 'member',
        }],
        projectId: PROJECT_ID,
      });
    const rejection = new CloudAuthorityRejection({ code: 'authorization-denied' });
    const authorityTransfer = jest.fn().mockRejectedValueOnce(rejection);
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer },
      listProjectMembers,
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
    };
    const options = {
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: jest.fn() as never,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      persistence,
    };
    const input = {
      descriptor: {
        caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
        caFingerprint: 'c'.repeat(64),
        preparationId: 'intent-target-preparation',
        projectId: PROJECT_ID,
        publishedAt: '2026-08-27T00:00:00.000Z',
        schemaVersion: 1 as const,
        selectedTargetMemberId: 'member-target',
        sourceAuthorityGeneration: 1,
        sourceCloudUrl: 'https://cloud.example.test/',
        targetUrl: 'https://192.168.1.20:54545',
      },
      operationIntentId: 'intent-manager-rejected',
    };

    await expect(new AuthorityTransferModule(options).beginCloudToLanTransfer(input))
      .rejects.toBe(rejection);
    expect(managerEntry).toBeNull();
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(listProjectMembers).toHaveBeenCalledTimes(2);
    expect(persistence.rejectCloudToLanManagerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'submitted', status: null }),
    );
    expect(persistence.settleCloudToLanManagerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'rejected', status: null }),
    );
    expect(authorityTransfer).toHaveBeenCalledTimes(1);
  });

  it('coexists as the selected target and initiating Manager on one installation', async () => {
    const targetUrl = 'https://192.168.1.20:54545';
    const sourceUrl = 'https://cloud.example.test/';
    let targetEntry: CloudToLanTargetEntryRecord | null = null;
    let managerEntry: CloudToLanManagerEntryRecord | null = null;
    const persistence = {
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      loadCloudToLanTargetEntry: jest.fn(async () => targetEntry),
      markCloudToLanManagerBeginPossiblySent: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = markCloudToLanManagerBeginPossiblySent(entry);
        return managerEntry;
      }),
      prepareCloudToLanManagerEntry: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = entry;
        return entry;
      }),
      prepareCloudToLanTargetEntry: jest.fn(async (
        entry: CloudToLanTargetEntryRecord,
      ) => {
        targetEntry = entry;
        return entry;
      }),
      publishCloudToLanTargetEntry: jest.fn(async (
        entry: CloudToLanTargetEntryRecord,
        descriptor: Parameters<typeof publishCloudToLanTargetEntry>[1],
      ) => {
        targetEntry = publishCloudToLanTargetEntry(entry, descriptor);
        return targetEntry;
      }),
      recordCloudToLanManagerStatus: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
        transferStatus: CollabAuthorityTransferStatus,
      ) => {
        managerEntry = recordCloudToLanManagerStatus(entry, transferStatus);
        return managerEntry;
      }),
    } as unknown as AuthorityTransferPersistence;
    const cloudSnapshot = {
      currentMember: {
        activatedAt: '2026-08-27T00:00:00.000Z',
        createdAt: '2026-08-27T00:00:00.000Z',
        displayName: 'Self Manager',
        id: 'member-self-manager',
        personalRef: 'refs/heads/members/member-self-manager',
        role: 'manager' as const,
        status: 'active' as const,
      },
      eventSequence: 3,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 1,
        createdAt: '2026-08-27T00:00:00.000Z',
        expectedMainOid: 'a'.repeat(40),
        id: PROJECT_ID,
        mainRef: 'refs/heads/main',
        name: 'Transfer Project',
      },
      ticketHighlights: [],
    };
    const begun: CollabAuthorityTransferStatus = {
      ...proposal(),
      direction: 'cloud-to-lan',
      sourceAuthority: { generation: 1, kind: 'cloud' },
      targetAuthority: { generation: 2, kind: 'lan' },
      targetUrl,
    };
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn(async () => begun) },
      listProjectMembers: jest.fn(async () => ({
        authorityGeneration: 1,
        managerSetGeneration: 1,
        members: [{
          bindingState: 'bound',
          displayName: 'Self Manager',
          importedClaimGeneration: null,
          importedClaimState: 'not-applicable',
          memberId: 'member-self-manager',
          membershipRevision: 1,
          role: 'manager',
        }],
        projectId: PROJECT_ID,
      })),
      memberId: 'member-self-manager',
      personalRef: 'refs/heads/members/member-self-manager',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => cloudSnapshot),
      serverUrl: sourceUrl,
    };
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        prepareTarget: jest.fn(async () => ({
          caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
          caFingerprint: 'c'.repeat(64),
          targetUrl,
        })),
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      persistence,
    });

    const descriptor = await module.prepareCloudToLanTarget({
      operationIntentId: 'intent-self-preparation',
      projectId: PROJECT_ID,
    });
    const handle = await module.beginCloudToLanTransfer({
      descriptor,
      operationIntentId: 'intent-self-manager-begin',
    });

    expect(targetEntry).toMatchObject({
      ownerInstallationKey: TEST_INSTALLATION_A,
      phase: 'published',
      selectedTargetMemberId: 'member-self-manager',
    });
    expect(managerEntry).toMatchObject({
      initiatingMemberId: 'member-self-manager',
      phase: 'observing',
    });
    expect(handle).toMatchObject({
      preparationId: 'intent-self-preparation',
      selectedTargetMemberId: 'member-self-manager',
      transferId: TRANSFER_ID,
    });
  });

  it('releases a withdrawn preparation even when listener disposal fails', async () => {
    let targetEntry: CloudToLanTargetEntryRecord | null = null;
    const persistence = {
      loadCloudToLanTargetEntry: jest.fn(async () => targetEntry),
      prepareCloudToLanTargetEntry: jest.fn(async (entry: CloudToLanTargetEntryRecord) => {
        targetEntry = entry;
        return entry;
      }),
      publishCloudToLanTargetEntry: jest.fn(async (
        entry: CloudToLanTargetEntryRecord,
        descriptor: Parameters<typeof publishCloudToLanTargetEntry>[1],
      ) => {
        targetEntry = publishCloudToLanTargetEntry(entry, descriptor);
        return targetEntry;
      }),
      withdrawCloudToLanTargetEntry: jest.fn(async (entry: CloudToLanTargetEntryRecord) => {
        targetEntry = withdrawCloudToLanTargetEntry(
          entry,
          '2026-08-27T00:01:00.000Z',
        );
        return targetEntry;
      }),
    } as unknown as AuthorityTransferPersistence;
    const connections = [0, 1].map(() => ({
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      listProjectMembers: jest.fn(),
      memberId: 'member-target',
      personalRef: 'refs/heads/members/member-target',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => ({
        currentMember: {
          displayName: 'Target',
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
        },
        project: { authorityGeneration: 1, id: PROJECT_ID },
      })),
      serverUrl: 'https://cloud.example.test/',
    }));
    const firstDispose = jest.fn()
      .mockRejectedValueOnce(new Error('listener-dispose-failed'))
      .mockResolvedValue(undefined);
    const targetDisposals = [firstDispose, jest.fn(async () => undefined)];
    let connectionIndex = 0;
    let targetIndex = 0;
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connections[connectionIndex++] as never,
      createCloudToLanTarget: () => {
        const dispose = targetDisposals[targetIndex++];
        return {
          acceptanceRequest: jest.fn(),
          activate: jest.fn(),
          cancelStaging: jest.fn(),
          dispose,
          prepareTarget: jest.fn(async () => ({
            caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
            caFingerprint: 'c'.repeat(64),
            targetUrl: 'https://192.168.1.20:54545',
          })),
          stage: jest.fn(),
        };
      },
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      persistence,
    });

    await module.prepareCloudToLanTarget({
      operationIntentId: 'intent-first-target-preparation',
      projectId: PROJECT_ID,
    });
    await expect(module.withdrawCloudToLanTarget({
      preparationId: 'intent-first-target-preparation',
      projectId: PROJECT_ID,
    }))
      .rejects.toThrow('listener-dispose-failed');
    await module.prepareCloudToLanTarget({
      operationIntentId: 'intent-replacement-target-preparation',
      projectId: PROJECT_ID,
    });
    await module.close();

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(connections[0].dispose).toHaveBeenCalledTimes(1);
    expect(connections[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('releases a failed pre-handoff acceptance binding when the target withdraws', async () => {
    let targetEntry: CloudToLanTargetEntryRecord | null = null;
    const persistence = {
      load: jest.fn(async () => null),
      loadCloudToLanTargetEntry: jest.fn(async () => targetEntry),
      prepareCloudToLanTargetEntry: jest.fn(async (entry: CloudToLanTargetEntryRecord) => {
        targetEntry = entry;
        return entry;
      }),
      publishCloudToLanTargetEntry: jest.fn(async (
        entry: CloudToLanTargetEntryRecord,
        descriptor: Parameters<typeof publishCloudToLanTargetEntry>[1],
      ) => {
        targetEntry = publishCloudToLanTargetEntry(entry, descriptor);
        return targetEntry;
      }),
      withdrawCloudToLanTargetEntry: jest.fn(async (entry: CloudToLanTargetEntryRecord) => {
        targetEntry = withdrawCloudToLanTargetEntry(entry, '2026-08-27T00:01:00.000Z');
        return targetEntry;
      }),
    } as unknown as AuthorityTransferPersistence;
    const targetUrl = 'https://192.168.1.20:54545';
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: {
        authorityTransfer: jest.fn(async () => ({
          ...proposal(),
          direction: 'cloud-to-lan' as const,
          phase: 'cloud-quiesced' as const,
          sourceAuthority: { generation: 1, kind: 'cloud' as const },
          targetAuthority: { generation: 2, kind: 'lan' as const },
          targetUrl,
        })),
      },
      listProjectMembers: jest.fn(),
      memberId: 'member-target',
      personalRef: 'refs/heads/members/member-target',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => ({
        currentMember: {
          displayName: 'Target',
          id: 'member-target',
          personalRef: 'refs/heads/members/member-target',
          role: 'member',
        },
        project: { authorityGeneration: 1, id: PROJECT_ID },
      })),
      serverUrl: 'https://cloud.example.test/',
    };
    const disposeTarget = jest.fn(async () => {
      throw new Error('listener-dispose-failed');
    });
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        dispose: disposeTarget,
        prepareTarget: jest.fn(async () => ({
          caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
          caFingerprint: 'c'.repeat(64),
          targetUrl,
        })),
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      persistence,
    });
    const descriptor = await module.prepareCloudToLanTarget({
      operationIntentId: 'intent-failed-accept-preparation',
      projectId: PROJECT_ID,
    });
    const handle = {
      operationIntentId: 'intent-failed-accept-manager',
      preparationId: descriptor.preparationId,
      projectId: PROJECT_ID,
      schemaVersion: 1 as const,
      selectedTargetMemberId: descriptor.selectedTargetMemberId,
      sourceAuthorityGeneration: descriptor.sourceAuthorityGeneration,
      sourceCloudUrl: descriptor.sourceCloudUrl,
      targetUrl: descriptor.targetUrl,
      transferId: TRANSFER_ID,
    };

    await expect(module.acceptCloudToLanTransfer({ handle })).rejects.toMatchObject({
      safeContext: { reason: 'cloud-to-lan-prepared-status-mismatch' },
    });
    await expect(module.withdrawCloudToLanTarget({
      preparationId: descriptor.preparationId,
      projectId: PROJECT_ID,
    })).rejects.toThrow('listener-dispose-failed');

    expect(targetEntry).toMatchObject({ phase: 'withdrawn' });
    expect(disposeTarget).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
    await module.close();
    expect(disposeTarget).toHaveBeenCalledTimes(1);
  });

  it('classifies an existing target binding retry failure after durable progress', async () => {
    const completedStatus = recoverableClaimantRecord({ direction: 'cloud-to-lan' }).status;
    const collectingStatus: CollabAuthorityTransferStatus = {
      ...completedStatus,
      batchRevision: null,
      batchSha256: null,
      checkpointSha256: null,
      phase: 'collecting-readiness',
      relinquishmentProof: null,
      state: 'active',
      updatedAt: completedStatus.createdAt,
    };
    const preparing = createCloudToLanTargetEntry({
      createdAt: completedStatus.createdAt,
      expiresAt: completedStatus.expiresAt,
      operationIntentId: 'intent-self-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: 'member-host',
      selectedTargetPersonalRef: 'refs/heads/members/member-host',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(preparing, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: completedStatus.createdAt,
      targetUrl: completedStatus.targetUrl,
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: completedStatus.relinquishmentProof!.operationIntentId,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: completedStatus,
    });
    const targetEntry = handoffCloudToLanTargetEntry(published, physical);
    let managerEntry: CloudToLanManagerEntryRecord | null = recordCloudToLanManagerStatus(
      markCloudToLanManagerBeginPossiblySent(createCloudToLanManagerEntry({
        createdAt: collectingStatus.createdAt,
        descriptor: published.descriptor!,
        expiresAt: collectingStatus.expiresAt,
        initiatingMemberId: 'member-host',
        initiatingPersonalRef: 'refs/heads/members/member-host',
        operationIntentId: physical.operationIntentId,
      })),
      collectingStatus,
    );
    const handle = cloudToLanTransferHandle(managerEntry);
    const settleCloudToLanManagerEntry = jest.fn(async () => {
      managerEntry = null;
    });
    const persistence = {
      load: jest.fn(async () => physical),
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      loadCloudToLanTargetEntry: jest.fn(async () => targetEntry),
      recordCloudToLanManagerStatus: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
        transferStatus: CollabAuthorityTransferStatus,
      ) => {
        const recorded = recordCloudToLanManagerStatus(entry, transferStatus);
        managerEntry = recorded;
        return recorded;
      }),
      settleCloudToLanManagerEntry,
    } as unknown as AuthorityTransferPersistence;
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      listProjectMembers: jest.fn(),
      memberId: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(),
      serverUrl: 'https://cloud.example.test/',
    };
    const createCloudToLanConnection = jest.fn(async () => connection as never);
    const activate = jest.fn()
      .mockResolvedValueOnce('activation-proof')
      .mockRejectedValueOnce(new Error('simulated retry convergence failure'));
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate,
        cancelStaging: jest.fn(),
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence,
    });

    await expect(module.acceptCloudToLanTransfer({ handle })).resolves.toMatchObject({
      state: 'completed',
    });
    await expect(module.acceptCloudToLanTransfer({ handle })).rejects.toMatchObject({
      result: {
        durableProgress: true,
        operationId: physical.operationIntentId,
        status: 'recovery-required',
      },
    });

    expect(settleCloudToLanManagerEntry).toHaveBeenCalledTimes(1);
    expect(managerEntry).toBeNull();
    expect(createCloudToLanConnection).toHaveBeenCalledTimes(1);
  });

  it('releases the target listener and Cloud session when Manager cancellation settlement fails', async () => {
    const collectingStatus = proposal({
      direction: 'cloud-to-lan',
      sourceAuthority: { generation: 1, kind: 'cloud' },
      targetAuthority: { generation: 2, kind: 'lan' },
      targetUrl: 'https://192.168.1.20:54545',
    });
    const cancelledStatus: CollabAuthorityTransferStatus = {
      ...collectingStatus,
      phase: 'cancelled',
      state: 'cancelled',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };
    const preparing = createCloudToLanTargetEntry({
      createdAt: collectingStatus.createdAt,
      expiresAt: collectingStatus.expiresAt,
      operationIntentId: 'intent-cancelled-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: 'member-host',
      selectedTargetPersonalRef: 'refs/heads/members/member-host',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(preparing, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: collectingStatus.createdAt,
      targetUrl: collectingStatus.targetUrl,
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-cancelled-manager-begin',
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: cancelledStatus,
    });
    const targetEntry = handoffCloudToLanTargetEntry(published, physical);
    let managerEntry: CloudToLanManagerEntryRecord | null = recordCloudToLanManagerStatus(
      markCloudToLanManagerBeginPossiblySent(createCloudToLanManagerEntry({
        createdAt: collectingStatus.createdAt,
        descriptor: published.descriptor!,
        expiresAt: collectingStatus.expiresAt,
        initiatingMemberId: 'member-host',
        initiatingPersonalRef: 'refs/heads/members/member-host',
        operationIntentId: physical.operationIntentId,
      })),
      collectingStatus,
    );
    const completeTerminalCleanup = jest.fn(async () => undefined);
    const persistence = {
      completeTerminalCleanup,
      load: jest.fn(async () => physical),
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      loadCloudToLanTargetEntry: jest.fn(async () => targetEntry),
      recordCloudToLanManagerStatus: jest.fn(async () => {
        throw new Error('simulated Manager status persistence failure');
      }),
      settleCloudToLanManagerEntry: jest.fn(async () => { managerEntry = null; }),
    } as unknown as AuthorityTransferPersistence;
    const cancelStaging = jest.fn(async () => undefined);
    const disposeTarget = jest.fn(async () => undefined);
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      listProjectMembers: jest.fn(),
      memberId: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(),
      serverUrl: 'https://cloud.example.test/',
    };
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging,
        dispose: disposeTarget,
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence,
    });

    connection.memberId = 'member-relocated';
    await expect(module.acceptCloudToLanTransfer({
      handle: cloudToLanTransferHandle(managerEntry!),
    })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-cloud-binding-mismatch' },
    });
    connection.memberId = 'member-host';

    await expect(module.acceptCloudToLanTransfer({
      handle: cloudToLanTransferHandle(managerEntry!),
    })).rejects.toMatchObject({
      result: {
        durableProgress: true,
        operationId: physical.operationIntentId,
        status: 'recovery-required',
      },
    });

    expect(cancelStaging).toHaveBeenCalledTimes(1);
    expect(completeTerminalCleanup).toHaveBeenCalledTimes(1);
    expect(disposeTarget).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(2);
    expect(managerEntry).toMatchObject({ phase: 'observing' });
  });

  it('replays one frozen Manager begin after an ambiguous result without another snapshot', async () => {
    let managerEntry: CloudToLanManagerEntryRecord | null = null;
    const persistence = {
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      markCloudToLanManagerBeginPossiblySent: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = markCloudToLanManagerBeginPossiblySent(entry);
        return managerEntry;
      }),
      prepareCloudToLanManagerEntry: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = entry;
        return entry;
      }),
      recordCloudToLanManagerStatus: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
        transferStatus: CollabAuthorityTransferStatus,
      ) => {
        managerEntry = recordCloudToLanManagerStatus(entry, transferStatus);
        return managerEntry;
      }),
      rejectCloudToLanManagerEntry: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = rejectCloudToLanManagerEntry(entry);
        return managerEntry;
      }),
      settleCloudToLanManagerEntry: jest.fn(async () => {
        managerEntry = null;
      }),
    } as unknown as AuthorityTransferPersistence;
    const targetUrl = 'https://192.168.1.20:54545';
    const begun: CollabAuthorityTransferStatus = {
      ...proposal(),
      direction: 'cloud-to-lan',
      sourceAuthority: { generation: 1, kind: 'cloud' },
      targetAuthority: { generation: 2, kind: 'lan' },
      targetUrl,
    };
    const authorityTransfer = jest.fn()
      .mockRejectedValueOnce(new Error('ambiguous-network-loss'))
      .mockRejectedValueOnce(new CloudAuthorityRejection({ code: 'authorization-denied' }))
      .mockResolvedValueOnce(begun);
    const readSnapshot = jest.fn(async () => ({
      currentMember: {
        activatedAt: '2026-08-27T00:00:00.000Z',
        createdAt: '2026-08-27T00:00:00.000Z',
        displayName: 'Manager',
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
        status: 'active',
      },
      eventSequence: 3,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: {
        authorityGeneration: 1,
        createdAt: '2026-08-27T00:00:00.000Z',
        expectedMainOid: 'a'.repeat(40),
        id: PROJECT_ID,
        mainRef: 'refs/heads/main',
        name: 'Transfer Project',
      },
      ticketHighlights: [],
    }));
    const listProjectMembers = jest.fn(async () => ({
      authorityGeneration: 1,
      managerSetGeneration: 1,
      members: [{
        bindingState: 'bound',
        displayName: 'Target',
        importedClaimGeneration: null,
        importedClaimState: 'not-applicable',
        memberId: 'member-target',
        membershipRevision: 1,
        role: 'member',
      }],
      projectId: PROJECT_ID,
    }));
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer },
      listProjectMembers,
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
    };
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: jest.fn() as never,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: jest.fn(async (_projectId, _owner, _mode, operation) => operation()),
      } as unknown as CollabProjectLifecycleSubsystem,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      persistence,
    });
    const input = {
      descriptor: {
        caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
        caFingerprint: 'c'.repeat(64),
        preparationId: 'intent-target-preparation',
        projectId: PROJECT_ID,
        publishedAt: '2026-08-27T00:00:00.000Z',
        schemaVersion: 1 as const,
        selectedTargetMemberId: 'member-target',
        sourceAuthorityGeneration: 1,
        sourceCloudUrl: 'https://cloud.example.test/',
        targetUrl,
      },
      operationIntentId: 'intent-ambiguous-manager-begin',
    };

    await expect(module.beginCloudToLanTransfer(input)).rejects.toMatchObject({
      result: {
        durablePhase: 'committed',
        durableProgress: true,
        operationId: 'intent-ambiguous-manager-begin',
        status: 'recovery-required',
      },
    });
    expect(managerEntry).toMatchObject({ phase: 'submitted', status: null });
    connection.serverUrl = 'https://relocated.example.test/';
    await expect(module.beginCloudToLanTransfer({
      ...input,
      operationIntentId: 'intent-relocated-facade-retry',
    })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-cloud-binding-mismatch' },
    });
    expect(authorityTransfer).toHaveBeenCalledTimes(1);
    connection.serverUrl = 'https://cloud.example.test/';
    await expect(module.beginCloudToLanTransfer({
      ...input,
      operationIntentId: 'intent-new-facade-ambiguous-retry',
    })).rejects.toMatchObject({
      result: {
        durablePhase: 'committed',
        durableProgress: true,
        operationId: 'intent-ambiguous-manager-begin',
        status: 'recovery-required',
      },
    });
    expect(managerEntry).toMatchObject({ phase: 'submitted', status: null });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(listProjectMembers).toHaveBeenCalledTimes(1);
    await expect(module.beginCloudToLanTransfer({
      ...input,
      operationIntentId: 'intent-final-facade-ambiguous-retry',
    })).resolves.toMatchObject({
      operationIntentId: 'intent-ambiguous-manager-begin',
      transferId: TRANSFER_ID,
    });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(listProjectMembers).toHaveBeenCalledTimes(1);
    expect(authorityTransfer.mock.calls[0]?.[1]).toEqual(authorityTransfer.mock.calls[1]?.[1]);
    expect(authorityTransfer.mock.calls[1]?.[1]).toEqual(authorityTransfer.mock.calls[2]?.[1]);
  });

  it('serializes concurrent Manager begins before deciding whether a rejection is definitive', async () => {
    const descriptor = {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      preparationId: 'intent-concurrent-target-preparation',
      projectId: PROJECT_ID,
      publishedAt: '2026-08-27T00:00:00.000Z',
      schemaVersion: 1 as const,
      selectedTargetMemberId: 'member-target',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.20:54545',
    };
    let managerEntry: CloudToLanManagerEntryRecord | null = createCloudToLanManagerEntry({
      createdAt: '2026-08-27T00:00:00.000Z',
      descriptor,
      expiresAt: '2026-09-26T00:00:00.000Z',
      initiatingMemberId: 'member-manager',
      initiatingPersonalRef: 'refs/heads/members/member-manager',
      operationIntentId: 'intent-concurrent-manager-begin',
    });
    const persistence = {
      inspectLifecycleOwner: jest.fn(async () => managerEntry ? 'nonterminal' : 'absent'),
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      markCloudToLanManagerBeginPossiblySent: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = markCloudToLanManagerBeginPossiblySent(entry);
        return managerEntry;
      }),
      rejectCloudToLanManagerEntry: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => {
        managerEntry = rejectCloudToLanManagerEntry(entry);
        return managerEntry;
      }),
      settleCloudToLanManagerEntry: jest.fn(async () => {
        managerEntry = null;
      }),
    } as unknown as AuthorityTransferPersistence;
    const authorityTransfer = jest.fn()
      .mockRejectedValueOnce(new Error('ambiguous-network-loss-after-commit'))
      .mockRejectedValueOnce(new CloudAuthorityRejection({ code: 'authorization-denied' }));
    const readSnapshot = jest.fn(async () => ({
      currentMember: {
        id: 'member-manager',
        personalRef: 'refs/heads/members/member-manager',
        role: 'manager',
      },
      project: { authorityGeneration: 1, id: PROJECT_ID },
    }));
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer },
      listProjectMembers: jest.fn(async () => ({
        members: [{
          bindingState: 'bound',
          memberId: 'member-manager',
          role: 'manager',
        }],
        projectId: PROJECT_ID,
      })),
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
    };
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn(),
      durableOwners: [],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: jest.fn() as never,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      persistence,
    });
    const input = {
      descriptor,
      operationIntentId: 'intent-ignored-concurrent-retry',
    };

    const results = await Promise.allSettled([
      module.beginCloudToLanTransfer(input),
      module.beginCloudToLanTransfer(input),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({
        reason: {
          result: {
            durableProgress: true,
            operationId: 'intent-concurrent-manager-begin',
            status: 'recovery-required',
          },
        },
        status: 'rejected',
      });
    }
    expect(managerEntry).toMatchObject({ phase: 'submitted', status: null });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(persistence.rejectCloudToLanManagerEntry).not.toHaveBeenCalled();
  });

  it('replays a submitted Manager journal during startup recovery', async () => {
    const descriptor = {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      preparationId: 'intent-recovery-target-preparation',
      projectId: PROJECT_ID,
      publishedAt: '2026-08-27T00:00:00.000Z',
      schemaVersion: 1 as const,
      selectedTargetMemberId: 'member-target',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.20:54545',
    };
    let managerEntry: CloudToLanManagerEntryRecord | null =
      markCloudToLanManagerBeginPossiblySent(createCloudToLanManagerEntry({
        createdAt: '2026-08-27T00:00:00.000Z',
        descriptor,
        expiresAt: '2026-09-26T00:00:00.000Z',
        initiatingMemberId: 'member-manager',
        initiatingPersonalRef: 'refs/heads/members/member-manager',
        operationIntentId: 'intent-recovery-manager-begin',
      }));
    const frozenRequest = managerEntry.request;
    const begun = proposal({
      direction: 'cloud-to-lan',
      sourceAuthority: { generation: 1, kind: 'cloud' },
      targetAuthority: { generation: 2, kind: 'lan' },
      targetUrl: descriptor.targetUrl,
    });
    let physicalRecord: AuthorityTransferRecord | null = null;
    const persistence = {
      inspectLifecycleOwner: jest.fn(async () => 'absent'),
      load: jest.fn(async () => physicalRecord),
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      markCloudToLanManagerBeginPossiblySent: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
      ) => entry),
      recordCloudToLanManagerStatus: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
        status: CollabAuthorityTransferStatus,
      ) => {
        managerEntry = recordCloudToLanManagerStatus(entry, status);
        return managerEntry;
      }),
      scanProjectCatalog: jest.fn(async () => ({
        invalidEntryCount: 0,
        projectIds: [PROJECT_ID],
      })),
      settleCloudToLanManagerEntry: jest.fn(async () => { managerEntry = null; }),
    } as unknown as AuthorityTransferPersistence;
    const completed = recoverableClaimantRecord({ direction: 'cloud-to-lan' }).status;
    const authorityTransfer = jest.fn()
      .mockResolvedValueOnce(begun)
      .mockResolvedValueOnce(completed);
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer },
      listProjectMembers: jest.fn(),
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(),
      serverUrl: descriptor.sourceCloudUrl,
    };
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn(),
      durableOwners: [],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      persistence,
    });

    await expect(lifecycle.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(authorityTransfer).toHaveBeenCalledWith(
      'beginCloudToLanTransfer',
      frozenRequest,
      {},
    );
    expect(managerEntry).toMatchObject({ phase: 'observing', status: begun });
    expect(connection.dispose).toHaveBeenCalledTimes(1);

    physicalRecord = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-recovery-manager-begin',
      ownerInstallationKey: TEST_INSTALLATION_B,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: begun,
    });

    await expect(lifecycle.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(authorityTransfer).toHaveBeenLastCalledWith(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: TRANSFER_ID },
      {},
    );
    expect(managerEntry).toBeNull();
    expect(connection.dispose).toHaveBeenCalledTimes(2);
  });

  it('settles a same-device Manager only after its target physical recovery', async () => {
    const completedStatus = recoverableClaimantRecord({ direction: 'cloud-to-lan' }).status;
    const collectingStatus: CollabAuthorityTransferStatus = {
      ...completedStatus,
      batchRevision: null,
      batchSha256: null,
      checkpointSha256: null,
      phase: 'collecting-readiness',
      relinquishmentProof: null,
      state: 'active',
      updatedAt: completedStatus.createdAt,
    };
    const descriptor = {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      preparationId: 'intent-same-device-target-preparation',
      projectId: PROJECT_ID,
      publishedAt: completedStatus.createdAt,
      schemaVersion: 1 as const,
      selectedTargetMemberId: 'member-host',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: completedStatus.targetUrl,
    };
    let managerEntry: CloudToLanManagerEntryRecord | null = recordCloudToLanManagerStatus(
      markCloudToLanManagerBeginPossiblySent(createCloudToLanManagerEntry({
        createdAt: collectingStatus.createdAt,
        descriptor,
        expiresAt: collectingStatus.expiresAt,
        initiatingMemberId: 'member-host',
        initiatingPersonalRef: 'refs/heads/members/member-host',
        operationIntentId: completedStatus.relinquishmentProof!.operationIntentId,
      })),
      collectingStatus,
    );
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: managerEntry.operationIntentId,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: completedStatus,
    });
    const settleCloudToLanManagerEntry = jest.fn(async () => { managerEntry = null; });
    const persistence = {
      inspectLifecycleOwner: jest.fn(async () => 'nonterminal'),
      load: jest.fn(async () => physical),
      loadCloudToLanManagerEntry: jest.fn(async () => managerEntry),
      loadRecoveryOwnerRecord: jest.fn(async () => physical),
      recordCloudToLanManagerStatus: jest.fn(async (
        entry: CloudToLanManagerEntryRecord,
        status: CollabAuthorityTransferStatus,
      ) => {
        managerEntry = recordCloudToLanManagerStatus(entry, status);
        return managerEntry;
      }),
      recoverInterruptedClaimCommitment: jest.fn(async () => undefined),
      scanProjectCatalog: jest.fn(async () => ({
        invalidEntryCount: 0,
        projectIds: [PROJECT_ID],
      })),
      settleCloudToLanManagerEntry,
    } as unknown as AuthorityTransferPersistence;
    const resume = jest.fn(async () => undefined);
    const createCloudToLanConnection = jest.fn(async () => {
      throw new Error('same-device recovery must not reconnect Cloud');
    });
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn(),
      durableOwners: [],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      persistence,
      terminalResolver: { resolve: jest.fn(async () => ({ resume })) },
    });

    await expect(lifecycle.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(createCloudToLanConnection).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(PROJECT_ID, {});
    expect(settleCloudToLanManagerEntry).toHaveBeenCalledTimes(1);
    expect(managerEntry).toBeNull();
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
    } as unknown as CloudAuthorityConnection;
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
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
        runExclusive: async <Result>(
          _projectId: string,
          _owner: string,
          _mode: string,
          operation: () => Promise<Result>,
        ) => operation(),
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

    expect(prepareTarget).toHaveBeenCalledWith(targetUrl);
  });

  it('rebinds a published target entry to its exact listener endpoint during startup recovery', async () => {
    const targetUrl = 'https://192.168.1.20:54545';
    const preparing = createCloudToLanTargetEntry({
      createdAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-09-26T00:00:00.000Z',
      operationIntentId: 'intent-recovered-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: 'member-target',
      selectedTargetPersonalRef: 'refs/heads/members/member-target',
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(preparing, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-27T00:01:00.000Z',
      targetUrl,
    });
    const persistence = {
      inspectLifecycleOwner: jest.fn(async () => 'nonterminal'),
      loadCloudToLanManagerEntry: jest.fn(async () => null),
      loadCloudToLanTargetEntry: jest.fn(async () => published),
      loadRecoveryOwnerRecord: jest.fn(async () => null),
      scanProjectCatalog: jest.fn(async () => ({
        invalidEntryCount: 0,
        projectIds: [PROJECT_ID],
      })),
    } as unknown as AuthorityTransferPersistence;
    const readSnapshot = jest.fn(() => {
      throw new Error('published preparation recovery must not read a new snapshot');
    });
    const connection = {
      authorityGeneration: 1,
      dispose: jest.fn(),
      lifecycle: { authorityTransfer: jest.fn() },
      listProjectMembers: jest.fn(),
      memberId: 'member-target',
      personalRef: 'refs/heads/members/member-target',
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
    };
    const disposeTarget = jest.fn(async () => {
      throw new Error('listener-dispose-failed');
    });
    const prepareTarget = jest.fn(async (expectedTargetUrl?: string) => ({
      targetUrl: expectedTargetUrl ?? targetUrl,
    }));
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn(),
      durableOwners: [],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: ownerInstallationKey => {
        if (ownerInstallationKey !== TEST_INSTALLATION_A) throw new Error('foreign owner');
      },
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createCloudToLanConnection: async () => connection as never,
      createCloudToLanTarget: () => ({
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        dispose: disposeTarget,
        prepareTarget,
        stage: jest.fn(),
      }),
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      persistence,
    });

    await expect(lifecycle.lifecycleRecovery.resume()).resolves.toBeUndefined();

    expect(prepareTarget).toHaveBeenCalledWith(targetUrl);
    expect(readSnapshot).not.toHaveBeenCalled();
    await expect(module.close()).rejects.toThrow('listener-dispose-failed');
    expect(disposeTarget).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('reconstructs an accepted source runtime behind the existing LAN Host route', async () => {
    const sourceEndpoint = jest.fn(async () => 'https://127.0.0.1:54545');
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
    } as unknown as CloudAuthorityConnection;
    const recoverCloudSession = jest.fn(async () => cloudSession);
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-authority-transfer-module',
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: proposal(),
    });
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource: () => ({
        activateTerminal: jest.fn(),
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(),
        reopenAfterCancellation: jest.fn(),
        sourceEndpoint,
      }),
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {
        load: async () => record,
        loadSourceEntry: async () => null,
      } as unknown as AuthorityTransferPersistence,
      recoverCloudSession,
    });

    await module.runtimes.prepare(record);

    expect(recoverCloudSession).toHaveBeenCalledWith(record);
    expect(sourceEndpoint).toHaveBeenCalledWith(record);
    expect(module.sourceActiveService({
      authorityGeneration: 1,
      authenticateMemberCredential: async () => ({ memberId: 'member-host' }),
      hostMemberId: 'member-host',
      projectId: PROJECT_ID,
    })).not.toBeNull();
  });

  it.each([
    { phase: 'target-cleaned', state: 'active' },
    { phase: 'cancelled', state: 'cancelled' },
  ] as const)(
    'settles a locally recoverable source at $phase without reconnecting Cloud',
    async ({ phase, state }) => {
    const resume = jest.fn(async () => undefined);
    const recoverCloudSession = jest.fn(async () => {
      throw new Error('Cloud recovery must not run for settled cancellation');
    });
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: () => Promise.resolve([]),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
        save: () => Promise.resolve(),
      },
      convergence: {} as never,
      createLanToCloudSource: jest.fn() as never,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
      } as unknown as CollabProjectLifecycleSubsystem,
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
      recoverCloudSession,
      terminalResolver: {
        resolve: jest.fn(async () => ({ resume })),
      },
    });
    const record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-authority-transfer-module',
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...proposal(),
        phase,
        state,
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });

    await module.runtimes.resume(record, {});

    expect(resume).toHaveBeenCalledWith(PROJECT_ID, {});
    expect(recoverCloudSession).not.toHaveBeenCalled();
    },
  );

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
    } as unknown as CloudAuthorityConnection;
    const recoverClaimant = jest.fn(async () => ({
      cloudSession,
      direction: 'lan-to-cloud' as const,
      lanClient: { requestWithMember: jest.fn(async () => undefined) } as never,
      memberCredential: Buffer.alloc(32, 1).toString('base64url'),
      mode: 'full' as const,
    }));
    new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
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
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
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

  it('redeems a Manager-reissued claim through exact Cloud status and snapshot confirmation', async () => {
    let record: AuthorityTransferClaimantRecord | null = null;
    const phases: string[] = [];
    const status = recoverableClaimantRecord().status;
    const descriptor = managerReissuedDescriptor();
    const receipt = {
      checkpointSha256: status.checkpointSha256!,
      claimSha256: createHash('sha256').update(descriptor.claim, 'utf8').digest('hex'),
      memberId: descriptor.memberId,
      projectId: PROJECT_ID,
      receiptId: 'receipt-manager-reissued',
      receiptKeyId: 'receipt-key-manager-reissued',
      redeemedAt: '2026-10-01T00:01:00.000Z',
      signature: Buffer.alloc(64, 3).toString('base64url'),
      signatureAlgorithm: 'ed25519' as const,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    };
    const authorityTransfer = jest.fn(async (
      operation: string,
      request: Readonly<{ readonly idempotencyKey?: string }>,
    ) => operation === 'claimTransferredMembership'
      ? { ...receipt, operationIntentId: request.idempotencyKey! }
      : status);
    const snapshot = {
      currentMember: {
        displayName: 'Host',
        id: 'member-host',
        personalRef: 'refs/heads/members/member-host',
        role: 'manager' as const,
      },
      eventSequence: 9,
      project: {
        authorityGeneration: 2,
        authorityKind: 'cloud' as const,
        id: PROJECT_ID,
        name: 'Recovery',
      },
    };
    const readSnapshot = jest.fn(async () => snapshot);
    const cloudSession = {
      dispose: jest.fn(),
      lifecycle: { authorityTransfer },
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
      supports: (capability: CollabCloudCapability) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityConnection;
    const lanToCloudMember = jest.fn(async () => undefined);
    const createManagerReissuedClaimConnection = jest.fn(async () => cloudSession);
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: async () => record ? [PROJECT_ID] : [],
        load: async () => record,
        remove: async () => {
          const existed = record !== null;
          record = null;
          return existed;
        },
        save: async current => {
          record = current;
          phases.push(current.phase);
        },
      },
      convergence: { lanToCloudMember } as never,
      createManagerReissuedClaimConnection,
      createLanToCloudSource: jest.fn() as never,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: async <Result>(
          _projectId: string,
          _owner: string,
          _mode: string,
          operation: () => Promise<Result>,
        ) => operation(),
      } as unknown as CollabProjectLifecycleSubsystem,
      loadClaimantMembership: async () => ({
        authority: {
          authorityGeneration: 1,
          endpoint: 'https://192.168.1.10:54545',
          gitRemoteUrl: `https://192.168.1.10:54545/v1/git/${PROJECT_ID}/repository.git`,
          hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nsource\n-----END CERTIFICATE-----\n',
          hostCaFingerprint: 'a'.repeat(64),
          kind: 'lan',
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        hostOwnership: { ownsAuthority: false },
        lastEventSequence: 1,
        member: {
          credential: Buffer.alloc(32, 1).toString('base64url'),
          displayName: 'Host',
          id: 'member-host',
          personalRef: 'refs/heads/members/member-host',
          role: 'manager',
        },
        project: { id: PROJECT_ID, name: 'Recovery', workspacePath: 'workspace/recovery' },
        schemaVersion: 3,
        updatedAt: '2026-08-27T00:00:00.000Z',
      }),
      now: () => new Date('2026-10-01T00:00:10.000Z'),
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
    });
    const controller = new AbortController();
    await module.redeemManagerReissuedClaim({
      claim: descriptor,
      kind: 'cloud-membership-claim',
      serverUrl: 'https://cloud.example.test/',
    }, {
      signal: controller.signal,
    });

    expect(phases).toEqual([
      'redemption-prepared',
      'target-claimed',
      'target-confirmed',
      'membership-converged',
      'completed',
    ]);
    expect(authorityTransfer.mock.calls.map(([operation]) => operation)).toEqual([
      'claimTransferredMembership',
      'getProjectAuthorityTransfer',
    ]);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(lanToCloudMember).toHaveBeenCalledWith({ snapshot, status });
    expect(createManagerReissuedClaimConnection).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test/',
    }, { signal: controller.signal });
    expect(record).toBeNull();
    expect(cloudSession.dispose).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it('rejects Manager-reissued redemption before local or remote work when another lifecycle owner is pending', async () => {
    const loadClaimantMembership = jest.fn(async () => managerClaimantMembership());
    const createManagerReissuedClaimConnection = jest.fn(async () => {
      throw new Error('claim connection must not open');
    });
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn(),
      durableOwners: [{
        inspect: async () => 'nonterminal',
        name: 'local-exit',
      }],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: async () => [],
        load: async () => null,
        remove: async () => false,
        save: jest.fn(async () => undefined),
      },
      convergence: {} as never,
      createLanToCloudSource: jest.fn() as never,
      createManagerReissuedClaimConnection,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      loadClaimantMembership,
      persistence: {
        inspectLifecycleOwner: jest.fn(async () => 'absent'),
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
    });

    await expect(module.redeemManagerReissuedClaim({
      claim: managerReissuedDescriptor(),
      kind: 'cloud-membership-claim',
      serverUrl: 'https://cloud.example.test/',
    })).rejects.toMatchObject({
      safeContext: { reason: 'lifecycle-owner-pending' },
    });

    expect(loadClaimantMembership).not.toHaveBeenCalled();
    expect(createManagerReissuedClaimConnection).not.toHaveBeenCalled();
  });

  it('queues the complete Manager-reissued entry before claimant persistence', async () => {
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: jest.fn(),
      durableOwners: [],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const saved: AuthorityTransferClaimantRecord[] = [];
    const loadClaimantMembership = jest.fn(async () => managerClaimantMembership());
    const cloudSession = {
      dispose: jest.fn(),
      lifecycle: {
        authorityTransfer: jest.fn(async () => {
          throw new Error('simulated remote stop');
        }),
      },
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(),
      serverUrl: 'https://cloud.example.test/',
      supports: () => true,
    } as unknown as CloudAuthorityConnection;
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      claimantStore: {
        listProjectIds: async () => saved.length > 0 ? [PROJECT_ID] : [],
        load: async () => saved.at(-1) ?? null,
        remove: async () => false,
        save: async record => { saved.push(record); },
      },
      convergence: {} as never,
      createLanToCloudSource: jest.fn() as never,
      createManagerReissuedClaimConnection: async () => cloudSession,
      installationKey: TEST_INSTALLATION_A,
      lifecycle,
      loadClaimantMembership,
      persistence: {
        inspectLifecycleOwner: jest.fn(async () => 'absent'),
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
    });
    const competingOwner = lifecycle.runExclusive(
      PROJECT_ID,
      'local-exit',
      'operation',
      async () => {
        ownerEntered();
        await ownerGate;
      },
    );
    await entered;

    const redemption = module.redeemManagerReissuedClaim({
      claim: managerReissuedDescriptor(),
      kind: 'cloud-membership-claim',
      serverUrl: 'https://cloud.example.test/',
    }).catch(error => error as Error);
    await new Promise(resolve => setImmediate(resolve));
    const membershipLoadedBeforeRelease = loadClaimantMembership.mock.calls.length > 0;
    const savedBeforeRelease = saved.length > 0;

    releaseOwner();
    await competingOwner;
    await expect(redemption).resolves.toMatchObject({ message: 'simulated remote stop' });
    expect(membershipLoadedBeforeRelease).toBe(false);
    expect(savedBeforeRelease).toBe(false);
    expect(loadClaimantMembership).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      expect.objectContaining({ phase: 'redemption-prepared', variant: 'manager-reissued' }),
    ]);
    expect(cloudSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired ambiguous Manager reissue only from exact authenticated target binding', async () => {
    const descriptor = managerReissuedDescriptor();
    let record: AuthorityTransferClaimantRecord | null =
      createManagerReissuedAuthorityTransferClaimantRecord({
        descriptor,
        memberPersonalRef: 'refs/heads/members/member-host',
        operationIntentId: 'intent-manager-reissued-expired',
        serverUrl: 'https://cloud.example.test/',
      });
    const status = recoverableClaimantRecord().status;
    const authorityTransfer = jest.fn(async () => status);
    const readSnapshot = jest.fn(async () => managerClaimantSnapshot());
    const cloudSession = {
      dispose: jest.fn(),
      lifecycle: { authorityTransfer },
      projectId: PROJECT_ID,
      readSnapshot,
      serverUrl: 'https://cloud.example.test/',
      supports: (capability: CollabCloudCapability) => (
        capability === 'authority-transfer' || capability === 'project-snapshot'
      ),
    } as unknown as CloudAuthorityConnection;
    const lanToCloudMember = jest.fn(async () => undefined);
    const module = new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
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
      convergence: { lanToCloudMember } as never,
      createLanToCloudSource: jest.fn() as never,
      createManagerReissuedClaimConnection: async () => cloudSession,
      installationKey: TEST_INSTALLATION_A,
      lifecycle: {
        registerDurableOwner: jest.fn(),
        registerRecoveryStage: jest.fn(),
        runExclusive: async <Result>(
          _projectId: string,
          _owner: string,
          _mode: string,
          operation: () => Promise<Result>,
        ) => operation(),
      } as unknown as CollabProjectLifecycleSubsystem,
      loadClaimantMembership: async () => managerClaimantMembership(),
      now: () => new Date(descriptor.expiresAt),
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
    });

    await module.redeemManagerReissuedClaim({
      claim: descriptor,
      kind: 'cloud-membership-claim',
      serverUrl: 'https://cloud.example.test/',
    });

    expect(authorityTransfer).toHaveBeenCalledWith(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: TRANSFER_ID },
      {},
    );
    expect(authorityTransfer).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(lanToCloudMember).toHaveBeenCalledTimes(1);
    expect(record).toBeNull();
    expect(cloudSession.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Member', { currentMember: { ...managerClaimantSnapshot().currentMember, id: 'member-other' } }],
    ['personal ref', { currentMember: { ...managerClaimantSnapshot().currentMember, personalRef: 'refs/heads/members/other' } }],
    ['generation', { project: { ...managerClaimantSnapshot().project, authorityGeneration: 3 } }],
  ] as const)(
    'keeps an expired Manager reissue blocked when target %s does not match',
    async (_label, override) => {
      const descriptor = managerReissuedDescriptor();
      let record: AuthorityTransferClaimantRecord | null =
        createManagerReissuedAuthorityTransferClaimantRecord({
          descriptor,
          memberPersonalRef: 'refs/heads/members/member-host',
          operationIntentId: 'intent-manager-reissued-expired',
          serverUrl: 'https://cloud.example.test/',
        });
      const status = recoverableClaimantRecord().status;
      const snapshot = managerClaimantSnapshot();
      const cloudSession = {
        dispose: jest.fn(),
        lifecycle: { authorityTransfer: jest.fn(async () => status) },
        projectId: PROJECT_ID,
        readSnapshot: jest.fn(async () => ({ ...snapshot, ...override })),
        serverUrl: 'https://cloud.example.test/',
        supports: () => true,
      } as unknown as CloudAuthorityConnection;
      const lanToCloudMember = jest.fn();
      const module = new AuthorityTransferModule({
        assertLanToCloudSourceOwner: () => undefined,
        assertRecoveryOwner: () => undefined,
        claimantStore: {
          listProjectIds: async () => [PROJECT_ID],
          load: async () => record,
          remove: async () => false,
          save: async current => { record = current; },
        },
        convergence: { lanToCloudMember } as never,
        createLanToCloudSource: jest.fn() as never,
        createManagerReissuedClaimConnection: async () => cloudSession,
        installationKey: TEST_INSTALLATION_A,
        lifecycle: {
          registerDurableOwner: jest.fn(),
          registerRecoveryStage: jest.fn(),
          runExclusive: async <Result>(
            _projectId: string,
            _owner: string,
            _mode: string,
            operation: () => Promise<Result>,
          ) => operation(),
        } as unknown as CollabProjectLifecycleSubsystem,
        loadClaimantMembership: async () => managerClaimantMembership(),
        now: () => new Date(descriptor.expiresAt),
        persistence: {
          loadCloudToLanManagerEntry: jest.fn(async () => null),
        } as unknown as AuthorityTransferPersistence,
      });

      await expect(module.redeemManagerReissuedClaim({
        claim: descriptor,
        kind: 'cloud-membership-claim',
        serverUrl: 'https://cloud.example.test/',
      })).rejects.toMatchObject({
        safeContext: { reason: 'authority-transfer-claimant-target-binding-invalid' },
      });

      expect(record).toMatchObject({
        phase: 'redemption-prepared',
        variant: 'manager-reissued',
      });
      expect(lanToCloudMember).not.toHaveBeenCalled();
      expect(cloudSession.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('does not recover a claimant while its same-Project Manager observer is unresolved', async () => {
    const record = recoverableClaimantRecord();
    let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
    const recoverClaimant = jest.fn();
    new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
      installationKey: TEST_INSTALLATION_A,
      claimantStore: {
        listProjectIds: async () => [PROJECT_ID],
        load: async () => record,
        remove: async () => false,
        save: async () => undefined,
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
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => ({ phase: 'observing' })),
      } as unknown as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await expect(claimantRecovery!.run()).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-manager-observer-pending' },
    });
    expect(recoverClaimant).not.toHaveBeenCalled();
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
      assertLanToCloudSourceOwner: () => undefined,
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
        persistence: {
          loadCloudToLanManagerEntry: jest.fn(async () => null),
        } as unknown as AuthorityTransferPersistence,
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

  it('finishes a target-confirmed Manager-reissued claimant locally without Cloud or LAN transport', async () => {
    const descriptor = managerReissuedDescriptor();
    const status = recoverableClaimantRecord().status;
    const prepared = createManagerReissuedAuthorityTransferClaimantRecord({
      descriptor,
      memberPersonalRef: 'refs/heads/members/member-host',
      operationIntentId: 'intent-manager-local-only',
      serverUrl: 'https://cloud.example.test/',
    });
    const claimed = advanceAuthorityTransferClaimantRecord(prepared, {
      phase: 'target-claimed',
      redemptionReceipt: {
        checkpointSha256: status.checkpointSha256!,
        claimSha256: createHash('sha256').update(descriptor.claim, 'utf8').digest('hex'),
        memberId: descriptor.memberId,
        operationIntentId: prepared.operationIntentId,
        projectId: descriptor.projectId,
        receiptId: 'receipt-manager-local-only',
        receiptKeyId: 'receipt-key-manager-local-only',
        redeemedAt: '2026-10-01T00:01:00.000Z',
        signature: Buffer.alloc(64, 3).toString('base64url'),
        signatureAlgorithm: 'ed25519',
        targetAuthorityGeneration: descriptor.targetAuthorityGeneration,
        transferId: descriptor.transferId,
      },
      updatedAt: '2026-10-01T00:01:00.000Z',
    });
    let record: AuthorityTransferClaimantRecord | null =
      advanceAuthorityTransferClaimantRecord(claimed, {
        convergenceProof: 'receipt',
        phase: 'target-confirmed',
        targetStatus: status,
        updatedAt: '2026-10-01T00:02:00.000Z',
      });
    let claimantRecovery: AuthorityTransferClaimantRecovery | null = null;
    const recoverConvertedClaimant = jest.fn(async () => undefined);
    const recoverClaimant = jest.fn(async () => ({
      direction: 'lan-to-cloud' as const,
      mode: 'local-only' as const,
    }));
    new AuthorityTransferModule({
      assertLanToCloudSourceOwner: () => undefined,
      assertRecoveryOwner: () => undefined,
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
      installationKey: TEST_INSTALLATION_A,
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
      now: () => new Date('2026-10-01T00:03:00.000Z'),
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await claimantRecovery!.run();

    expect(recoverClaimant).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'target-confirmed',
      variant: 'manager-reissued',
    }));
    expect(recoverConvertedClaimant).toHaveBeenCalledTimes(1);
    expect(record).toBeNull();
  });

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
      assertLanToCloudSourceOwner: () => undefined,
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
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
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
      assertLanToCloudSourceOwner: () => undefined,
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
        persistence: {
          loadCloudToLanManagerEntry: jest.fn(async () => null),
        } as unknown as AuthorityTransferPersistence,
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
      assertLanToCloudSourceOwner: () => undefined,
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
      persistence: {
        loadCloudToLanManagerEntry: jest.fn(async () => null),
      } as unknown as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await claimantRecovery!.run();

    expect(record).toBeNull();
    expect(recoverClaimant).not.toHaveBeenCalled();
  });
});
