import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabAuthorityInstallationStatus,
  CollabLocalLANMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';

export interface LANAuthorityActiveRoute {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: CollabProjectId;
}

export interface LANAuthorityTarget {
  readonly endpoint: string;
}

export interface LANAuthorityTargetResolverOptions {
  readonly inspectInstallation: (
    projectId: CollabProjectId,
  ) => Promise<CollabAuthorityInstallationStatus>;
  readonly readActiveRoute: (
    projectId: CollabProjectId,
  ) => LANAuthorityActiveRoute | null;
}

export class LANAuthorityTargetResolver {
  constructor(private readonly options: LANAuthorityTargetResolverOptions) {}

  async resolve(
    membership: CollabLocalLANMembershipRecord,
  ): Promise<LANAuthorityTarget | null> {
    const projectId = membership.project.id;
    let installationStatus: CollabAuthorityInstallationStatus;
    try {
      installationStatus = await this.options.inspectInstallation(projectId);
    } catch {
      return null;
    }
    if (installationStatus !== 'hosted-here') return null;
    const route = this.options.readActiveRoute(projectId);
    if (
      !route
      || route.projectId !== projectId
      || route.caFingerprint !== membership.authority.hostCaFingerprint
      || route.caCertificatePem !== membership.authority.hostCaCertificatePem
    ) {
      return null;
    }
    return { endpoint: route.endpoint };
  }
}
