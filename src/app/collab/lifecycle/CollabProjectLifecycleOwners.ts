import { type CollabProjectId } from '@claudian-collab/protocol';

import type { LocalCleanupRecord } from '@/app/collab/exit/LocalCleanupRecord';
import type {
  ManagerResponsibilityReceiptRecord,
} from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type {
  CollabProjectLifecycleDurableOwner,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';
import type { RetirementTombstoneRecord } from '@/app/collab/retirement/RetirementTombstoneRecord';

export interface CollabProjectLifecycleOwnerStores {
  readonly cloudBootstrapTransitions: {
    inspectLifecycleOwner(
      projectId: CollabProjectId,
    ): Promise<'absent' | 'nonterminal' | 'terminal'>;
  };
  readonly hostTransferRecovery: {
    load(
      projectId: CollabProjectId,
      direction: 'incoming' | 'outgoing',
    ): Promise<HostTransferRecoveryRecord | null>;
  };
  readonly localCleanup: {
    load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
  };
  readonly managerReceipts: {
    load(projectId: CollabProjectId): Promise<ManagerResponsibilityReceiptRecord | null>;
  };
  readonly pendingLeaves: {
    load(projectId: CollabProjectId): Promise<PendingLeaveRecord | null>;
  };
  readonly retiredCleanups: {
    load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
  };
  readonly retirements: {
    loadRetirementRecord(projectId: CollabProjectId): Promise<RetirementRecord | null>;
  };
  readonly retirementTombstones: {
    loadRetirementTombstone(projectId: CollabProjectId): Promise<RetirementTombstoneRecord | null>;
  };
}

export function createCollabProjectLifecycleDurableOwners(
  stores: CollabProjectLifecycleOwnerStores,
  isRecoveryOwner: (ownerInstallationKey: string | undefined) => boolean,
): readonly CollabProjectLifecycleDurableOwner[] {
  return Object.freeze([
    Object.freeze({
      inspect: (projectId: CollabProjectId) => (
        stores.cloudBootstrapTransitions.inspectLifecycleOwner(projectId)
      ),
      name: 'cloud-bootstrap',
    }),
    Object.freeze({
      inspect: async (projectId: CollabProjectId) => {
        const [incoming, outgoing] = await Promise.all([
          stores.hostTransferRecovery.load(projectId, 'incoming'),
          stores.hostTransferRecovery.load(projectId, 'outgoing'),
        ]);
        if (incoming && outgoing) {
          throw new Error('Conflicting Host transfer recovery records');
        }
        const record = incoming ?? outgoing;
        return record && (
          record.ownerInstallationKey === undefined
          || isRecoveryOwner(record.ownerInstallationKey)
        )
          ? record.direction === 'incoming'
            && record.receiverCredentialHash !== null
            && record.stagingDirectoryName === null
              ? 'terminal' as const
              : 'nonterminal' as const
          : 'absent' as const;
      },
      name: 'host-transfer',
    }),
    Object.freeze({
      inspect: async (projectId: CollabProjectId) => {
        const [receipt, pendingLeave] = await Promise.all([
          stores.managerReceipts.load(projectId),
          stores.pendingLeaves.load(projectId),
        ]);
        if (!receipt) return 'absent' as const;
        // A durable pending Leave adopts responsibility for settling the
        // acknowledged receipt. It must be the only nonterminal owner after a
        // crash between recording the Leave and consuming the receipt.
        if (pendingLeave) return 'terminal' as const;
        // Source-created offers remain reversible authority proposals. This target-only
        // receipt becomes a local lifecycle owner only after acknowledgement.
        if (receipt.status === 'offered') return 'proposal' as const;
        return receipt.status === 'acknowledged'
          ? 'nonterminal' as const
          : 'terminal' as const;
      },
      name: 'manager-responsibility',
    }),
    Object.freeze({
      inspect: async (projectId: CollabProjectId) => {
        const [pendingLeave, cleanup, retirement] = await Promise.all([
          stores.pendingLeaves.load(projectId),
          stores.localCleanup.load(projectId),
          stores.retirements.loadRetirementRecord(projectId),
        ]);
        if (cleanup && cleanup.purpose !== 'leave') {
          throw new Error('Invalid local-exit cleanup owner');
        }
        if (!pendingLeave && !cleanup) return 'absent' as const;
        return retirement ? 'terminal' as const : 'nonterminal' as const;
      },
      name: 'local-exit',
    }),
    Object.freeze({
      inspect: async (projectId: CollabProjectId) => {
        const [retirement, cleanup, tombstone] = await Promise.all([
          stores.retirements.loadRetirementRecord(projectId),
          stores.retiredCleanups.load(projectId),
          stores.retirementTombstones.loadRetirementTombstone(projectId),
        ]);
        if (cleanup && cleanup.purpose !== 'retire') {
          throw new Error('Invalid retirement cleanup owner');
        }
        const ownedTombstone = tombstone && (
          tombstone.ownerInstallationKey === undefined
          || isRecoveryOwner(tombstone.ownerInstallationKey)
        )
          ? tombstone
          : null;
        return retirement || cleanup || ownedTombstone
          ? 'nonterminal' as const
          : 'absent' as const;
      },
      name: 'retirement',
    }),
  ]);
}
