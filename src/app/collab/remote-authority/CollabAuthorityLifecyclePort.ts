import type { Readable } from 'node:stream';

import type {
  CollabAuthorityTransferOperation,
  CollabAuthorityTransferOperationMap,
  CollabCloudAuthorityTransferArtifact,
  CollabProjectRetirementOperation,
  CollabProjectRetirementOperationMap,
} from '@claudian-collab/protocol';

import type { CollabOperationOptions } from '@/core/collab';

export interface CollabAuthorityArtifactUpload {
  readonly artifact: CollabCloudAuthorityTransferArtifact;
  readonly body: Readable;
  readonly byteCount: number;
  readonly projectId: string;
  readonly transferId: string;
}

export interface CollabAuthorityArtifactDownload {
  readonly body: Readable;
  readonly byteCount: number;
}

/**
 * Authority lifecycle operations remain package-shaped at the remote boundary.
 * Direction coordinators own phase policy and call this stateless transport port.
 */
export interface CollabAuthorityLifecyclePort {
  authorityTransfer<Operation extends CollabAuthorityTransferOperation>(
    operation: Operation,
    request: CollabAuthorityTransferOperationMap[Operation]['request'],
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferOperationMap[Operation]['response']>;
  retirement<Operation extends CollabProjectRetirementOperation>(
    operation: Operation,
    request: CollabProjectRetirementOperationMap[Operation]['request'],
    options?: CollabOperationOptions,
  ): Promise<CollabProjectRetirementOperationMap[Operation]['response']>;
  uploadAuthorityTransferArtifact(
    input: CollabAuthorityArtifactUpload,
    options?: CollabOperationOptions,
  ): Promise<void>;
  downloadAuthorityTransferArtifact(
    input: Omit<CollabAuthorityArtifactUpload, 'body' | 'byteCount'>,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityArtifactDownload>;
}
