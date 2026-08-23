import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import type {
  HostTransferSourceIdentityPort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import type { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export class LanHostTransferSourceIdentity implements HostTransferSourceIdentityPort {
  constructor(
    private readonly tlsIdentity: Pick<LanTlsIdentity, 'hostCaSigner'>,
    private readonly projects: Pick<CollabLocalProjectRepository, 'loadMembership'>,
  ) {}

  hostCaSigner() {
    return this.tlsIdentity.hostCaSigner();
  }

  async memberCredential(projectId: CollabProjectId): Promise<string> {
    const membership = await this.projects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
    ) {
      throw new CollabError({
        code: 'project-not-found',
        safeContext: { reason: 'host-transfer-source-membership-missing' },
      });
    }
    return membership.member.credential;
  }
}
