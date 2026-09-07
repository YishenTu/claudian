import type { CollabCloudCapability } from '@claudian-collab/protocol';

import { ProjectEventClient } from '@/app/collab/client/ProjectEventClient';
import type {
  CollabLocalLanMembershipRecord,
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { LocalMembershipControlPort } from '@/app/collab/membership/LocalMembershipControlPort';
import { LocalProjectControlPort } from '@/app/collab/publish/LocalProjectControlPort';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type {
  CollabAuthorityMembershipControlPort,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import type {
  CollabAuthorityAdapter,
  CollabAuthorityEventConnectionInput,
  CollabAuthoritySession,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import type { LanAuthorityTarget } from '@/app/collab/remote-authority/LanAuthorityTargetResolver';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const LAN_CAPABILITIES: ReadonlySet<CollabCloudCapability> = new Set([
  'accept',
  'git-receive-pack-personal-ref',
  'git-upload-pack',
  'project-events',
  'project-snapshot',
  'requests',
  'tickets',
]);

export interface LanAuthorityAdapterOptions {
  readonly createControl?: (
    membership: CollabLocalLanMembershipRecord,
  ) => CollabAuthorityControlPort;
  readonly createEvent?: (
    input: ConstructorParameters<typeof ProjectEventClient>[0],
    onInvalidation: ConstructorParameters<typeof ProjectEventClient>[1],
  ) => { dispose(): void; start?(): void };
  readonly createMembershipControl?: (
    membership: CollabLocalLanMembershipRecord,
  ) => CollabAuthorityMembershipControlPort;
  readonly resolveLocalTarget?: (
    membership: CollabLocalLanMembershipRecord,
  ) => Promise<LanAuthorityTarget | null>;
}

function adapterError(reason: string): CollabError {
  return new CollabError({
    code: 'host-stopped',
    recoveryActions: ['restart-host', 'retry'],
    safeContext: { reason },
  });
}

export class LanAuthorityAdapter implements CollabAuthorityAdapter {
  readonly authorityKind = 'lan' as const;
  private readonly createControl: NonNullable<LanAuthorityAdapterOptions['createControl']>;
  private readonly createEvent: NonNullable<LanAuthorityAdapterOptions['createEvent']>;
  private readonly createMembershipControl: NonNullable<
    LanAuthorityAdapterOptions['createMembershipControl']
  >;
  private readonly resolveLocalTarget: NonNullable<
    LanAuthorityAdapterOptions['resolveLocalTarget']
  >;

  constructor(options: LanAuthorityAdapterOptions = {}) {
    this.createControl = options.createControl ?? (membership => new LocalProjectControlPort({
      loadMembership: async projectId => (
        projectId === membership.project.id ? membership : null
      ),
    }));
    this.createEvent = options.createEvent
      ?? ((input, onInvalidation) => new ProjectEventClient(input, onInvalidation));
    this.createMembershipControl = options.createMembershipControl
      ?? (membership => new LocalMembershipControlPort(membership));
    this.resolveLocalTarget = options.resolveLocalTarget ?? (async () => null);
  }

  async create(membership: CollabLocalMembershipRecord): Promise<CollabAuthoritySession> {
    if (!isCollabLocalLanMembership(membership)) {
      throw new TypeError('LAN adapter requires a LAN membership');
    }
    const { endpoint, gitRemoteUrl, hostCaCertificatePem, hostCaFingerprint } =
      membership.authority;
    if (!endpoint || !gitRemoteUrl || !hostCaCertificatePem || !hostCaFingerprint) {
      throw adapterError('lan-authority-session-trust-unavailable');
    }
    const localTarget = await this.resolveLocalTarget(membership);
    const effectiveEndpoint = localTarget?.endpoint ?? endpoint;
    const effectiveGitRemoteUrl = localTarget
      ? `${localTarget.endpoint}/v1/git/${membership.project.id}/repository.git`
      : gitRemoteUrl;
    const effectiveMembership: CollabLocalLanMembershipRecord = localTarget
      ? {
        ...membership,
        authority: {
          ...membership.authority,
          endpoint: effectiveEndpoint,
          gitRemoteUrl: effectiveGitRemoteUrl,
        },
      }
      : membership;
    const control = this.createControl(effectiveMembership);
    return {
      authorityKind: 'lan',
      control,
      dispose: () => undefined,
      events: {
        connect: ({ afterSequence, onInvalidation }: CollabAuthorityEventConnectionInput) => {
          const event = this.createEvent({
            caCertificatePem: hostCaCertificatePem,
            endpoint: effectiveEndpoint,
            lastSequence: afterSequence,
            memberCredential: membership.member.credential,
            projectId: membership.project.id,
          }, onInvalidation);
          event.start?.();
          return event;
        },
      },
      git: {
        caCertificatePem: hostCaCertificatePem,
        headers: [{
          name: 'Authorization',
          value: `Basic ${Buffer.from(
            `${membership.member.id}:${membership.member.credential}`,
          ).toString('base64')}`,
        }],
        remoteUrl: effectiveGitRemoteUrl,
      },
      membership: this.createMembershipControl(effectiveMembership),
      supports: capability => LAN_CAPABILITIES.has(capability),
    };
  }
}
