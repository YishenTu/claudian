import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import {
  MembershipControlClient,
} from '@/app/collab/membership/MembershipControlClient';
import type {
  CollabAuthorityMembershipControlPort,
  CollabAuthorityMembershipOperation,
  CollabAuthorityMembershipOperationMap,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import type { CollabOperationOptions } from '@/core/collab';

const CONTROL_TIMEOUT_MS = 10_000;

export interface LocalMembershipControlPortOptions {
  readonly createClient?: (
    trust: {
      readonly caCertificatePem: string;
      readonly caFingerprint: string;
      readonly endpoint: string;
      readonly projectId: string;
    },
  ) => Pick<MembershipControlClient, CollabAuthorityMembershipOperation>;
}

export class LocalMembershipControlPort implements CollabAuthorityMembershipControlPort {
  private client: Pick<
    MembershipControlClient,
    CollabAuthorityMembershipOperation
  > | null = null;
  private readonly credential: string;
  private readonly createClient: NonNullable<LocalMembershipControlPortOptions['createClient']>;
  private readonly trust: {
    readonly caCertificatePem: string;
    readonly caFingerprint: string;
    readonly endpoint: string;
    readonly projectId: string;
  };

  constructor(
    membership: CollabLocalLanMembershipRecord,
    options: LocalMembershipControlPortOptions = {},
  ) {
    const { endpoint, hostCaCertificatePem, hostCaFingerprint } = membership.authority;
    if (!endpoint || !hostCaCertificatePem || !hostCaFingerprint) {
      throw new TypeError('LAN membership control requires complete Host trust');
    }
    this.createClient = options.createClient ?? (trust => new MembershipControlClient(
      new PinnedCollabHttpClient(trust, CONTROL_TIMEOUT_MS),
    ));
    this.trust = {
      caCertificatePem: hostCaCertificatePem,
      caFingerprint: hostCaFingerprint,
      endpoint,
      projectId: membership.project.id,
    };
    this.credential = membership.member.credential;
  }

  membership<Operation extends CollabAuthorityMembershipOperation>(
    operation: Operation,
    input: CollabAuthorityMembershipOperationMap[Operation]['input'],
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityMembershipOperationMap[Operation]['result']> {
    const client = this.client ??= this.createClient(this.trust);
    const method = client[operation] as (
      authenticated: typeof input & {
        readonly memberCredential: string;
        readonly signal?: AbortSignal;
      },
    ) => Promise<CollabAuthorityMembershipOperationMap[Operation]['result']>;
    return method.call(client, {
      ...input,
      memberCredential: this.credential,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}
