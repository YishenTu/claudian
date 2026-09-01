import { randomUUID } from 'node:crypto';

import type { CollabManagerResponsibilityOffer, CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian-collab/protocol';

import { type CollabLocalProjectRepository, isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { type CloudManagerResponsibilityReceiptRecord, decodeCloudManagerResponsibilityReceiptRecord, type ManagerResponsibilityReceiptState, managerResponsibilityReceiptState } from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import type { CollabAuthorityMembershipRouterPort } from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import { type CollabCloudProjectSnapshot, type CollabLanProjectSnapshot, type CollabManagerResponsibilityOfferSummary, type CollabOperationOptions, type CollabProjectSnapshot, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabMembershipPendingLeavePort {
  load(projectId: CollabProjectId): Promise<unknown>;
}

export interface CollabMembershipManagerReceiptPort {
  load(projectId: CollabProjectId): Promise<ManagerResponsibilityReceiptState | CloudManagerResponsibilityReceiptRecord | null>;
  saveCloud(record: CloudManagerResponsibilityReceiptRecord): Promise<void>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(
    projectId: CollabProjectId,
    summary: CollabManagerResponsibilityOfferSummary,
  ): Promise<void>;
}

interface ManagerResponsibilityReconciliationRequest {
  readonly memberId: CollabMemberId;
  readonly offerId: CollabOperationId;
  readonly projectId: CollabProjectId;
}

interface ManagerResponsibilityContext {
  readonly projects: CollabLocalProjectRepository;
  readonly control: CollabAuthorityMembershipRouterPort;
  readonly managerReceipts: CollabMembershipManagerReceiptPort;
  readonly pendingLeaves: CollabMembershipPendingLeavePort;
}



export interface ManagerResponsibilityOperationPort {
  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
}

export class ManagerResponsibilityOperationCoordinator
implements ManagerResponsibilityOperationPort {
  private readonly tails = new Map<CollabProjectId, Promise<void>>();

  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    const pending = previous.then(operation);
    const tail = pending.then(() => undefined, () => undefined);
    this.tails.set(projectId, tail);
    void tail.then(() => {
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    });
    return pending;
  }

  private async acknowledgeManagerResponsibilityUnlocked(
    request: ManagerResponsibilityReconciliationRequest,
    context: ManagerResponsibilityContext,
    options: CollabOperationOptions,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    if (await context.pendingLeaves.load(request.projectId)) {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-target-leaving' },
      });
    }
    const offered = await context.control.membership('getManagerResponsibilityOffer', {
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
    if (offered.targetMemberId !== request.memberId) {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-offer-not-acknowledgeable' },
      });
    }
    await context.managerReceipts.save(request.projectId, offered);
    if (offered.status === 'acknowledged') return offered;
    if (offered.status !== 'offered') {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-offer-not-acknowledgeable' },
      });
    }
    const acknowledged = await context.control.membership('acknowledgeManagerResponsibility', {
      idempotencyKey: `manager-ack-${request.offerId}`,
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
    await context.managerReceipts.save(request.projectId, acknowledged);
    return acknowledged;
  }

  reconcileSnapshot(
    snapshot: CollabProjectSnapshot,
    context: ManagerResponsibilityContext,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    return this.run(snapshot.project.id, () => (
      this.reconcileManagerResponsibilitySnapshotUnlocked(snapshot, context, options)
    ));
  }

  private async reconcileManagerResponsibilitySnapshotUnlocked(
    snapshot: CollabProjectSnapshot,
    context: ManagerResponsibilityContext,
    options: CollabOperationOptions,
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    if (!isCollabLanProjectSnapshot(snapshot)) {
      await this.reconcileCloudSnapshot(snapshot, context, options);
      return null;
    }
    const lanSnapshot: CollabLanProjectSnapshot = snapshot;
    const offer = lanSnapshot.managerResponsibilityOffer;
    if (
      !offer
      || offer.targetMemberId !== snapshot.currentMember.id
      || (offer.status !== 'offered' && offer.status !== 'acknowledged')
    ) {
      await context.managerReceipts.remove(snapshot.project.id);
      return null;
    }
    const receipt = await context.managerReceipts.load(snapshot.project.id);
    if (receipt && 'offer' in receipt) throw new CollabError({ code: 'authority-integrity-error' });
    if (receipt && managerResponsibilityReceiptState(receipt).offerId !== offer.offerId) {
      await context.managerReceipts.remove(snapshot.project.id);
    }
    if (offer.status === 'acknowledged') {
      await context.managerReceipts.save(snapshot.project.id, offer);
      return offer;
    }
    if (await context.pendingLeaves.load(snapshot.project.id)) {
      const declined = await this.declineManagerResponsibilityUnlocked({
        memberId: snapshot.currentMember.id,
        offerId: offer.offerId,
        projectId: snapshot.project.id,
      }, context, options);
      await context.managerReceipts.remove(snapshot.project.id);
      return declined;
    }
    return this.acknowledgeManagerResponsibilityUnlocked({
      memberId: snapshot.currentMember.id,
      offerId: offer.offerId,
      projectId: snapshot.project.id,
    }, context, options);
  }

  private async declineManagerResponsibilityUnlocked(
    request: ManagerResponsibilityReconciliationRequest,
    context: ManagerResponsibilityContext,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const summary = await context.control.membership('declineManagerResponsibility', {
      idempotencyKey: `manager-decline-${request.offerId}`,
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
    await context.managerReceipts.save(request.projectId, summary);
    return summary;
  }

  private async reconcileCloudSnapshot(snapshot: CollabCloudProjectSnapshot, context: ManagerResponsibilityContext, options: CollabOperationOptions): Promise<void> {
    const projectId = snapshot.project.id;
    const membership = await context.projects.loadMembership(projectId);
    if (!membership || !isCollabLocalCloudMembership(membership) || membership.member.id !== snapshot.currentMember.id
      || membership.authority.authorityGeneration !== snapshot.project.authorityGeneration) throw new CollabError({ code: 'authority-integrity-error' });
    const binding = { projectId, memberId: membership.member.id, serverUrl: membership.authority.serverUrl, authorityGeneration: membership.authority.authorityGeneration };
    const existing = await context.managerReceipts.load(projectId);
    if (existing && !('offer' in existing)) throw new CollabError({ code: 'authority-integrity-error' });
    let receipt = existing;
    if (receipt && (receipt.projectId !== projectId || receipt.memberId !== binding.memberId || receipt.serverUrl !== binding.serverUrl
      || receipt.authorityGeneration !== binding.authorityGeneration)) throw new CollabError({ code: 'authority-integrity-error' });
    if (!receipt) {
      const listed = await context.control.cloudMembership('listCurrentManagerResponsibilityOffers', { projectId }, binding, options);
      if (listed.projectId !== projectId) throw new CollabError({ code: 'authority-integrity-error' });
      const candidates = listed.offers.filter(offer => offer.targetMemberId === binding.memberId && (offer.state === 'offered' || offer.state === 'acknowledged'));
      if (candidates.length > 1) throw new CollabError({ code: 'authority-integrity-error' });
      const offer = candidates[0];
      if (!offer) return;
      const operation = offer.state === 'acknowledged' ? null : 'acknowledgeManagerResponsibility';
      receipt = decodeCloudManagerResponsibilityReceiptRecord({
        ...binding, schemaVersion: 3, kind: 'manager-responsibility-receipt', offer, operation,
        request: operation === null ? null : { projectId, offerId: offer.offerId, expectedOfferRevision: offer.revision, idempotencyKey: `manager-ack-${randomUUID().replaceAll('-', '')}` },
        phase: operation === null ? 'settled' : 'prepared', updatedAt: new Date().toISOString(),
      });
      await context.managerReceipts.saveCloud(receipt);
    } else if (receipt.phase === 'settled') {
      const { offer } = await context.control.cloudMembership('getManagerResponsibilityOffer', { projectId, offerId: receipt.offer.offerId }, binding, options);
      if (offer.offerId !== receipt.offer.offerId || offer.targetMemberId !== binding.memberId || offer.sourceManagerMemberId !== receipt.offer.sourceManagerMemberId) {
        throw new CollabError({ code: 'authority-integrity-error' });
      }
      if (offer.state !== 'offered' && offer.state !== 'acknowledged') {
        await context.managerReceipts.remove(projectId);
        return;
      }
      if (offer.state !== 'acknowledged') throw new CollabError({ code: 'authority-integrity-error' });
      receipt = decodeCloudManagerResponsibilityReceiptRecord({ ...receipt, offer, updatedAt: new Date().toISOString() });
      await context.managerReceipts.saveCloud(receipt);
    }
    if (receipt.phase === 'settled') return;
    if (receipt.phase === 'prepared' && (membership.lifecycle === 'leaving' || await context.pendingLeaves.load(projectId))) {
      receipt = decodeCloudManagerResponsibilityReceiptRecord({ ...receipt, operation: 'declineManagerResponsibility',
        request: { projectId, offerId: receipt.offer.offerId, expectedOfferRevision: receipt.offer.revision, idempotencyKey: `manager-decline-${randomUUID().replaceAll('-', '')}` } });
      await context.managerReceipts.saveCloud(receipt);
    }
    receipt = { ...receipt, phase: 'submitted', updatedAt: new Date().toISOString() };
    await context.managerReceipts.saveCloud(receipt);
    const operation = receipt.operation;
    const request = receipt.request;
    if (!operation || !request) throw new CollabError({ code: 'authority-integrity-error' });
    const submittedReceipt = receipt;
    let offer: CollabManagerResponsibilityOffer;
    try {
      ({ offer } = await context.control.cloudMembership(
        operation,
        request,
        submittedReceipt,
        options,
      ));
    } catch (error) {
      if (!(error instanceof CloudAuthorityRejection)) throw error;
      const listed = await context.control.cloudMembership(
        'listCurrentManagerResponsibilityOffers',
        { projectId },
        binding,
        options,
      );
      if (listed.projectId !== projectId) {
        throw new CollabError({ code: 'authority-integrity-error' });
      }
      const matching = listed.offers.filter(offer => (
        offer.offerId === submittedReceipt.offer.offerId
      ));
      if (
        matching.length > 1
        || (matching[0] && (
          matching[0].sourceManagerMemberId !== submittedReceipt.offer.sourceManagerMemberId
          || matching[0].targetMemberId !== submittedReceipt.offer.targetMemberId
          || matching[0].purpose !== submittedReceipt.offer.purpose
        ))
      ) {
        throw new CollabError({ code: 'authority-integrity-error' });
      }
      const recovered = matching[0];
      if (!recovered) {
        await context.managerReceipts.remove(projectId);
        throw error;
      }
      if (
        operation !== 'acknowledgeManagerResponsibility'
        || recovered.state !== 'acknowledged'
      ) throw error;
      offer = recovered;
    }
    if (offer.offerId !== submittedReceipt.offer.offerId || offer.targetMemberId !== submittedReceipt.memberId || offer.sourceManagerMemberId !== submittedReceipt.offer.sourceManagerMemberId
      || offer.purpose !== submittedReceipt.offer.purpose || offer.revision !== request.expectedOfferRevision + 1
      || offer.state !== (operation === 'acknowledgeManagerResponsibility' ? 'acknowledged' : 'declined')) {
      throw new CollabError({ code: 'authority-integrity-error' });
    }
    receipt = decodeCloudManagerResponsibilityReceiptRecord({ ...submittedReceipt, phase: 'settled', offer, updatedAt: new Date().toISOString() });
    await context.managerReceipts.saveCloud(receipt);
    if (offer.state === 'declined') await context.managerReceipts.remove(projectId);
  }


}
