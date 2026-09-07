import path from 'node:path';

import { type CollabChangedFile } from '@claudian-collab/protocol';

import type {
  GitChangedBlob,
  GitRepositoryReadSession,
  GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import { type CollabReviewFileContent, type CollabReviewFileRequest } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const TEXT_EXTENSIONS = new Set([
  '.canvas', '.css', '.csv', '.html', '.js', '.json', '.jsx', '.md',
  '.markdown', '.mermaid', '.svg', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml',
]);

const SAFE_IMAGE_MIME_TYPES = new Map<string, NonNullable<
  Extract<CollabReviewFileContent, { kind: 'binary' }>['preview']
>['mimeType']>([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

export type ExactComparisonFileRequest = Pick<
  CollabReviewFileRequest,
  'comparisonBaseOid' | 'comparisonTargetOid' | 'file'
>;

function comparisonError(
  code: 'authority-integrity-error' | 'quota-exceeded',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({
    code,
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason, ...safeContext },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function startsWithBytes(contents: Buffer, expected: readonly number[]): boolean {
  return contents.byteLength >= expected.length
    && expected.every((byte, index) => contents[index] === byte);
}

function safeImageMimeType(
  repositoryPath: string,
  contents: Buffer,
): NonNullable<Extract<CollabReviewFileContent, { kind: 'binary' }>['preview']>['mimeType']
  | undefined {
  const extension = path.posix.extname(repositoryPath).toLocaleLowerCase('en-US');
  const mimeType = SAFE_IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) return undefined;
  switch (mimeType) {
    case 'image/gif':
      return startsWithBytes(contents, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
        || startsWithBytes(contents, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
        ? mimeType
        : undefined;
    case 'image/jpeg':
      return startsWithBytes(contents, [0xff, 0xd8, 0xff]) ? mimeType : undefined;
    case 'image/png':
      return startsWithBytes(contents, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? mimeType
        : undefined;
    case 'image/webp':
      return contents.byteLength >= 12
        && startsWithBytes(contents, [0x52, 0x49, 0x46, 0x46])
        && contents.subarray(8, 12).equals(Buffer.from('WEBP'))
        ? mimeType
        : undefined;
  }
}

function changedFile(change: GitChangedBlob): CollabChangedFile {
  if (
    (change.kind !== 'added' && (change.oldOid === undefined || change.oldSize === undefined))
    || (change.kind !== 'deleted' && (change.newOid === undefined || change.newSize === undefined))
  ) {
    throw comparisonError('authority-integrity-error', 'review-tree-entry-missing', {
      repositoryPath: change.path,
    });
  }
  const binary = !TEXT_EXTENSIONS.has(
    path.posix.extname(change.path).toLocaleLowerCase('en-US'),
  );
  const oldBytes = change.oldSize;
  const newBytes = change.newSize;
  return {
    binary,
    kind: change.kind,
    largeForReview: !binary && Math.max(oldBytes ?? 0, newBytes ?? 0)
      > CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes,
    ...(newBytes === undefined ? {} : { newBytes }),
    ...(oldBytes === undefined ? {} : { oldBytes }),
    path: change.path,
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
  };
}

function decodeUtf8(contents: Buffer | null): string | null | undefined {
  if (contents === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    return undefined;
  }
}

function exceedsLineLimit(value: string | null): boolean {
  if (value === null || value.length === 0) return false;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
    if (lines > CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines) return true;
  }
  return false;
}

function assertExpectedSize(
  expected: number | undefined,
  actual: number | undefined,
  side: 'new' | 'old',
): void {
  if (expected !== undefined && expected !== actual) {
    throw comparisonError('authority-integrity-error', 'review-blob-size-mismatch', { side });
  }
}

export function reviewFileContentFromBuffers(
  requestedFile: CollabChangedFile,
  oldContents: Buffer | null,
  newContents: Buffer | null,
): CollabReviewFileContent {
  assertExpectedSize(requestedFile.oldBytes, oldContents?.byteLength, 'old');
  assertExpectedSize(requestedFile.newBytes, newContents?.byteLength, 'new');

  const file: CollabChangedFile = {
    ...requestedFile,
    binary: requestedFile.binary,
    largeForReview: requestedFile.largeForReview,
    ...(newContents === null ? {} : { newBytes: newContents.byteLength }),
    ...(oldContents === null ? {} : { oldBytes: oldContents.byteLength }),
  };
  const oldText = requestedFile.binary ? undefined : decodeUtf8(oldContents);
  const newText = requestedFile.binary ? undefined : decodeUtf8(newContents);
  if (oldText === undefined || newText === undefined) {
    file.binary = true;
    file.largeForReview = false;
    const previewBytes = newContents ?? oldContents;
    const mimeType = previewBytes
      ? safeImageMimeType(requestedFile.path, previewBytes)
      : undefined;
    return {
      file,
      kind: 'binary',
      ...(previewBytes && mimeType
        ? { preview: { bytes: new Uint8Array(previewBytes), mimeType } }
        : {}),
    };
  }
  if (
    file.largeForReview
    || (oldContents?.byteLength ?? 0) > CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes
    || (newContents?.byteLength ?? 0) > CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes
    || exceedsLineLimit(oldText)
    || exceedsLineLimit(newText)
  ) {
    return { file: { ...file, largeForReview: true }, kind: 'large-text' };
  }
  return { file, kind: 'text', newText, oldText };
}

export class NativeGitExactComparisonRepository {
  constructor(private readonly git: GitRepositoryService) {}

  async compare(
    repositoryPath: string,
    comparisonBaseOid: string,
    comparisonTargetOid: string,
    signal?: AbortSignal,
  ): Promise<readonly CollabChangedFile[]> {
    return this.git.withReadSession(repositoryPath, 'working', session => this.compareInSession(
      session,
      comparisonBaseOid,
      comparisonTargetOid,
      signal,
    ));
  }

  async compareInSession(
    session: GitRepositoryReadSession,
    comparisonBaseOid: string,
    comparisonTargetOid: string,
    signal?: AbortSignal,
  ): Promise<readonly CollabChangedFile[]> {
    throwIfCancelled(signal);
    const changes = await session.listChangedBlobs(comparisonBaseOid, comparisonTargetOid);
    if (changes.length > CLAUDIAN_COLLAB_LIMITS.maxChangedPaths) {
      throw comparisonError('quota-exceeded', 'review-changed-path-limit', {
        limit: CLAUDIAN_COLLAB_LIMITS.maxChangedPaths,
        quota: 'maxChangedPaths',
      });
    }
    throwIfCancelled(signal);
    return changes.map(changedFile);
  }

  async readFile(
    repositoryPath: string,
    request: ExactComparisonFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabReviewFileContent> {
    return this.git.withReadSession(repositoryPath, 'working', session => this.readFileInSession(
      session,
      request,
      signal,
    ));
  }

  async readFileInSession(
    session: GitRepositoryReadSession,
    request: ExactComparisonFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabReviewFileContent> {
    throwIfCancelled(signal);
    const oldPath = request.file.previousPath ?? request.file.path;
    const requests = [
      ...(request.file.kind === 'added' ? [] : [{
        repositoryRelativePath: oldPath,
        treeish: request.comparisonBaseOid,
      }]),
      ...(request.file.kind === 'deleted' ? [] : [{
        repositoryRelativePath: request.file.path,
        treeish: request.comparisonTargetOid,
      }]),
    ];
    const contents = await session.readBlobsAtPaths(requests);
    const oldContents = request.file.kind === 'added' ? null : contents[0] ?? null;
    const newContents = request.file.kind === 'deleted'
      ? null
      : contents[request.file.kind === 'added' ? 0 : 1] ?? null;
    throwIfCancelled(signal);
    if (request.file.kind !== 'added' && oldContents === null) {
      throw comparisonError('authority-integrity-error', 'review-old-blob-missing');
    }
    if (request.file.kind !== 'deleted' && newContents === null) {
      throw comparisonError('authority-integrity-error', 'review-new-blob-missing');
    }
    return reviewFileContentFromBuffers(request.file, oldContents, newContents);
  }
}
