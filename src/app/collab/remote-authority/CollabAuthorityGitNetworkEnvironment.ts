import { readFile } from 'node:fs/promises';

import type { CollabProjectId } from '@claudian/collab-protocol';

import {
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import type { CollabAuthorityGitNetwork } from '@/app/collab/remote-authority/CollabAuthoritySession';

export class CollabAuthorityGitNetworkEnvironment {
  constructor(private readonly vaultRoot: string) {}

  async resolve(
    projectId: CollabProjectId,
    network: CollabAuthorityGitNetwork,
  ): Promise<GitNetworkEnvironment> {
    let sslCaInfoPath: string | undefined;
    if (network.caCertificatePem !== undefined) {
      const relativeCaPath = `.claudian/collab/projects/${projectId}/git-ca.pem`;
      const existingCaPath = await resolveCollabVaultPath(this.vaultRoot, relativeCaPath);
      const existingCa = await readFile(existingCaPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (existingCa !== network.caCertificatePem) {
        await writeCollabFileAtomically(
          this.vaultRoot,
          relativeCaPath,
          network.caCertificatePem,
          { mode: 0o600 },
        );
      }
      sslCaInfoPath = await resolveCollabVaultPath(
        this.vaultRoot,
        relativeCaPath,
        { mustExist: true },
      );
    }
    return {
      headers: network.headers,
      ...(sslCaInfoPath === undefined ? {} : { sslCaInfoPath }),
    };
  }
}
