import type { AcceptCoordinatorGitPort } from '@/app/collab/accept/AcceptCoordinator';
import { CollabGitTreePolicy } from '@/app/collab/git/CollabGitTreePolicy';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';

export class AcceptGitRepository implements AcceptCoordinatorGitPort {
  constructor(
    private readonly repositoryPath: string,
    private readonly git: GitRepositoryService,
    private readonly treePolicy = new CollabGitTreePolicy(),
    private readonly resourceAdmission: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation(),
  ) {}

  commitTree(
    input: Parameters<AcceptCoordinatorGitPort['commitTree']>[0],
  ): Promise<string> {
    return this.resourceAdmission(() => this.git.commitTree(this.repositoryPath, input));
  }

  compareAndSwapRef(
    ref: string,
    nextOid: string,
    expectedOid: string,
  ): Promise<{ readonly currentOid: string | null; readonly updated: boolean }> {
    return this.resourceAdmission(() => this.git.compareAndSwapRef(
      this.repositoryPath,
      ref,
      nextOid,
      expectedOid,
    ));
  }

  isAncestor(ancestorOid: string, descendantOid: string): Promise<boolean> {
    return this.resourceAdmission(() => this.git.isAncestor(this.repositoryPath, ancestorOid, descendantOid));
  }

  mergeTree(
    acceptedOid: string,
    memberOid: string,
  ): ReturnType<AcceptCoordinatorGitPort['mergeTree']> {
    return this.resourceAdmission(() => this.git.mergeTree(this.repositoryPath, acceptedOid, memberOid));
  }

  resolveRef(ref: string): Promise<string | null> {
    return this.resourceAdmission(() => this.git.resolveRef(this.repositoryPath, ref));
  }

  async validateTree(treeishOid: string): Promise<void> {
    await this.resourceAdmission(async () => {
      const entries = await this.git.listTreeRecursive(this.repositoryPath, treeishOid);
      this.treePolicy.validate(entries);
    });
  }
}
