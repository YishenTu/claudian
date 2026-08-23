import type { CollabCloudCapability } from '@claudian-collab/protocol';

import type { CollabProjectResource } from '@/app/collab/activity/CollabProjectWorkSession';
import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
import type { CollabAuthorityKind } from '@/core/collab';

export type CollabAuthorityEventInvalidation =
  | {
    readonly kind: 'retired';
    readonly retiredAt: string;
    readonly sequence: number;
  }
  | { readonly kind: 'snapshot'; readonly sequence: number }
  | {
    readonly kind: 'request';
    readonly requestId: string;
    readonly sequence: number;
  };

export interface CollabAuthorityEventConnectionInput {
  readonly afterSequence: number;
  readonly onInvalidation: (
    invalidation: CollabAuthorityEventInvalidation,
  ) => Promise<number>;
}

export interface CollabAuthorityEventPort {
  connect(input: CollabAuthorityEventConnectionInput): CollabProjectResource;
}

export interface CollabAuthorityGitHeader {
  readonly name: string;
  readonly sensitive?: boolean;
  readonly value: string;
}

export interface CollabAuthorityGitNetwork {
  readonly caCertificatePem?: string;
  readonly headers: readonly CollabAuthorityGitHeader[];
  readonly remoteUrl: string;
}

export interface CollabAuthoritySession extends CollabProjectResource {
  readonly authorityKind: CollabAuthorityKind;
  readonly control: CollabAuthorityControlPort;
  readonly events: CollabAuthorityEventPort;
  readonly git: CollabAuthorityGitNetwork;
  supports(capability: CollabCloudCapability): boolean;
}

export interface CollabAuthorityAdapter {
  readonly authorityKind: CollabAuthorityKind;
  create(membership: CollabLocalMembershipRecord): Promise<CollabAuthoritySession>;
}
