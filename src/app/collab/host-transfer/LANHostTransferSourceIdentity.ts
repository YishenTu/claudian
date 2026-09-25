import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLANMembership } from '@/app/collab/CollabLocalProjectRepository';
import type {
  HostTransferSourceIdentityPort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import type { LANTLSIdentity } from '@/app/collab/lan/LANTLSIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export class LANHostTransferSourceIdentity implements HostTransferSourceIdentityPort {
  constructor(
    private readonly tlsIdentity: Pick<LANTLSIdentity, 'hostCaSigner'>,
    private readonly projects: Pick<CollabLocalProjectRepository, 'loadMembership'>,
  ) {}

  hostCaSigner() {
    return this.tlsIdentity.hostCaSigner();
  }

  async memberCredential(projectId: CollabProjectId): Promise<string> {
    const membership = await this.projects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLANMembership(membership)
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
