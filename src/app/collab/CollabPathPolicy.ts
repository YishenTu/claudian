import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { isWindowsReservedName } from '@/core/collab/WindowsPortablePath';

const RESERVED_ROOTS = new Set([
  '.claudian',
  '.git',
  'workspace',
]);
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const INVALID_WINDOWS_CHARACTER = /[<>:"\\|?*]/;

export interface CollabPathPolicyOptions {
  readonly obsidianConfigDirectory?: string;
}

export type CollabImportCandidateKind =
  | 'file'
  | 'symlink'
  | 'junction'
  | 'gitlink'
  | 'other';

export interface CollabImportCandidate {
  readonly path: string;
  readonly size: number;
  readonly kind: CollabImportCandidateKind;
}

export type CollabPathValidationResult =
  | {
    readonly ok: true;
    readonly path: string;
    readonly comparisonKey: string;
  }
  | {
    readonly ok: false;
    readonly error: CollabError;
  };

export interface CollabImportRejection {
  readonly candidate: CollabImportCandidate;
  readonly error: CollabError;
}

export interface CollabImportValidationResult {
  readonly ok: boolean;
  readonly accepted: readonly CollabImportCandidate[];
  readonly rejected: readonly CollabImportRejection[];
  readonly totalBytes: number;
  readonly aggregateError?: CollabError;
}

function pathError(
  code: 'path-invalid' | 'path-not-portable',
  reason: string,
  repositoryPath?: string,
): CollabError {
  return new CollabError({
    code,
    safeContext: {
      reason,
      ...(repositoryPath === undefined ? {} : { repositoryPath }),
    },
  });
}

function quotaError(
  quota: keyof typeof CLAUDIAN_COLLAB_LIMITS,
  actual: number,
): CollabError {
  return new CollabError({
    code: 'quota-exceeded',
    safeContext: {
      actual,
      limit: CLAUDIAN_COLLAB_LIMITS[quota],
      quota,
    },
    recoveryActions: ['open-diagnostics'],
  });
}

function hasValidMeasuredSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function candidateIdentity(candidate: CollabImportCandidate): string {
  return `${candidate.kind}\u0000${candidate.size}`;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export class CollabPathPolicy {
  private readonly reservedRoots: ReadonlySet<string>;

  constructor(options: CollabPathPolicyOptions = {}) {
    const reservedRoots = new Set(RESERVED_ROOTS);
    const configDirectory = options.obsidianConfigDirectory;
    if (configDirectory) {
      if (configDirectory.includes('/') || configDirectory.includes('\\')) {
        throw pathError('path-invalid', 'obsidian-config-directory-invalid');
      }
      reservedRoots.add(configDirectory.normalize('NFC').toLocaleLowerCase('en-US'));
    }
    this.reservedRoots = reservedRoots;
  }

  validateRepositoryPath(repositoryPath: string): CollabPathValidationResult {
    if (
      repositoryPath.length === 0
      || repositoryPath.startsWith('/')
      || repositoryPath.startsWith('\\\\')
      || WINDOWS_ABSOLUTE_PATH.test(repositoryPath)
    ) {
      return {
        ok: false,
        error: pathError('path-invalid', 'path-must-be-relative'),
      };
    }

    if (repositoryPath.length > CLAUDIAN_COLLAB_LIMITS.maxRepositoryPathUtf16) {
      return {
        ok: false,
        error: pathError('path-not-portable', 'repository-path-too-long', repositoryPath),
      };
    }

    const segments = repositoryPath.split('/');
    for (const segment of segments) {
      if (segment.length === 0 || segment === '.' || segment === '..') {
        return {
          ok: false,
          error: pathError('path-invalid', 'invalid-path-segment', repositoryPath),
        };
      }
      if (segment.length > CLAUDIAN_COLLAB_LIMITS.maxPathSegmentUtf16) {
        return {
          ok: false,
          error: pathError('path-not-portable', 'path-segment-too-long', repositoryPath),
        };
      }
      if (
        containsControlCharacter(segment)
        || INVALID_WINDOWS_CHARACTER.test(segment)
        || /[. ]$/.test(segment)
        || isWindowsReservedName(segment)
      ) {
        return {
          ok: false,
          error: pathError('path-not-portable', 'unsupported-path-segment', repositoryPath),
        };
      }
      if (this.reservedRoots.has(segment.normalize('NFC').toLocaleLowerCase('en-US'))) {
        return {
          ok: false,
          error: pathError('path-invalid', 'reserved-directory', repositoryPath),
        };
      }
    }

    return {
      comparisonKey: repositoryPath.normalize('NFC').toLocaleLowerCase('en-US'),
      ok: true,
      path: repositoryPath,
    };
  }

  validateImportCandidates(
    candidates: readonly CollabImportCandidate[],
  ): CollabImportValidationResult {
    const rejectedByIndex = new Map<number, CollabError>();
    const comparisonGroups = new Map<string, number[]>();
    const exactCandidates = new Map<string, { index: number; identity: string }>();
    const duplicateIndexes = new Set<number>();

    for (const [index, candidate] of candidates.entries()) {
      const pathResult = this.validateRepositoryPath(candidate.path);
      if (!pathResult.ok) {
        rejectedByIndex.set(index, pathResult.error);
        continue;
      }
      if (candidate.kind !== 'file') {
        rejectedByIndex.set(index, new CollabError({
          code: 'unsupported-file-type',
          safeContext: { kind: candidate.kind, repositoryPath: candidate.path },
        }));
        continue;
      }
      if (!hasValidMeasuredSize(candidate.size)) {
        rejectedByIndex.set(index, pathError(
          'path-invalid',
          'invalid-file-size',
          candidate.path,
        ));
        continue;
      }
      if (candidate.size > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes) {
        rejectedByIndex.set(index, quotaError('maxBlobBytes', candidate.size));
        continue;
      }

      const exact = exactCandidates.get(candidate.path);
      if (exact) {
        if (exact.identity === candidateIdentity(candidate)) {
          duplicateIndexes.add(index);
          continue;
        }
        const error = pathError('path-not-portable', 'ambiguous-duplicate-path', candidate.path);
        rejectedByIndex.set(exact.index, error);
        rejectedByIndex.set(index, error);
        continue;
      }
      exactCandidates.set(candidate.path, { index, identity: candidateIdentity(candidate) });

      const indexes = comparisonGroups.get(pathResult.comparisonKey) ?? [];
      indexes.push(index);
      comparisonGroups.set(pathResult.comparisonKey, indexes);
    }

    for (const indexes of comparisonGroups.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        rejectedByIndex.set(index, pathError(
          'path-not-portable',
          'portability-collision',
          candidates[index]?.path,
        ));
      }
    }

    const accepted: CollabImportCandidate[] = [];
    const rejected: CollabImportRejection[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const error = rejectedByIndex.get(index);
      if (error) {
        rejected.push({ candidate, error });
      } else if (!duplicateIndexes.has(index)) {
        accepted.push(candidate);
      }
    }

    const totalBytes = accepted.reduce((total, candidate) => total + candidate.size, 0);
    const aggregateError = totalBytes > CLAUDIAN_COLLAB_LIMITS.maxCheckoutBytes
      ? quotaError('maxCheckoutBytes', totalBytes)
      : undefined;
    return {
      accepted,
      ...(aggregateError === undefined ? {} : { aggregateError }),
      ok: rejected.length === 0 && aggregateError === undefined,
      rejected,
      totalBytes,
    };
  }

  validateChangedPathCount(count: number): CollabError | null {
    return this.validateQuota(count, 'maxChangedPaths');
  }

  validateReceivedPackSize(bytes: number): CollabError | null {
    return this.validateQuota(bytes, 'maxReceivedPackBytes');
  }

  validateCommentSize(bytes: number): CollabError | null {
    return this.validateQuota(bytes, 'maxCommentBytes');
  }

  validateHostRepositorySize(bytes: number): CollabError | null {
    return this.validateQuota(bytes, 'hostRepositorySoftLimitBytes');
  }

  classifyTextDiff(bytes: number, lines: number): 'text' | 'opaque' {
    if (!hasValidMeasuredSize(bytes) || !hasValidMeasuredSize(lines)) return 'opaque';
    return bytes <= CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes
      && lines <= CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines
      ? 'text'
      : 'opaque';
  }

  private validateQuota(
    actual: number,
    quota: keyof typeof CLAUDIAN_COLLAB_LIMITS,
  ): CollabError | null {
    if (!hasValidMeasuredSize(actual) || actual > CLAUDIAN_COLLAB_LIMITS[quota]) {
      return quotaError(quota, actual);
    }
    return null;
  }
}
