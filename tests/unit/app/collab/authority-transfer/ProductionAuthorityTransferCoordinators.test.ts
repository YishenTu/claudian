import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  type CollabAuthorityRelinquishmentProof,
  type CollabAuthorityTransferStatus,
  type CollabTransferredMembershipClaimBatch,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  type AuthorityTransferRecord,
  createAuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  CloudToLanTargetCoordinator,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTargetCoordinator';
import {
  LanToCloudSourceCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  CollabAuthorityLifecyclePort,
} from '@/app/collab/remote-authority/CollabAuthorityLifecyclePort';

const PROJECT_ID = 'project-production-transfer';
const TRANSFER_ID = 'transfer-production-transfer';
const HOST_MEMBER_ID = 'member-host';
const CREATED_AT = '2026-08-27T00:00:00.000Z';
const EXPIRES_AT = '2026-09-26T00:00:00.000Z';
const CHECKPOINT_SHA256 = 'a'.repeat(64);
const BATCH_SHA256 = 'b'.repeat(64);
const SIGNATURE = Buffer.alloc(64, 7).toString('base64url');
const RECEIPT_VERIFIER = Object.freeze({
  projectId: PROJECT_ID,
  receiptKeyId: 'receipt-key-production-transfer',
  receiptPublicKey: Buffer.alloc(32, 6).toString('base64url'),
  receiptPublicKeyEncoding: 'base64url-raw' as const,
  signatureAlgorithm: 'ed25519' as const,
  transferId: TRANSFER_ID,
});

function status(
  direction: 'cloud-to-lan' | 'lan-to-cloud',
  phase: CollabAuthorityTransferStatus['phase'],
  overrides: Partial<CollabAuthorityTransferStatus> = {},
): CollabAuthorityTransferStatus {
  const forward = direction === 'lan-to-cloud'
    ? [
        'collecting-readiness',
        'source-quiesced',
        'checkpoint-received',
        'checkpoint-validated',
        'claims-retained',
        'repository-published',
        'source-relinquished',
        'cloud-activated',
        'completed',
      ]
    : [
        'collecting-readiness',
        'cloud-quiesced',
        'checkpoint-captured',
        'target-staged',
        'claims-retained',
        'cloud-relinquished',
        'lan-activated',
        'completed',
      ];
  const index = forward.indexOf(phase);
  const checkpoint = index >= 2 ? CHECKPOINT_SHA256 : null;
  const batch = index >= 4;
  const proofRequired = direction === 'lan-to-cloud' ? index >= 6 : index >= 5;
  const proof = proofRequired
    ? relinquishmentProof(direction)
    : null;
  return {
    batchRevision: batch ? 1 : null,
    batchSha256: batch ? BATCH_SHA256 : null,
    checkpointSha256: checkpoint,
    createdAt: CREATED_AT,
    direction,
    expiresAt: EXPIRES_AT,
    phase,
    projectId: PROJECT_ID,
    relinquishmentProof: proof,
    sourceAuthority: {
      generation: 1,
      kind: direction === 'lan-to-cloud' ? 'lan' : 'cloud',
    },
    state: phase === 'completed'
      ? 'completed'
      : phase === 'cancelled'
        ? 'cancelled'
        : 'active',
    targetAuthority: {
      generation: 2,
      kind: direction === 'lan-to-cloud' ? 'cloud' : 'lan',
    },
    targetUrl: direction === 'lan-to-cloud'
      ? 'https://cloud.example.test'
      : 'https://192.168.1.10:43123',
    transferId: TRANSFER_ID,
    updatedAt: '2026-08-27T00:00:10.000Z',
    ...overrides,
  };
}

