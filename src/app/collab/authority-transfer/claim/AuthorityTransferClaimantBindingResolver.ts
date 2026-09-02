import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  RecoveredAuthorityTransferClaimantBinding,
} from '@/app/collab/authority-transfer/AuthorityTransferModule';
import type {
  AuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  authorityTransferClaimantRequiresSource,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecovery';
import type {
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferClaimantBindingResolverOptions {
  readonly createCloudConnection: (input: Readonly<{
        readonly projectId: CollabProjectId;
    readonly serverUrl: string;
  }>) => Promise<CloudAuthorityConnection>;
  readonly createLanClient?: (
    input: ConstructorParameters<typeof LanAuthorityTransferClient>[0],
  ) => LanAuthorityTransferClient;
  readonly loadMembership: (
    projectId: CollabProjectId,
  ) => Promise<CollabLocalMembershipRecord | null>;
  readonly now?: () => Date;
}

function resolutionError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/** Reconstructs only the transports still authoritative for a claimant phase. */
export class AuthorityTransferClaimantBindingResolver {
  private readonly createLanClient: NonNullable<
    AuthorityTransferClaimantBindingResolverOptions['createLanClient']
  >;
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferClaimantBindingResolverOptions) {
    this.createLanClient = options.createLanClient
      ?? (input => new LanAuthorityTransferClient(input));
    this.now = options.now ?? (() => new Date());
  }

  async resolve(
    record: AuthorityTransferClaimantRecord,
  ): Promise<RecoveredAuthorityTransferClaimantBinding> {
    const membership = await this.options.loadMembership(record.projectId);
    if (!membership || membership.member.id !== record.memberId) {
      throw resolutionError('authority-transfer-claimant-membership-invalid');
    }
    if (record.variant === 'manager-reissued') {
      if (membership.member.personalRef !== record.memberPersonalRef) {
        throw resolutionError('authority-transfer-claimant-membership-invalid');
      }
      if (isCollabLocalCloudMembership(membership)) {
        if (
          record.phase !== 'target-confirmed'
          && record.phase !== 'membership-converged'
          && record.phase !== 'completed'
        ) throw resolutionError('authority-transfer-claimant-phase-invalid');
        if (
          membership.authority.authorityGeneration
            !== record.descriptor.targetAuthorityGeneration
          || membership.authority.serverUrl !== record.serverUrl
        ) throw resolutionError('authority-transfer-claimant-target-invalid');
        return { direction: 'lan-to-cloud', mode: 'local-only' };
      }
      if (!isCollabLocalLanMembership(membership) || membership.hostOwnership.ownsAuthority) {
        throw resolutionError('authority-transfer-claimant-source-invalid');
      }
      return {
        cloudSession: await this.options.createCloudConnection({
          projectId: record.projectId,
          serverUrl: record.serverUrl,
        }),
        direction: 'lan-to-cloud',
        mode: 'manager-reissued',
      };
    }
    const requiresSource = authorityTransferClaimantRequiresSource(record, this.now());
    if (record.status.direction === 'lan-to-cloud') {
      if (isCollabLocalCloudMembership(membership)) {
        if (record.phase !== 'source-acknowledged') {
          throw resolutionError('authority-transfer-claimant-phase-invalid');
        }
        return { direction: 'lan-to-cloud', mode: 'local-only' };
      }
      if (!isCollabLocalLanMembership(membership)) {
        throw resolutionError('authority-transfer-claimant-source-invalid');
      }
      const cloudSession = await this.options.createCloudConnection({
        projectId: record.projectId,
        serverUrl: record.status.targetUrl,
      });
      if (!requiresSource) {
        return { cloudSession, direction: 'lan-to-cloud', mode: 'target-only' };
      }
      try {
        if (
          !membership.authority.endpoint
          || !membership.authority.hostCaCertificatePem
          || !membership.authority.hostCaFingerprint
        ) throw resolutionError('authority-transfer-claimant-source-invalid');
        return {
          cloudSession,
          direction: 'lan-to-cloud',
          lanClient: this.createLanClient({
            caCertificatePem: membership.authority.hostCaCertificatePem,
            caFingerprint: membership.authority.hostCaFingerprint,
            endpoint: membership.authority.endpoint,
            projectId: record.projectId,
          }),
          memberCredential: membership.member.credential,
          mode: 'full',
        };
      } catch (error) {
        cloudSession.dispose();
        throw error;
      }
    }
    if (isCollabLocalLanMembership(membership)) {
      if (record.phase !== 'source-acknowledged') {
        throw resolutionError('authority-transfer-claimant-phase-invalid');
      }
      if (membership.authority.authorityGeneration !== record.status.targetAuthority.generation) {
        throw resolutionError('authority-transfer-claimant-target-generation-mismatch');
      }
      return { direction: 'cloud-to-lan', mode: 'local-only' };
    }
    if (!isCollabLocalCloudMembership(membership) || !record.lanTarget) {
      throw resolutionError('authority-transfer-claimant-target-invalid');
    }
    if (!requiresSource) {
      return {
        direction: 'cloud-to-lan',
        mode: 'target-only',
        targetHost: record.lanTarget,
      };
    }
    const cloudSession = await this.options.createCloudConnection({
      projectId: record.projectId,
      serverUrl: membership.authority.serverUrl,
    });
    try {
      return {
        cloudSession,
        direction: 'cloud-to-lan',
        lanClient: this.createLanClient({
          ...record.lanTarget,
          projectId: record.projectId,
        }),
        mode: 'full',
        targetHost: record.lanTarget,
      };
    } catch (error) {
      cloudSession.dispose();
      throw error;
    }
  }
}
