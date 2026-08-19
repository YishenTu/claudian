import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import type { GitRecursiveTreeEntry } from '@/app/collab/git/GitRepositoryService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function treeError(reason: string): CollabError {
  return new CollabError({
    code: 'unsupported-file-type',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function isRegularFile(entry: GitRecursiveTreeEntry): boolean {
  return entry.type === 'blob'
    && (entry.mode === '100644' || entry.mode === '100755')
    && entry.size !== null;
}

export class CollabGitTreePolicy {
  constructor(private readonly paths = new CollabPathPolicy()) {}

  validate(entries: readonly GitRecursiveTreeEntry[]): void {
    const countError = this.paths.validateChangedPathCount(entries.length);
    if (countError) throw countError;
    if (entries.some(entry => !isRegularFile(entry))) {
      throw treeError('collab-tree-entry-unsupported');
    }
    const validation = this.paths.validateImportCandidates(entries.map(entry => ({
      kind: 'file' as const,
      path: entry.path,
      size: entry.size!,
    })));
    if (!validation.ok) {
      throw validation.aggregateError ?? validation.rejected[0]?.error
        ?? treeError('collab-tree-policy-failed');
    }
  }
}
