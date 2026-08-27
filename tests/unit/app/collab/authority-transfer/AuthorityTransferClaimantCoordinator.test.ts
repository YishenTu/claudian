import { createHash } from 'node:crypto';

import type {
  ClaimTransferredMembershipRequest,
  CollabAuthorityTransferStatus,
  CollabTransferredMembershipClaim,
  CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';

import {
  AuthorityTransferClaimantCoordinator,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantCoordinator';
import type {
  AuthorityTransferClaimantRecord,
  AuthorityTransferClaimantStore,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  advanceAuthorityTransferClaimantRecord,
  createAuthorityTransferClaimantRecord,
  decodeAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';

const PROJECT_ID = 'project-claimant';
const TRANSFER_ID = 'transfer-claimant';
const MEMBER_ID = 'member-offline';
const INTENT_ID = 'intent-claimant';
const CREATED_AT = '2026-08-27T00:00:00.000Z';
const CHECKPOINT_SHA256 = 'a'.repeat(64);
const CLAIM_VALUE = Buffer.alloc(32, 4).toString('base64url');
const TARGET_CREDENTIAL = Buffer.alloc(32, 9).toString('base64url');
const LAN_TARGET = {
  caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n',
  caFingerprint: 'd'.repeat(64),
  endpoint: 'https://192.168.1.20:54545/',
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

function receipt(): CollabTransferredMembershipRedemptionReceipt {
  return {
    checkpointSha256: CHECKPOINT_SHA256,
    claimSha256: createHash('sha256').update(CLAIM_VALUE, 'utf8').digest('hex'),
    memberId: MEMBER_ID,
    operationIntentId: INTENT_ID,
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
  it('rejects a claim or redemption outside the exact transfer lifetime', () => {
    const value = {
      claim: claim(),
      createdAt: CREATED_AT,
      kind: 'authority-transfer-claimant',
      lanTarget: null,
      memberId: MEMBER_ID,
      operationIntentId: INTENT_ID,
      phase: 'completed',
      projectId: PROJECT_ID,
      redemptionReceipt: receipt(),
      schemaVersion: 1,
      status: completed('lan-to-cloud'),
      targetCredential: null,
      transferId: TRANSFER_ID,
      updatedAt: '2026-08-27T00:02:00.000Z',
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
              .update(Buffer.from(TARGET_CREDENTIAL, 'base64url'))
              .digest('hex'),
          } : {}),
        });
        expect('credentialHash' in request).toBe(expectsCredential);
        return receipt();
      });
      const converge = jest.fn(async () => undefined);
      const coordinator = new AuthorityTransferClaimantCoordinator({
        convergence: { converge },
        createCredential: () => TARGET_CREDENTIAL,
        lanTarget: expectsCredential ? LAN_TARGET : null,
        now: () => new Date('2026-08-27T00:02:00.000Z'),
        source: { acknowledgeRedemption: acknowledge, getClaim },
        store,
        target: { claimTransferredMembership: claimTarget },
      });

      await coordinator.start({
        memberId: MEMBER_ID,
        operationIntentId: INTENT_ID,
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
        target: { claimTransferredMembership: async () => receipt() },
      });

      await expect(first.start({
        memberId: MEMBER_ID,
        operationIntentId: INTENT_ID,
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
        target: { claimTransferredMembership: unavailable },
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
      target: { claimTransferredMembership: jest.fn() },
    });

    await expect(coordinator.start({
      memberId: MEMBER_ID,
      operationIntentId: INTENT_ID,
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
    const target = jest.fn(async () => receipt());
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: { converge: async () => undefined },
      createCredential: jest.fn(() => TARGET_CREDENTIAL),
      lanTarget: LAN_TARGET,
      source: {
        acknowledgeRedemption: async () => undefined,
        getClaim,
      },
      store,
      target: { claimTransferredMembership: target },
    });
    store.failNextRemove = true;
    await expect(coordinator.start({
      memberId: MEMBER_ID,
      operationIntentId: INTENT_ID,
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
        target: { claimTransferredMembership: target },
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
      target: { claimTransferredMembership: jest.fn() },
    });

    await coordinator.resume(PROJECT_ID);

    expect(acknowledge).not.toHaveBeenCalled();
    expect(converge).toHaveBeenCalledTimes(1);
    expect(store.record).toBeNull();
  });
});
