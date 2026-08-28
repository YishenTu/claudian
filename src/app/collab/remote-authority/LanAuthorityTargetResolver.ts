import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabAuthorityInstallationStatus,
  CollabLocalLanMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';

export interface LanAuthorityActiveRoute {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: CollabProjectId;
}

export interface LanAuthorityTarget {
  readonly endpoint: string;
}

export interface LanAuthorityTargetResolverOptions {
  readonly inspectInstallation: (
    projectId: CollabProjectId,
  ) => Promise<CollabAuthorityInstallationStatus>;
  readonly readActiveRoute: (
    projectId: CollabProjectId,
  ) => LanAuthorityActiveRoute | null;
}

export class LanAuthorityTargetResolver {
  constructor(private readonly options: LanAuthorityTargetResolverOptions) {}

  async resolve(
    membership: CollabLocalLanMembershipRecord,
  ): Promise<LanAuthorityTarget | null> {
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
