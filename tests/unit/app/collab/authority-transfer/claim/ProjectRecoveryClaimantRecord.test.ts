import { testClock, testTime } from '@test/helpers/testClock';

import { AuthorityTransferClaimantCoordinator } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantCoordinator';
import { type AuthorityTransferClaimantRecord, decodeAuthorityTransferClaimantRecord } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { decodeProjectRecoveryClaimantRecord } from '@/app/collab/authority-transfer/claim/ProjectRecoveryClaimantRecord';

const request = { projectId: 'project-demo', expectedAuthorityGeneration: 4, idempotencyKey: 'redeem-one',
  recoveryLinkId: 'recovery-one', token: 'a'.repeat(64), proofCredential: 'b'.repeat(43) };
const prepared = {
  schemaVersion: 5, kind: 'authority-transfer-claimant', variant: 'project-recovery',
  projectId: 'project-demo', memberId: 'member-one', memberPersonalRef: 'refs/heads/members/member-one',
  operationIntentId: 'redeem-one', cloudPrincipalId: `vault-${'c'.repeat(64)}`, targetCredential: null,
  createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
  phase: 'redemption-prepared', retainedAttempts: [], redemptionRequest: request, redemptionReceipt: null, convergence: null,
  invitation: { target: { kind: 'cloud', serverUrl: 'http://100.89.0.41:8787' },
    link: { projectId: 'project-demo', recoveryLinkId: 'recovery-one', authorityGeneration: 4, token: 'a'.repeat(64),
      expiresAt: testTime({ days: 18, minutes: 15 }), secretReplayExpiresAt: testTime({ days: 18, minutes: 10 }) } },
};

describe('ProjectRecoveryClaimantRecord', () => {
  it('retains the original identity proof without inventing a transfer identity', () => {
    expect(decodeProjectRecoveryClaimantRecord(prepared, () => { throw new Error('No predecessors'); })).toEqual(prepared);
    expect(() => decodeProjectRecoveryClaimantRecord({ ...prepared, transferId: 'fake-transfer' }, () => { throw new Error(); })).toThrow();
    expect(() => decodeProjectRecoveryClaimantRecord({ ...prepared, redemptionRequest: { ...request, projectId: 'project-other' } }, () => { throw new Error(); })).toThrow();
    expect(() => decodeProjectRecoveryClaimantRecord({ ...prepared, cloudPrincipalId: null }, () => { throw new Error(); })).toThrow();
  });

  it('requires the exact redemption result and confirmed identity before any local convergence', () => {
    const receipt = { projectId: 'project-demo', recoveryLinkId: 'recovery-one', authorityGeneration: 4,
      memberId: 'member-one', personalRef: 'refs/heads/members/member-one', receiptId: 'receipt-one', recoveredAt: '2026-09-14T00:01:00.000Z' };
    const claimed = { ...prepared, phase: 'target-claimed', updatedAt: receipt.recoveredAt, redemptionReceipt: receipt };
    expect(decodeProjectRecoveryClaimantRecord(claimed, () => { throw new Error(); })).toEqual(claimed);
    expect(() => decodeProjectRecoveryClaimantRecord({ ...claimed, redemptionReceipt: { ...receipt, memberId: 'member-two' } }, () => { throw new Error(); })).toThrow();
    expect(() => decodeProjectRecoveryClaimantRecord({ ...claimed, phase: 'target-confirmed' }, () => { throw new Error(); })).toThrow();
    const confirmed = { ...claimed, phase: 'target-confirmed', convergence: {
      target: prepared.invitation.target, previousBindings: [{ remoteUrl: 'https://old.example/v7/projects/project-demo/repository.git', serverUrl: 'https://old.example' }],
      identity: { authorityGeneration: 4, project: { id: 'project-demo', name: 'Demo' }, eventSequence: 12,
        currentMember: { id: 'member-one', personalRef: 'refs/heads/members/member-one', displayName: 'One', role: 'member' } },
    } };
    expect(decodeProjectRecoveryClaimantRecord(confirmed, () => { throw new Error(); })).toEqual(confirmed);
  });
});

 it('replays a possibly redeemed request after expiry and converges offline from durable target proof', async () => {
   let record: AuthorityTransferClaimantRecord | null = null;
   let failResponse = true;
   let failConvergence = true;
   let online = true;
   const requests: unknown[] = [];
   const receipt = { projectId: 'project-demo', recoveryLinkId: 'recovery-one', authorityGeneration: 4,
     memberId: 'member-one', personalRef: 'refs/heads/members/member-one', receiptId: 'receipt-one', recoveredAt: '2026-09-14T00:01:00.000Z' };
   const plan = { target: prepared.invitation.target, previousBindings: [{ remoteUrl: 'https://old.example/v7/projects/project-demo/repository.git', serverUrl: 'https://old.example' }],
     identity: { authorityGeneration: 4, project: { id: 'project-demo', name: 'Demo' }, eventSequence: 12,
       currentMember: { id: 'member-one', personalRef: 'refs/heads/members/member-one', displayName: 'One', role: 'member' as const } } };
   const make = () => new AuthorityTransferClaimantCoordinator({
     now: testClock({ days: 18, hours: 1 }),
     store: { load: async () => record, save: async value => { record = decodeAuthorityTransferClaimantRecord(value); },
       remove: async () => { record = null; return true; }, listProjectIds: async () => ['project-demo'] },
     target: { cloudPrincipalId: prepared.cloudPrincipalId,
       claimTransferredMembership: async () => { throw new Error('No transfer'); },
       redeemProjectRecoveryLink: async value => { if (!online) throw new Error('Offline'); requests.push(value.redemptionRequest);
         if (failResponse) { failResponse = false; throw new Error('Lost response'); } return receipt; },
       confirmProjectRecoveryBinding: async () => { if (!online) throw new Error('Offline'); return plan as never; } },
     convergence: { converge: async value => { expect(value.variant).toBe('project-recovery');
       if (failConvergence) { failConvergence = false; throw new Error('Interrupted origin write'); } } },
   });
   await expect(make().startProjectRecovery({ invitation: prepared.invitation as never, memberId: prepared.memberId,
     memberPersonalRef: prepared.memberPersonalRef, proofCredential: request.proofCredential, operationIntentId: prepared.operationIntentId })).rejects.toThrow('Lost response');
   await expect(make().resume('project-demo')).rejects.toThrow('Interrupted origin write');
   expect(requests).toEqual([request, request]);
   online = false;
   await make().resume('project-demo');
   expect(record).toBeNull();
 });
