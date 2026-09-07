import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabLocalMembershipRecord,
  CollabLocalProjectIndexEntry,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION,
  decodeManagerResponsibilityReceiptRecord,
  type ManagerResponsibilityReceiptRecord,
} from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import type { CollabMembershipManagerReceiptPort } from '@/app/collab/membership/CollabMembershipService';
import type { CollabLocalCleanupStatus, CollabManagerResponsibilityOfferSummary } from '@/core/collab';

type LifecycleRepository = Pick<
  CollabLocalProjectRepository,
  | 'loadIndex'
  | 'loadMembership'
  | 'loadLifecycleProjectDocument'
  | 'removeLifecycleProjectDocument'
  | 'removeProject'
  | 'purgeProjectPrivateState'
  | 'saveLifecycleProjectDocument'
  | 'saveMembership'
  | 'upsertProject'
>;

export interface LocalExitProjectStorePort {
  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null>;
  markLeaving(
    projectId: CollabProjectId,
    cleanupStatus: CollabLocalCleanupStatus,
  ): Promise<void>;
  removeProject(projectId: CollabProjectId): Promise<void>;
  purgePrivateState(projectId: CollabProjectId): Promise<void>;
  restoreActive(projectId: CollabProjectId): Promise<void>;
}

export class LocalExitProjectStore implements LocalExitProjectStorePort {
  constructor(private readonly projects: LifecycleRepository) {}

  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null> {
    return this.projects.loadMembership(projectId);
  }

  async markLeaving(
    projectId: CollabProjectId,
    cleanupStatus: CollabLocalCleanupStatus,
  ): Promise<void> {
    const [index, membership] = await Promise.all([
      this.projects.loadIndex(),
      this.projects.loadMembership(projectId),
    ]);
    const entry = index.projects.find(project => project.id === projectId);
    if (!membership) throw new TypeError('Local exit Project is missing');
    if (!entry && membership.lifecycle === 'leaving' && cleanupStatus !== 'failed') return;
    if (!entry && membership.lifecycle === 'leaving') {
      await this.projects.upsertProject({
        authorityKind: membership.authority.kind,
        cleanupStatus,
        createdAt: membership.createdAt,
        id: membership.project.id,
        lifecycle: 'leaving',
        name: membership.project.name,
        updatedAt: membership.updatedAt,
        workspacePath: membership.project.workspacePath,
      });
      return;
    }
    if (!entry) throw new TypeError('Local exit Project is missing');
    const updatedEntry: CollabLocalProjectIndexEntry = {
      ...entry,
      cleanupStatus,
      lifecycle: 'leaving',
    };
    await this.projects.upsertProject(updatedEntry);
    await this.projects.saveMembership({ ...membership, lifecycle: 'leaving' });
  }

  removeProject(projectId: CollabProjectId): Promise<void> {
    return this.projects.removeProject(projectId);
  }

  async purgePrivateState(projectId: CollabProjectId): Promise<void> {
    await this.projects.purgeProjectPrivateState(projectId);
  }

  async restoreActive(projectId: CollabProjectId): Promise<void> {
    const [index, membership] = await Promise.all([
      this.projects.loadIndex(),
      this.projects.loadMembership(projectId),
    ]);
    if (!membership) throw new TypeError('Local exit Project is missing');
    const entry = index.projects.find(project => project.id === projectId);
    const {
      cleanupStatus: _cleanupStatus,
      lifecycle: _lifecycle,
      retiredAt: _retiredAt,
      ...identity
    } = entry ?? {
      authorityKind: membership.authority.kind,
      createdAt: membership.createdAt,
      id: membership.project.id,
      name: membership.project.name,
      updatedAt: membership.updatedAt,
      workspacePath: membership.project.workspacePath,
    };
    await this.projects.upsertProject({ ...identity, lifecycle: 'active' });
    await this.projects.saveMembership({ ...membership, lifecycle: 'active' });
  }
}

export class ManagerResponsibilityReceiptStore
implements CollabMembershipManagerReceiptPort {
  private readonly now: () => Date;

  constructor(
    private readonly projects: LifecycleRepository,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
  }

  async load(projectId: CollabProjectId): Promise<ManagerResponsibilityReceiptRecord | null> {
    let legacyPurpose: 'manager-transfer' | 'manager-leave' | null = null;
    const receipt = await this.projects.loadLifecycleProjectDocument(
      projectId,
      'manager-responsibility-receipt',
      value => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const candidate = value as Readonly<Record<string, unknown>>;
          if (
            candidate.schemaVersion === 1
            && (candidate.purpose === 'manager-transfer'
              || candidate.purpose === 'manager-leave')
          ) {
            legacyPurpose = candidate.purpose;
          }
        }
        return decodeManagerResponsibilityReceiptRecord(value);
      },
    );
    if (!receipt) return null;
    if (legacyPurpose === 'manager-transfer') {
      await this.remove(projectId);
      return null;
    }
    if (legacyPurpose === 'manager-leave') {
      await this.projects.saveLifecycleProjectDocument(
        projectId,
        'manager-responsibility-receipt',
        receipt,
        decodeManagerResponsibilityReceiptRecord,
      );
    }
    return receipt;
  }

  remove(projectId: CollabProjectId): Promise<boolean> {
    return this.projects.removeLifecycleProjectDocument(
      projectId,
      'manager-responsibility-receipt',
    );
  }

  async save(
    projectId: CollabProjectId,
    summary: CollabManagerResponsibilityOfferSummary,
  ): Promise<void> {
    const existing = await this.load(projectId);
    const minimumUpdatedAt = summary.acknowledgedAt ?? summary.offeredAt;
    const updatedAt = new Date(Math.max(
      this.now().getTime(),
      Date.parse(minimumUpdatedAt),
    )).toISOString();
    const record: ManagerResponsibilityReceiptRecord = decodeManagerResponsibilityReceiptRecord({
      acknowledgedAt: summary.acknowledgedAt ?? null,
      expiresAt: summary.expiresAt,
      kind: 'manager-responsibility-receipt',
      offerId: summary.offerId,
      offeredAt: summary.offeredAt,
      projectId,
      purpose: summary.purpose,
      schemaVersion: COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION,
      sourceManagerMemberId: summary.sourceManagerMemberId,
      status: summary.status,
      targetMemberId: summary.targetMemberId,
      updatedAt,
    });
    if (
      existing
      && existing.offerId !== record.offerId
      && (existing.status === 'offered' || existing.status === 'acknowledged')
    ) {
      throw new TypeError('Another Manager responsibility receipt is pending');
    }
    await this.projects.saveLifecycleProjectDocument(
      projectId,
      'manager-responsibility-receipt',
      record,
      decodeManagerResponsibilityReceiptRecord,
    );
  }
}
