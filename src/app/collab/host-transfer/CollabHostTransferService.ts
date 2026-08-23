import { randomUUID } from 'node:crypto';

import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import type { HostTransferRecoveryStorePort } from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  hostTransferAcceptanceIdempotencyKey,
} from '@/app/collab/host-transfer/HostTransferOperationIdentity';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type {
  IncomingHostTransferCoordinator,
} from '@/app/collab/host-transfer/IncomingHostTransferCoordinator';
import type { HostTransferControlClient } from '@/app/collab/lan/HostTransferControlClient';
import { type CollabCoordinationSnapshot, type CollabCreateHostTransferRequest, type CollabHostTransferIntentRequest, type CollabLanProjectSnapshot, type CollabOperationOptions, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type IncomingCoordinator = Pick<IncomingHostTransferCoordinator, 'accept' | 'close' | 'resume'>;

interface IncomingCoordinatorEntry {
  readonly authorityIdentity: string;
  readonly coordinator: Promise<IncomingCoordinator>;
}

type LanCoordinationSnapshot = Omit<CollabCoordinationSnapshot, 'snapshot'> & {
  readonly snapshot: CollabLanProjectSnapshot;
};

export interface CollabHostTransferServiceOptions {
  readonly createControlClient: (
    membership: CollabLocalLanMembershipRecord,
  ) => Pick<HostTransferControlClient, 'cancel' | 'create' | 'decline'>;
  readonly createIdempotencyKey?: (kind: string) => string;
  readonly createIncomingCoordinator: (
    membership: CollabLocalLanMembershipRecord,
  ) => Promise<IncomingCoordinator> | IncomingCoordinator;
  readonly projects: Pick<
    CollabLocalProjectRepository,
    'loadIndex' | 'loadMembership'
  >;
  readonly recovery: Pick<HostTransferRecoveryStorePort, 'load'>;
  readonly resumeOutgoing?: (projectId: CollabProjectId) => Promise<void>;
  readonly resumeCompletedOutgoing?: (record: HostTransferRecoveryRecord) => Promise<void>;
  readonly snapshots: {
    readCoordinationSnapshot(
      projectId: CollabProjectId,
      options?: CollabOperationOptions,
    ): Promise<CollabCoordinationSnapshot>;
  };
}

function serviceError(reason: string, code: 'authorization-denied' | 'host-stopped' | 'project-not-found' = 'project-not-found') {
  return new CollabError({ code, recoveryActions: ['retry'], safeContext: { reason } });
}

export class CollabHostTransferService {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly createIdempotencyKey: (kind: string) => string;
  private readonly incomingCoordinators = new Map<CollabProjectId, IncomingCoordinatorEntry>();

  constructor(private readonly options: CollabHostTransferServiceOptions) {
    this.createIdempotencyKey = options.createIdempotencyKey
      ?? (kind => `${kind}-${randomUUID().replaceAll('-', '')}`);
  }

  async createHostTransfer(
    request: CollabCreateHostTransferRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const { coordination, membership } = await this.session(request.projectId, options);
    await this.options.createControlClient(membership).create({
      memberCredential: membership.member.credential,
      request: {
        expectedHostMemberId: coordination.snapshot.project.hostMemberId,
        idempotencyKey: this.createIdempotencyKey('create-host-transfer'),
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async acceptHostTransfer(
    request: CollabHostTransferIntentRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const { coordination, membership } = await this.session(request.projectId, options);
    const transfer = coordination.snapshot.hostTransfer;
    const acceptedRecovery = transfer?.phase === 'accepted'
      ? await this.options.recovery.load(request.projectId, 'incoming')
      : null;
    const canReplayAccepted = acceptedRecovery?.direction === 'incoming'
      && acceptedRecovery.phase === 'accepted'
      && acceptedRecovery.transferId === request.transferId
      && acceptedRecovery.sourceHostMemberId === coordination.snapshot.project.hostMemberId
      && acceptedRecovery.targetHostMemberId === membership.member.id;
    if (
      !transfer
      || transfer.transferId !== request.transferId
      || transfer.targetMemberId !== membership.member.id
      || (!transfer.canAccept && !canReplayAccepted)
    ) throw serviceError('host-transfer-acceptance-not-current', 'authorization-denied');
    await (await this.incomingCoordinator(membership)).accept({
      idempotencyKey: this.acceptanceIdempotencyKey(
        request.projectId,
        request.transferId,
        membership.member.id,
      ),
      projectId: request.projectId,
      sourceHostMemberId: coordination.snapshot.project.hostMemberId,
      targetHostMemberId: membership.member.id,
      transferId: request.transferId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  private acceptanceIdempotencyKey(
    projectId: CollabProjectId,
    transferId: string,
    targetMemberId: string,
  ): string {
    return hostTransferAcceptanceIdempotencyKey(projectId, transferId, targetMemberId);
  }

  async declineHostTransfer(
    request: CollabHostTransferIntentRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const { membership } = await this.session(request.projectId, options);
    await this.options.createControlClient(membership).decline({
      memberCredential: membership.member.credential,
      request: {
        expectedTargetMemberId: membership.member.id,
        idempotencyKey: this.createIdempotencyKey('decline-host-transfer'),
        projectId: request.projectId,
        transferId: request.transferId,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async cancelHostTransfer(
    request: CollabHostTransferIntentRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const { coordination, membership } = await this.session(request.projectId, options);
    await this.options.createControlClient(membership).cancel({
      memberCredential: membership.member.credential,
      request: {
        expectedHostMemberId: coordination.snapshot.project.hostMemberId,
        idempotencyKey: this.createIdempotencyKey('cancel-host-transfer'),
        projectId: request.projectId,
        transferId: request.transferId,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async resume(options: CollabOperationOptions = {}): Promise<void> {
    this.assertOpen();
    const index = await this.options.projects.loadIndex();
    let firstError: unknown;
    for (const project of index.projects) {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      try {
        const record = await this.options.recovery.load(project.id, 'outgoing')
          ?? await this.options.recovery.load(project.id, 'incoming');
        if (!record) continue;
        if (record.direction === 'outgoing') {
          if (
            record.phase === 'completed'
            && record.targetTerminalResponseReceived
            && this.options.resumeCompletedOutgoing
          ) {
            await this.options.resumeCompletedOutgoing(record);
            continue;
          }
          await this.options.resumeOutgoing?.(project.id);
          continue;
        }
        const membership = await this.requireMembership(project.id);
        const incoming = await this.incomingCoordinator(membership);
        if (options.signal) await incoming.resume(project.id, options.signal);
        else await incoming.resume(project.id);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError) throw serviceError('host-transfer-recovery-failed');
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const coordinators = [...this.incomingCoordinators.values()];
    this.incomingCoordinators.clear();
    this.closePromise = Promise.allSettled(coordinators.map(async entry => {
      const coordinator = await entry.coordinator;
      await coordinator.close();
    })).then(() => undefined);
    return this.closePromise;
  }

  private incomingCoordinator(
    membership: CollabLocalLanMembershipRecord,
  ): Promise<IncomingCoordinator> {
    this.assertOpen();
    const authorityIdentity = [
      membership.authority.endpoint,
      membership.authority.hostCaFingerprint,
      membership.member.credential,
    ].join('\u0000');
    const existing = this.incomingCoordinators.get(membership.project.id);
    if (existing?.authorityIdentity === authorityIdentity) return existing.coordinator;
    const coordinator = (async () => {
      if (existing) {
        const previous = await existing.coordinator;
        await previous.close();
      }
      return this.options.createIncomingCoordinator(membership);
    })();
    const entry = { authorityIdentity, coordinator };
    this.incomingCoordinators.set(membership.project.id, entry);
    void coordinator.catch(() => {
      if (this.incomingCoordinators.get(membership.project.id) === entry) {
        this.incomingCoordinators.delete(membership.project.id);
      }
    });
    return coordinator;
  }

  private assertOpen(): void {
    if (this.closed) throw serviceError('host-transfer-service-closed');
  }

  private async session(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<{
    readonly coordination: LanCoordinationSnapshot;
    readonly membership: CollabLocalLanMembershipRecord;
  }> {
    const [membership, coordination] = await Promise.all([
      this.requireMembership(projectId),
      this.options.snapshots.readCoordinationSnapshot(projectId, options),
    ]);
    if (coordination.source !== 'online' || coordination.stale) {
      throw serviceError('host-transfer-authority-required', 'host-stopped');
    }
    if (
      coordination.snapshot.project.id !== projectId
      || coordination.snapshot.currentMember.id !== membership.member.id
    ) throw serviceError('host-transfer-snapshot-mismatch');
    if (!isCollabLanProjectSnapshot(coordination.snapshot)) {
      throw serviceError('host-transfer-lan-only', 'authorization-denied');
    }
    return { coordination: coordination as LanCoordinationSnapshot, membership };
  }

  private async requireMembership(
    projectId: CollabProjectId,
  ): Promise<CollabLocalLanMembershipRecord> {
    const membership = await this.options.projects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
    ) {
      throw serviceError('host-transfer-membership-missing');
    }
    if (
      !membership.authority.endpoint
      || !membership.authority.hostCaCertificatePem
      || !membership.authority.hostCaFingerprint
    ) throw serviceError('host-transfer-host-unavailable', 'host-stopped');
    return membership;
  }
}
