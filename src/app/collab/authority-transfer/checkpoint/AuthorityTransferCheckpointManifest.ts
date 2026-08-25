import { createHash } from 'node:crypto';

import {
  COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
  COLLAB_PROJECT_COORDINATION_FORMAT_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabCheckpointArtifactFact,
  type CollabCheckpointAuthority,
  type CollabCheckpointGitRef,
  type CollabCheckpointObjectFormat,
  type CollabIsoTimestamp,
  type CollabProjectCheckpointManifest,
  type CollabProjectId,
  decodeCollabProjectCheckpointManifest,
  encodeCollabProjectCheckpointManifestDigestInput,
} from '@claudian-collab/protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CreateAuthorityTransferCheckpointManifestInput {
  readonly artifacts: readonly CollabCheckpointArtifactFact[];
  readonly createdAt: CollabIsoTimestamp;
  readonly expectedMainOid: string;
  readonly gitObjectFormat: CollabCheckpointObjectFormat;
  readonly operationId: string;
  readonly projectId: CollabProjectId;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly sourceAuthority: CollabCheckpointAuthority;
  readonly targetAuthority: CollabCheckpointAuthority;
}

function manifestError(): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason: 'checkpoint-manifest-invalid' },
  });
}

function digest(manifest: CollabProjectCheckpointManifest): string {
  return createHash('sha256')
    .update(encodeCollabProjectCheckpointManifestDigestInput(manifest), 'utf8')
    .digest('hex');
}

export function createAuthorityTransferCheckpointManifest(
  input: CreateAuthorityTransferCheckpointManifestInput,
): CollabProjectCheckpointManifest {
  try {
    const unsigned = decodeCollabProjectCheckpointManifest({
      artifacts: input.artifacts,
      coordinationFormatVersion: COLLAB_PROJECT_COORDINATION_FORMAT_VERSION,
      createdAt: input.createdAt,
      expectedMainOid: input.expectedMainOid,
      gitObjectFormat: input.gitObjectFormat,
      manifestSchemaVersion: COLLAB_PROJECT_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
      manifestSha256: '0'.repeat(64),
      operationId: input.operationId,
      profile: 'authority-transfer',
      projectId: input.projectId,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      refs: input.refs,
      sourceAuthority: input.sourceAuthority,
      targetAuthority: input.targetAuthority,
    });
    return decodeCollabProjectCheckpointManifest({
      ...unsigned,
      manifestSha256: digest(unsigned),
    });
  } catch {
    throw manifestError();
  }
}

export function verifyAuthorityTransferCheckpointManifest(
  manifest: CollabProjectCheckpointManifest,
): CollabProjectCheckpointManifest {
  try {
    const decoded = decodeCollabProjectCheckpointManifest(manifest);
    if (decoded.profile !== 'authority-transfer' || decoded.manifestSha256 !== digest(decoded)) {
      throw manifestError();
    }
    return decoded;
  } catch {
    throw manifestError();
  }
}