function relinquishmentProof(
  direction: 'cloud-to-lan' | 'lan-to-cloud',
  batchSha256 = BATCH_SHA256,
): CollabAuthorityRelinquishmentProof {
  return {
    batchRevision: 1,
    batchSha256,
    certificate: SIGNATURE,
    certificateAlgorithm: 'ed25519',
    checkpointSha256: CHECKPOINT_SHA256,
    committedAt: '2026-08-27T00:00:09.000Z',
    operationIntentId: 'intent-production-transfer',
    projectId: PROJECT_ID,
    sourceAuthority: {
      generation: 1,
      kind: direction === 'lan-to-cloud' ? 'lan' : 'cloud',
    },
    sourceHostMemberId: direction === 'lan-to-cloud' ? HOST_MEMBER_ID : null,
    targetAuthority: {
      generation: 2,
      kind: direction === 'lan-to-cloud' ? 'cloud' : 'lan',
    },
    transferId: TRANSFER_ID,
  } as CollabAuthorityRelinquishmentProof;
}

function claimBatch(direction: 'cloud-to-lan' | 'lan-to-cloud') {
  const candidate: CollabTransferredMembershipClaimBatch = {
    batchRevision: 1,
    batchSha256: '0'.repeat(64),
    checkpointSha256: CHECKPOINT_SHA256,
    claims: direction === 'lan-to-cloud'
      ? []
      : [{ claim: Buffer.alloc(32, 4).toString('base64url'), memberId: 'member-offline' }],
    expiresAt: EXPIRES_AT,
    projectId: PROJECT_ID,
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  };
  return {
    ...candidate,
    batchSha256: createHash('sha256')
      .update(encodeCollabTransferredMembershipClaimBatchDigestInput(candidate), 'utf8')
      .digest('hex'),
  };
}

class MemoryPersistence {
  batch: CollabTransferredMembershipClaimBatch | null = null;
  record: AuthorityTransferRecord | null = null;
  readonly phases: string[] = [];

  create = async (record: AuthorityTransferRecord): Promise<void> => {
    this.record = record;
    this.phases.push(record.status.phase);
  };
  load = async (): Promise<AuthorityTransferRecord | null> => this.record;
  pinReceiptVerifier = async (
    _projectId: string,
    _transferId: string,
    verifier: typeof RECEIPT_VERIFIER,
  ): Promise<AuthorityTransferRecord> => {
    this.record = { ...this.record!, receiptVerifier: verifier };
    return this.record;
  };
  advance = async (record: AuthorityTransferRecord): Promise<void> => {
    this.record = record;
    this.phases.push(record.status.phase);
  };
  retainClaimBatch = jest.fn(async (input: { batch: CollabTransferredMembershipClaimBatch }) => {
    this.batch = input.batch;
    return {};
  });
  loadRetainedClaimBatch = jest.fn(async () => this.batch);
  acknowledgeClaimBatch = jest.fn(async (receipt: unknown) => receipt);

  asPort(): AuthorityTransferPersistence {
    return this as unknown as AuthorityTransferPersistence;
  }
}

function custodyReceipt(direction: 'cloud-to-lan' | 'lan-to-cloud', batchSha256: string) {
  return {
    batchRevision: 1,
    batchSha256,
    checkpointSha256: CHECKPOINT_SHA256,
    committedAt: '2026-08-27T00:00:08.000Z',
    custodyAuthority: {
      generation: 1,
      kind: direction === 'lan-to-cloud' ? 'lan' : 'cloud',
    },
    operationIntentId: 'intent-production-transfer',
    projectId: PROJECT_ID,
    receiptId: 'receipt-production-transfer',
    submittedByMemberId: HOST_MEMBER_ID,
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  } as const;
}

