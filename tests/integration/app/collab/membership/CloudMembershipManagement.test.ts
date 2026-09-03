import assert from 'node:assert/strict';
import fs, { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_LIMITS,
  collabCloudCapabilitiesRoute,
  collabCloudCapabilityDocument,
  collabCloudErrorEnvelope,
  collabCloudProjectOperationRoute,
  collabCloudSuccessEnvelope,
  collabControlOperationCodec,
  CollabError as ProtocolError,
  type CollabManagerResponsibilityOffer,
  decodeCollabProtocolEnvelope,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { WebSocketServer } from 'ws';

import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import { decodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';

const PROJECT_ID = 'project-cloud-management';
const MEMBER_ID = 'member-manager';
const MAIN_OID = 'a'.repeat(40);

jest.setTimeout(30_000);

describe('Cloud membership management', () => {
  it('does not create a receipt when the authority returns multiple active responsibility offers', async () => {
    const fixture = await createFixture({ receiptTarget: true, multipleReceiptOffers: true });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.readSnapshot(PROJECT_ID)).resolves.toMatchObject({ status: 'success' });
      await waitUntil(() => fixture.responsibilityListings > 0);
      await expect(access(fixture.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.acknowledgements).toEqual([]);
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('automatically acknowledges responsibility after cache and membership projection, independently of a pending user mutation', async () => {
    const fixture = await createFixture({ receiptTarget: true });
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const at = fixture.invitation.createdAt;
      await client.foundation.local.projects.saveProjectDocument(PROJECT_ID, 'cloud-management-intent', {
        schemaVersion: 1, kind: 'cloud-management-intent', completionId: 'completion-prior-user-invitation', projectId: PROJECT_ID, memberId: MEMBER_ID,
        authorityGeneration: 7, serverUrl: fixture.serverUrl, phase: 'submitted', operation: 'createProjectInvitation',
        request: { projectId: PROJECT_ID, idempotencyKey: 'prior-user-invitation', expectedManagerSetGeneration: 9 }, response: null, createdAt: at, updatedAt: at,
      });
      const userIntent = await readFile(fixture.intentPath, 'utf8');
      await client.feature.readSnapshot(PROJECT_ID);
      await waitUntil(() => fixture.acknowledgements.length === 1);
      expect(fixture.acknowledgements).toHaveLength(1);
      const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'));
      expect(receipt).toMatchObject({ schemaVersion: 3, phase: 'submitted', operation: 'acknowledgeManagerResponsibility', request: {
        projectId: PROJECT_ID, offerId: 'offer-created', expectedOfferRevision: 1,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.readSnapshot(PROJECT_ID)).resolves.toMatchObject({ status: 'success', value: { source: 'online', snapshot: { currentMember: { role: 'member' } } } });
      await waitUntil(() => fixture.acknowledgements.length === 2);
      expect(fixture.acknowledgements).toEqual([receipt.request, receipt.request]);
      expect(JSON.parse(await readFile(fixture.receiptPath, 'utf8'))).toMatchObject({ phase: 'settled', offer: { state: 'acknowledged', revision: 2 } });
      expect(await readFile(fixture.intentPath, 'utf8')).toBe(userIntent);
      const firstResume = await client.feature.resumeManagementOperation(PROJECT_ID);
      expect(firstResume).toMatchObject({ status: 'recovery-required' });
      expect(fixture.requests).toHaveLength(1);
      const resumed = await client.feature.resumeManagementOperation(PROJECT_ID);
      expect(resumed).toMatchObject({
        status: 'success',
        value: {
          action: 'create-invitation',
          status: 'result-retained',
        },
      });
      if (resumed.status !== 'success') throw new Error('Expected retained management result');
      await expect(client.feature.completeManagementOperation({
        completionId: resumed.value.completionId,
        projectId: PROJECT_ID,
      })).resolves.toMatchObject({ status: 'success' });
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(fixture.receiptPath, 'utf8'))).toMatchObject({
        phase: 'settled',
        offer: { state: 'acknowledged', revision: 2 },
      });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('retains acknowledged responsibility after a post-commit rejection barrier', async () => {
    const fixture = await createFixture({
      receiptTarget: true,
      rejectAcknowledgement: true,
      rejectedAcknowledgementCommitted: true,
    });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await client.feature.readSnapshot(PROJECT_ID);
      await waitUntil(() => fixture.acknowledgements.length === 1);
      await waitForDocument(fixture.receiptPath, value => {
        const offer = value.offer;
        return value.phase === 'settled'
          && typeof offer === 'object'
          && offer !== null
          && 'state' in offer
          && offer.state === 'acknowledged';
      });
      expect(fixture.acknowledgements).toHaveLength(1);
      expect(JSON.parse(await readFile(fixture.receiptPath, 'utf8'))).toMatchObject({
        phase: 'settled',
        offer: { revision: 2, state: 'acknowledged' },
      });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('preserves a submitted responsibility receipt when rejection precedes acknowledgement', async () => {
    const fixture = await createFixture({ receiptTarget: true, rejectAcknowledgement: true });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await client.feature.readSnapshot(PROJECT_ID);
      await waitUntil(() => fixture.acknowledgements.length === 1);
      expect(fixture.acknowledgements).toHaveLength(1);
      expect(JSON.parse(await readFile(fixture.receiptPath, 'utf8'))).toMatchObject({
        phase: 'submitted',
        offer: { revision: 1, state: 'offered' },
      });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it.each(['pending', 'retained'] as const)('bounds a reissued claim by its own expiry without releasing an unknown %s operation', async state => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, memberId: 'member-imported' };
      await client.feature.reissueMemberClaim(request);
      if (state === 'retained') await client.feature.reissueMemberClaim(request);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.claim.expiresAt) + 1);
      try {
        const expectedValue = state === 'retained'
          ? { status: 'result-retained', invitation: null }
          : { status: 'pending', invitation: null };
        await expect(client.feature.readManagementOperation(PROJECT_ID)).resolves.toMatchObject({
          status: 'success', value: expectedValue,
        });
      } finally { clock.mockRestore(); }
      expect(fixture.claimReissues).toHaveLength(state === 'retained' ? 2 : 1);
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('cannot replace or dismiss an unresolved mutation with another management action', async () => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await client.feature.createInvitation(PROJECT_ID);
      const original = await readFile(fixture.intentPath, 'utf8');
      await expect(client.feature.demoteManager({ projectId: PROJECT_ID, targetMemberId: 'member-bob' })).resolves.toMatchObject({ status: 'recovery-required' });
      await expect(client.feature.completeManagementOperation({ projectId: PROJECT_ID })).resolves.toMatchObject({ status: 'failure' });
      expect(await readFile(fixture.intentPath, 'utf8')).toBe(original);
      expect(fixture.demotions).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('does not infer a claim generation or create a mutation from a hidden imported Member', async () => {
    const fixture = await createFixture({ hiddenImportedMember: true });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.listMembers(PROJECT_ID)).resolves.toMatchObject({ status: 'success', value: expect.arrayContaining([{
        memberId: 'member-imported', displayName: 'Dana', role: 'member', importedClaim: { state: 'hidden', bindingState: 'hidden' },
      }]) });
      await expect(client.feature.reissueMemberClaim({ projectId: PROJECT_ID, memberId: 'member-imported' })).resolves.toMatchObject({ status: 'failure', error: { code: 'authorization-denied' } });
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.claimReissues).toEqual([]);
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('revokes the selected imported claim with the same membership, claim and Manager-set tuple after loss', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, memberId: 'member-imported' };
      await expect(client.feature.revokeMemberClaim(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'revokeTransferredMembershipClaim', request: {
        projectId: PROJECT_ID, memberId: 'member-imported', expectedMembershipRevision: 6, expectedClaimGeneration: 3, expectedManagerSetGeneration: 9,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.revokeMemberClaim(request)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.claimRevocations).toEqual([saved.request, saved.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('reissues an imported Member claim with frozen server facts and retains its exact private descriptor after restart', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, memberId: 'member-imported' };
      await expect(client.feature.reissueMemberClaim(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'reissueTransferredMembershipClaim', request: {
        projectId: PROJECT_ID, memberId: 'member-imported', expectedMembershipRevision: 6, expectedClaimGeneration: 3, expectedManagerSetGeneration: 9,
      } });
      await client.close();
      client = fixture.client();
      const result = await client.feature.reissueMemberClaim(request);
      expect(fixture.failures).toEqual([]);
      expect(result).toEqual({ status: 'success', value: expect.anything() });
      if (result.status !== 'success') throw new Error('Expected recovered claim descriptor');
      expect(result.value.encodedInvitation).toMatch(/^claudian-cloud-claim:v1:/);
      const descriptor = JSON.parse(Buffer.from(result.value.encodedInvitation.slice('claudian-cloud-claim:v1:'.length), 'base64url').toString('utf8'));
      expect(descriptor).toEqual({ serverUrl: fixture.serverUrl, claim: fixture.claim });
      expect(fixture.claimReissues).toEqual([saved.request, saved.request]);
      expect(JSON.parse(await readFile(fixture.intentPath, 'utf8'))).toMatchObject({ phase: 'result-retained', response: fixture.claim });
      expect(await client.feature.readManagementOperation(PROJECT_ID)).toMatchObject({ status: 'success', value: {
        action: 'reissue-member-claim', status: 'result-retained', invitation: result.value,
      } });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('lists current responsibility offers without exposing revision tuples or creating an intent', async () => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.listManagerResponsibilityOffers(PROJECT_ID)).resolves.toEqual({ status: 'success', value: [{
        offerId: 'offer-created', sourceManagerMemberId: MEMBER_ID, targetMemberId: 'member-carol', purpose: 'manager-promotion',
        status: 'offered', offeredAt: fixture.invitation.createdAt, expiresAt: fixture.invitation.expiresAt,
      }] });
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.offers).toEqual([]);
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('lists authoritative members without exposing membership or imported-claim generations', async () => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.listMembers(PROJECT_ID)).resolves.toEqual({ status: 'success', value: [
        { memberId: MEMBER_ID, displayName: 'Alice', role: 'manager', importedClaim: null },
        { memberId: 'member-bob', displayName: 'Bob', role: 'manager', importedClaim: null },
        { memberId: 'member-carol', displayName: 'Carol', role: 'member', importedClaim: null },
        { memberId: 'member-imported', displayName: 'Dana', role: 'member', importedClaim: { state: 'override-active', bindingState: 'unbound' } },
      ] });
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('freezes promotion against the acknowledged offer and target membership, then replays exactly', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, targetMemberId: 'member-carol', managerResponsibilityOfferId: 'offer-acknowledged' };
      await expect(client.feature.promoteManager(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'promoteManager', request: {
        projectId: PROJECT_ID, targetMemberId: 'member-carol', managerResponsibilityOfferId: 'offer-acknowledged',
        expectedTargetMembershipRevision: 8, expectedManagerSetGeneration: 9, expectedOfferRevision: 2,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.promoteManager(request)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.promotions).toEqual([saved.request, saved.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('freezes the selected responsibility offer revision before cancellation and replays after restart', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, offerId: 'offer-created' };
      await expect(client.feature.cancelManagerResponsibilityOffer(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'cancelManagerResponsibilityOffer', request: {
        projectId: PROJECT_ID, offerId: 'offer-created', expectedOfferRevision: 1,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.cancelManagerResponsibilityOffer(request)).resolves.toMatchObject({ status: 'success', value: {
        offerId: 'offer-created', status: 'cancelled', sourceManagerMemberId: MEMBER_ID, targetMemberId: 'member-carol',
      } });
      expect(fixture.offerCancellations).toEqual([saved.request, saved.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it.each([false, true])('classifies a pre-cancelled attempt against its existing durable state (pending: %s)', async pending => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      if (pending) await client.feature.createInvitation(PROJECT_ID);
      const controller = new AbortController();
      controller.abort();
      await expect(client.feature.createInvitation(PROJECT_ID, { signal: controller.signal })).resolves.toMatchObject({
        status: pending ? 'recovery-required' : 'cancelled', durableProgress: pending,
      });
      expect(fixture.requests).toHaveLength(pending ? 1 : 0);
      const phase = await readFile(fixture.intentPath, 'utf8').then(value => JSON.parse(value).phase, error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      expect(phase).toBe(pending ? 'submitted' : null);
    } finally { await client.close(); await fixture.close(); }
  });

  it('retains the submitted request when the successful result cannot be persisted', async () => {
    let restoreRename = () => {};
    const fixture = await createFixture({ onInvitationResult: async intentPath => {
      const rename = fs.rename;
      const failure = jest.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
        if (target === intentPath) throw Object.assign(new Error('Synthetic rename failure'), { code: 'EIO' });
        await rename(source, target);
      });
      restoreRename = () => { failure.mockRestore(); };
    } });
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await client.feature.createInvitation(PROJECT_ID);
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved.phase).toBe('submitted');
      restoreRename();
      await client.close();
      client = fixture.client();
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.requests).toEqual([saved.request, saved.request, saved.request]);
      expect(fixture.failures).toEqual([]);
    } finally {
      restoreRename();
      await client.close(); await fixture.close();
    }
  });

  it('creates one responsibility offer from authoritative member facts and recovers its neutral result', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, targetMemberId: 'member-carol', purpose: 'manager-promotion' as const };
      await expect(client.feature.createManagerResponsibilityOffer(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'createManagerResponsibilityOffer', request: {
        projectId: PROJECT_ID, targetMemberId: 'member-carol', purpose: 'manager-promotion', expectedTargetMembershipRevision: 8, expectedManagerSetGeneration: 9,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.createManagerResponsibilityOffer(request)).resolves.toEqual({ status: 'success', value: {
        offerId: 'offer-created', sourceManagerMemberId: MEMBER_ID, targetMemberId: 'member-carol', purpose: 'manager-promotion',
        status: 'offered', offeredAt: fixture.invitation.createdAt, expiresAt: fixture.invitation.expiresAt,
      } });
      expect(fixture.offers).toEqual([saved.request, saved.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('resumes the exact Manager Leave successor intent through production lifecycle composition', async () => {
    const fixture = await createFixture({ managerLeaveOffer: true });
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const pendingLeaves = new CollabLifecycleJournalStore(fixture.vaultRoot).pendingLeaves;
      await pendingLeaves.save({
        authorityGeneration: 7,
        authorityKind: 'cloud',
        cleanupChoice: 'keep-files',
        cleanupMarkerNonce: 'q'.repeat(43),
        createdAt: fixture.createdAt,
        idempotencyKey: 'leave-manager-private',
        kind: 'pending-leave',
        localCleanupComplete: false,
        localRole: 'manager',
        memberId: MEMBER_ID,
        operationId: 'leave-manager-operation',
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        phase: 'queued',
        projectCreatedAt: fixture.createdAt,
        projectId: PROJECT_ID,
        projectName: 'Management',
        request: null,
        schemaVersion: 3,
        serverUrl: fixture.serverUrl,
        updatedAt: fixture.createdAt,
        workspacePath: 'Projects/management',
      });
      const request = {
        projectId: PROJECT_ID,
        purpose: 'manager-leave' as const,
        targetMemberId: 'member-carol',
      };

      await expect(client.feature.createManagerResponsibilityOffer(request)).resolves.toMatchObject({
        status: 'recovery-required',
      });
      const submitted = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(submitted).toMatchObject({
        operation: 'createManagerResponsibilityOffer',
        phase: 'submitted',
        request: { projectId: PROJECT_ID, purpose: 'manager-leave', targetMemberId: 'member-carol' },
      });

      await client.close();
      client = fixture.client();
      const resumed = await client.feature.resumeManagementOperation(PROJECT_ID);
      expect(resumed).toMatchObject({
        status: 'success',
        value: { action: 'create-manager-offer', status: 'result-retained' },
      });
      if (resumed.status !== 'success') throw new Error('Expected retained Manager Leave offer');
      await expect(client.feature.completeManagementOperation({
        completionId: resumed.value.completionId,
        projectId: PROJECT_ID,
      })).resolves.toMatchObject({ status: 'success' });

      expect(fixture.offers).toEqual([submitted.request, submitted.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(pendingLeaves.load(PROJECT_ID)).resolves.toMatchObject({ phase: 'queued' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('retains member removal across response loss without recapturing the target revision', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, memberId: 'member-bob' };
      await expect(client.feature.removeMember(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'removeMember', phase: 'submitted', request: {
        projectId: PROJECT_ID, targetMemberId: 'member-bob', expectedTargetMembershipRevision: 12, expectedManagerSetGeneration: 9,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.removeMember(request)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.removals).toEqual([saved.request, saved.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('freezes the authoritative target membership before demotion and replays it after restart', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, targetMemberId: 'member-bob' };
      await expect(client.feature.demoteManager(request)).resolves.toMatchObject({ status: 'recovery-required' });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved).toMatchObject({ operation: 'demoteManager', phase: 'submitted', request: {
        projectId: PROJECT_ID, targetMemberId: 'member-bob', expectedTargetMembershipRevision: 12, expectedManagerSetGeneration: 9,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.demoteManager(request)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.demotions).toEqual([saved.request, saved.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('preserves a rejected request when the recovery barrier is unavailable', async () => {
    const fixture = await createFixture({ staleInvitation: true, blockBarrier: true });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({ status: 'recovery-required' });
      expect(fixture.requests).toHaveLength(1);
      expect(JSON.parse(await readFile(fixture.intentPath, 'utf8'))).toMatchObject({ phase: 'submitted', request: fixture.requests[0] });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('replays the same frozen request after a completed stale rejection', async () => {
    const fixture = await createFixture({ staleInvitation: true });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({
        status: 'recovery-required',
      });
      expect(fixture.requests).toHaveLength(1);
      const submitted = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(submitted).toMatchObject({ phase: 'submitted', request: fixture.requests[0] });
      await expect(client.feature.resumeManagementOperation(PROJECT_ID)).resolves.toMatchObject({
        status: 'success',
        value: { status: 'result-retained' },
      });
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1]).toEqual(fixture.requests[0]);
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('retains a denied secret-bearing request until exact replay recovers its result', async () => {
    const fixture = await createFixture({ deniedInvitation: true });
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({
        error: { code: 'authorization-denied' },
        status: 'recovery-required',
      });
      expect(fixture.requests).toHaveLength(1);
      const submitted = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(submitted).toMatchObject({ phase: 'submitted', request: fixture.requests[0] });
      await client.close();
      client = fixture.client();
      await expect(client.feature.resumeManagementOperation(PROJECT_ID)).resolves.toMatchObject({
        status: 'success',
        value: {
          invitation: { encodedInvitation: expect.any(String) },
          status: 'result-retained',
        },
      });
      expect(fixture.requests).toEqual([submitted.request, submitted.request]);
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('reports durable recovery when cancellation follows a submitted invitation', async () => {
    const cancellation = new AbortController();
    const fixture = await createFixture({ onInvitationRequest: () => cancellation.abort() });
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const recovery = await client.feature.createInvitation(PROJECT_ID, { signal: cancellation.signal });
      expect(recovery).toMatchObject({
        status: 'recovery-required', durableProgress: true, durablePhase: 'committed',
      });
      const saved = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(saved.phase).toBe('submitted');
      expect(recovery).toMatchObject({ operationId: PROJECT_ID });
      expect(recovery).not.toMatchObject({ operationId: saved.request.idempotencyKey });
      const pending = await client.feature.readManagementOperation(PROJECT_ID);
      expect(pending).toMatchObject({ status: 'success', value: { status: 'pending' } });
      if (pending.status !== 'success' || !pending.value) throw new Error('Expected pending management operation');
      expect(pending.value).not.toHaveProperty('operationId');
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('freezes invitation revocation facts and replays the same request after response loss', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, invitationId: 'invitation-existing' };
      await expect(client.feature.revokeInvitation(request)).resolves.toMatchObject({ status: 'recovery-required', durableProgress: true });
      expect(fixture.revocations).toHaveLength(1);
      const submitted = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(submitted).toMatchObject({ phase: 'submitted', operation: 'revokeProjectInvitation', request: {
        expectedInvitationRevision: 5, expectedManagerSetGeneration: 9, invitationId: 'invitation-existing', projectId: PROJECT_ID,
      } });
      await client.close();
      client = fixture.client();
      await expect(client.feature.revokeInvitation(request)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.revocations).toEqual([submitted.request, submitted.request]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('explicitly resumes a frozen management request without rediscovering its target', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const request = { projectId: PROJECT_ID, invitationId: 'invitation-existing' };
      await expect(client.feature.revokeInvitation(request)).resolves.toMatchObject({
        durableProgress: true,
        status: 'recovery-required',
      });
      const submitted = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      await client.close();
      client = fixture.client();

      const resumed = await client.feature.resumeManagementOperation(PROJECT_ID);
      expect(resumed).toMatchObject({
        status: 'success',
        value: {
          action: 'revoke-invitation',
          invitation: null,
          status: 'result-retained',
        },
      });
      if (resumed.status !== 'success') throw new Error('Expected retained management result');
      expect(fixture.revocations).toEqual([submitted.request, submitted.request]);
      await expect(client.feature.readManagementOperation(PROJECT_ID)).resolves.toMatchObject({
        status: 'success',
        value: { action: 'revoke-invitation', status: 'result-retained' },
      });
      await expect(access(fixture.intentPath)).resolves.toBeUndefined();
      await expect(client.feature.completeManagementOperation({
        completionId: resumed.value.completionId,
        projectId: PROJECT_ID,
      }))
        .resolves.toMatchObject({ status: 'success' });
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await client.close(); await fixture.close(); }
  });

  it('lists Cloud invitations without minting secrets or exposing CAS revisions', async () => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.listInvitations(PROJECT_ID)).resolves.toEqual({
        status: 'success', value: [{ invitationId: 'invitation-existing', state: 'active', createdAt: fixture.invitation.createdAt, expiresAt: fixture.invitation.expiresAt }],
      });
      expect(fixture.requests).toEqual([]);
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await client.close(); await fixture.close(); }
  });

  it.each(['member', 'endpoint', 'generation'] as const)('preserves a retained result without exposing or settling it after %s binding drift', async drift => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await client.feature.createInvitation(PROJECT_ID);
      await client.feature.createInvitation(PROJECT_ID);
      const saved = await readFile(fixture.intentPath, 'utf8');
      const projects = client.foundation.local.projects;
      const membership = await projects.loadMembership(PROJECT_ID);
      if (!membership || !isCollabLocalCloudMembership(membership)) throw new Error('Missing Cloud membership');
      const serverUrl = drift === 'endpoint' ? `${fixture.serverUrl}/new` : fixture.serverUrl;
      await projects.saveMembership({
        ...membership,
        authority: { ...membership.authority, serverUrl, gitRemoteUrl: `${serverUrl}/v4/projects/${PROJECT_ID}/repository.git`, authorityGeneration: drift === 'generation' ? 8 : 7 },
        member: drift === 'member' ? { ...membership.member, id: 'member-other', personalRef: 'refs/heads/members/member-other' } : membership.member,
      });
      await expect(client.feature.readManagementOperation(PROJECT_ID)).resolves.toMatchObject({ status: 'failure', error: { code: 'authority-integrity-error' } });
      await expect(client.feature.completeManagementOperation({ projectId: PROJECT_ID })).resolves.toMatchObject({ status: 'failure' });
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({ status: 'failure' });
      expect(await readFile(fixture.intentPath, 'utf8')).toBe(saved);
      expect(fixture.requests).toHaveLength(2);
    } finally { await client.close(); await fixture.close(); }
  });

  it.each(['pending', 'retained'] as const)('expires a retained secret without discarding an ambiguous %s request', async state => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await client.feature.createInvitation(PROJECT_ID);
      if (state === 'retained') await client.feature.createInvitation(PROJECT_ID);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.invitation.expiresAt) + 1);
      try {
        const result = await client.feature.readManagementOperation(PROJECT_ID);
        const expectedPending = expect.objectContaining({ status: 'pending', invitation: null });
        const expectedRetained = expect.objectContaining({ status: 'result-retained', invitation: null });
        expect(result).toEqual({ status: 'success', value: state === 'retained' ? expectedRetained : expectedPending });
      } finally { clock.mockRestore(); }
      expect(fixture.requests).toHaveLength(state === 'retained' ? 2 : 1);
      const present = await access(fixture.intentPath).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      });
      expect(present).toBe(true);
    } finally { await client.close(); await fixture.close(); }
  });

  it('reads without creating an invitation and releases only the exact copied or dismissed result', async () => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      await expect(client.feature.readManagementOperation(PROJECT_ID)).resolves.toEqual({ status: 'success', value: null });
      expect(fixture.requests).toEqual([]);
      await client.feature.createInvitation(PROJECT_ID);
      await client.feature.createInvitation(PROJECT_ID);
      const state = await client.feature.readManagementOperation(PROJECT_ID);
      expect(state.status).toBe('success');
      if (state.status !== 'success' || !state.value) throw new Error('Expected retained result');
      expect(state.value).toMatchObject({ action: 'create-invitation', status: 'result-retained', invitation: { expiresAt: fixture.invitation.expiresAt } });
      expect(state.value).not.toHaveProperty('operationId');
      await expect(access(fixture.intentPath)).resolves.toBeUndefined();
      await expect(client.feature.completeManagementOperation({
        completionId: state.value.completionId,
        projectId: PROJECT_ID,
      }))
        .resolves.toMatchObject({ status: 'success' });
      await expect(access(fixture.intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.requests).toHaveLength(2);
      await expect(client.feature.createInvitation(PROJECT_ID)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.requests[2]).not.toEqual(fixture.requests[0]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('serializes simultaneous invitation choices into one durable request', async () => {
    const fixture = await createFixture();
    const client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const results = await Promise.all([
        client.feature.createInvitation(PROJECT_ID), client.feature.createInvitation(PROJECT_ID),
      ]);
      expect(fixture.failures).toEqual([]);
      expect(results.map(result => result.status)).toContain('success');
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[0]).toEqual(fixture.requests[1]);
    } finally { await client.close(); await fixture.close(); }
  });

  it('retains the exact invitation request before a lost reply and replays it after restart', async () => {
    const fixture = await createFixture();
    let client = fixture.client();
    try {
      await fixture.seed(client.foundation);
      const first = await client.feature.createInvitation(PROJECT_ID);
      expect(first.status).not.toBe('success');
      expect(fixture.failures).toEqual([]);
      expect(fixture.requests).toHaveLength(1);
      const submitted = JSON.parse(await readFile(fixture.intentPath, 'utf8'));
      expect(submitted).toMatchObject({
        phase: 'submitted', projectId: PROJECT_ID, request: fixture.requests[0],
      });
      await client.close();
      client = fixture.client();
      const resumed = await client.feature.createInvitation(PROJECT_ID);
      expect(resumed.status).toBe('success');
      if (resumed.status !== 'success') throw new Error('Expected recovered invitation');
      expect(fixture.requests).toEqual([submitted.request, submitted.request]);
      expect(decodeCloudProjectInvitation(resumed.value.encodedInvitation)).toEqual({
        kind: 'cloud-invitation', invitation: fixture.invitation, serverUrl: fixture.serverUrl,
      });
      expect(JSON.parse(await readFile(fixture.intentPath, 'utf8'))).toMatchObject({
        phase: 'result-retained', request: submitted.request, response: fixture.invitation,
      });
      expect(fixture.failures).toEqual([]);
    } finally { await client.close(); await fixture.close(); }
  });
});

async function createFixture(options: { onInvitationRequest?: () => void; onInvitationResult?: (intentPath: string) => Promise<void>; staleInvitation?: boolean; deniedInvitation?: boolean; blockBarrier?: boolean; hiddenImportedMember?: boolean; receiptTarget?: boolean; rejectAcknowledgement?: boolean; rejectedAcknowledgementCommitted?: boolean; multipleReceiptOffers?: boolean; managerLeaveOffer?: boolean } = {}) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-management-'));
  const createdAt = new Date().toISOString();
  const invitation = {
    createdAt, expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
    invitationId: 'invitation-created', issuedState: 'active', projectId: PROJECT_ID,
    secret: 'A'.repeat(43), secretReplayExpiresAt: new Date(Date.parse(createdAt) + 2_592_000_000).toISOString(),
  };
  const claim = {
    claim: `${'B'.repeat(42)}A`, claimGeneration: 4, createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 2_592_000_000).toISOString(), memberId: 'member-imported', projectId: PROJECT_ID,
    secretReplayExpiresAt: new Date(Date.parse(createdAt) + 2_592_000_000).toISOString(), targetAuthorityGeneration: 7, transferId: 'transfer-imported',
  };
  const memberRole: 'manager' | 'member' = options.receiptTarget ? 'member' : 'manager';
  const member = {
    activatedAt: createdAt, createdAt, displayName: 'Alice', id: MEMBER_ID,
    personalRef: `refs/heads/members/${MEMBER_ID}`, role: memberRole, status: 'active',
  };
  const offered: CollabManagerResponsibilityOffer = {
    acknowledgedAt: null, expiresAt: invitation.expiresAt, managerSetGenerationAtOffer: 9, offeredAt: createdAt,
    offerId: 'offer-created', purpose: options.managerLeaveOffer ? 'manager-leave' : 'manager-promotion', revision: 1, sourceManagerMemberId: options.receiptTarget ? 'member-bob' : MEMBER_ID,
    state: 'offered', targetMemberId: options.receiptTarget ? MEMBER_ID : 'member-carol', targetMembershipRevisionAtOffer: options.receiptTarget ? 4 : 8, terminalAt: null,
  };
  const snapshot = {
    currentMember: member, eventSequence: 7, members: [member], openRequests: [], openTicketCount: 0,
    project: { authorityGeneration: 7, createdAt, expectedMainOid: MAIN_OID, id: PROJECT_ID, mainRef: 'refs/heads/main', name: 'Management' },
    ticketHighlights: [],
  };
  const requests: unknown[] = [];
  let managerSetGeneration = 9;
  let currentRole: 'manager' | 'member' = memberRole;
  const revocations: unknown[] = [];
  const demotions: unknown[] = [];
  const removals: unknown[] = [];
  const offers: unknown[] = [];
  const offerCancellations: unknown[] = [];
  const promotions: unknown[] = [];
  const claimReissues: unknown[] = [];
  const claimRevocations: unknown[] = [];
  const acknowledgements: unknown[] = [];
  let responsibilityListings = 0;
  let responsibilityOffer: CollabManagerResponsibilityOffer = offered;
  const failures: unknown[] = [];
  const intentPath = path.join(vaultRoot, '.claudian/collab/projects', PROJECT_ID, 'cloud-management-intent.json');
  const receiptPath = path.join(path.dirname(intentPath), 'manager-responsibility-receipt.json');
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers['x-claudian-development-actor'], undefined);
      assert.ok(request.url && request.url.startsWith('/operator/cloud/'));
      const target = request.url.slice('/operator/cloud'.length);
      response.setHeader('content-type', 'application/json');
      if (target === collabCloudCapabilitiesRoute().target) {
        response.end(JSON.stringify(collabCloudCapabilityDocument([
          'project-snapshot', 'project-events', 'cloud-project-invitations', 'cloud-project-membership', 'cloud-project-manager-responsibility', 'cloud-imported-membership-claims',
        ], {
          maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
          maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
          maxCheckpointRepositoryBundleBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
          maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
          maxDevelopmentBootstrapGitBundleBytes: 1_024, maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
          maxDevelopmentBootstrapReportUtf8Bytes: 1_024, maxEventReplay: 100, maxGitReceivePackBytes: 1_024,
          maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes, maxRepositoryBytes: 1_048_576,
        })));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = decodeCollabProtocolEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(envelope.status, 'ok');
      if (envelope.status !== 'ok') throw new Error('Invalid fixture request');
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'getProjectSnapshot').target) {
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          ...snapshot,
          currentMember: { ...snapshot.currentMember, role: currentRole },
          members: snapshot.members.map(snapshotMember => snapshotMember.id === MEMBER_ID
            ? { ...snapshotMember, role: currentRole }
            : snapshotMember),
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'listProjectMembers').target) {
        if (managerSetGeneration === 10 && options.blockBarrier) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          managerSetGeneration, projectId: PROJECT_ID,
          members: [{ bindingState: 'bound', displayName: 'Alice', importedClaimGeneration: null,
            importedClaimState: 'not-applicable', memberId: MEMBER_ID, membershipRevision: 4, role: currentRole },
          { bindingState: 'bound', displayName: 'Bob', importedClaimGeneration: null,
            importedClaimState: 'not-applicable', memberId: 'member-bob', membershipRevision: 12, role: 'manager' },
          { bindingState: 'bound', displayName: 'Carol', importedClaimGeneration: null,
            importedClaimState: 'not-applicable', memberId: 'member-carol', membershipRevision: 8, role: 'member' },
          { bindingState: options.hiddenImportedMember ? 'hidden' : 'unbound', displayName: 'Dana', importedClaimGeneration: options.hiddenImportedMember ? null : 3,
            importedClaimState: options.hiddenImportedMember ? 'hidden' : 'override-active', memberId: 'member-imported', membershipRevision: 6, role: 'member' }],
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'listProjectInvitations').target) {
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          managerSetGeneration: 9, projectId: PROJECT_ID,
          invitations: [{ createdAt, expiresAt: invitation.expiresAt, invitationId: 'invitation-existing', revision: 5, state: 'active', terminalAt: null }],
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'acknowledgeManagerResponsibility').target) {
        const decoded = collabControlOperationCodec('acknowledgeManagerResponsibility').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
        assert.equal(receipt.phase, 'submitted');
        assert.deepEqual(receipt.request, decoded.value);
        const cache = JSON.parse(await readFile(path.join(path.dirname(intentPath), 'cache.json'), 'utf8'));
        const membership = JSON.parse(await readFile(path.join(path.dirname(intentPath), 'membership.json'), 'utf8'));
        assert.equal(cache.snapshot.currentMember.role, 'member');
        assert.equal(membership.member.role, 'member');
        assert.equal(membership.lastEventSequence, 7);
        acknowledgements.push(decoded.value);
        if (acknowledgements.length === 1 && options.rejectAcknowledgement) {
          if (options.rejectedAcknowledgementCommitted) {
            responsibilityOffer = {
              ...offered,
              acknowledgedAt: createdAt,
              revision: 2,
              state: 'acknowledged',
            };
          }
          response.writeHead(403).end(JSON.stringify(collabCloudErrorEnvelope(
            envelope.value.requestId,
            new ProtocolError({ code: 'authorization-denied' }),
          )));
          return;
        }
        if (acknowledgements.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, { offer: { ...offered, acknowledgedAt: createdAt, state: 'acknowledged', revision: 2 } })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'revokeTransferredMembershipClaim').target) {
        const decoded = collabControlOperationCodec('revokeTransferredMembershipClaim').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        claimRevocations.push(decoded.value);
        if (claimRevocations.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          claimGeneration: 4, memberId: 'member-imported', projectId: PROJECT_ID, revokedAt: createdAt, state: 'revoked',
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'reissueTransferredMembershipClaim').target) {
        const decoded = collabControlOperationCodec('reissueTransferredMembershipClaim').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        claimReissues.push(decoded.value);
        if (claimReissues.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, claim)));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'listCurrentManagerResponsibilityOffers').target) {
        responsibilityListings += 1;
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          offers: options.multipleReceiptOffers
            ? [responsibilityOffer, { ...responsibilityOffer, offerId: 'offer-second' }]
            : [responsibilityOffer],
          projectId: PROJECT_ID,
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'getManagerResponsibilityOffer').target) {
        const decoded = collabControlOperationCodec('getManagerResponsibilityOffer').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const offer = decoded.value.offerId === 'offer-acknowledged'
          ? { ...offered, offerId: 'offer-acknowledged', acknowledgedAt: createdAt, state: 'acknowledged', revision: 2 }
          : offered;
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, { offer })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'promoteManager').target) {
        const decoded = collabControlOperationCodec('promoteManager').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        promotions.push(decoded.value);
        if (promotions.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          managerSetGeneration: 10, membershipRevision: 9, offerRevision: 3, projectId: PROJECT_ID, promotedMemberId: 'member-carol',
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'cancelManagerResponsibilityOffer').target) {
        const decoded = collabControlOperationCodec('cancelManagerResponsibilityOffer').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        offerCancellations.push(decoded.value);
        if (offerCancellations.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, { offer: {
          ...offered, revision: 2, state: 'cancelled', terminalAt: createdAt,
        } })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'createManagerResponsibilityOffer').target) {
        const decoded = collabControlOperationCodec('createManagerResponsibilityOffer').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        offers.push(decoded.value);
        if (offers.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, { offer: offered })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'removeMember').target) {
        const decoded = collabControlOperationCodec('removeMember').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        removals.push(decoded.value);
        if (removals.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          discardedRequestId: null, managerSetGeneration: 10, memberId: 'member-bob', projectId: PROJECT_ID,
          removedAt: new Date().toISOString(), status: 'revoked',
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'demoteManager').target) {
        const decoded = collabControlOperationCodec('demoteManager').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        demotions.push(decoded.value);
        if (demotions.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          demotedMemberId: 'member-bob', managerSetGeneration: 10, membershipRevision: 13, projectId: PROJECT_ID,
        })));
        return;
      }
      if (target === collabCloudProjectOperationRoute(PROJECT_ID, 'revokeProjectInvitation').target) {
        const decoded = collabControlOperationCodec('revokeProjectInvitation').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        assert.equal(decoded.value.expectedManagerSetGeneration, 9);
        assert.equal(decoded.value.expectedInvitationRevision, 5);
        assert.equal(decoded.value.invitationId, 'invitation-existing');
        const saved = JSON.parse(await readFile(intentPath, 'utf8'));
        assert.equal(saved.phase, 'submitted');
        assert.deepEqual(saved.request, decoded.value);
        revocations.push(decoded.value);
        if (revocations.length === 1) { request.socket.destroy(); return; }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          invitationId: 'invitation-existing', projectId: PROJECT_ID, revision: 6, revokedAt: new Date().toISOString(), state: 'revoked',
        })));
        return;
      }
      assert.equal(target, collabCloudProjectOperationRoute(PROJECT_ID, 'createProjectInvitation').target);
      const decoded = collabControlOperationCodec('createProjectInvitation').decodeRequest(envelope.value.data);
      if (decoded.status !== 'ok') throw decoded.error;
      if (requests.length === 0) {
        assert.equal(decoded.value.expectedManagerSetGeneration, managerSetGeneration);
      }
      const saved = JSON.parse(await readFile(intentPath, 'utf8'));
      assert.equal(saved.phase, 'submitted');
      assert.deepEqual(saved.request, decoded.value);
      requests.push(decoded.value);
      options.onInvitationRequest?.();
      if (requests.length === 1 && options.deniedInvitation) {
        currentRole = 'member';
        managerSetGeneration = 10;
        response.writeHead(403).end(JSON.stringify(collabCloudErrorEnvelope(
          envelope.value.requestId,
          new ProtocolError({ code: 'authorization-denied' }),
        )));
        return;
      }
      if (requests.length === 1 && options.staleInvitation) {
        managerSetGeneration = 10;
        response.writeHead(409).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId,
          new ProtocolError({ code: 'authority-not-synchronized' }))));
        return;
      }
      if (requests.length === 1) { request.socket.destroy(); return; }
      if (requests.length === 2) await options.onInvitationResult?.(intentPath);
      response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, invitation)));
    })().catch(error => { failures.push(error); response.writeHead(500).end(); });
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const serverUrl = `http://127.0.0.1:${address.port}/operator/cloud`;
  return {
    failures, intentPath, receiptPath, invitation, requests, revocations, demotions, removals, offers, offerCancellations, promotions, claimReissues, claimRevocations, acknowledgements, claim, serverUrl, createdAt, vaultRoot,
    get responsibilityListings() { return responsibilityListings; },
    client: () => {
      const foundation = new ClaudianCollabService({ getConfiguredGitPath: () => '', installationKey: TEST_INSTALLATION_A, obsidianConfigDirectory: '.obsidian', vaultRoot });
      const projectSetup = new CollabProjectSetupService(foundation, { installationKey: TEST_INSTALLATION_A, vaultRoot });
      const feature = createCollabFeatureSubcomposition({ cloudAuthority: new CloudAuthorityAdapter(), foundation, projectSetup, vaultRoot }).feature;
      return { foundation, feature, close: async () => { await feature.close(); await foundation.close(); } };
    },
    seed: async (foundation: ClaudianCollabService) => {
      await foundation.local.projects.saveMembership({
        schemaVersion: 3, createdAt, updatedAt: createdAt, lastEventSequence: options.receiptTarget ? 0 : 7,
        authority: { authorityGeneration: 7, bindingVersion: 4, gitRemoteUrl: `${serverUrl}/v4/projects/${PROJECT_ID}/repository.git`, kind: 'cloud', serverUrl, wireVersion: 8 },
        member: { id: MEMBER_ID, displayName: 'Alice', role: 'manager', personalRef: member.personalRef },
        project: { id: PROJECT_ID, name: 'Management', workspacePath: 'Projects/management' },
      });
      await foundation.local.projects.upsertProject({ authorityKind: 'cloud', createdAt, id: PROJECT_ID, name: 'Management', updatedAt: createdAt, workspacePath: 'Projects/management' });
    },
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(vaultRoot, { recursive: true, force: true });
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fixture state');
}

async function waitForDocument(
  documentPath: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(documentPath, 'utf8')) as Record<string, unknown>;
      if (predicate(value)) return;
    } catch {
      // The lifecycle transition may not have created its document yet.
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fixture document');
}
