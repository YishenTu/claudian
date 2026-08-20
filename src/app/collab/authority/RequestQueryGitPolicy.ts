import { COLLAB_MAIN_REF } from '@claudian/collab-protocol';

import type {
  RequestQueryGitInput,
  RequestQueryGitPort,
  RequestQueryGitResult,
} from '@/app/collab/authority/RequestQueryService';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

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
      const merge = await session.mergeTree(mainOid, input.latestHeadOid);
      return {
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
