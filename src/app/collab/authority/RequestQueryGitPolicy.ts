import path from 'node:path';

import { COLLAB_MAIN_REF } from '@claudian/collab-protocol';

import type {
  RequestQueryGitInput,
  RequestQueryGitPort,
  RequestQueryGitResult,
} from '@/app/collab/authority/RequestQueryService';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const TEXT_EXTENSIONS = new Set([
  '.canvas', '.css', '.csv', '.html', '.js', '.json', '.jsx', '.md',
  '.markdown', '.mermaid', '.svg', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml',
]);

function queryError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class RequestQueryGitPolicy implements RequestQueryGitPort {
  constructor(
    private readonly repositoryPath: string,
    private readonly git: GitRepositoryService,
  ) {}

  async inspect(input: RequestQueryGitInput): Promise<RequestQueryGitResult> {
    return this.git.withReadSession(this.repositoryPath, 'bare', async session => {
      const refs = await session.resolveRefs([COLLAB_MAIN_REF, input.personalRef]);
      const mainOid = refs.get(COLLAB_MAIN_REF) ?? null;
      const personalOid = refs.get(input.personalRef) ?? null;
      if (!mainOid || !personalOid) throw queryError('request-detail-ref-missing');
      const changes = await session.listChangedFiles(mainOid, input.latestHeadOid);
      if (changes.length > CLAUDIAN_COLLAB_LIMITS.maxChangedPaths) {
        throw new CollabError({
          code: 'quota-exceeded',
          safeContext: {
            limit: CLAUDIAN_COLLAB_LIMITS.maxChangedPaths,
            quota: 'maxChangedPaths',
          },
        });
      }
      const merge = await session.mergeTree(mainOid, input.latestHeadOid);
      return {
        changedFiles: changes.map(change => {
          const binary = !TEXT_EXTENSIONS.has(
            path.posix.extname(change.path).toLocaleLowerCase('en-US'),
          );
          return {
            binary,
            kind: change.kind,
            largeForReview: false,
            path: change.path,
            ...(change.previousPath ? { previousPath: change.previousPath } : {}),
          };
        }),
        currentMainOid: mainOid,
        reviewCondition: personalOid !== input.latestHeadOid
          ? 'stale'
          : merge.kind === 'conflicting'
            ? 'conflicting'
            : 'clean',
        reviewedHeadOid: input.latestHeadOid,
      };
    });
  }
}
