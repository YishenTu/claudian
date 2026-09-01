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
import {
  LanToCloudRequesterCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudRequesterCoordinator';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  LanAuthorityTransferClient,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type {
  CloudAuthorityConnection,
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
      persistence: {} as AuthorityTransferPersistence,
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
      persistence: {} as AuthorityTransferPersistence,
      recoverClaimant,
    });

    await claimantRecovery!.run();

    expect(record).toBeNull();
    expect(recoverClaimant).not.toHaveBeenCalled();
  });
});
