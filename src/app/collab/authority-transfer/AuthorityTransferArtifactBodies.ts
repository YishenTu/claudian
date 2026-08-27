import type { Readable } from 'node:stream';

export interface AuthorityTransferArtifactBody {
  readonly body: Readable;
}

export function destroyAuthorityTransferArtifactBodies(
  artifacts: readonly AuthorityTransferArtifactBody[],
): void {
  for (const artifact of artifacts) artifact.body.destroy();
}
