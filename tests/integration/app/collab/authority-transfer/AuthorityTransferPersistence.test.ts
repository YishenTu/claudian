import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type CollabAuthorityTransferStatus,
  type CollabCloudToLanTransferPhase,
  type CollabLanToCloudTransferPhase,
  type CollabTransferredMembershipClaimBatch,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';
import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';

import {
  createAuthorityTransferEntryDocument,
  createAuthorityTransferEntryRecord as createOwnedAuthorityTransferEntryRecord,
  createAuthorityTransferRequesterEntry as createOwnedAuthorityTransferRequesterEntry,
  prepareAuthorityTransferSourceCancellation,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import {
  assertAuthorityTransferTransition,
  createAuthorityTransferRecord,
  decodeAuthorityTransferRecord,
  expireAuthorityTransferTerminalResponder,
  markAuthorityTransferTerminalCleanupCompleted,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  createCloudToLanManagerEntry,
  createCloudToLanTargetEntry,
  decodeCloudToLanManagerEntryRecord,
  markCloudToLanManagerBeginPossiblySent,
  publishCloudToLanTargetEntry,
  recordCloudToLanManagerStatus,
  rejectCloudToLanManagerEntry,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import {
  createAuthorityTransferClaimBatchCommitmentRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimBatchCommitmentRecord';
import {
  createAuthorityTransferClaimCustodyRecord,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferClaimCustodyRecord';
import {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';

const PROJECT_ID = 'project-alpha';
const TRANSFER_ID = 'transfer-one';
const OPERATION_INTENT_ID = 'intent-one';
const CLOUD_RELINQUISHMENT_INTENT_ID = 'intent-cloud-relinquishment';
const CHECKPOINT_SHA256 = 'a'.repeat(64);
const MEMBER_ALICE = 'member-alice';
const MEMBER_BOB = 'member-bob';
const EXPIRES_AT = '2026-09-30T00:00:00.000Z';

function createAuthorityTransferEntryRecord(
  input: Omit<
    Parameters<typeof createOwnedAuthorityTransferEntryRecord>[0],
    'ownerInstallationKey'
  >,
) {
  return createOwnedAuthorityTransferEntryRecord({
    ...input,
    ownerInstallationKey: TEST_INSTALLATION_A,
  });
}

function createAuthorityTransferRequesterEntry(
  input: Omit<
    Parameters<typeof createOwnedAuthorityTransferRequesterEntry>[0],
    'installationKey'
  >,
) {
  return createOwnedAuthorityTransferRequesterEntry({
    ...input,
    installationKey: TEST_INSTALLATION_A,
  });
}
const ENTRY_EXPIRES_AT = '2026-09-25T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function claimBatch(
  batchRevision = 1,
  claimSuffix = 'A',
  options: {
    readonly claims?: CollabTransferredMembershipClaimBatch['claims'];
    readonly expiresAt?: string;
  } = {},
): CollabTransferredMembershipClaimBatch {
  const unsigned: CollabTransferredMembershipClaimBatch = {
    batchRevision,
    batchSha256: '0'.repeat(64),
    checkpointSha256: CHECKPOINT_SHA256,
    claims: options.claims ?? [
      { claim: `${'A'.repeat(42)}${claimSuffix}`, memberId: MEMBER_ALICE },
      { claim: `${'B'.repeat(42)}${claimSuffix}`, memberId: MEMBER_BOB },
    ],
    expiresAt: options.expiresAt ?? EXPIRES_AT,
    projectId: PROJECT_ID,
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  };
  return {
    ...unsigned,
    batchSha256: sha256(encodeCollabTransferredMembershipClaimBatchDigestInput(unsigned)),
  };
}

const LAN_TO_CLOUD_PHASES: readonly CollabLanToCloudTransferPhase[] = [
  'collecting-readiness',
  'source-quiesced',
  'checkpoint-received',
  'checkpoint-validated',
  'claims-retained',
  'repository-published',
  'source-relinquished',
  'cloud-activated',
  'completed',
];
const CLOUD_TO_LAN_PHASES: readonly CollabCloudToLanTransferPhase[] = [
  'collecting-readiness',
  'cloud-quiesced',
  'checkpoint-captured',
  'target-staged',
  'claims-retained',
  'cloud-relinquished',
  'lan-activated',
  'completed',
];

function transferStatus(
  phase: CollabLanToCloudTransferPhase,
  updatedMinute = LAN_TO_CLOUD_PHASES.indexOf(phase),
): CollabAuthorityTransferStatus {
  const checkpointRequired = LAN_TO_CLOUD_PHASES.indexOf(phase) >= 2;
  const batchRequired = LAN_TO_CLOUD_PHASES.indexOf(phase) >= 4;
  const relinquished = LAN_TO_CLOUD_PHASES.indexOf(phase) >= 6;
  const proof = relinquished
    ? {
        batchRevision: 1,
        batchSha256: claimBatch().batchSha256,
        certificate: 'A'.repeat(86),
        certificateAlgorithm: 'ed25519' as const,
        checkpointSha256: CHECKPOINT_SHA256,
        committedAt: '2026-08-26T00:05:00.000Z',
        operationIntentId: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        sourceAuthority: { generation: 1, kind: 'lan' as const },
        sourceHostMemberId: MEMBER_ALICE,
        targetAuthority: { generation: 2, kind: 'cloud' as const },
        transferId: TRANSFER_ID,
      }
    : null;
  return {
    batchRevision: batchRequired ? 1 : null,
    batchSha256: batchRequired ? claimBatch().batchSha256 : null,
    checkpointSha256: checkpointRequired ? CHECKPOINT_SHA256 : null,
    createdAt: '2026-08-26T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: EXPIRES_AT,
    phase,
    projectId: PROJECT_ID,
    relinquishmentProof: proof,
    sourceAuthority: { generation: 1, kind: 'lan' },
    state: phase === 'completed' ? 'completed' : 'active',
    targetAuthority: { generation: 2, kind: 'cloud' },
    targetUrl: 'http://127.0.0.1:8787/',
    transferId: TRANSFER_ID,
    updatedAt: `2026-08-26T00:${String(updatedMinute).padStart(2, '0')}:00.000Z`,
  };
}

function proposalStatus(
  overrides: Partial<CollabAuthorityTransferStatus> = {},
): CollabAuthorityTransferStatus {
  return {
    ...transferStatus('collecting-readiness'),
    expiresAt: ENTRY_EXPIRES_AT,
    ...overrides,
  };
}

function cloudToLanStatus(
  phase: CollabCloudToLanTransferPhase,
): CollabAuthorityTransferStatus {
  const phaseIndex = CLOUD_TO_LAN_PHASES.indexOf(phase);
  const checkpointRequired = phaseIndex >= 2;
  const batchRequired = phaseIndex >= 4;
  const relinquished = phaseIndex >= 5;
  return {
    batchRevision: batchRequired ? 1 : null,
    batchSha256: batchRequired ? claimBatch().batchSha256 : null,
    checkpointSha256: checkpointRequired ? CHECKPOINT_SHA256 : null,
    createdAt: '2026-08-26T00:00:00.000Z',
    direction: 'cloud-to-lan',
    expiresAt: EXPIRES_AT,
    phase,
    projectId: PROJECT_ID,
    relinquishmentProof: relinquished
      ? {
          batchRevision: 1,
          batchSha256: claimBatch().batchSha256,
          certificate: 'A'.repeat(86),
          certificateAlgorithm: 'ed25519',
          checkpointSha256: CHECKPOINT_SHA256,
          committedAt: '2026-08-26T00:04:30.000Z',
          operationIntentId: CLOUD_RELINQUISHMENT_INTENT_ID,
          projectId: PROJECT_ID,
          sourceAuthority: { generation: 1, kind: 'cloud' },
          sourceHostMemberId: null,
          targetAuthority: { generation: 2, kind: 'lan' },
          transferId: TRANSFER_ID,
        }
      : null,
    sourceAuthority: { generation: 1, kind: 'cloud' },
    state: phase === 'completed' ? 'completed' : 'active',
    targetAuthority: { generation: 2, kind: 'lan' },
    targetUrl: 'https://192.168.1.20:27001/',
    transferId: TRANSFER_ID,
    updatedAt: `2026-08-26T00:${String(phaseIndex).padStart(2, '0')}:00.000Z`,
  };
}

describe('AuthorityTransferPersistence', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-authority-transfer-'));
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-08-26T00:01:00.000Z'));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('persists and replays a source-local proposal before handing it to one physical owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request,
      status: proposalStatus(),
    });

    await expect(persistence.proposeEntry(entry)).resolves.toEqual(entry);
    persistence = new AuthorityTransferPersistence(
      new CollabLocalProjectRepository(vaultRoot),
      { isRecoveryOwner: () => true },
    );
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toEqual(entry);
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('proposal');
    await expect(persistence.proposeEntry(createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request,
      status: {
        ...entry.status,
        transferId: 'transfer-retry-must-not-replace-identity',
      },
    }))).resolves.toEqual(entry);
    await expect(persistence.proposeEntry(createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_ALICE,
      request,
      status: entry.status,
    }))).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-entry-conflict' },
    });

    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    await expect(persistence.handoffEntry(entry, physical)).resolves.toEqual(physical);
    await expect(persistence.load(PROJECT_ID)).resolves.toEqual(physical);
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toMatchObject({
      phase: 'handed-off',
      successor: {
        operationIntentId: OPERATION_INTENT_ID,
        ownerInstallationKey: TEST_INSTALLATION_A,
        transferId: TRANSFER_ID,
      },
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
  });

  it('proves imported-claim management only for the matching completed LAN-to-Cloud source custody', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    }));
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('completed'),
    }));
    await persistence.retainClaimBatch({
      batch: claimBatch(),
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await persistence.acknowledgeClaimBatch({
      batchRevision: 1,
      batchSha256: claimBatch().batchSha256,
      checkpointSha256: CHECKPOINT_SHA256,
      committedAt: '2026-08-26T00:03:00.000Z',
      custodyAuthority: { generation: 1, kind: 'lan' },
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-imported-management',
      submittedByMemberId: MEMBER_ALICE,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    });

    await expect(persistence.assertCloudImportedClaimManagementPredecessor(
      PROJECT_ID,
      {
        actorMemberId: MEMBER_ALICE,
        authorityGeneration: 2,
        importedMemberId: MEMBER_BOB,
      },
    )).resolves.toBeUndefined();
    await expect(persistence.assertCloudImportedClaimManagementPredecessor(
      PROJECT_ID,
      {
        actorMemberId: MEMBER_ALICE,
        authorityGeneration: 2,
        importedMemberId: 'member-not-imported',
      },
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-imported-claim-predecessor-invalid' },
    });
    await expect(persistence.assertCloudImportedClaimManagementPredecessor(
      PROJECT_ID,
      {
        actorMemberId: MEMBER_BOB,
        authorityGeneration: 2,
        importedMemberId: MEMBER_ALICE,
      },
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-imported-claim-predecessor-invalid' },
    });
    await expect(persistence.assertCloudImportedClaimManagementPredecessor(
      PROJECT_ID,
      {
        actorMemberId: MEMBER_ALICE,
        authorityGeneration: 3,
        importedMemberId: MEMBER_BOB,
      },
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-imported-claim-predecessor-invalid' },
    });

    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: cloudToLanStatus('completed'),
    }));
    await expect(persistence.assertCloudImportedClaimManagementPredecessor(
      PROJECT_ID,
      {
        actorMemberId: MEMBER_ALICE,
        authorityGeneration: 2,
        importedMemberId: MEMBER_BOB,
      },
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-imported-claim-predecessor-invalid' },
    });
  });

  it('persists coexisting target and Manager entries and recovers a physical-first target handoff', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const target = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(target, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    await persistence.prepareCloudToLanTargetEntry(target);
    await persistence.publishCloudToLanTargetEntry(target, published.descriptor!);
    const manager = createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:00:45.000Z',
      descriptor: published.descriptor!,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      ownerInstallationKey: TEST_INSTALLATION_A,
      operationIntentId: OPERATION_INTENT_ID,
    });
    await persistence.prepareCloudToLanManagerEntry(manager);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      manager: { operationIntentId: OPERATION_INTENT_ID, phase: 'prepared' },
      target: { operationIntentId: 'intent-target-preparation', phase: 'published' },
    });

    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...cloudToLanStatus('collecting-readiness'),
        targetUrl: published.descriptor!.targetUrl,
      },
    });
    let injectSplit = true;
    const splitEntryStore = {
      ...repository.authorityTransferEntries,
      saveTarget: async (record: typeof published) => {
        if (record.phase === 'handed-off' && injectSplit) {
          injectSplit = false;
          throw new Error('injected-target-handoff-split');
        }
        await repository.authorityTransferEntries.saveTarget(record);
      },
    };
    const splitPersistence = new AuthorityTransferPersistence({
      authorityTransferClaimCommitments: repository.authorityTransferClaimCommitments,
      authorityTransferClaims: repository.authorityTransferClaims,
      authorityTransferEntries: splitEntryStore,
      authorityTransferRecords: repository.authorityTransferRecords,
    }, { isRecoveryOwner: owner => owner === TEST_INSTALLATION_A });
    await expect(splitPersistence.handoffCloudToLanTargetEntry(published, physical))
      .rejects.toThrow('injected-target-handoff-split');
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toEqual(physical);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      target: { phase: 'published', successor: null },
    });

    const recovered = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    await expect(recovered.load(PROJECT_ID)).resolves.toEqual(physical);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      manager: { phase: 'prepared' },
      target: {
        phase: 'handed-off',
        successor: {
          operationIntentId: OPERATION_INTENT_ID,
          ownerInstallationKey: TEST_INSTALLATION_A,
          transferId: TRANSFER_ID,
        },
      },
    });
    await expect(recovered.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
  });

  it('rejects a Manager begin while an unrelated local target preparation exists', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const target = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-unrelated-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(target, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    await persistence.prepareCloudToLanTargetEntry(target);
    await persistence.publishCloudToLanTargetEntry(target, published.descriptor!);
    const unrelatedDescriptor = {
      ...published.descriptor!,
      targetUrl: 'https://192.168.1.99:27001',
    };

    await expect(persistence.prepareCloudToLanManagerEntry(
      createCloudToLanManagerEntry({
        createdAt: '2026-08-26T00:00:45.000Z',
        descriptor: unrelatedDescriptor,
        expiresAt: ENTRY_EXPIRES_AT,
        initiatingMemberId: MEMBER_ALICE,
        initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
        ownerInstallationKey: TEST_INSTALLATION_A,
        operationIntentId: OPERATION_INTENT_ID,
      }),
    )).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-manager-entry-conflict' },
    });
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      manager: null,
      target: { operationIntentId: 'intent-unrelated-target-preparation' },
    });
  });

  it('withdraws a preparing target before descriptor publication', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
      now: () => new Date('2026-08-26T00:00:30.000Z'),
    });
    const preparing = await persistence.prepareCloudToLanTargetEntry(
      createCloudToLanTargetEntry({
        createdAt: '2026-08-26T00:00:00.000Z',
        expiresAt: ENTRY_EXPIRES_AT,
        operationIntentId: 'intent-unpublished-target',
        ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: PROJECT_ID,
        selectedTargetMemberId: MEMBER_BOB,
        selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
        sourceAuthorityGeneration: 1,
        sourceCloudUrl: 'https://cloud.example.test/',
      }),
    );

    await expect(persistence.withdrawCloudToLanTargetEntry(preparing)).resolves.toMatchObject({
      descriptor: null,
      phase: 'withdrawn',
      withdrawnAt: '2026-08-26T00:00:30.000Z',
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
  });

  it('withdraws only the same-device target while its Manager begin remains unresolved', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const preparing = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-original-target',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_ALICE,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(preparing, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    await persistence.prepareCloudToLanTargetEntry(preparing);
    await persistence.publishCloudToLanTargetEntry(preparing, published.descriptor!);
    await persistence.prepareCloudToLanManagerEntry(createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:00:45.000Z',
      descriptor: published.descriptor!,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      ownerInstallationKey: TEST_INSTALLATION_A,
      operationIntentId: OPERATION_INTENT_ID,
    }));
    await expect(persistence.withdrawCloudToLanTargetEntry(published)).resolves.toMatchObject({
      phase: 'withdrawn',
    });
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      manager: { operationIntentId: OPERATION_INTENT_ID, phase: 'prepared' },
      target: { operationIntentId: 'intent-original-target', phase: 'withdrawn' },
    });
    const replacement = createCloudToLanTargetEntry({
      ...preparing,
      operationIntentId: 'intent-replacement-target',
    });

    await expect(persistence.prepareCloudToLanTargetEntry(replacement)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-target-entry-conflict' },
    });
  });

  it('observes an exact published foreign target while preparing its Manager entry', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const foreignTarget = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-foreign-target',
      ownerInstallationKey: TEST_INSTALLATION_B,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(foreignTarget, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    await repository.authorityTransferEntries.saveTarget(published);

    await expect(persistence.prepareCloudToLanManagerEntry(createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:00:45.000Z',
      descriptor: published.descriptor!,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      ownerInstallationKey: TEST_INSTALLATION_A,
      operationIntentId: OPERATION_INTENT_ID,
    }))).resolves.toMatchObject({ phase: 'prepared' });
  });

  it('rejects a Manager phase that disagrees with its observed status state', () => {
    const prepared = createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:00:45.000Z',
      descriptor: publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
        createdAt: '2026-08-26T00:00:00.000Z',
        expiresAt: ENTRY_EXPIRES_AT,
        operationIntentId: 'intent-decoder-target',
        ownerInstallationKey: TEST_INSTALLATION_A,
        projectId: PROJECT_ID,
        selectedTargetMemberId: MEMBER_BOB,
        selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
        sourceAuthorityGeneration: 1,
        sourceCloudUrl: 'https://cloud.example.test/',
      }), {
        caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
        caFingerprint: 'c'.repeat(64),
        publishedAt: '2026-08-26T00:00:30.000Z',
        targetUrl: 'https://192.168.1.20:27001',
      }).descriptor!,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      ownerInstallationKey: TEST_INSTALLATION_A,
      operationIntentId: OPERATION_INTENT_ID,
    });
    const observing = recordCloudToLanManagerStatus(
      markCloudToLanManagerBeginPossiblySent(prepared),
      { ...cloudToLanStatus('collecting-readiness'), targetUrl: prepared.descriptor.targetUrl },
    );
    const completed = recordCloudToLanManagerStatus(observing, {
      ...cloudToLanStatus('completed'),
      targetUrl: prepared.descriptor.targetUrl,
    });

    expect(() => decodeCloudToLanManagerEntryRecord({
      ...observing,
      phase: 'settled',
    })).toThrow('Invalid Cloud-to-LAN Manager entry binding');
    expect(() => decodeCloudToLanManagerEntryRecord({
      ...completed,
      phase: 'observing',
    })).toThrow('Invalid Cloud-to-LAN Manager entry binding');
    const rejected = rejectCloudToLanManagerEntry(
      markCloudToLanManagerBeginPossiblySent(prepared),
    );
    expect(rejected).toMatchObject({ phase: 'rejected', status: null });
    expect(() => decodeCloudToLanManagerEntryRecord({
      ...rejected,
      status: cloudToLanStatus('collecting-readiness'),
    })).toThrow('Invalid Cloud-to-LAN Manager entry binding');
    const {
      ownerInstallationKey: _legacyOwnerlessManager,
      ...ownerlessManager
    } = prepared;
    expect(() => decodeCloudToLanManagerEntryRecord(ownerlessManager))
      .toThrow('Invalid Cloud-to-LAN Manager entry');
  });

  it('recovers a crash after the definitive Manager rejection write without removing the target', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const target = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-rejected-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_ALICE,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    }), {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    await repository.authorityTransferEntries.saveTarget(target);
    const prepared = await persistence.prepareCloudToLanManagerEntry(
      createCloudToLanManagerEntry({
        createdAt: '2026-08-26T00:00:45.000Z',
        descriptor: target.descriptor!,
        expiresAt: ENTRY_EXPIRES_AT,
        initiatingMemberId: MEMBER_ALICE,
        initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
        ownerInstallationKey: TEST_INSTALLATION_A,
        operationIntentId: OPERATION_INTENT_ID,
      }),
    );
    const submitted = await persistence.markCloudToLanManagerBeginPossiblySent(prepared);
    const rejected = await persistence.rejectCloudToLanManagerEntry(submitted);

    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      manager: { operationIntentId: OPERATION_INTENT_ID, phase: 'rejected' },
      target: { operationIntentId: 'intent-rejected-target-preparation', phase: 'published' },
    });

    const restarted = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    await restarted.settleCloudToLanManagerEntry(rejected);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      manager: null,
      target: { operationIntentId: 'intent-rejected-target-preparation', phase: 'published' },
    });
  });

  it('removes the handed-off target entry only after physical terminal cleanup is durable', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const preparing = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-terminal-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(preparing, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    await persistence.prepareCloudToLanTargetEntry(preparing);
    await persistence.publishCloudToLanTargetEntry(preparing, published.descriptor!);
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...cloudToLanStatus('completed'),
        targetUrl: published.descriptor!.targetUrl,
      },
    });
    await persistence.handoffCloudToLanTargetEntry(published, physical);

    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });

    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
      transferId: TRANSFER_ID,
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
  });

  it('recovers a crash between the terminal marker and target-entry removal', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const preparing = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-split-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    });
    const published = publishCloudToLanTargetEntry(preparing, {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...cloudToLanStatus('completed'),
        targetUrl: published.descriptor!.targetUrl,
      },
    });
    await repository.authorityTransferEntries.saveTarget(
      publishCloudToLanTargetEntry(preparing, published.descriptor!),
    );
    await repository.authorityTransferRecords.save(physical);
    const removeTarget = jest.fn()
      .mockResolvedValueOnce(false)
      .mockImplementation(record => repository.authorityTransferEntries.removeTarget(record));
    const persistence = new AuthorityTransferPersistence({
      authorityTransferClaimCommitments: repository.authorityTransferClaimCommitments,
      authorityTransferClaims: repository.authorityTransferClaims,
      authorityTransferEntries: {
        ...repository.authorityTransferEntries,
        removeTarget,
      },
      authorityTransferRecords: repository.authorityTransferRecords,
    }, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    await persistence.handoffCloudToLanTargetEntry(
      publishCloudToLanTargetEntry(preparing, published.descriptor!),
      physical,
    );
    const cleanup = {
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    };

    await expect(persistence.completeTerminalCleanup(cleanup)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-entry-target-stale' },
    });
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');

    await expect(persistence.completeTerminalCleanup(cleanup)).resolves.toBeUndefined();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
    expect(removeTarget).toHaveBeenCalledTimes(2);
  });

  it('keeps a locally initiated remote-target Manager handoff in lifecycle ownership', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });
    const descriptor = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-remote-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_B,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    }), {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    }).descriptor!;
    let manager = await persistence.prepareCloudToLanManagerEntry(
      createCloudToLanManagerEntry({
        createdAt: '2026-08-26T00:00:45.000Z',
        descriptor,
        expiresAt: ENTRY_EXPIRES_AT,
        initiatingMemberId: MEMBER_ALICE,
        initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
        ownerInstallationKey: TEST_INSTALLATION_A,
        operationIntentId: OPERATION_INTENT_ID,
      }),
    );
    manager = await persistence.markCloudToLanManagerBeginPossiblySent(manager);
    manager = await persistence.recordCloudToLanManagerStatus(manager, {
      ...cloudToLanStatus('collecting-readiness'),
      targetUrl: descriptor.targetUrl,
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: () => persistence.close(),
      durableOwners: [{
        inspect: projectId => persistence.inspectLifecycleOwner(projectId),
        name: 'authority-transfer',
      }],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const competingOperation = jest.fn().mockResolvedValue(undefined);
    await expect(lifecycle.runExclusive(
      PROJECT_ID,
      'host-transfer',
      'operation',
      competingOperation,
    )).rejects.toMatchObject({
      safeContext: { reason: 'lifecycle-owner-pending' },
    });
    expect(competingOperation).not.toHaveBeenCalled();

    await expect(Promise.resolve().then(() => persistence.recordCloudToLanManagerStatus(manager, {
      ...cloudToLanStatus('cloud-quiesced'),
      targetUrl: descriptor.targetUrl,
      updatedAt: '2026-08-26T00:03:00.000Z',
      transferId: 'transfer-other',
    }))).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-observed-identity-mismatch' },
    });
    manager = await persistence.recordCloudToLanManagerStatus(manager, {
      ...cloudToLanStatus('checkpoint-captured'),
      targetUrl: descriptor.targetUrl,
    });
    await expect(Promise.resolve().then(() => persistence.recordCloudToLanManagerStatus(manager, {
      ...cloudToLanStatus('cloud-quiesced'),
      targetUrl: descriptor.targetUrl,
      updatedAt: '2026-08-26T00:03:00.000Z',
    }))).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-observed-phase-regressed' },
    });

    manager = await persistence.recordCloudToLanManagerStatus(manager, {
      ...cloudToLanStatus('completed'),
      targetUrl: descriptor.targetUrl,
    });
    expect(manager.phase).toBe('settled');
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await expect(persistence.prepareCloudToLanManagerEntry(createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:06:00.000Z',
      descriptor,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      operationIntentId: 'intent-replacement-manager',
      ownerInstallationKey: TEST_INSTALLATION_A,
    }))).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-manager-entry-conflict' },
    });
    await persistence.settleCloudToLanManagerEntry(manager);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toBeNull();
  });

  it('admits target lifecycle work when foreign Manager deletion arrives after terminal convergence', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const descriptor = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-remote-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_B,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'https://cloud.example.test/',
    }), {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:00:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    }).descriptor!;
    let manager = createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:00:45.000Z',
      descriptor,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
    });
    manager = markCloudToLanManagerBeginPossiblySent(manager);
    manager = recordCloudToLanManagerStatus(manager, {
      ...cloudToLanStatus('completed'),
      targetUrl: descriptor.targetUrl,
    });
    const physical = markAuthorityTransferTerminalCleanupCompleted(createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_B,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...cloudToLanStatus('completed'),
        targetUrl: descriptor.targetUrl,
      },
    }));
    await repository.authorityTransferEntries.saveManager(manager);
    await repository.authorityTransferRecords.save(physical);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_B,
    });
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: () => persistence.close(),
      durableOwners: [{
        inspect: projectId => persistence.inspectLifecycleOwner(projectId),
        name: 'authority-transfer',
      }],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const operation = jest.fn().mockResolvedValue('admitted');

    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
    await expect(lifecycle.runExclusive(
      PROJECT_ID,
      'host-transfer',
      'operation',
      operation,
    )).resolves.toBe('admitted');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('preserves a bounded raw HTTP Cloud endpoint in target preparation', () => {
    expect(createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-raw-http-target',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 1,
      sourceCloudUrl: 'http://127.0.0.1:8787',
    }).sourceCloudUrl).toBe('http://127.0.0.1:8787');
  });

  it('adopts the Cloud lifecycle timestamps only at the first physical source phase', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    }));
    const canonical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...entry.status,
        createdAt: '2026-08-26T00:00:05.000Z',
        expiresAt: '2026-09-30T00:00:05.000Z',
        phase: 'source-quiesced',
        updatedAt: '2026-08-26T00:00:06.000Z',
      },
    });

    await expect(persistence.adoptLanToCloudCanonicalIdentity(canonical))
      .resolves.toBeUndefined();
    await expect(persistence.load(PROJECT_ID)).resolves.toEqual(canonical);
    await expect(persistence.adoptLanToCloudCanonicalIdentity(canonical)).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-canonical-identity-adoption-invalid' },
    });
  });

  it('fails closed when a handed-off source entry loses its physical successor', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, physical);
    await repository.authorityTransferRecords.remove(PROJECT_ID);

    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await expect(persistence.loadRecoveryOwnerRecord(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-entry-successor-missing' },
    });
    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-entry-successor-missing' },
    });
  });

  it('durably cancels the exact handed-off source before Cloud begin', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, physical);

    const prepared = await persistence.cancelUnbegunLanToCloudSource({
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: 'intent-cancel-pre-begin',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });
    expect(prepared).toMatchObject({
      status: { phase: 'target-cleaned', state: 'active' },
    });
    await expect(persistence.completeUnbegunLanToCloudCancellation(prepared))
      .resolves.toMatchObject({
      status: { phase: 'cancelled', state: 'cancelled' },
    });
  });

  it('clears an exact rejected cancellation after observed begin progress is durable', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    const cancellation = {
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness' as const,
      idempotencyKey: 'intent-cancel-lost-begin',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, physical);
    await persistence.markLanToCloudBeginPossiblySent(physical);
    await persistence.prepareLanToCloudCancellation(cancellation);
    await persistence.markLanToCloudCancellationPossiblySent(cancellation);
    const advanced = {
      ...physical,
      status: {
        ...transferStatus('source-quiesced'),
        expiresAt: physical.status.expiresAt,
      },
    };
    await persistence.advance(advanced, 'collecting-readiness');

    await expect(persistence.settleRejectedLanToCloudCancellation(
      cancellation,
      advanced,
    )).resolves.toBeUndefined();
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toMatchObject({
      beginSubmission: 'possibly-sent',
      cancellation: null,
    });
  });

  it('resumes local pre-begin cancellation after an interrupted durable phase', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let failAfterTargetInvalidated = true;
    const persistence = new AuthorityTransferPersistence({
      ...repository,
      authorityTransferRecords: {
        ...repository.authorityTransferRecords,
        save: async record => {
          await repository.authorityTransferRecords.save(record);
          if (record.status.phase === 'target-invalidated' && failAfterTargetInvalidated) {
            failAfterTargetInvalidated = false;
            throw new Error('injected-local-cancellation-failure');
          }
        },
      },
    }, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, physical);
    await expect(persistence.cancelUnbegunLanToCloudSource({
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: 'intent-cancel-pre-begin',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    })).rejects.toThrow('injected-local-cancellation-failure');

    const recovered = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    const interrupted = await recovered.load(PROJECT_ID);
    if (!interrupted) throw new Error('Missing interrupted cancellation');
    const prepared = await recovered.resumeUnbegunLanToCloudCancellation(interrupted);
    expect(prepared).toMatchObject({ status: { phase: 'target-cleaned', state: 'active' } });
    await expect(recovered.completeUnbegunLanToCloudCancellation(prepared))
      .resolves.toMatchObject({ status: { phase: 'cancelled', state: 'cancelled' } });
  });

  it('recovers cancellation when Cloud absence is durable before the first physical phase', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let failFirstCancellationPhase = true;
    const persistence = new AuthorityTransferPersistence({
      ...repository,
      authorityTransferRecords: {
        ...repository.authorityTransferRecords,
        save: async record => {
          if (record.status.phase === 'cancel-intent' && failFirstCancellationPhase) {
            failFirstCancellationPhase = false;
            throw new Error('injected-before-first-cancellation-phase');
          }
          await repository.authorityTransferRecords.save(record);
        },
      },
    }, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    const cancellation = {
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness' as const,
      idempotencyKey: 'intent-cancel-after-cloud-absence',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };
    await persistence.proposeEntry(entry);
    await persistence.handoffEntry(entry, physical);
    await persistence.markLanToCloudBeginPossiblySent(physical);
    await persistence.prepareLanToCloudCancellation(cancellation);
    await persistence.markLanToCloudCancellationPossiblySent(cancellation);
    await expect(persistence.cancelUnbegunLanToCloudSource(cancellation, true))
      .rejects.toThrow('injected-before-first-cancellation-phase');
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      source: { beginSubmission: 'cloud-absent' },
    });

    const recovered = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    const interrupted = await recovered.load(PROJECT_ID);
    if (!interrupted) throw new Error('Missing interrupted cancellation');
    await expect(recovered.markLanToCloudBeginPossiblySent(interrupted)).rejects.toMatchObject({
      code: 'authority-transfer-stale',
    });
    const prepared = await recovered.resumeUnbegunLanToCloudCancellation(interrupted);
    expect(prepared).toMatchObject({ status: { phase: 'target-cleaned', state: 'active' } });
    await expect(recovered.completeUnbegunLanToCloudCancellation(prepared))
      .resolves.toMatchObject({ status: { phase: 'cancelled', state: 'cancelled' } });
  });

  it('rejects a progressed physical status from the nonphysical entry document', () => {
    expect(() => createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus({
        phase: 'source-quiesced',
        updatedAt: '2026-08-26T00:01:00.000Z',
      }),
    })).toThrow('Invalid authority transfer entry proposal status');
  });

  it('cancels and replays a source-local proposal without creating a physical transfer', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await persistence.proposeEntry(entry);
    const cancellation = {
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness' as const,
      idempotencyKey: 'intent-cancel-proposal',
      projectId: PROJECT_ID,
      transferId: entry.status.transferId,
    };

    const cancelled = await persistence.cancelSourceEntry(cancellation);
    expect(cancelled).toMatchObject({
      phase: 'cancelled',
      status: { phase: 'cancelled', state: 'cancelled' },
    });
    await expect(persistence.cancelSourceEntry(cancellation)).resolves.toEqual(cancelled);
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toBeNull();

    await expect(persistence.proposeEntry(createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_ALICE,
      request: {
        ...entry.request,
        targetUrl: 'https://different-cloud.example.test/',
      },
      status: proposalStatus({
        targetUrl: 'https://different-cloud.example.test/',
        transferId: 'transfer-reused-intent',
      }),
    }))).rejects.toMatchObject({ code: 'authority-transfer-stale' });

    const replacement = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_ALICE,
      request: {
        ...entry.request,
        idempotencyKey: 'intent-after-cancelled-proposal',
      },
      status: proposalStatus({ transferId: 'transfer-after-cancelled-proposal' }),
    });
    await expect(persistence.proposeEntry(replacement)).resolves.toEqual(replacement);
    await expect(persistence.cancelSourceEntry(cancellation)).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-entry-cancel-stale' },
    });
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toEqual(replacement);
  });

  it('rejects an unbounded source proposal lifetime', () => {
    expect(() => createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: {
        ...proposalStatus(),
        expiresAt: '2027-08-26T00:00:00.000Z',
      },
    })).toThrow('Invalid authority transfer entry expiry');
  });

  it('recovers a crash after the physical successor is saved but before entry handoff', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let failHandedOffSave = true;
    const persistence = new AuthorityTransferPersistence({
      authorityTransferClaimCommitments: repository.authorityTransferClaimCommitments,
      authorityTransferClaims: repository.authorityTransferClaims,
      authorityTransferEntries: {
        ...repository.authorityTransferEntries,
        saveSource: async record => {
          if (record.phase === 'handed-off' && failHandedOffSave) {
            failHandedOffSave = false;
            throw new Error('injected-entry-handoff-failure');
          }
          await repository.authorityTransferEntries.saveSource(record);
        },
      },
      authorityTransferRecords: repository.authorityTransferRecords,
    }, { isRecoveryOwner: () => true });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await persistence.proposeEntry(entry);
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });

    await expect(persistence.handoffEntry(entry, physical))
      .rejects.toThrow('injected-entry-handoff-failure');
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toEqual(physical);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toEqual(
      createAuthorityTransferEntryDocument({ projectId: PROJECT_ID, source: entry }),
    );

    const recovered = new AuthorityTransferPersistence(
      new CollabLocalProjectRepository(vaultRoot),
      { isRecoveryOwner: () => true },
    );
    await expect(recovered.load(PROJECT_ID)).resolves.toEqual(physical);
    await expect(recovered.loadSourceEntry(PROJECT_ID)).resolves.toMatchObject({
      phase: 'handed-off',
      successor: {
        operationIntentId: OPERATION_INTENT_ID,
        ownerInstallationKey: TEST_INSTALLATION_A,
        transferId: TRANSFER_ID,
      },
    });
  });

  it('keeps requester intent nonphysical and upgrades the same-device copy to source authority', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const requester = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request,
    });
    const otherRequester = createOwnedAuthorityTransferRequesterEntry({
      installationKey: TEST_INSTALLATION_B,
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_ALICE,
      request: { ...request, idempotencyKey: 'intent-other-installation' },
    });

    await expect(persistence.submitRequesterEntry(requester)).resolves.toEqual(requester);
    await expect(persistence.submitRequesterEntry(otherRequester)).resolves.toEqual(otherRequester);
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
    const source = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request,
      status: proposalStatus(),
    });
    await expect(persistence.proposeEntry(source)).resolves.toEqual(source);
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toEqual(source);
    await expect(persistence.completeRequesterEntry(
      requester,
      source.status,
    )).resolves.toMatchObject({ status: source.status });
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toMatchObject({ status: source.status });
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_B))
      .resolves.toEqual(otherRequester);
  });

  it('does not clobber requester and source components written by separate installations', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let waitingLoads = 0;
    let releaseLoads!: () => void;
    const bothLoaded = new Promise<void>(resolve => {
      releaseLoads = resolve;
    });
    const entryStore = {
      ...repository.authorityTransferEntries,
      load: async (projectId: string) => {
        const loaded = await repository.authorityTransferEntries.load(projectId);
        waitingLoads += 1;
        if (waitingLoads === 2) releaseLoads();
        await bothLoaded;
        return loaded;
      },
    };
    const stores = {
      authorityTransferClaimCommitments: repository.authorityTransferClaimCommitments,
      authorityTransferClaims: repository.authorityTransferClaims,
      authorityTransferEntries: entryStore,
      authorityTransferRecords: repository.authorityTransferRecords,
    };
    const requesterPersistence = new AuthorityTransferPersistence(stores, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const sourcePersistence = new AuthorityTransferPersistence(stores, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_B,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const requester = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request,
    });
    const source = createOwnedAuthorityTransferEntryRecord({
      ownerInstallationKey: TEST_INSTALLATION_B,
      proposedByMemberId: MEMBER_BOB,
      request,
      status: proposalStatus(),
    });

    await Promise.all([
      requesterPersistence.submitRequesterEntry(requester),
      sourcePersistence.proposeEntry(source),
    ]);

    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toEqual(
      createAuthorityTransferEntryDocument({
        projectId: PROJECT_ID,
        requesters: { [TEST_INSTALLATION_A]: requester },
        source,
      }),
    );
  });

  it('preserves requester components synchronized while expiry removes an old snapshot', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const expired = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request,
    });
    const renewed = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-09-25T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request: { ...request, idempotencyKey: 'intent-renewed' },
    });
    const sibling = createOwnedAuthorityTransferRequesterEntry({
      proposedAt: '2026-09-25T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request: { ...request, idempotencyKey: 'intent-sibling' },
      installationKey: TEST_INSTALLATION_B,
    });
    await repository.authorityTransferEntries.saveRequester(expired);
    let renewedBytes: Buffer | null = null;
    let siblingBytes: Buffer | null = null;
    const entryStore = {
      ...repository.authorityTransferEntries,
      removeRequester: async (record: typeof expired) => {
        await repository.authorityTransferEntries.saveRequester(renewed);
        await repository.authorityTransferEntries.saveRequester(sibling);
        const requesterDirectory = repository.getProjectPaths(PROJECT_ID)
          .authorityTransferEntry;
        [renewedBytes, siblingBytes] = await Promise.all([
          readFile(path.join(vaultRoot, requesterDirectory, 'requesters', `${TEST_INSTALLATION_A}.json`)),
          readFile(path.join(vaultRoot, requesterDirectory, 'requesters', `${TEST_INSTALLATION_B}.json`)),
        ]);
        return repository.authorityTransferEntries.removeRequester(record);
      },
    };
    const persistence = new AuthorityTransferPersistence({
      authorityTransferClaimCommitments: repository.authorityTransferClaimCommitments,
      authorityTransferClaims: repository.authorityTransferClaims,
      authorityTransferEntries: entryStore,
      authorityTransferRecords: repository.authorityTransferRecords,
    }, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-09-25T00:00:00.000Z'),
    });

    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toEqual(renewed);
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_B))
      .resolves.toEqual(sibling);
    const requesterDirectory = repository.getProjectPaths(PROJECT_ID).authorityTransferEntry;
    await expect(readFile(path.join(
      vaultRoot,
      requesterDirectory,
      'requesters',
      `${TEST_INSTALLATION_A}.json`,
    ))).resolves.toEqual(renewedBytes);
    await expect(readFile(path.join(
      vaultRoot,
      requesterDirectory,
      'requesters',
      `${TEST_INSTALLATION_B}.json`,
    ))).resolves.toEqual(siblingBytes);
  });

  it('expires a bounded nonphysical requester intent before admitting a replacement', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const requester = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request,
    });
    let persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-09-24T23:59:59.999Z'),
    });
    await persistence.submitRequesterEntry(requester);
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toEqual(requester);

    persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-09-25T00:00:00.000Z'),
    });
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toBeNull();
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toBeNull();
    await expect(persistence.submitRequesterEntry(createAuthorityTransferRequesterEntry({
      proposedAt: '2026-09-25T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request: { ...request, idempotencyKey: 'intent-replacement' },
    }))).resolves.toMatchObject({
      request: { idempotencyKey: 'intent-replacement' },
    });
  });

  it('settles an exact requester cancellation before admitting a replacement intent', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const requester = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request,
    });
    const proposed = await persistence.completeRequesterEntry(
      await persistence.submitRequesterEntry(requester),
      proposalStatus(),
    );
    await persistence.settleRequesterCancellation(proposed, {
      ...proposalStatus(),
      phase: 'cancelled',
      state: 'cancelled',
      updatedAt: '2026-08-26T00:01:00.000Z',
    });
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toBeNull();

    const replacement = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:01:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request: { ...request, idempotencyKey: 'intent-requester-replacement' },
    });
    await expect(persistence.submitRequesterEntry(replacement)).resolves.toEqual(replacement);
  });

  it('keeps requester state independent from a synchronized foreign physical transfer', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      targetUrl: 'http://127.0.0.1:8787/',
    };
    const requester = createAuthorityTransferRequesterEntry({
      proposedAt: '2026-08-26T00:00:00.000Z',
      proposedByMemberId: MEMBER_BOB,
      request,
    });
    await repository.authorityTransferEntries.saveRequester(requester);
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: proposalStatus(),
    }));
    let persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_B,
      now: () => new Date('2026-09-24T23:59:59.999Z'),
    });

    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toEqual(requester);
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).resolves.toBeUndefined();

    persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_B,
      now: () => new Date('2026-09-25T00:00:00.000Z'),
    });
    await expect(persistence.loadRequesterEntry(PROJECT_ID, TEST_INSTALLATION_A))
      .resolves.toBeNull();
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      ownerInstallationKey: TEST_INSTALLATION_A,
    });
  });

  it('ignores a synchronized foreign source slot as lifecycle ownership', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const foreignSource = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await repository.authorityTransferEntries.saveSource(foreignSource);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_B,
    });

    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toBeNull();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).resolves.toBeUndefined();
  });

  it('fails closed on a local handed-off source paired with a foreign physical record', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const localSource = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await repository.authorityTransferEntries.saveSource({
      ...localSource,
      phase: 'handed-off',
      successor: {
        operationIntentId: OPERATION_INTENT_ID,
        ownerInstallationKey: TEST_INSTALLATION_A,
        transferId: TRANSFER_ID,
      },
    });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-foreign-physical',
      ownerInstallationKey: TEST_INSTALLATION_B,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-foreign-physical',
      status: proposalStatus({ transferId: 'transfer-foreign-physical' }),
    }));
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });

    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
  });

  it('preserves an expired foreign source until its owning installation removes it', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const foreignSource = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await repository.authorityTransferEntries.saveSource(foreignSource);
    await repository.authorityTransferRecords.save({
      ...createAuthorityTransferRecord({
        lifecycleOwnership: 'owned',
        localRole: 'source',
        operationIntentId: 'intent-local-terminal',
        ownerInstallationKey: TEST_INSTALLATION_B,
        sourceLanEndpoint: 'https://127.0.0.1:54545',
        stagingDirectoryName: '.claudian-authority-transfer-transfer-local-terminal',
        status: {
          ...proposalStatus({ transferId: 'transfer-local-terminal' }),
          phase: 'cancelled',
          state: 'cancelled',
        },
      }),
      terminalCleanupCompleted: true,
    });
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_B,
      now: () => new Date(ENTRY_EXPIRES_AT),
    });
    const replacement = createOwnedAuthorityTransferEntryRecord({
      ownerInstallationKey: TEST_INSTALLATION_B,
      proposedByMemberId: MEMBER_ALICE,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-local-replacement',
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus({ transferId: 'transfer-local-replacement' }),
    });

    await expect(persistence.proposeEntry(replacement)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toMatchObject({
      source: { ownerInstallationKey: TEST_INSTALLATION_A },
    });
  });

  it('retains an exact cancelled tombstone with terminal physical cleanup', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await persistence.proposeEntry(entry);
    const physical = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    });
    await persistence.handoffEntry(entry, physical);
    await persistence.prepareLanToCloudCancellation({
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: 'intent-cancel-terminal',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...entry.status,
        phase: 'cancelled',
        state: 'cancelled',
        updatedAt: '2026-08-26T00:08:00.000Z',
      },
    }));

    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });

    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toMatchObject({
      phase: 'cancelled',
      status: { state: 'cancelled' },
    });
    await expect(persistence.prepareLanToCloudCancellation({
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: 'intent-cancel-terminal',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    })).resolves.toMatchObject({ status: { state: 'cancelled' } });
    await expect(persistence.prepareLanToCloudCancellation({
      expectedAuthorityGeneration: 1,
      expectedPhase: 'collecting-readiness',
      idempotencyKey: 'intent-cancel-terminal-changed',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(persistence.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
    });
    await expect(persistence.proposeEntry(createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: entry.request,
      status: proposalStatus({ transferId: 'transfer-delayed-replay' }),
    }))).resolves.toMatchObject({
      phase: 'cancelled',
      status: { transferId: TRANSFER_ID },
    });

    const expiredPersistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date(ENTRY_EXPIRES_AT),
    });
    await expect(expiredPersistence.loadSourceEntry(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
      transferId: TRANSFER_ID,
    });
  });

  it('keeps terminal cleanup recoverable until the handed-off entry is settled', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await repository.authorityTransferEntries.saveSource(
      prepareAuthorityTransferSourceCancellation({
        ...entry,
        phase: 'handed-off',
        successor: {
          operationIntentId: OPERATION_INTENT_ID,
          ownerInstallationKey: TEST_INSTALLATION_A,
          transferId: TRANSFER_ID,
        },
      }, {
        expectedAuthorityGeneration: 1,
        expectedPhase: 'collecting-readiness',
        idempotencyKey: 'intent-cancel-terminal',
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      }),
    );
    await repository.authorityTransferRecords.save({
      ...createAuthorityTransferRecord({
        lifecycleOwnership: 'owned',
        localRole: 'source',
        operationIntentId: OPERATION_INTENT_ID,
        ownerInstallationKey: TEST_INSTALLATION_A,
        sourceLanEndpoint: 'https://127.0.0.1:54545',
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: {
          ...entry.status,
          phase: 'cancelled',
          state: 'cancelled',
          updatedAt: '2026-08-26T00:08:00.000Z',
        },
      }),
      terminalCleanupCompleted: true,
    });
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });

    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toMatchObject({
      phase: 'cancelled',
      status: { state: 'cancelled' },
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
  });

  it('admits a new source proposal after a safe cancelled physical cleanup', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...proposalStatus(),
        phase: 'cancelled',
        state: 'cancelled',
        updatedAt: '2026-08-26T00:08:00.000Z',
      },
    }));
    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });
    const replacement = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-replacement-proposal',
        projectId: PROJECT_ID,
        targetUrl: 'https://replacement-cloud.example.test/',
      },
      status: proposalStatus({
        targetUrl: 'https://replacement-cloud.example.test/',
        transferId: 'transfer-replacement-proposal',
      }),
    });

    await expect(persistence.proposeEntry(replacement)).resolves.toEqual(replacement);
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toBeNull();
    await expect(persistence.loadSourceEntry(PROJECT_ID)).resolves.toEqual(replacement);
  });

  it('does not replace a synchronized physical record after stale cleanup inspection', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const cancelled = {
      ...createAuthorityTransferRecord({
        lifecycleOwnership: 'owned',
        localRole: 'source',
        operationIntentId: OPERATION_INTENT_ID,
        ownerInstallationKey: TEST_INSTALLATION_A,
        sourceLanEndpoint: 'https://127.0.0.1:54545',
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: {
          ...proposalStatus(),
          phase: 'cancelled',
          state: 'cancelled',
          updatedAt: '2026-08-26T00:08:00.000Z',
        },
      }),
      terminalCleanupCompleted: true,
    };
    const synchronized = createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-synchronized-physical',
      ownerInstallationKey: TEST_INSTALLATION_B,
      sourceLanEndpoint: 'https://127.0.0.1:54546',
      stagingDirectoryName: '.claudian-authority-transfer-transfer-synchronized-physical',
      status: proposalStatus({ transferId: 'transfer-synchronized-physical' }),
    });
    await repository.authorityTransferRecords.save(cancelled);
    const physicalStore = {
      ...repository.authorityTransferRecords,
      removeExact: async (record: typeof cancelled) => {
        await repository.authorityTransferRecords.save(synchronized);
        return repository.authorityTransferRecords.removeExact(record);
      },
    };
    const persistence = new AuthorityTransferPersistence({
      authorityTransferClaimCommitments: repository.authorityTransferClaimCommitments,
      authorityTransferClaims: repository.authorityTransferClaims,
      authorityTransferEntries: repository.authorityTransferEntries,
      authorityTransferRecords: physicalStore,
    }, {
      isRecoveryOwner: owner => owner === TEST_INSTALLATION_A,
    });
    const replacement = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-stale-cleanup-replacement',
        projectId: PROJECT_ID,
        targetUrl: 'https://replacement-cloud.example.test/',
      },
      status: proposalStatus({
        targetUrl: 'https://replacement-cloud.example.test/',
        transferId: 'transfer-stale-cleanup-replacement',
      }),
    });

    await expect(persistence.proposeEntry(replacement)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-physical-record-stale' },
    });
    await expect(repository.authorityTransferRecords.load(PROJECT_ID))
      .resolves.toEqual(synchronized);
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toBeNull();
  });

  it('fails closed when an entry and physical successor do not have one exact identity', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const entry = createAuthorityTransferEntryRecord({
      proposedByMemberId: MEMBER_BOB,
      request: {
        expectedAuthorityGeneration: 1,
        idempotencyKey: OPERATION_INTENT_ID,
        projectId: PROJECT_ID,
        targetUrl: 'http://127.0.0.1:8787/',
      },
      status: proposalStatus(),
    });
    await repository.authorityTransferEntries.saveSource(entry);
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-conflicting-successor',
      ownerInstallationKey: TEST_INSTALLATION_A,
      sourceLanEndpoint: 'https://127.0.0.1:54545',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: entry.status,
    }));
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
    });

    await expect(persistence.load(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-entry-successor-mismatch' },
    });
  });

  it('recovers every exact LAN source phase and permanently fences the old authority', async () => {
    let repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    let record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    });
    await persistence.create(record);
    record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    });
    await persistence.advance(record, 'collecting-readiness');
    persistence = new AuthorityTransferPersistence(
      new CollabLocalProjectRepository(vaultRoot),
      { isRecoveryOwner: () => true },
    );
    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID))
      .rejects.toMatchObject({ code: 'durable-progress-recovery-required' });

    for (const phase of LAN_TO_CLOUD_PHASES.slice(1)) {
      if (phase === 'claims-retained') {
        const batch = claimBatch();
        await persistence.retainClaimBatch({
          batch,
          operationIntentId: OPERATION_INTENT_ID,
          purpose: 'source-terminal',
        });
        await persistence.acknowledgeClaimBatch({
          batchRevision: batch.batchRevision,
          batchSha256: batch.batchSha256,
          checkpointSha256: batch.checkpointSha256,
          committedAt: '2026-08-26T00:03:30.000Z',
          custodyAuthority: { generation: 1, kind: 'lan' },
          operationIntentId: OPERATION_INTENT_ID,
          projectId: PROJECT_ID,
          receiptId: 'custody-receipt-phase-loop',
          submittedByMemberId: MEMBER_ALICE,
          targetAuthorityGeneration: 2,
          transferId: TRANSFER_ID,
        });
      }
      record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
        localRole: 'source',
        operationIntentId: OPERATION_INTENT_ID,
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: transferStatus(phase),
      });
      await persistence.advance(record, LAN_TO_CLOUD_PHASES[
        LAN_TO_CLOUD_PHASES.indexOf(phase) - 1
      ]);

      repository = new CollabLocalProjectRepository(vaultRoot);
      persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
      await expect(persistence.load(PROJECT_ID)).resolves.toEqual(record);
    }

    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-source-relinquished' },
    });
    await expect(repository.listAuthorityTransferProjectIds()).resolves.toEqual([PROJECT_ID]);
  }, 30_000); // The complete phase walk includes real file and directory synchronization.

  it('serializes LAN Host start against authority-transfer fence creation', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    let releaseStart!: () => void;
    const release = new Promise<void>(resolve => {
      releaseStart = resolve;
    });
    const start = persistence.runWithAuthorityStartGuard(PROJECT_ID, async () => {
      markStarted();
      await release;
      return 'running';
    });
    await started;
    const collecting = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    });
    let recordCreated = false;
    const create = persistence.create(collecting).then(record => {
      recordCreated = true;
      return record;
    });
    await Promise.resolve();
    expect(recordCreated).toBe(false);

    releaseStart();
    await expect(start).resolves.toBe('running');
    await create;
    await persistence.advance(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('source-quiesced'),
    }), 'collecting-readiness');

    await expect(persistence.runWithAuthorityStartGuard(
      PROJECT_ID,
      async () => 'unexpected',
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-authority-quiesced' },
    });
  });

  it('keeps an ownerless legacy authority fence visible and blocks Host restart', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const current = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: cloudToLanStatus('cloud-quiesced'),
    });
    const { ownerInstallationKey: _ownerInstallationKey, ...withoutOwner } = current;
    await repository.authorityTransferRecords.save(decodeAuthorityTransferRecord({
      ...withoutOwner,
      schemaVersion: 1,
    }));
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_A,
    });

    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await expect(persistence.runWithAuthorityStartGuard(
      PROJECT_ID,
      async () => 'unexpected',
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-legacy-owner-missing' },
    });
  });

  it('isolates Project guards and closes new persistence admission while draining', async () => {
    const emptyStore = {
      load: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const persistence = new AuthorityTransferPersistence({
      authorityTransferClaimCommitments: emptyStore,
      authorityTransferClaims: emptyStore,
      authorityTransferEntries: {
        ...emptyStore,
        removeManager: jest.fn().mockResolvedValue(false),
        removeRequester: jest.fn().mockResolvedValue(false),
        removeSource: jest.fn().mockResolvedValue(false),
        removeTarget: jest.fn().mockResolvedValue(false),
        saveManager: jest.fn().mockResolvedValue(undefined),
        saveRequester: jest.fn().mockResolvedValue(undefined),
        saveSource: jest.fn().mockResolvedValue(undefined),
        saveTarget: jest.fn().mockResolvedValue(undefined),
      },
      authorityTransferRecords: {
        ...emptyStore,
        listProjectIds: jest.fn().mockResolvedValue([]),
        removeExact: jest.fn().mockResolvedValue(false),
        scanProjectCatalog: jest.fn().mockResolvedValue({
          invalidEntryCount: 0,
          projectIds: [],
        }),
      },
    }, { isRecoveryOwner: () => true });
    let releaseAlpha!: () => void;
    let markAlphaStarted!: () => void;
    const alphaStarted = new Promise<void>(resolve => { markAlphaStarted = resolve; });
    const alphaBlocked = new Promise<void>(resolve => { releaseAlpha = resolve; });
    const alpha = persistence.runWithAuthorityStartGuard(PROJECT_ID, async () => {
      markAlphaStarted();
      await alphaBlocked;
      return 'alpha';
    });
    await alphaStarted;

    let betaCompleted = false;
    const beta = persistence.runWithAuthorityStartGuard(
      'project-beta',
      async () => 'beta',
    ).then(result => {
      betaCompleted = true;
      return result;
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const projectsWereIsolated = betaCompleted;

    releaseAlpha();
    await expect(alpha).resolves.toBe('alpha');
    await expect(beta).resolves.toBe('beta');

    let releaseDrain!: () => void;
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>(resolve => { markDrainStarted = resolve; });
    const drainBlocked = new Promise<void>(resolve => { releaseDrain = resolve; });
    const admittedBeforeClose = persistence.runWithAuthorityStartGuard(
      'project-gamma',
      async () => {
        markDrainStarted();
        await drainBlocked;
      },
    );
    await drainStarted;

    const closing = persistence.close();
    await expect(persistence.assertAuthorityRestartAllowed('project-beta'))
      .rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-persistence-closed' },
      });
    releaseDrain();
    await admittedBeforeClose;
    await expect(closing).resolves.toBeUndefined();
    expect(projectsWereIsolated).toBe(true);
  });

  it('rotates only an unacknowledged exact batch and scrubs one verified claim at a time', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const first = claimBatch();
    const rotated = claimBatch(2, 'C');
    await persistence.create(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    }));
    const retained = await persistence.retainClaimBatch({
      batch: first,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await expect(persistence.retainClaimBatch({
      batch: first,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    })).resolves.toEqual(retained);
    const persistedRotation = await persistence.rotateClaimBatch({
      batch: rotated,
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await expect(persistence.rotateClaimBatch({
      batch: rotated,
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    })).resolves.toEqual(persistedRotation);
    await expect(persistence.rotateClaimBatch({
      batch: rotated,
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: 'intent-replayed-under-another-operation',
      purpose: 'source-terminal',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });

    const receipt = {
      batchRevision: rotated.batchRevision,
      batchSha256: rotated.batchSha256,
      checkpointSha256: CHECKPOINT_SHA256,
      committedAt: '2026-08-26T00:03:00.000Z',
      custodyAuthority: { generation: 1, kind: 'lan' as const },
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-one',
      submittedByMemberId: MEMBER_ALICE,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    };
    await expect(persistence.acknowledgeClaimBatch({
      ...receipt,
      custodyAuthority: { generation: 1, kind: 'cloud' },
      receiptId: 'custody-receipt-wrong-source',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(persistence.acknowledgeClaimBatch({
      ...receipt,
      committedAt: EXPIRES_AT,
      receiptId: 'custody-receipt-after-expiry',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(persistence.acknowledgeClaimBatch(receipt)).resolves.toEqual(receipt);

    persistence = new AuthorityTransferPersistence(new CollabLocalProjectRepository(vaultRoot), { isRecoveryOwner: () => true });
    await expect(persistence.acknowledgeClaimBatch(receipt)).resolves.toEqual(receipt);
    await expect(persistence.rotateClaimBatch({
      batch: claimBatch(3, 'D'),
      expectedBatchRevision: rotated.batchRevision,
      expectedBatchSha256: rotated.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_BOB))
      .rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-terminal-claim-unavailable' },
      });
    const relinquishedStatus = transferStatus('source-relinquished');
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...relinquishedStatus,
        batchRevision: rotated.batchRevision,
        batchSha256: rotated.batchSha256,
        relinquishmentProof: {
          ...relinquishedStatus.relinquishmentProof!,
          batchRevision: rotated.batchRevision,
          batchSha256: rotated.batchSha256,
        },
      },
    }));
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_BOB))
      .resolves.toMatchObject({ claim: rotated.claims[1].claim, memberId: MEMBER_BOB });

    const redemptionReceipt = {
      checkpointSha256: CHECKPOINT_SHA256,
      claimSha256: sha256(rotated.claims[1].claim),
      memberId: MEMBER_BOB,
      operationIntentId: 'claim-intent-bob',
      projectId: PROJECT_ID,
      receiptId: 'redemption-receipt-bob',
      receiptKeyId: 'receipt-key-one',
      redeemedAt: '2026-08-26T00:03:59.000Z',
      signature: 'A'.repeat(86),
      signatureAlgorithm: 'ed25519' as const,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    };
    await expect(persistence.scrubClaimWithVerifiedReceipt({
      acknowledgedAt: EXPIRES_AT,
      receipt: {
        ...redemptionReceipt,
        receiptId: 'redemption-receipt-after-expiry',
        redeemedAt: EXPIRES_AT,
      },
    })).rejects.toMatchObject({ code: 'membership-claim-invalid' });
    await persistence.scrubClaimWithVerifiedReceipt({
      acknowledgedAt: '2026-08-26T00:04:00.000Z',
      receipt: redemptionReceipt,
    });
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_BOB))
      .rejects.toMatchObject({ code: 'membership-claim-already-redeemed' });
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_ALICE))
      .resolves.toMatchObject({ claim: rotated.claims[0].claim, memberId: MEMBER_ALICE });

    const claimPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'authority-transfer-claims.json',
    );
    expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(claimPath, 'utf8')).not.toContain(rotated.claims[1].claim);
    const summary = await readFile(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'authority-transfer.json',
    ), 'utf8').catch(() => '');
    expect(summary).not.toContain(rotated.claims[0].claim);
  });

  it('requires rotation to replace the exact retained member set and transfer lifetime', async () => {
    const persistence = new AuthorityTransferPersistence(
      new CollabLocalProjectRepository(vaultRoot),
      { isRecoveryOwner: () => true },
    );
    const first = claimBatch();
    await persistence.create(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    }));
    await persistence.retainClaimBatch({
      batch: first,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });

    await expect(persistence.rotateClaimBatch({
      batch: claimBatch(2, 'C', {
        claims: [
          first.claims[0],
          { claim: `${'B'.repeat(42)}C`, memberId: MEMBER_BOB },
        ],
      }),
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(persistence.rotateClaimBatch({
      batch: claimBatch(2, 'C', {
        claims: [
          { claim: `${'A'.repeat(42)}C`, memberId: MEMBER_ALICE },
        ],
      }),
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    await expect(persistence.rotateClaimBatch({
      batch: claimBatch(2, 'C', { expiresAt: '2026-10-01T00:00:00.000Z' }),
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    })).rejects.toMatchObject({ code: 'authority-transfer-stale' });
  });

  it('rejects coherently tampered raw custody against its durable batch commitment', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const batch = claimBatch();
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('source-relinquished'),
    }));
    await persistence.retainClaimBatch({
      batch,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await persistence.acknowledgeClaimBatch({
      batchRevision: batch.batchRevision,
      batchSha256: batch.batchSha256,
      checkpointSha256: batch.checkpointSha256,
      committedAt: '2026-08-26T00:03:30.000Z',
      custodyAuthority: { generation: 1, kind: 'lan' },
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-tamper',
      submittedByMemberId: MEMBER_ALICE,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    });
    const claimPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'authority-transfer-claims.json',
    );
    const custody = JSON.parse(await readFile(claimPath, 'utf8')) as {
      claims: Array<{ claim: string; claimSha256: string }>;
    };
    const tamperedClaim = `${'C'.repeat(42)}A`;
    custody.claims[0].claim = tamperedClaim;
    custody.claims[0].claimSha256 = sha256(tamperedClaim);
    await writeFile(claimPath, JSON.stringify(custody), { mode: 0o600 });

    persistence = new AuthorityTransferPersistence(new CollabLocalProjectRepository(vaultRoot), { isRecoveryOwner: () => true });
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_ALICE))
      .rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'authority-transfer-claim-commitment-mismatch' },
      });
  });

  it('recovers every exact LAN target phase without creating a terminal responder', async () => {
    let repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    let record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: cloudToLanStatus('collecting-readiness'),
    });
    await persistence.create(record);
    record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: cloudToLanStatus('collecting-readiness'),
    });
    await persistence.advance(record, 'collecting-readiness');

    for (const phase of CLOUD_TO_LAN_PHASES.slice(1)) {
      if (phase === 'claims-retained') {
        const batch = claimBatch();
        const stageOperationIntentId = authorityTransferChildIdempotencyKey(
          OPERATION_INTENT_ID,
          'stage',
        );
        await persistence.retainClaimBatch({
          batch,
          operationIntentId: stageOperationIntentId,
          purpose: 'target-delivery',
        });
        await persistence.acknowledgeClaimBatch({
          batchRevision: batch.batchRevision,
          batchSha256: batch.batchSha256,
          checkpointSha256: batch.checkpointSha256,
          committedAt: '2026-08-26T00:03:30.000Z',
          custodyAuthority: { generation: 1, kind: 'cloud' },
          operationIntentId: stageOperationIntentId,
          projectId: PROJECT_ID,
          receiptId: 'target-custody-receipt',
          submittedByMemberId: MEMBER_ALICE,
          targetAuthorityGeneration: 2,
          transferId: TRANSFER_ID,
        });
      }
      record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
        localRole: 'target',
        operationIntentId: OPERATION_INTENT_ID,
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: cloudToLanStatus(phase),
      });
      await persistence.advance(record, CLOUD_TO_LAN_PHASES[
        CLOUD_TO_LAN_PHASES.indexOf(phase) - 1
      ]);

      repository = new CollabLocalProjectRepository(vaultRoot);
      persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
      await expect(persistence.load(PROJECT_ID)).resolves.toEqual(record);
      expect(record.terminalResponder).toBeNull();
    }

    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).resolves.toBeUndefined();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await repository.authorityTransferClaims.remove(PROJECT_ID);
    persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    const completeTerminalCleanup = () => (
      persistence as unknown as {
        completeTerminalCleanup(input: {
          operationIntentId: string;
          projectId: string;
          stagingDirectoryName: string;
          transferId: string;
        }): Promise<void>;
      }
    ).completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });
    await expect(completeTerminalCleanup()).resolves.toBeUndefined();
    await expect(repository.authorityTransferClaims.load(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toBeNull();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
    await expect(persistence.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
    });
  });

  it('reopens a cancelled source only after durable target cleanup and source recovery', async () => {
    const persistence = new AuthorityTransferPersistence(
      new CollabLocalProjectRepository(vaultRoot),
      { isRecoveryOwner: () => true },
    );
    let record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    });
    await persistence.create(record);
    record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('source-quiesced'),
    });
    await persistence.advance(record, 'collecting-readiness');

    const cancellationPhases = [
      'cancel-intent',
      'target-invalidated',
      'target-cleaned',
      'source-reopened',
      'cancelled',
    ] as const;
    let previousPhase: CollabAuthorityTransferStatus['phase'] = 'source-quiesced';
    const restartOutcomes: string[] = [];
    for (const [index, phase] of cancellationPhases.entries()) {
      record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
        localRole: 'source',
        operationIntentId: OPERATION_INTENT_ID,
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: {
          ...transferStatus('source-quiesced', index + 2),
          phase,
          state: phase === 'cancelled' ? 'cancelled' : 'active',
        },
      });
      await persistence.advance(record, previousPhase);
      previousPhase = phase;
      await persistence.assertAuthorityRestartAllowed(PROJECT_ID).then(
        () => restartOutcomes.push('allowed'),
        error => restartOutcomes.push((error as { code: string }).code),
      );
    }
    expect(restartOutcomes).toEqual([
      'durable-progress-recovery-required',
      'durable-progress-recovery-required',
      'durable-progress-recovery-required',
      'allowed',
      'allowed',
    ]);
  });

  it('replaces only a fully cleaned safe cancellation with a new transfer attempt', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const cancelled = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('source-quiesced', 8),
        phase: 'cancelled',
        state: 'cancelled',
      },
    });
    await repository.authorityTransferRecords.save(cancelled);
    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });
    const replacement = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: 'replacement-intent',
      stagingDirectoryName: '.claudian-authority-transfer-replacement-transfer',
      status: {
        ...transferStatus('collecting-readiness', 9),
        transferId: 'replacement-transfer',
      },
    });

    await expect(persistence.create(replacement)).resolves.toBeUndefined();
    await expect(persistence.load(PROJECT_ID)).resolves.toEqual(replacement);
  });

  it('replaces a fully cleaned target cancellation with a fresh target preparation', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const cancelled = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...cloudToLanStatus('cloud-quiesced'),
        phase: 'cancelled',
        state: 'cancelled',
        updatedAt: '2026-08-26T00:08:00.000Z',
      },
    });
    await repository.authorityTransferRecords.save(cancelled);
    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });
    const replacement = createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:09:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-replacement-target',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 2,
      sourceCloudUrl: 'http://127.0.0.1:8787',
    });

    await expect(persistence.prepareCloudToLanTargetEntry(replacement)).resolves.toEqual(
      replacement,
    );
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toBeNull();
  });

  it('refuses terminal cleanup when claim custody belongs to a different durable owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const cancelled = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('source-quiesced', 8),
        phase: 'cancelled',
        state: 'cancelled',
      },
    });
    const divergentCustody = createAuthorityTransferClaimCustodyRecord({
      batch: claimBatch(),
      createdAt: '2026-08-26T00:01:00.000Z',
      operationIntentId: 'different-operation-intent',
      purpose: 'source-terminal',
    });
    await repository.authorityTransferRecords.save(cancelled);
    await repository.authorityTransferClaims.save(divergentCustody);
    await repository.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(divergentCustody),
    );

    await expect(persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    })).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-claim-owner-stale' },
    });
    await expect(repository.authorityTransferClaims.load(PROJECT_ID))
      .resolves.toEqual(divergentCustody);
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toEqual(createAuthorityTransferClaimBatchCommitmentRecord(divergentCustody));
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: false,
    });
  });

  it('refuses claim expiry when custody belongs to a different durable owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date(EXPIRES_AT),
    });
    const completed = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('completed'),
    });
    const divergentCustody = createAuthorityTransferClaimCustodyRecord({
      batch: claimBatch(),
      createdAt: '2026-08-26T00:01:00.000Z',
      operationIntentId: 'different-operation-intent',
      purpose: 'source-terminal',
    });
    await repository.authorityTransferRecords.save(completed);
    await repository.authorityTransferClaims.save(divergentCustody);
    await repository.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(divergentCustody),
    );

    await expect(persistence.expireTerminalResponder(PROJECT_ID, TRANSFER_ID))
      .rejects.toMatchObject({
        code: 'authority-transfer-stale',
        safeContext: { reason: 'authority-transfer-claim-owner-stale' },
      });
    await expect(repository.authorityTransferClaims.load(PROJECT_ID)).resolves.toMatchObject({
      claims: [
        expect.objectContaining({ disposition: 'retained' }),
        expect.objectContaining({ disposition: 'retained' }),
      ],
    });
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      terminalResponder: { state: 'active' },
    });
  });

  it('expires the terminal responder only after scrubbing every retained raw claim', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:00:00.000Z'),
    });
    const completed = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('completed'),
    });
    await repository.authorityTransferRecords.save(completed);
    await persistence.retainClaimBatch({
      batch: claimBatch(),
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await persistence.acknowledgeClaimBatch({
      batchRevision: 1,
      batchSha256: claimBatch().batchSha256,
      checkpointSha256: CHECKPOINT_SHA256,
      committedAt: '2026-08-26T00:03:00.000Z',
      custodyAuthority: { generation: 1, kind: 'lan' },
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-expiry',
      submittedByMemberId: MEMBER_ALICE,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    });

    await expect(persistence.expireTerminalResponder(
      PROJECT_ID,
      TRANSFER_ID,
    )).rejects.toMatchObject({ code: 'authority-transfer-stale' });
    const completeTerminalCleanup = () => persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });
    await expect(completeTerminalCleanup()).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-terminal-responder-active' },
    });
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_ALICE))
      .resolves.toMatchObject({ memberId: MEMBER_ALICE });

    persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date(EXPIRES_AT),
    });
    await persistence.expireTerminalResponder(PROJECT_ID, TRANSFER_ID);

    await expect(repository.authorityTransferClaims.load(PROJECT_ID)).resolves.toMatchObject({
      claims: [
        expect.objectContaining({ claim: null, disposition: 'expired' }),
        expect.objectContaining({ claim: null, disposition: 'expired' }),
      ],
    });
    await expect(persistence.load(PROJECT_ID)).resolves.toMatchObject({
      restartFence: 'permanent',
      terminalCleanupCompleted: false,
      terminalResponder: { state: 'expired' },
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await expect(completeTerminalCleanup()).resolves.toBeUndefined();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
    await expect(repository.authorityTransferClaims.load(PROJECT_ID)).resolves.toBeNull();
  });

  it('expires and cleans a single-member transfer with an exact empty claim batch immediately', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:00:00.000Z'),
    });
    const batchSha256 = '001a79c6e03aa40c576542ab21f7a692e5e8ec0d930f705101a29dd2809a66b3';
    const batch: CollabTransferredMembershipClaimBatch = {
      batchRevision: 1,
      batchSha256,
      checkpointSha256: CHECKPOINT_SHA256,
      claims: [],
      expiresAt: EXPIRES_AT,
      projectId: PROJECT_ID,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    };
    const status: CollabAuthorityTransferStatus = {
      ...transferStatus('completed'),
      batchSha256,
      relinquishmentProof: {
        ...transferStatus('completed').relinquishmentProof!,
        batchSha256,
      },
    };
    const completed = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status,
    });
    const target = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
      createdAt: '2026-08-26T00:05:00.000Z',
      expiresAt: ENTRY_EXPIRES_AT,
      operationIntentId: 'intent-next-target',
      ownerInstallationKey: TEST_INSTALLATION_B,
      projectId: PROJECT_ID,
      selectedTargetMemberId: MEMBER_BOB,
      selectedTargetPersonalRef: `refs/heads/members/${MEMBER_BOB}`,
      sourceAuthorityGeneration: 2,
      sourceCloudUrl: 'http://127.0.0.1:8787/',
    }), {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      publishedAt: '2026-08-26T00:05:30.000Z',
      targetUrl: 'https://192.168.1.20:27001',
    });
    const manager = createCloudToLanManagerEntry({
      createdAt: '2026-08-26T00:06:00.000Z',
      descriptor: target.descriptor!,
      expiresAt: ENTRY_EXPIRES_AT,
      initiatingMemberId: MEMBER_ALICE,
      initiatingPersonalRef: `refs/heads/members/${MEMBER_ALICE}`,
      ownerInstallationKey: TEST_INSTALLATION_A,
      operationIntentId: 'intent-next-manager',
    });
    const requester = await persistence.completeRequesterEntry(
      await persistence.submitRequesterEntry(createAuthorityTransferRequesterEntry({
        proposedAt: '2026-08-26T00:00:00.000Z',
        proposedByMemberId: MEMBER_ALICE,
        request: {
          expectedAuthorityGeneration: 1,
          idempotencyKey: OPERATION_INTENT_ID,
          projectId: PROJECT_ID,
          targetUrl: status.targetUrl,
        },
      })),
      {
        ...transferStatus('collecting-readiness'),
        createdAt: '2026-08-26T00:00:08.000Z',
        expiresAt: '2026-09-30T00:00:08.000Z',
        updatedAt: '2026-08-26T00:00:08.000Z',
      },
    );
    await repository.authorityTransferRecords.save(completed);
    await persistence.retainClaimBatch({
      batch,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await persistence.acknowledgeClaimBatch({
      batchRevision: 1,
      batchSha256,
      checkpointSha256: CHECKPOINT_SHA256,
      committedAt: '2026-08-26T00:03:00.000Z',
      custodyAuthority: { generation: 1, kind: 'lan' },
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-empty',
      submittedByMemberId: MEMBER_ALICE,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    });
    await expect(persistence.prepareCloudToLanManagerEntry(manager)).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-manager-entry-conflict' },
    });

    persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date('2026-08-26T00:04:00.000Z'),
    });
    await expect(persistence.isRetainedClaimBatchEmpty(PROJECT_ID, TRANSFER_ID))
      .resolves.toBe(true);
    await persistence.expireTerminalResponder(PROJECT_ID, TRANSFER_ID);
    await expect(repository.authorityTransferClaims.load(PROJECT_ID)).resolves.toMatchObject({
      claims: [],
    });
    await persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    });

    await expect(persistence.load(PROJECT_ID)).resolves.toMatchObject({
      terminalCleanupCompleted: true,
      terminalResponder: { state: 'expired' },
    });
    await expect(repository.authorityTransferClaims.load(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toBeNull();
    await expect(repository.authorityTransferEntries.load(PROJECT_ID)).resolves.toBeNull();
    await expect(repository.authorityTransferEntries.removeRequester(requester))
      .resolves.toBe(false);
    await expect(persistence.prepareCloudToLanManagerEntry(manager)).resolves.toEqual(manager);
    await expect(repository.authorityTransferRecords.load(PROJECT_ID)).resolves.toMatchObject({
      restartFence: 'permanent',
      terminalCleanupCompleted: true,
      transferId: TRANSFER_ID,
    });
  });

  it('recovers terminal completion after claim files were removed before the record fence', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const completed = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('completed'),
    });
    await repository.authorityTransferRecords.save(
      expireAuthorityTransferTerminalResponder(completed),
    );
    const persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date(EXPIRES_AT),
    });

    await expect(persistence.expireTerminalResponder(PROJECT_ID, TRANSFER_ID))
      .resolves.toBeUndefined();
    await expect(persistence.completeTerminalCleanup({
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      transferId: TRANSFER_ID,
    })).resolves.toBeUndefined();
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('terminal');
  });

  it('repairs only an unacknowledged interrupted claim commitment write', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    let persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await persistence.create(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('collecting-readiness'),
    }));
    const first = await persistence.retainClaimBatch({
      batch: claimBatch(),
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await repository.authorityTransferClaimCommitments.remove(PROJECT_ID);

    persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const recoverInterruptedCommitment = () => (
      persistence as unknown as {
        recoverInterruptedClaimCommitment(projectId: string): Promise<void>;
      }
    ).recoverInterruptedClaimCommitment(PROJECT_ID);
    const inspectLifecycleOwner = () => (
      persistence as unknown as {
        inspectLifecycleOwner(projectId: string): Promise<string>;
      }
    ).inspectLifecycleOwner(PROJECT_ID);
    await expect(inspectLifecycleOwner()).resolves.toBe('nonterminal');
    await expect(recoverInterruptedCommitment()).resolves.toBeUndefined();
    await expect(persistence.load(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
    });

    const rotated = await persistence.rotateClaimBatch({
      batch: claimBatch(2, 'C'),
      expectedBatchRevision: first.batchRevision,
      expectedBatchSha256: first.batchSha256,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await repository.authorityTransferClaimCommitments.save(
      createAuthorityTransferClaimBatchCommitmentRecord(first),
    );

    persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await expect(inspectLifecycleOwner()).resolves.toBe('nonterminal');
    await expect(recoverInterruptedCommitment()).resolves.toBeUndefined();
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toEqual(createAuthorityTransferClaimBatchCommitmentRecord(rotated));
  });

  it('refuses interrupted cleanup of a commitment owned by another operation', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const cancelled = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('claims-retained', 8),
        phase: 'cancelled',
        state: 'cancelled',
      },
    });
    const divergentCustody = createAuthorityTransferClaimCustodyRecord({
      batch: claimBatch(),
      createdAt: '2026-08-26T00:01:00.000Z',
      operationIntentId: 'different-operation-intent',
      purpose: 'source-terminal',
    });
    const divergentCommitment = createAuthorityTransferClaimBatchCommitmentRecord(
      divergentCustody,
    );
    await repository.authorityTransferRecords.save(cancelled);
    await repository.authorityTransferClaimCommitments.save(divergentCommitment);

    await expect(persistence.recoverInterruptedClaimCommitment(PROJECT_ID))
      .rejects.toMatchObject({
        code: 'authority-transfer-stale',
        safeContext: { reason: 'authority-transfer-claim-owner-stale' },
      });
    await expect(repository.authorityTransferClaimCommitments.load(PROJECT_ID))
      .resolves.toEqual(divergentCommitment);
  });

  it('rejects phase regression and cancellation after source relinquishment', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    const relinquished = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('source-relinquished'),
    });
    await repository.authorityTransferRecords.save(relinquished);

    await expect(persistence.advance(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('repository-published', 7),
        phase: 'cancel-intent',
      },
    }), 'source-relinquished')).rejects.toMatchObject({
      code: 'authority-transfer-cancellation-forbidden',
    });
    await expect(persistence.advance(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('repository-published', 8),
    }), 'source-relinquished')).rejects.toMatchObject({
      code: 'authority-transfer-stale',
    });
  });

  it('rejects terminal-cleanup completion forged through normal phase advancement', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('source-quiesced', 6),
        phase: 'source-reopened',
      },
    }));
    const cancelled = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('source-quiesced', 7),
        phase: 'cancelled',
        state: 'cancelled',
      },
    });

    await expect(persistence.advance({
      ...cancelled,
      terminalCleanupCompleted: true,
    }, 'source-reopened')).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-phase-invalid' },
    });
    await expect(persistence.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
  });

  it('rejects terminal-responder expiry forged through normal phase advancement', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });
    await repository.authorityTransferRecords.save(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('cloud-activated'),
    }));
    const batch = claimBatch();
    await persistence.retainClaimBatch({
      batch,
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    });
    await persistence.acknowledgeClaimBatch({
      batchRevision: batch.batchRevision,
      batchSha256: batch.batchSha256,
      checkpointSha256: batch.checkpointSha256,
      committedAt: '2026-08-26T00:03:00.000Z',
      custodyAuthority: { generation: 1, kind: 'lan' },
      operationIntentId: OPERATION_INTENT_ID,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-forged-expiry',
      submittedByMemberId: MEMBER_ALICE,
      targetAuthorityGeneration: 2,
      transferId: TRANSFER_ID,
    });
    const forgedExpiry = expireAuthorityTransferTerminalResponder(
      createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
        localRole: 'source',
        operationIntentId: OPERATION_INTENT_ID,
        stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
        status: transferStatus('completed'),
      }),
    );

    await expect(persistence.advance(forgedExpiry, 'cloud-activated')).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-phase-invalid' },
    });
    await expect(persistence.load(PROJECT_ID)).resolves.toMatchObject({
      status: { phase: 'cloud-activated' },
      terminalResponder: { state: 'active' },
    });
  });

  it('freezes checkpoint and relinquishment proof identity across phase advancement', () => {
    const checkpointReceived = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('checkpoint-received'),
    });
    const replacedCheckpoint = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...transferStatus('checkpoint-validated'),
        checkpointSha256: 'b'.repeat(64),
      },
    });
    expect(() => assertAuthorityTransferTransition(checkpointReceived, replacedCheckpoint))
      .toThrow('Authority transfer checkpoint changed');

    const relinquished = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: transferStatus('source-relinquished'),
    });
    const activatedStatus = transferStatus('cloud-activated');
    const replacedProof = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...activatedStatus,
        relinquishmentProof: {
          ...activatedStatus.relinquishmentProof!,
          certificate: `${'A'.repeat(85)}Q`,
        },
      },
    });
    expect(() => assertAuthorityTransferTransition(relinquished, replacedProof))
      .toThrow('Authority transfer relinquishment proof changed');
  });

  it('rejects a relinquishment proof outside the exact operation intent and lifetime', () => {
    const status = transferStatus('source-relinquished');
    expect(() => createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...status,
        relinquishmentProof: {
          ...status.relinquishmentProof!,
          operationIntentId: 'intent-from-another-attempt',
        },
      },
    })).toThrow('Invalid authority transfer relinquishment proof');
    expect(() => createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      localRole: 'source',
      operationIntentId: OPERATION_INTENT_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: {
        ...status,
        relinquishmentProof: {
          ...status.relinquishmentProof!,
          committedAt: '2026-08-25T23:59:59.000Z',
        },
      },
    })).toThrow('Invalid authority transfer relinquishment proof');
  });

  it('fails startup enumeration closed for raw claim custody without its transfer owner', async () => {
    const repository = new CollabLocalProjectRepository(vaultRoot);
    await repository.authorityTransferClaims.save(createAuthorityTransferClaimCustodyRecord({
      batch: claimBatch(),
      createdAt: '2026-08-26T00:00:00.000Z',
      operationIntentId: OPERATION_INTENT_ID,
      purpose: 'source-terminal',
    }));
    const persistence = new AuthorityTransferPersistence(repository, { isRecoveryOwner: () => true });

    await expect(persistence.listProjectIds()).resolves.toEqual([PROJECT_ID]);
    await expect(persistence.load(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-claim-custody-orphaned' },
    });
    await expect(persistence.assertAuthorityRestartAllowed(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'authority-transfer-claim-custody-orphaned' },
    });
    await expect(persistence.loadClaim(PROJECT_ID, TRANSFER_ID, MEMBER_ALICE))
      .rejects.toMatchObject({ code: 'authority-transfer-stale' });
  });
});
