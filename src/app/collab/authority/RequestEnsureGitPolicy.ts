import { COLLAB_MAIN_REF, collabMemberRef } from '@claudian/collab-protocol';

import type {
  RequestEnsureHeadPolicyInput,
  RequestEnsureHeadPolicyPort,
} from '@/app/collab/authority/RequestEnsureService';
import { CollabGitTreePolicy } from '@/app/collab/git/CollabGitTreePolicy';
import type {
  GitRecursiveTreeEntry,
  GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RequestEnsureGitPort {
  isAncestor(
    repositoryPath: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean>;
  listTreeRecursive(
    repositoryPath: string,
    commitOid: string,
  ): Promise<readonly GitRecursiveTreeEntry[]>;
  resolveRef(repositoryPath: string, ref: string): Promise<string | null>;
}

function policyError(
  code:
    | 'authority-integrity-error'
    | 'request-head-not-pushed'
    | 'stale-main'
    | 'unsupported-file-type',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'request-head-not-pushed' || code === 'stale-main'
      ? ['retry']
      : ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class RequestEnsureGitPolicy implements RequestEnsureHeadPolicyPort {
  private readonly treePolicy: CollabGitTreePolicy;

  constructor(
    private readonly repositoryPath: string,
    private readonly git: RequestEnsureGitPort,
    treePolicy = new CollabGitTreePolicy(),
  ) {
    this.treePolicy = treePolicy;
  }

  async validate(
    input: RequestEnsureHeadPolicyInput,
  ): Promise<{ readonly mainOid: string }> {
    if (input.personalRef !== collabMemberRef(input.memberId)) {
      throw policyError('authority-integrity-error', 'request-personal-ref-mismatch');
    }
    const personalHead = await this.git.resolveRef(this.repositoryPath, input.personalRef);
    if (personalHead !== input.headOid) {
      throw policyError('request-head-not-pushed', 'request-head-not-current');
    }
    if (!await this.git.isAncestor(this.repositoryPath, input.headOid, personalHead)) {
      throw policyError('request-head-not-pushed', 'request-head-not-reachable');
    }
    const mainOid = await this.git.resolveRef(this.repositoryPath, COLLAB_MAIN_REF);
    if (!mainOid) throw policyError('authority-integrity-error', 'request-main-ref-missing');
    if (mainOid !== input.expectedMainOid) {
      throw policyError('stale-main', 'request-main-not-expected');
    }
    const entries = await this.git.listTreeRecursive(this.repositoryPath, input.headOid);
    this.treePolicy.validate(entries);
    const revalidatedHead = await this.git.resolveRef(this.repositoryPath, input.personalRef);
    if (revalidatedHead !== input.headOid) {
      throw policyError('request-head-not-pushed', 'request-head-changed-during-validation');
    }
    const revalidatedMain = await this.git.resolveRef(this.repositoryPath, COLLAB_MAIN_REF);
    if (revalidatedMain !== input.expectedMainOid) {
      throw policyError('stale-main', 'request-main-changed-during-validation');
    }
    return { mainOid: input.expectedMainOid };
  }
}

export function createRequestEnsureGitPolicy(
  repositoryPath: string,
  git: GitRepositoryService,
): RequestEnsureGitPolicy {
  return new RequestEnsureGitPolicy(repositoryPath, git);
}
