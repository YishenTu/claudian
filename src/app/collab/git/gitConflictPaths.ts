import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import type { GitRecursiveTreeEntry } from '@/app/collab/git/GitRepositoryService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface GitConflictStage {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly path: string;
  readonly stage: 1 | 2 | 3;
}

function conflictError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export function parseGitConflictStages(fields: readonly string[]): readonly GitConflictStage[] {
  const pathPolicy = new CollabPathPolicy();
  return fields.map(field => {
    const match = /^(100644|100755) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([123])\t(.+)$/.exec(field);
    if (!match) throw conflictError('git-conflict-stage-invalid');
    const validation = pathPolicy.validateRepositoryPath(match[4]);
    if (!validation.ok) throw validation.error;
    return {
      mode: match[1] as GitConflictStage['mode'],
      oid: match[2],
      path: match[4],
      stage: Number(match[3]) as GitConflictStage['stage'],
    };
  });
}

export function canonicalConflictStagePaths(
  stages: readonly GitConflictStage[],
  personalTree: readonly GitRecursiveTreeEntry[],
  acceptedTree: readonly GitRecursiveTreeEntry[],
): ReadonlyMap<string, string> {
  const trees = [personalTree, acceptedTree].map(entries => {
    const files = new Map(entries.map(entry => [entry.path, entry]));
    const directories = new Set<string>();
    for (const entry of entries) {
      for (let slash = entry.path.indexOf('/'); slash >= 0; slash = entry.path.indexOf('/', slash + 1)) {
        directories.add(entry.path.slice(0, slash));
      }
    }
    return { directories, files };
  });
  const paths = new Map<string, string>();
  for (const stage of stages) {
    if (stage.stage === 1 || trees.some(tree => tree.files.has(stage.path))) continue;
    const own = trees[stage.stage - 2];
    const other = trees[stage.stage === 2 ? 1 : 0];
    const matches: string[] = [];
    for (let tilde = stage.path.indexOf('~'); tilde >= 0; tilde = stage.path.indexOf('~', tilde + 1)) {
      const originalPath = stage.path.slice(0, tilde);
      const original = own.files.get(originalPath);
      if (
        original?.type === 'blob'
        && original.oid === stage.oid
        && original.mode === stage.mode
        && other.directories.has(originalPath)
      ) matches.push(originalPath);
    }
    if (matches.length > 1) throw conflictError('git-conflict-path-ambiguous');
    if (matches.length === 1) paths.set(stage.path, matches[0]);
  }
  return paths;
}
