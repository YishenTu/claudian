import type {
  CollabAuthorityTransferStatus,
  CollabMemberId,
  CollabProjectId,
  RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import {
  type AuthorityTransferRequesterEntryRecord,
  createAuthorityTransferRequesterEntry,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import type {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  LanAuthorityTransferClient,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface LanToCloudRequesterCoordinatorOptions {
  readonly client: LanAuthorityTransferClient;
  readonly memberCredential: string;
  readonly memberId: CollabMemberId;
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
  readonly persistence: AuthorityTransferPersistence;
  readonly projectId: CollabProjectId;
}

function requesterError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function sameRequest(
  left: RequestLanToCloudTransferRequest,
  right: RequestLanToCloudTransferRequest,
): boolean {
  return left.projectId === right.projectId
    && left.expectedAuthorityGeneration === right.expectedAuthorityGeneration
    && left.idempotencyKey === right.idempotencyKey
    && left.targetUrl === right.targetUrl;
}

export class LanToCloudRequesterCoordinator {
  private readonly now: () => Date;

  constructor(private readonly options: LanToCloudRequesterCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async propose(
    request: RequestLanToCloudTransferRequest,
    operationOptions: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    if (request.projectId !== this.options.projectId) {
      throw new CollabError({ code: 'project-not-found' });
    }
    const existing = await this.options.persistence.loadRequesterEntry(
      this.options.projectId,
      this.options.installationKey,
    );
    if (
      existing
      && !sameRequest(existing.request, request)
      && existing.request.idempotencyKey === request.idempotencyKey
    ) {
      throw requesterError('authority-transfer-requester-idempotency-key-reused');
    }
    if (existing?.status && !sameRequest(existing.request, request)) {
      const status = await this.options.client.requestWithMember(
        'getProjectAuthorityTransfer',
        {
          projectId: existing.projectId,
          transferId: existing.status.transferId,
        },
        this.options.memberCredential,
        operationOptions,
      );
      if (status.state !== 'cancelled') {
        throw requesterError('authority-transfer-requester-entry-conflict');
      }
      await this.options.persistence.settleRequesterCancellation(existing, status);
    }
    const submitted = await this.options.persistence.submitRequesterEntry(
      createAuthorityTransferRequesterEntry({
        installationKey: this.options.installationKey,
        proposedAt: this.now().toISOString(),
        proposedByMemberId: this.options.memberId,
        request,
      }),
    );
    if (submitted.status) return submitted.status;
    if (submitted.entryRole !== 'requester') {
      throw requesterError('authority-transfer-requester-entry-role-invalid');
    }
    const observed = await this.adoptObservedSource(submitted);
    if (observed) return observed;
    const status = await this.options.client.requestWithMember(
      'requestLanToCloudTransfer',
      submitted.request,
      this.options.memberCredential,
      operationOptions,
    );
    const completed = await this.options.persistence.completeRequesterEntry(
      submitted,
      status,
    );
    if (!completed.status) {
      throw requesterError('authority-transfer-requester-result-missing');
    }
    return completed.status;
  }

  async resume(
    operationOptions: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const entry = await this.options.persistence.loadRequesterEntry(
      this.options.projectId,
      this.options.installationKey,
    );
    if (!entry || entry.proposedByMemberId !== this.options.memberId) {
      throw requesterError('authority-transfer-requester-entry-missing');
    }
    if (entry.status) return entry.status;
    if (entry.entryRole !== 'requester') {
      throw requesterError('authority-transfer-requester-entry-role-invalid');
    }
    const observed = await this.adoptObservedSource(entry);
    if (observed) return observed;
    return this.propose(entry.request, operationOptions);
  }

  async resumeMatching(
    request: Omit<RequestLanToCloudTransferRequest, 'idempotencyKey'>,
    operationOptions: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus | null> {
    const entry = await this.options.persistence.loadRequesterEntry(
      this.options.projectId,
      this.options.installationKey,
    );
    if (
      !entry
      || entry.projectId !== request.projectId
      || entry.request.expectedAuthorityGeneration !== request.expectedAuthorityGeneration
      || entry.request.targetUrl !== request.targetUrl
    ) return null;
    if (entry.status) {
      const status = await this.options.client.requestWithMember(
        'getProjectAuthorityTransfer',
        {
          projectId: entry.projectId,
          transferId: entry.status.transferId,
        },
        this.options.memberCredential,
        operationOptions,
      );
      if (status.state === 'cancelled') {
        await this.options.persistence.settleRequesterCancellation(entry, status);
        return null;
      }
      return status;
    }
    return this.resume(operationOptions);
  }

  private async adoptObservedSource(
    entry: AuthorityTransferRequesterEntryRecord,
  ): Promise<CollabAuthorityTransferStatus | null> {
    const source = await this.options.persistence.loadObservedSourceEntry(entry.projectId);
    if (
      !source
      || source.proposedByMemberId !== entry.proposedByMemberId
      || !sameRequest(source.request, entry.request)
    ) return null;
    const completed = await this.options.persistence.completeRequesterEntry(
      entry,
      source.status,
    );
    if (!completed.status) {
      throw requesterError('authority-transfer-requester-result-missing');
    }
    return completed.status;
  }
}