describe('production authority-transfer direction coordinators', () => {
  it('retains the accepted source endpoint pin after a post-save failure', async () => {
    const persistence = new MemoryPersistence();
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'proposal',
      localRole: 'source',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'collecting-readiness'),
    });
    persistence.advance = async (record: AuthorityTransferRecord) => {
      persistence.record = record;
      throw new Error('simulated post-save failure');
    };
    const releaseSourceEndpoint = jest.fn(async () => undefined);
    const coordinator = new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud: {} as CollabAuthorityLifecyclePort,
      persistence: persistence.asPort(),
      source: {
        acceptanceRequest: jest.fn(async record => ({
          expectedAuthorityGeneration: record.status.sourceAuthority.generation,
          idempotencyKey: 'intent-host-acceptance',
          projectId: PROJECT_ID,
          targetUrl: record.status.targetUrl,
          transferId: TRANSFER_ID,
        })),
        acceptProposal: jest.fn(),
        activateTerminal: jest.fn(),
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(),
        releaseSourceEndpoint,
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn(),
        sourceEndpoint: jest.fn(async () => 'https://127.0.0.1:54545'),
      },
    });

    await expect(coordinator.acceptAndTransfer({
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-host-acceptance',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test',
      transferId: TRANSFER_ID,
    })).rejects.toThrow('simulated post-save failure');

    expect(persistence.record).toMatchObject({
      lifecycleOwnership: 'owned',
      sourceLanEndpoint: 'https://127.0.0.1:54545',
    });
    expect(releaseSourceEndpoint).not.toHaveBeenCalled();
  });

  it('destroys every captured body when a LAN-to-Cloud upload fails', async () => {
    const persistence = new MemoryPersistence();
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'source-quiesced'),
    });
    const bodies = [new Readable({ read() {} }), new Readable({ read() {} })];
    const cloud = {
      authorityTransfer: jest.fn(async (operation: string) => {
        if (operation === 'getAuthorityTransferReceiptVerifier') return RECEIPT_VERIFIER;
        throw new Error(`unexpected ${operation}`);
      }),
      downloadAuthorityTransferArtifact: jest.fn(),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(async () => {
        throw new Error('injected-upload-failure');
      }),
    } as unknown as CollabAuthorityLifecyclePort;
    const coordinator = new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      source: {
        acceptanceRequest: jest.fn(),
        acceptProposal: jest.fn(),
        activateTerminal: jest.fn(),
        capture: jest.fn(async () => ({
          artifacts: bodies.map((body, index) => ({
            artifact: index === 0 ? 'checkpoint.json' as const : 'coordination.ndjson' as const,
            body,
            byteCount: 1,
          })),
          checkpointManifestSha256: CHECKPOINT_SHA256,
          sourceHostMemberId: HOST_MEMBER_ID,
          sourceProof: 'source-proof',
        })),
        commitRelinquishmentFence: jest.fn(),
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn(),
      },
    });

    await expect(coordinator.resume(PROJECT_ID)).rejects.toThrow('injected-upload-failure');
    expect(bodies.every(body => body.destroyed)).toBe(true);
  });

  it('destroys downloaded bodies when a later Cloud-to-LAN download fails', async () => {
    const persistence = new MemoryPersistence();
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('cloud-to-lan', 'checkpoint-captured'),
    });
    const first = new Readable({ read() {} });
    let downloads = 0;
    const cloud = {
      authorityTransfer: jest.fn(),
      downloadAuthorityTransferArtifact: jest.fn(async ({ artifact }) => {
        downloads += 1;
        if (downloads === 2) throw new Error('injected-download-failure');
        return { artifact, body: first, byteCount: 1 };
      }),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort;
    const coordinator = new CloudToLanTargetCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      target: {
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        stage: jest.fn(),
      },
    });

    await expect(coordinator.resume(PROJECT_ID)).rejects.toThrow('injected-download-failure');
    expect(first.destroyed).toBe(true);
  });

  it('destroys every downloaded body when Cloud-to-LAN staging fails', async () => {
    const persistence = new MemoryPersistence();
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('cloud-to-lan', 'checkpoint-captured'),
    });
    const bodies: Readable[] = [];
    const cloud = {
      authorityTransfer: jest.fn(),
      downloadAuthorityTransferArtifact: jest.fn(async ({ artifact }) => {
        const body = new Readable({ read() {} });
        bodies.push(body);
        return { artifact, body, byteCount: 1 };
      }),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort;
    const coordinator = new CloudToLanTargetCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      target: {
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging: jest.fn(),
        stage: jest.fn(async () => {
          throw new Error('injected-stage-failure');
        }),
      },
    });

    await expect(coordinator.resume(PROJECT_ID)).rejects.toThrow('injected-stage-failure');
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every(body => body.destroyed)).toBe(true);
  });

  it.each([
    'collecting-readiness',
    'source-quiesced',
    'checkpoint-received',
    'checkpoint-validated',
    'claims-retained',
    'repository-published',
    'source-relinquished',
    'cloud-activated',
    'completed',
  ] as const)('recovers LAN-to-Cloud after durable phase %s', async phase => {
    const persistence = new MemoryPersistence();
    const batch = claimBatch('lan-to-cloud');
    const withBatch = (nextPhase: CollabAuthorityTransferStatus['phase']) => status(
      'lan-to-cloud',
      nextPhase,
      {
        batchRevision: 1,
        batchSha256: batch.batchSha256,
        ...(nextPhase === 'source-relinquished'
          || nextPhase === 'cloud-activated'
          || nextPhase === 'completed'
          ? { relinquishmentProof: relinquishmentProof('lan-to-cloud', batch.batchSha256) }
          : {}),
      },
    );
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: phase === 'checkpoint-validated'
        || phase === 'claims-retained'
        || phase === 'repository-published'
        || phase === 'source-relinquished'
        || phase === 'cloud-activated'
        || phase === 'completed'
        ? withBatch(phase)
        : status('lan-to-cloud', phase),
    });
    const cloud = {
      authorityTransfer: jest.fn(async (operation: string) => {
        if (operation === 'getAuthorityTransferReceiptVerifier') return RECEIPT_VERIFIER;
        if (operation === 'beginLanToCloudTransfer') {
          return status('lan-to-cloud', 'source-quiesced');
        }
        if (operation === 'rotateTransferredMembershipClaims') return batch;
        if (operation === 'acknowledgeTransferredMembershipClaimBatch') {
          return custodyReceipt('lan-to-cloud', batch.batchSha256);
        }
        if (operation === 'commitLanToCloudRelinquishment') {
          return withBatch('completed');
        }
        if (operation === 'getProjectAuthorityTransfer') {
          switch (persistence.record?.status.phase) {
            case 'source-quiesced':
            case 'checkpoint-received': return withBatch('checkpoint-validated');
            case 'checkpoint-validated':
            case 'claims-retained': return withBatch('repository-published');
            case 'source-relinquished':
            case 'cloud-activated': return withBatch('completed');
            default: throw new Error(`unexpected persisted phase ${persistence.record?.status.phase}`);
          }
        }
        throw new Error(`unexpected ${operation}`);
      }),
      downloadAuthorityTransferArtifact: jest.fn(),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(async () => undefined),
    } as unknown as CollabAuthorityLifecyclePort;
    const activateTerminal = jest.fn(async () => undefined);
    const coordinator = new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      source: {
        acceptanceRequest: jest.fn(async record => ({
          expectedAuthorityGeneration: record.status.sourceAuthority.generation,
          idempotencyKey: 'intent-host-acceptance',
          projectId: PROJECT_ID,
          targetUrl: record.status.targetUrl,
          transferId: TRANSFER_ID,
        })),
        acceptProposal: jest.fn(async () => persistence.record!.status),
        activateTerminal,
        capture: jest.fn(async () => ({
          artifacts: [{
            artifact: 'checkpoint.json' as const,
            body: Readable.from(['checkpoint']),
            byteCount: 10,
          }],
          checkpointManifestSha256: CHECKPOINT_SHA256,
          sourceHostMemberId: HOST_MEMBER_ID,
          sourceProof: Buffer.alloc(64, 3).toString('base64url'),
        })),
        commitRelinquishmentFence: jest.fn(async () => (
          relinquishmentProof('lan-to-cloud', batch.batchSha256)
        )),
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn(),
      },
    });

    await expect(coordinator.resume(PROJECT_ID)).resolves.toMatchObject({
      phase: 'completed',
      state: 'completed',
    });
    expect(activateTerminal).toHaveBeenCalledTimes(1);
  });

  it.each([
    'collecting-readiness',
    'cloud-quiesced',
    'checkpoint-captured',
    'target-staged',
    'claims-retained',
    'cloud-relinquished',
    'lan-activated',
    'completed',
  ] as const)('recovers Cloud-to-LAN after durable phase %s', async phase => {
    const persistence = new MemoryPersistence();
    const batch = claimBatch('cloud-to-lan');
    const withBatch = (nextPhase: CollabAuthorityTransferStatus['phase']) => status(
      'cloud-to-lan',
      nextPhase,
      {
        batchRevision: 1,
        batchSha256: batch.batchSha256,
        ...(nextPhase === 'cloud-relinquished'
          || nextPhase === 'lan-activated'
          || nextPhase === 'completed'
          ? { relinquishmentProof: relinquishmentProof('cloud-to-lan', batch.batchSha256) }
          : {}),
      },
    );
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: phase === 'target-staged'
        || phase === 'claims-retained'
        || phase === 'cloud-relinquished'
        || phase === 'lan-activated'
        || phase === 'completed'
        ? withBatch(phase)
        : status('cloud-to-lan', phase),
    });
    const cloud = {
      authorityTransfer: jest.fn(async (operation: string) => {
        if (operation === 'getAuthorityTransferReceiptVerifier') return RECEIPT_VERIFIER;
        if (operation === 'acceptCloudToLanTransferTarget') {
          return status('cloud-to-lan', 'cloud-quiesced');
        }
        if (operation === 'reportCloudToLanTargetStaged') {
          return custodyReceipt('cloud-to-lan', batch.batchSha256);
        }
        if (operation === 'confirmCloudToLanTargetActive') return withBatch('completed');
        if (operation === 'getProjectAuthorityTransfer') {
          switch (persistence.record?.status.phase) {
            case 'cloud-quiesced': return status('cloud-to-lan', 'checkpoint-captured');
            case 'checkpoint-captured':
            case 'target-staged':
            case 'claims-retained': return withBatch('cloud-relinquished');
            case 'lan-activated': return withBatch('completed');
            default: throw new Error(`unexpected persisted phase ${persistence.record?.status.phase}`);
          }
        }
        throw new Error(`unexpected ${operation}`);
      }),
      downloadAuthorityTransferArtifact: jest.fn(async ({ artifact }) => ({
        body: Readable.from([artifact]),
        byteCount: Buffer.byteLength(artifact),
      })),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort;
    const activate = jest.fn(async () => 'target-activation-proof');
    const coordinator = new CloudToLanTargetCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      target: {
        acceptanceRequest: jest.fn(async () => ({
          idempotencyKey: 'intent-target-acceptance',
          projectId: PROJECT_ID,
          targetHostMemberId: HOST_MEMBER_ID,
          targetProof: Buffer.alloc(64, 2).toString('base64url'),
          transferId: TRANSFER_ID,
        })),
        activate,
        cancelStaging: jest.fn(),
        stage: jest.fn(async () => ({
          checkpointSha256: CHECKPOINT_SHA256,
          claimBatch: batch,
          stageSha256: 'c'.repeat(64),
          targetAuthority: { generation: 2, kind: 'lan' as const },
          targetProof: Buffer.alloc(64, 5).toString('base64url'),
        })),
      },
    });

    await expect(coordinator.resume(PROJECT_ID)).resolves.toMatchObject({
      phase: 'completed',
      state: 'completed',
    });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'cancel-intent',
    'target-invalidated',
    'target-cleaned',
    'source-reopened',
    'cancelled',
  ] as const)('recovers both directions after cancellation phase %s', async phase => {
    const sourcePersistence = new MemoryPersistence();
    sourcePersistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', phase),
    });
    const targetPersistence = new MemoryPersistence();
    targetPersistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('cloud-to-lan', phase),
    });
    const lifecycle = (direction: 'cloud-to-lan' | 'lan-to-cloud') => ({
      authorityTransfer: jest.fn(async () => status(direction, 'cancelled')),
      downloadAuthorityTransferArtifact: jest.fn(),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort);
    const reopenAfterCancellation = jest.fn(async () => undefined);
    const cancelStaging = jest.fn(async () => undefined);

    await expect(new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud: lifecycle('lan-to-cloud'),
      persistence: sourcePersistence.asPort(),
      source: {
        acceptanceRequest: jest.fn(),
        acceptProposal: jest.fn(),
        activateTerminal: jest.fn(),
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(),
        reopenAfterCancellation,
        requestProposal: jest.fn(),
      },
    }).resume(PROJECT_ID)).resolves.toMatchObject({ state: 'cancelled' });
    await expect(new CloudToLanTargetCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud: lifecycle('cloud-to-lan'),
      persistence: targetPersistence.asPort(),
      target: {
        acceptanceRequest: jest.fn(),
        activate: jest.fn(),
        cancelStaging,
        stage: jest.fn(),
      },
    }).resume(PROJECT_ID)).resolves.toMatchObject({ state: 'cancelled' });

    expect(reopenAfterCancellation).toHaveBeenCalledTimes(1);
    expect(cancelStaging).toHaveBeenCalled();
  });

  it('resumes LAN-to-Cloud from a persisted checkpoint intermediate and restores terminal service', async () => {
    const persistence = new MemoryPersistence();
    const batch = claimBatch('lan-to-cloud');
    persistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'checkpoint-received'),
    });
    const statuses = [
      status('lan-to-cloud', 'checkpoint-validated', {
        batchRevision: 1,
        batchSha256: batch.batchSha256,
      }),
      status('lan-to-cloud', 'repository-published', {
        batchRevision: 1,
        batchSha256: batch.batchSha256,
      }),
    ];
    const cloud = {
      authorityTransfer: jest.fn(async (operation: string) => {
        if (operation === 'getAuthorityTransferReceiptVerifier') return RECEIPT_VERIFIER;
        if (operation === 'getProjectAuthorityTransfer') return statuses.shift()!;
        if (operation === 'rotateTransferredMembershipClaims') return batch;
        if (operation === 'acknowledgeTransferredMembershipClaimBatch') {
          return custodyReceipt('lan-to-cloud', batch.batchSha256);
        }
        if (operation === 'commitLanToCloudRelinquishment') {
          return status('lan-to-cloud', 'completed', {
            batchRevision: 1,
            batchSha256: batch.batchSha256,
            relinquishmentProof: relinquishmentProof('lan-to-cloud', batch.batchSha256),
          });
        }
        throw new Error(`unexpected ${operation}`);
      }),
      downloadAuthorityTransferArtifact: jest.fn(),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort;
    const activateTerminal = jest.fn(async () => undefined);
    const coordinator = new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      source: {
        acceptanceRequest: jest.fn(),
        acceptProposal: jest.fn(),
        activateTerminal,
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(async () => (
          relinquishmentProof('lan-to-cloud', batch.batchSha256)
        )),
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn(),
      },
    });

    await expect(coordinator.resume(PROJECT_ID)).resolves.toMatchObject({
      phase: 'completed',
      state: 'completed',
    });
    expect(activateTerminal).toHaveBeenCalledTimes(1);
  });

  it('reinstalls completed source and target services after restart', async () => {
    const sourcePersistence = new MemoryPersistence();
    sourcePersistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'completed'),
    });
    const activateTerminal = jest.fn(async () => undefined);
    const lifecycle = {
      authorityTransfer: jest.fn(),
      downloadAuthorityTransferArtifact: jest.fn(),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort;
    await new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud: lifecycle,
      persistence: sourcePersistence.asPort(),
      source: {
        acceptanceRequest: jest.fn(),
        acceptProposal: jest.fn(),
        activateTerminal,
        capture: jest.fn(),
        commitRelinquishmentFence: jest.fn(),
        reopenAfterCancellation: jest.fn(),
        requestProposal: jest.fn(),
      },
    }).resume(PROJECT_ID);

    const targetPersistence = new MemoryPersistence();
    targetPersistence.record = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: 'intent-production-transfer',
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('cloud-to-lan', 'completed'),
    });
    const activate = jest.fn(async () => 'target-activation-proof');
    await new CloudToLanTargetCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud: lifecycle,
      persistence: targetPersistence.asPort(),
      target: {
        acceptanceRequest: jest.fn(),
        activate,
        cancelStaging: jest.fn(),
        stage: jest.fn(),
      },
    }).resume(PROJECT_ID);

    expect(activateTerminal).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('moves LAN to Cloud after explicit Host acceptance without online-member input', async () => {
    const persistence = new MemoryPersistence();
    const batch = claimBatch('lan-to-cloud');
    const calls: string[] = [];
    let statusRead = 0;
    const cloud = {
      authorityTransfer: jest.fn(async (operation: string) => {
        calls.push(operation);
        switch (operation) {
          case 'getAuthorityTransferReceiptVerifier': return RECEIPT_VERIFIER;
          case 'beginLanToCloudTransfer': return status('lan-to-cloud', 'source-quiesced');
          case 'rotateTransferredMembershipClaims': return batch;
          case 'acknowledgeTransferredMembershipClaimBatch':
            return custodyReceipt('lan-to-cloud', batch.batchSha256);
          case 'getProjectAuthorityTransfer':
            statusRead += 1;
            return statusRead === 1
              ? status('lan-to-cloud', 'checkpoint-validated', {
                  batchRevision: 1,
                  batchSha256: batch.batchSha256,
                })
              : status('lan-to-cloud', 'repository-published', {
                  batchRevision: 1,
                  batchSha256: batch.batchSha256,
                });
          case 'commitLanToCloudRelinquishment':
            return status('lan-to-cloud', 'completed', {
              batchRevision: 1,
              batchSha256: batch.batchSha256,
              relinquishmentProof: relinquishmentProof('lan-to-cloud', batch.batchSha256),
            });
          default: throw new Error(`unexpected ${operation}`);
        }
      }),
      downloadAuthorityTransferArtifact: jest.fn(),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(async () => undefined),
    } as unknown as CollabAuthorityLifecyclePort;
    const source = {
      acceptanceRequest: jest.fn(async () => ({
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-host-acceptance',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test',
        transferId: TRANSFER_ID,
      })),
      acceptProposal: jest.fn(async () => status('lan-to-cloud', 'collecting-readiness')),
      activateTerminal: jest.fn(async () => undefined),
      capture: jest.fn(async () => ({
        artifacts: [
          {
            artifact: 'checkpoint.json' as const,
            body: Readable.from(['checkpoint']),
            byteCount: 10,
          },
        ],
        checkpointManifestSha256: CHECKPOINT_SHA256,
        sourceHostMemberId: HOST_MEMBER_ID,
        sourceProof: Buffer.alloc(64, 3).toString('base64url'),
      })),
      commitRelinquishmentFence: jest.fn(async () => (
        relinquishmentProof('lan-to-cloud', batch.batchSha256)
      )),
      reopenAfterCancellation: jest.fn(async () => undefined),
      requestProposal: jest.fn(async () => status('lan-to-cloud', 'collecting-readiness')),
      sourceEndpoint: jest.fn(async () => 'https://127.0.0.1:54545'),
    };
    const coordinator = new LanToCloudSourceCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      source,
    });
    await coordinator.propose({
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-production-transfer',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test',
    });
    const completed = await coordinator.acceptAndTransfer({
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-host-acceptance',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test',
      transferId: TRANSFER_ID,
    });

    expect(completed.state).toBe('completed');
    expect(persistence.record?.sourceLanEndpoint).toBe('https://127.0.0.1:54545');
    expect(source.acceptProposal).toHaveBeenCalledTimes(1);
    expect(source.activateTerminal).toHaveBeenCalledTimes(1);
    expect(calls).toContain('getAuthorityTransferReceiptVerifier');
    expect(calls.indexOf('getAuthorityTransferReceiptVerifier')).toBeLessThan(
      calls.indexOf('commitLanToCloudRelinquishment'),
    );
    expect(calls).toContain('commitLanToCloudRelinquishment');
    expect(persistence.phases).toEqual([
      'collecting-readiness',
      'collecting-readiness',
      'source-quiesced',
      'checkpoint-received',
      'checkpoint-validated',
      'claims-retained',
      'repository-published',
      'source-relinquished',
      'cloud-activated',
      'completed',
    ]);
  });

  it('stages Cloud to LAN inertly and activates only after Cloud relinquishment proof', async () => {
    const persistence = new MemoryPersistence();
    const batch = claimBatch('cloud-to-lan');
    let statusRead = 0;
    const cloud = {
      authorityTransfer: jest.fn(async (operation: string) => {
        switch (operation) {
          case 'acceptCloudToLanTransferTarget':
            return status('cloud-to-lan', 'cloud-quiesced');
          case 'getProjectAuthorityTransfer':
            statusRead += 1;
            return statusRead === 1
              ? status('cloud-to-lan', 'collecting-readiness')
              : statusRead === 2
                ? status('cloud-to-lan', 'checkpoint-captured')
                : status('cloud-to-lan', 'cloud-relinquished', {
                  batchRevision: 1,
                  batchSha256: batch.batchSha256,
                  relinquishmentProof: relinquishmentProof('cloud-to-lan', batch.batchSha256),
                });
          case 'reportCloudToLanTargetStaged':
            return custodyReceipt('cloud-to-lan', batch.batchSha256);
          case 'confirmCloudToLanTargetActive':
            return status('cloud-to-lan', 'completed', {
              batchRevision: 1,
              batchSha256: batch.batchSha256,
              relinquishmentProof: relinquishmentProof('cloud-to-lan', batch.batchSha256),
            });
          default: throw new Error(`unexpected ${operation}`);
        }
      }),
      downloadAuthorityTransferArtifact: jest.fn(async ({ artifact }) => ({
        body: Readable.from([artifact]),
        byteCount: Buffer.byteLength(artifact),
      })),
      retirement: jest.fn(),
      uploadAuthorityTransferArtifact: jest.fn(),
    } as unknown as CollabAuthorityLifecyclePort;
    const target = {
      acceptanceRequest: jest.fn(async () => {
        expect(persistence.record).toMatchObject({
          ownerInstallationKey: TEST_INSTALLATION_A,
          schemaVersion: 2,
        });
        return {
          idempotencyKey: 'intent-target-acceptance',
          projectId: PROJECT_ID,
          targetHostMemberId: HOST_MEMBER_ID,
          targetProof: Buffer.alloc(64, 2).toString('base64url'),
          transferId: TRANSFER_ID,
        };
      }),
      activate: jest.fn(async () => 'target-activation-proof'),
      cancelStaging: jest.fn(async () => undefined),
      stage: jest.fn(async () => ({
        checkpointSha256: CHECKPOINT_SHA256,
        claimBatch: batch,
        stageSha256: 'c'.repeat(64),
        targetAuthority: { generation: 2, kind: 'lan' as const },
        targetProof: Buffer.alloc(64, 5).toString('base64url'),
      })),
    };
    const coordinator = new CloudToLanTargetCoordinator({
      installationKey: TEST_INSTALLATION_A,
      cloud,
      persistence: persistence.asPort(),
      target,
    });
    const completed = await coordinator.acceptAndTransfer({
      idempotencyKey: 'intent-target-acceptance',
      projectId: PROJECT_ID,
      targetHostMemberId: HOST_MEMBER_ID,
      targetProof: Buffer.alloc(64, 2).toString('base64url'),
      transferId: TRANSFER_ID,
    }, 'intent-production-transfer');

    expect(completed.state).toBe('completed');
    expect(target.stage).toHaveBeenCalledTimes(1);
    expect(target.activate).toHaveBeenCalledTimes(1);
    expect(persistence.phases).toEqual([
      'collecting-readiness',
      'cloud-quiesced',
      'checkpoint-captured',
      'target-staged',
      'claims-retained',
      'cloud-relinquished',
      'lan-activated',
      'completed',
    ]);
  });
});
