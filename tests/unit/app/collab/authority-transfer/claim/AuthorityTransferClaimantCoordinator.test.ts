import { createHash } from 'node:crypto';

import type {
  ClaimTransferredMembershipRequest,
  CollabAuthorityTransferStatus,
  CollabTransferredMembershipClaim,
  CollabTransferredMembershipRedemptionReceipt,
  ReissueTransferredMembershipClaimResponse,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import {
  AuthorityTransferClaimantCoordinator,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantCoordinator';
import type {
  AuthorityTransferClaimantRecord,
  AuthorityTransferClaimantStore,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  advanceAuthorityTransferClaimantRecord,
  AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
  createAuthorityTransferClaimantRecord,
  createManagerReissuedAuthorityTransferClaimantRecord,
  decodeAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-claimant';
const TRANSFER_ID = 'transfer-claimant';
const MEMBER_ID = 'member-offline';
const INTENT_ID = 'intent-claimant';
const MANAGER_INTENT_ID = 'transfer-owner-intent';
const CLOUD_TO_LAN_INTENT_ID = authorityTransferChildIdempotencyKey(
  MANAGER_INTENT_ID,
  'claims',
);
const CREATED_AT = '2026-08-27T00:00:00.000Z';
const CHECKPOINT_SHA256 = 'a'.repeat(64);
const CLAIM_VALUE = Buffer.alloc(32, 4).toString('base64url');
const TARGET_CREDENTIAL = Buffer.alloc(32, 9).toString('base64url');
const LAN_TARGET = {
  caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n',
  caFingerprint: 'd'.repeat(64),
  endpoint: 'https://192.168.1.20:54545/',
};
const MANAGER_PREDECESSOR = {
  initiatingPersonalRef: 'refs/heads/members/member-offline',
  operationIntentId: MANAGER_INTENT_ID,
  ownerInstallationKey: TEST_INSTALLATION_A,
  preparationId: 'intent-target-preparation',
  selectedTargetMemberId: 'member-target',
  sourceCloudUrl: 'https://cloud.example.test/',
};

function completed(direction: 'cloud-to-lan' | 'lan-to-cloud'): CollabAuthorityTransferStatus {
  const sourceKind = direction === 'lan-to-cloud' ? 'lan' : 'cloud';
  const targetKind = direction === 'lan-to-cloud' ? 'cloud' : 'lan';
  return {
    batchRevision: 1,
    batchSha256: 'b'.repeat(64),
    checkpointSha256: CHECKPOINT_SHA256,
    createdAt: CREATED_AT,
    direction,
    expiresAt: '2026-09-26T00:00:00.000Z',
    phase: 'completed',
    projectId: PROJECT_ID,
    relinquishmentProof: {
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
      certificate: Buffer.alloc(64, 2).toString('base64url'),
      certificateAlgorithm: 'ed25519',
      checkpointSha256: CHECKPOINT_SHA256,
      committedAt: '2026-08-27T00:00:08.000Z',
      operationIntentId: 'transfer-owner-intent',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 1, kind: sourceKind },
      sourceHostMemberId: sourceKind === 'lan' ? 'member-host' : null,
      targetAuthority: { generation: 2, kind: targetKind },
      transferId: TRANSFER_ID,
    } as never,
    sourceAuthority: { generation: 1, kind: sourceKind },
    state: 'completed',
    targetAuthority: { generation: 2, kind: targetKind },
    targetUrl: direction === 'lan-to-cloud'
      ? 'https://cloud.example.test/'
      : 'https://192.168.1.20:54545/',
    transferId: TRANSFER_ID,
    updatedAt: '2026-08-27T00:00:10.000Z',
  };
}

function claim(): CollabTransferredMembershipClaim {
  return {
    claim: CLAIM_VALUE,
    expiresAt: '2026-09-26T00:00:00.000Z',
    memberId: MEMBER_ID,
    projectId: PROJECT_ID,
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  };
}

function reissuedClaim(): ReissueTransferredMembershipClaimResponse {
  return {
    ...claim(),
    claimGeneration: 4,
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
    secretReplayExpiresAt: '2026-10-31T00:00:00.000Z',
  };
}

function receipt(operationIntentId = INTENT_ID): CollabTransferredMembershipRedemptionReceipt {
  return {
    checkpointSha256: CHECKPOINT_SHA256,
    claimSha256: createHash('sha256').update(CLAIM_VALUE, 'utf8').digest('hex'),
    memberId: MEMBER_ID,
    operationIntentId,
    projectId: PROJECT_ID,
    receiptId: 'receipt-claimant',
    receiptKeyId: 'receipt-key-1',
    redeemedAt: '2026-08-27T00:01:00.000Z',
    signature: Buffer.alloc(64, 3).toString('base64url'),
    signatureAlgorithm: 'ed25519',
    targetAuthorityGeneration: 2,
    transferId: TRANSFER_ID,
  };
}

class MemoryStore implements AuthorityTransferClaimantStore {
  failNextRemove = false;
  failNextSavePhase: AuthorityTransferClaimantRecord['phase'] | null = null;
  record: AuthorityTransferClaimantRecord | null = null;
  readonly phases: string[] = [];

  listProjectIds = async () => this.record ? [this.record.projectId] : [];
  load = async () => this.record;
  remove = async () => {
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error('simulated cleanup crash');
    }
    const existed = this.record !== null;
    this.record = null;
    return existed;
  };
  save = async (record: AuthorityTransferClaimantRecord) => {
    if (this.failNextSavePhase === record.phase) {
      this.failNextSavePhase = null;
      throw new Error('simulated claimant progress crash');
    }
    this.record = record;
    this.phases.push(record.phase);
  };
}

describe('AuthorityTransferClaimantCoordinator', () => {
  it('persists a Manager-reissued descriptor and exact request before target redemption without resolving the source', async () => {
    const store = new MemoryStore();
    const source = {
      acknowledgeRedemption: jest.fn(),
      getClaim: jest.fn(),
    };
    const targetStatus = completed('lan-to-cloud');
    const claimTarget = jest.fn(async (
      record: AuthorityTransferClaimantRecord,
      request: ClaimTransferredMembershipRequest,
    ) => {
      expect(store.record).toEqual(record);
      expect(record).toMatchObject({
        descriptor: reissuedClaim(),
        phase: 'redemption-prepared',
        redemptionRequest: request,
        variant: 'manager-reissued',
      });
      return {
        ...receipt(),
        redeemedAt: '2026-10-01T00:01:00.000Z',
      };
    });
    const confirmTargetBinding = jest.fn(async (
      record: AuthorityTransferClaimantRecord,
      proof: 'receipt' | 'existing-binding',
    ) => {
      expect(proof).toBe('receipt');
      expect(store.record).toEqual(record);
      expect(record).toMatchObject({
        phase: 'target-claimed',
        redemptionReceipt: { receiptId: 'receipt-claimant' },
      });
      return targetStatus;
    });
    const converge = jest.fn(async (record: AuthorityTransferClaimantRecord) => {
      expect(store.record).toEqual(record);
      expect(record).toMatchObject({
        convergenceProof: 'receipt',
        phase: 'target-confirmed',
        targetStatus,
      });
    });
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge },
      now: () => new Date('2026-10-01T00:00:10.000Z'),
      source,
      store,
      target: { cloudPrincipalId: 'vault-' + 'a'.repeat(64), claimTransferredMembership: claimTarget, confirmTargetBinding },
    });

    await coordinator.startManagerReissued({
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      operationIntentId: INTENT_ID,
      serverUrl: 'https://cloud.example.test/',
    });

    expect(store.phases).toEqual([
      'redemption-prepared',
      'target-claimed',
      'target-confirmed',
      'membership-converged',
      'completed',
    ]);
    expect(store.record).toBeNull();
    expect(source.getClaim).not.toHaveBeenCalled();
    expect(source.acknowledgeRedemption).not.toHaveBeenCalled();
    expect(claimTarget).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'manager-reissued' }),
      {
        claim: CLAIM_VALUE,
        idempotencyKey: INTENT_ID,
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
      expect.any(Object),
    );
  });

  it('persists Manager-reissued progress when the client clock lags the Cloud descriptor', async () => {
    const store = new MemoryStore();
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: jest.fn(async () => undefined) },
      now: () => new Date('2026-09-30T23:59:00.000Z'),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: jest.fn(async () => ({
          ...receipt(),
          redeemedAt: '2026-10-01T00:01:00.000Z',
        })),
        confirmTargetBinding: jest.fn(async () => completed('lan-to-cloud')),
      },
    });

    await coordinator.startManagerReissued({
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      operationIntentId: INTENT_ID,
      serverUrl: 'https://cloud.example.test/',
    });

    expect(store.phases).toEqual([
      'redemption-prepared',
      'target-claimed',
      'target-confirmed',
      'membership-converged',
      'completed',
    ]);
    expect(store.record).toBeNull();
  });

  it('uses only authenticated existing-binding confirmation after a Manager reissue expires', async () => {
    const store = new MemoryStore();
    const claimTarget = jest.fn();
    const confirmTargetBinding = jest.fn(async (
      record: AuthorityTransferClaimantRecord,
      proof: 'receipt' | 'existing-binding',
    ) => {
      expect(proof).toBe('existing-binding');
      expect(record).toMatchObject({
        phase: 'redemption-prepared',
        redemptionReceipt: null,
        variant: 'manager-reissued',
      });
      return completed('lan-to-cloud');
    });
    const converge = jest.fn(async (record: AuthorityTransferClaimantRecord) => {
      expect(record).toMatchObject({
        convergenceProof: 'existing-binding',
        phase: 'target-confirmed',
        redemptionReceipt: null,
      });
    });
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge },
      now: () => new Date(reissuedClaim().expiresAt),
      store,
      target: { cloudPrincipalId: 'vault-' + 'a'.repeat(64), claimTransferredMembership: claimTarget, confirmTargetBinding },
    });

    await coordinator.startManagerReissued({
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      operationIntentId: INTENT_ID,
      serverUrl: 'https://cloud.example.test/',
    });

    expect(claimTarget).not.toHaveBeenCalled();
    expect(confirmTargetBinding).toHaveBeenCalledTimes(1);
    expect(converge).toHaveBeenCalledTimes(1);
    expect(store.record).toBeNull();
  });

  it('finishes a target-confirmed Manager reissue locally without a target confirmation port', async () => {
    const store = new MemoryStore();
    const prepared = createManagerReissuedAuthorityTransferClaimantRecord({
      cloudPrincipalId: 'vault-' + 'a'.repeat(64),
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      operationIntentId: INTENT_ID,
      serverUrl: 'https://cloud.example.test/',
    });
    const claimed = advanceAuthorityTransferClaimantRecord(prepared, {
      phase: 'target-claimed',
      redemptionReceipt: {
        ...receipt(),
        redeemedAt: '2026-10-01T00:01:00.000Z',
      },
      updatedAt: '2026-10-01T00:01:00.000Z',
    });
    store.record = advanceAuthorityTransferClaimantRecord(claimed, {
      convergenceProof: 'receipt',
      phase: 'target-confirmed',
      targetStatus: completed('lan-to-cloud'),
      updatedAt: '2026-10-01T00:02:00.000Z',
    });
    const converge = jest.fn(async () => undefined);
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge },
      now: () => new Date('2026-10-01T00:03:00.000Z'),
      store,
      target: { cloudPrincipalId: 'vault-' + 'a'.repeat(64), claimTransferredMembership: jest.fn() },
    });

    await coordinator.resume(PROJECT_ID);

    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'target-confirmed', variant: 'manager-reissued' }),
      {},
    );
    expect(store.record).toBeNull();
  });

  it('keeps an expired ambiguous Manager reissue visibly recoverable when exact binding cannot be proved', async () => {
    const store = new MemoryStore();
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: jest.fn() },
      now: () => new Date(reissuedClaim().expiresAt),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: jest.fn(),
        confirmTargetBinding: async () => {
          throw new CollabError({
            code: 'durable-progress-recovery-required',
            safeContext: { reason: 'target-binding-not-proved' },
          });
        },
      },
    });

    await expect(coordinator.startManagerReissued({
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      operationIntentId: INTENT_ID,
      serverUrl: 'https://cloud.example.test/',
    })).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });

    expect(store.record).toMatchObject({
      convergenceProof: null,
      phase: 'redemption-prepared',
      redemptionReceipt: null,
      variant: 'manager-reissued',
    });
  });

  it('recovers a persisted Manager-reissued receipt forward after its own expiry', async () => {
    const store = new MemoryStore();
    const beforeExpiry = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: jest.fn() },
      now: () => new Date('2026-10-01T00:00:10.000Z'),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: async () => ({
          ...receipt(),
          redeemedAt: '2026-10-01T00:01:00.000Z',
        }),
        confirmTargetBinding: async () => {
          throw new Error('simulated local death after receipt persistence');
        },
      },
    });
    await expect(beforeExpiry.startManagerReissued({
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      operationIntentId: INTENT_ID,
      serverUrl: 'https://cloud.example.test/',
    })).rejects.toThrow('simulated local death after receipt persistence');
    expect(store.record).toMatchObject({ phase: 'target-claimed' });

    const converge = jest.fn(async () => undefined);
    const afterExpiry = new AuthorityTransferClaimantCoordinator({
      convergence: { converge },
      now: () => new Date(reissuedClaim().expiresAt),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: jest.fn(),
        confirmTargetBinding: async (_record, proof) => {
          expect(proof).toBe('receipt');
          return completed('lan-to-cloud');
        },
      },
    });

    await afterExpiry.resume(PROJECT_ID);

    expect(converge).toHaveBeenCalledTimes(1);
    expect(store.record).toBeNull();
  });

  it.each(['source-issued', 'manager-reissued'] as const)('keeps the original Cloud principal during ambiguous %s redemption', async variant => {
    const store = new MemoryStore();
    const requests: ClaimTransferredMembershipRequest[] = [];
    let loseReply = true;
    const create = (cloudPrincipalId: string) => new AuthorityTransferClaimantCoordinator({
      convergence: { converge: async () => undefined },
      now: () => new Date(variant === 'source-issued' ? '2026-08-27T00:02:00.000Z' : '2026-10-01T00:02:00.000Z'),
      source: { getClaim: async () => claim(), acknowledgeRedemption: async () => undefined },
      store,
      target: {
        cloudPrincipalId,
        claimTransferredMembership: async (_record, request) => {
          requests.push(request);
          if (loseReply) throw new Error('simulated lost response');
          return { ...receipt(request.idempotencyKey), redeemedAt: variant === 'source-issued' ? '2026-08-27T00:01:00.000Z' : '2026-10-01T00:01:00.000Z' };
        },
        confirmTargetBinding: async () => completed('lan-to-cloud'),
      },
    });
    const original = 'vault-' + 'a'.repeat(64);
    const first = create(original);
    const started = variant === 'source-issued'
      ? first.start({ memberId: MEMBER_ID, operationIntentId: INTENT_ID, status: completed('lan-to-cloud') })
      : first.startManagerReissued({ descriptor: reissuedClaim(), memberPersonalRef: `refs/heads/members/${MEMBER_ID}`, operationIntentId: INTENT_ID, serverUrl: 'https://cloud.example.test/' });
    await expect(started).rejects.toThrow('simulated lost response');
    const retained = store.record;
    loseReply = false;
    await expect(create('vault-' + 'b'.repeat(64)).resume(PROJECT_ID)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
    expect(store.record).toEqual(retained);
    expect(requests).toHaveLength(1);
    await create(original).resume(PROJECT_ID);
    expect(requests).toEqual([requests[0], requests[0]]);
    expect(store.record).toBeNull();
  });

  it('replays the same private request after a lost Manager-reissued response', async () => {
    const store = new MemoryStore();
    const requests: ClaimTransferredMembershipRequest[] = [];
    const descriptor = reissuedClaim();
    const input = {
      descriptor,
      memberPersonalRef: 'refs/heads/members/member-offline',
      serverUrl: 'https://cloud.example.test/',
    };
    const first = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: jest.fn() },
      now: () => new Date('2026-10-01T00:00:10.000Z'),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: async (_record, request) => {
          requests.push(request);
          throw new Error('simulated lost response');
        },
        confirmTargetBinding: jest.fn(),
      },
    });
    await expect(first.startManagerReissued(input)).rejects.toThrow('simulated lost response');
    const frozenIntentId = store.record?.operationIntentId;
    expect(frozenIntentId).toMatch(/^manager-reissued-[a-f0-9]{32}$/);

    const second = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: async () => undefined },
      now: () => new Date('2026-10-01T00:00:20.000Z'),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: async (_record, request) => {
          requests.push(request);
          return {
            ...receipt(),
            operationIntentId: request.idempotencyKey,
            redeemedAt: '2026-10-01T00:01:00.000Z',
          };
        },
        confirmTargetBinding: async () => completed('lan-to-cloud'),
      },
    });

    await second.startManagerReissued(input);

    expect(requests).toEqual([
      {
        claim: descriptor.claim,
        idempotencyKey: frozenIntentId,
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
      {
        claim: descriptor.claim,
        idempotencyKey: frozenIntentId,
        projectId: PROJECT_ID,
        transferId: TRANSFER_ID,
      },
    ]);
    expect(store.record).toBeNull();
  });

  it('retains a revoked Manager reissue without attempting existing-binding recovery before expiry', async () => {
    const store = new MemoryStore();
    const confirmTargetBinding = jest.fn();
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: jest.fn() },
      now: () => new Date('2026-10-01T00:00:10.000Z'),
      store,
      target: {
        cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        claimTransferredMembership: async () => {
          throw new CollabError({ code: 'invitation-revoked' });
        },
        confirmTargetBinding,
      },
    });

    await expect(coordinator.startManagerReissued({
      descriptor: reissuedClaim(),
      memberPersonalRef: 'refs/heads/members/member-offline',
      serverUrl: 'https://cloud.example.test/',
    })).rejects.toMatchObject({ code: 'invitation-revoked' });

    expect(store.record).toMatchObject({
      phase: 'redemption-prepared',
      variant: 'manager-reissued',
    });
    expect(confirmTargetBinding).not.toHaveBeenCalled();
  });

  it('rejects a claim or redemption outside the exact transfer lifetime', () => {
    const value = {
      claim: claim(),
      createdAt: CREATED_AT,
      cloudPrincipalId: 'vault-' + 'a'.repeat(64),
      kind: 'authority-transfer-claimant',
      lanTarget: null,
      managerPredecessor: null,
      memberId: MEMBER_ID,
      operationIntentId: INTENT_ID,
      phase: 'completed',
      projectId: PROJECT_ID,
      redemptionReceipt: receipt(),
      schemaVersion: AUTHORITY_TRANSFER_CLAIMANT_RECORD_SCHEMA_VERSION,
      status: completed('lan-to-cloud'),
      targetCredential: null,
      transferId: TRANSFER_ID,
      updatedAt: '2026-08-27T00:02:00.000Z',
      variant: 'source-issued',
    };

    expect(() => decodeAuthorityTransferClaimantRecord({
      ...value,
      claim: { ...value.claim, expiresAt: '2026-09-25T00:00:00.000Z' },
    })).toThrow('Invalid authority-transfer claimant progress');
    expect(() => decodeAuthorityTransferClaimantRecord({
      ...value,
      redemptionReceipt: {
        ...value.redemptionReceipt,
        redeemedAt: value.status.expiresAt,
      },
    })).toThrow('Invalid authority-transfer claimant progress');
  });

  it.each([
    ['lan-to-cloud', false],
    ['cloud-to-lan', true],
  ] as const)(
    'durably redeems an offline Member for %s without Join or prebinding',
    async (direction, expectsCredential) => {
      const operationIntentId = direction === 'cloud-to-lan'
        ? CLOUD_TO_LAN_INTENT_ID
        : INTENT_ID;
      const store = new MemoryStore();
      const getClaim = jest.fn(async () => claim());
      const acknowledge = jest.fn(async () => undefined);
      const claimTarget = jest.fn(async (
        _record: AuthorityTransferClaimantRecord,
        request: ClaimTransferredMembershipRequest,
      ) => {
        expect(store.record?.phase).toBe('credential-persisted');
        expect(request).toMatchObject({
          ...(expectsCredential ? {
            credentialHash: createHash('sha256')
              .update(TARGET_CREDENTIAL, 'utf8')
              .digest('hex'),
          } : {}),
        });
        expect('credentialHash' in request).toBe(expectsCredential);
        return receipt(operationIntentId);
      });
      const converge = jest.fn(async () => undefined);
      const coordinator = new AuthorityTransferClaimantCoordinator({
        convergence: { converge },
        createCredential: () => TARGET_CREDENTIAL,
        lanTarget: expectsCredential ? LAN_TARGET : null,
        now: () => new Date('2026-08-27T00:02:00.000Z'),
        source: { acknowledgeRedemption: acknowledge, getClaim },
        store,
        target: { cloudPrincipalId: expectsCredential ? null : 'vault-' + 'a'.repeat(64), claimTransferredMembership: claimTarget },
      });

      await coordinator.start({
        managerPredecessor: direction === 'cloud-to-lan' ? MANAGER_PREDECESSOR : null,
        memberId: MEMBER_ID,
        operationIntentId,
        status: completed(direction),
      });

      expect(store.phases).toEqual([
        'prepared',
        'claim-retained',
        'credential-persisted',
        'target-claimed',
        'source-acknowledged',
        'membership-converged',
        'completed',
      ]);
      expect(store.record).toBeNull();
      expect(acknowledge).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'target-claimed' }),
        expect.any(Object),
      );
      expect(converge).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'source-acknowledged' }),
        expect.any(Object),
      );
    },
  );

  it.each(['lan-to-cloud', 'cloud-to-lan'] as const)(
    'recovers %s after convergence commits before claimant progress',
    async (direction) => {
      const operationIntentId = direction === 'cloud-to-lan'
        ? CLOUD_TO_LAN_INTENT_ID
        : INTENT_ID;
      const store = new MemoryStore();
      let membershipConverted = false;
      store.failNextSavePhase = 'membership-converged';
      const first = new AuthorityTransferClaimantCoordinator({
        convergence: {
          converge: async () => { membershipConverted = true; },
        },
        createCredential: () => TARGET_CREDENTIAL,
        lanTarget: direction === 'cloud-to-lan' ? LAN_TARGET : null,
        now: () => new Date('2026-08-27T00:02:00.000Z'),
        source: {
          acknowledgeRedemption: async () => undefined,
          getClaim: async () => claim(),
        },
        store,
        target: { cloudPrincipalId: direction === 'lan-to-cloud' ? 'vault-' + 'a'.repeat(64) : null, claimTransferredMembership: async () => receipt(operationIntentId) },
      });

      await expect(first.start({
        managerPredecessor: direction === 'cloud-to-lan' ? MANAGER_PREDECESSOR : null,
        memberId: MEMBER_ID,
        operationIntentId,
        status: completed(direction),
      })).rejects.toThrow('simulated claimant progress crash');
      expect(membershipConverted).toBe(true);
      expect(store.record?.phase).toBe('source-acknowledged');

      const recoverConvertedMembership = jest.fn(async () => {
        expect(membershipConverted).toBe(true);
      });
      const unavailable = jest.fn(async () => {
        throw new Error('remote transport must remain unavailable');
      });
      const restarted = new AuthorityTransferClaimantCoordinator({
        convergence: { converge: recoverConvertedMembership },
        lanTarget: direction === 'cloud-to-lan' ? LAN_TARGET : null,
        source: { acknowledgeRedemption: unavailable, getClaim: unavailable },
        store,
        target: { cloudPrincipalId: direction === 'lan-to-cloud' ? 'vault-' + 'a'.repeat(64) : null, claimTransferredMembership: unavailable },
      });

      await restarted.resume(PROJECT_ID);

      expect(recoverConvertedMembership).toHaveBeenCalledTimes(1);
      expect(unavailable).not.toHaveBeenCalled();
      expect(store.record).toBeNull();
    },
  );

  it('persists the Cloud-to-LAN target trust before retrieving a claim', async () => {
    const store = new MemoryStore();
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: jest.fn() },
      lanTarget: LAN_TARGET,
      source: {
        acknowledgeRedemption: jest.fn(),
        getClaim: jest.fn(async () => { throw new Error('simulated source outage'); }),
      },
      store,
      target: { cloudPrincipalId: null, claimTransferredMembership: jest.fn() },
    });

    await expect(coordinator.start({
      managerPredecessor: MANAGER_PREDECESSOR,
      memberId: MEMBER_ID,
      operationIntentId: CLOUD_TO_LAN_INTENT_ID,
      status: completed('cloud-to-lan'),
    })).rejects.toThrow('simulated source outage');

    expect(store.record).toMatchObject({
      lanTarget: LAN_TARGET,
      phase: 'prepared',
      projectId: PROJECT_ID,
    });
  });

  it('scrubs a terminal record after a cleanup crash without replaying effects', async () => {
    const store = new MemoryStore();
    const getClaim = jest.fn(async () => claim());
    const target = jest.fn(async () => receipt(CLOUD_TO_LAN_INTENT_ID));
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: async () => undefined },
      createCredential: jest.fn(() => TARGET_CREDENTIAL),
      lanTarget: LAN_TARGET,
      source: {
        acknowledgeRedemption: async () => undefined,
        getClaim,
      },
      store,
      target: { cloudPrincipalId: null, claimTransferredMembership: target },
    });
    store.failNextRemove = true;
    await expect(coordinator.start({
      managerPredecessor: MANAGER_PREDECESSOR,
      memberId: MEMBER_ID,
      operationIntentId: CLOUD_TO_LAN_INTENT_ID,
      status: completed('cloud-to-lan'),
    })).rejects.toThrow('simulated cleanup crash');
    const completedRecord = store.record!;
    expect(completedRecord.phase).toBe('completed');

    await coordinator.resume(PROJECT_ID);

    expect(store.record).toBeNull();
    expect(getClaim).toHaveBeenCalledTimes(1);
    expect(target).toHaveBeenCalledTimes(1);
  });

  it.each(['prepared', 'claim-retained', 'credential-persisted'] as const)(
    'scrubs an expired %s record without replaying remote effects',
    async (phase) => {
      const store = new MemoryStore();
      let record = createAuthorityTransferClaimantRecord({
      cloudPrincipalId: 'vault-' + 'a'.repeat(64),
        createdAt: CREATED_AT,
        memberId: MEMBER_ID,
        operationIntentId: INTENT_ID,
        status: completed('lan-to-cloud'),
      });
      if (phase !== 'prepared') {
        record = advanceAuthorityTransferClaimantRecord(record, {
          claim: claim(),
          phase: 'claim-retained',
          updatedAt: '2026-08-27T00:00:01.000Z',
        });
      }
      if (phase === 'credential-persisted') {
        record = advanceAuthorityTransferClaimantRecord(record, {
          phase: 'credential-persisted',
          targetCredential: null,
          updatedAt: '2026-08-27T00:00:02.000Z',
        });
      }
      store.record = record;
      const getClaim = jest.fn();
      const acknowledge = jest.fn();
      const target = jest.fn();
      const converge = jest.fn();
      const coordinator = new AuthorityTransferClaimantCoordinator({
        convergence: { converge },
        now: () => new Date('2026-09-26T00:00:00.000Z'),
        source: { acknowledgeRedemption: acknowledge, getClaim },
        store,
        target: { cloudPrincipalId: 'vault-' + 'a'.repeat(64), claimTransferredMembership: target },
      });

      await coordinator.resume(PROJECT_ID);

      expect(store.record).toBeNull();
      expect(getClaim).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
      expect(converge).not.toHaveBeenCalled();
    },
  );

  it('recovers forward after target claim expiry without replaying source acknowledgement', async () => {
    const store = new MemoryStore();
    let record = createAuthorityTransferClaimantRecord({
      cloudPrincipalId: 'vault-' + 'a'.repeat(64),
      createdAt: CREATED_AT,
      memberId: MEMBER_ID,
      operationIntentId: INTENT_ID,
      status: completed('lan-to-cloud'),
    });
    record = advanceAuthorityTransferClaimantRecord(record, {
      claim: claim(),
      phase: 'claim-retained',
      updatedAt: '2026-08-27T00:00:01.000Z',
    });
    record = advanceAuthorityTransferClaimantRecord(record, {
      phase: 'credential-persisted',
      targetCredential: null,
      updatedAt: '2026-08-27T00:00:02.000Z',
    });
    record = advanceAuthorityTransferClaimantRecord(record, {
      phase: 'target-claimed',
      redemptionReceipt: receipt(),
      updatedAt: '2026-08-27T00:01:00.000Z',
    });
    store.record = record;
    const acknowledge = jest.fn();
    const converge = jest.fn(async () => undefined);
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge },
      now: () => new Date('2026-09-26T00:00:00.000Z'),
      source: { acknowledgeRedemption: acknowledge, getClaim: jest.fn() },
      store,
      target: { cloudPrincipalId: 'vault-' + 'a'.repeat(64), claimTransferredMembership: jest.fn() },
    });

    await coordinator.resume(PROJECT_ID);

    expect(acknowledge).not.toHaveBeenCalled();
    expect(converge).toHaveBeenCalledTimes(1);
    expect(store.record).toBeNull();
  });
});
