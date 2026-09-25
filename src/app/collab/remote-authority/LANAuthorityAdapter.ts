import type { CollabCloudCapability } from '@claudian-collab/protocol';

import { ProjectEventClient } from '@/app/collab/client/ProjectEventClient';
import type {
  CollabLocalLANMembershipRecord,
  CollabLocalMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLANMembership } from '@/app/collab/CollabLocalProjectRepository';
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
import type { LANAuthorityTarget } from '@/app/collab/remote-authority/LANAuthorityTargetResolver';
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

export interface LANAuthorityAdapterOptions {
  readonly createControl?: (
    membership: CollabLocalLANMembershipRecord,
  ) => CollabAuthorityControlPort;
  readonly createEvent?: (
    input: ConstructorParameters<typeof ProjectEventClient>[0],
    onInvalidation: ConstructorParameters<typeof ProjectEventClient>[1],
  ) => { dispose(): void; start?(): void };
  readonly createMembershipControl?: (
    membership: CollabLocalLANMembershipRecord,
  ) => CollabAuthorityMembershipControlPort;
  readonly resolveLocalTarget?: (
    membership: CollabLocalLANMembershipRecord,
  ) => Promise<LANAuthorityTarget | null>;
}

function adapterError(reason: string): CollabError {
  return new CollabError({
    code: 'host-stopped',
    recoveryActions: ['restart-host', 'retry'],
    safeContext: { reason },
  });
}

export class LANAuthorityAdapter implements CollabAuthorityAdapter {
  readonly authorityKind = 'lan' as const;
  private readonly createControl: NonNullable<LANAuthorityAdapterOptions['createControl']>;
  private readonly createEvent: NonNullable<LANAuthorityAdapterOptions['createEvent']>;
  private readonly createMembershipControl: NonNullable<
    LANAuthorityAdapterOptions['createMembershipControl']
  >;
  private readonly resolveLocalTarget: NonNullable<
    LANAuthorityAdapterOptions['resolveLocalTarget']
  >;

  constructor(options: LANAuthorityAdapterOptions = {}) {
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
    if (!isCollabLocalLANMembership(membership)) {
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
    const effectiveMembership: CollabLocalLANMembershipRecord = localTarget
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
        connect: ({ afterSequence, onInvalidation, onConnectionResult }: CollabAuthorityEventConnectionInput) => {
          const event = this.createEvent({
            onConnectionResult,
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
