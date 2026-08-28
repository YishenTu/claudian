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
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  assertAuthorityTransferTransition,
  createAuthorityTransferRecord,
  decodeAuthorityTransferRecord,
  expireAuthorityTransferTerminalResponder,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
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

const PROJECT_ID = 'project-alpha';
const TRANSFER_ID = 'transfer-one';
const OPERATION_INTENT_ID = 'intent-one';
const CHECKPOINT_SHA256 = 'a'.repeat(64);
const MEMBER_ALICE = 'member-alice';
const MEMBER_BOB = 'member-bob';
const EXPIRES_AT = '2026-09-30T00:00:00.000Z';

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
          operationIntentId: OPERATION_INTENT_ID,
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
  });

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
      authorityTransferRecords: {
        ...emptyStore,
        listProjectIds: jest.fn().mockResolvedValue([]),
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
        await persistence.retainClaimBatch({
          batch,
          operationIntentId: OPERATION_INTENT_ID,
          purpose: 'target-delivery',
        });
        await persistence.acknowledgeClaimBatch({
          batchRevision: batch.batchRevision,
          batchSha256: batch.batchSha256,
          checkpointSha256: batch.checkpointSha256,
          committedAt: '2026-08-26T00:03:30.000Z',
          custodyAuthority: { generation: 1, kind: 'cloud' },
          operationIntentId: OPERATION_INTENT_ID,
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

  it('expires and cleans a single-member transfer with an exact empty claim batch', async () => {
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

    persistence = new AuthorityTransferPersistence(repository, {
      isRecoveryOwner: () => true,
      now: () => new Date(EXPIRES_AT),
    });
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
