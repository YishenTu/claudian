import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import type { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { changedFileForReview } from '@/app/collab/publish/PublishSnapshotProjection';
import {
  reviewFileContentFromBuffers,
} from '@/app/collab/review/NativeGitExactComparisonRepository';
import type { WorkingTreeReviewFilePort } from '@/app/collab/review/WorkingTreeReviewService';
import { type CollabChangedFile, type CollabReviewFileContent, type CollabWorkingTreeReviewFileRequest } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function reviewError(
  code: 'path-outside-project' | 'unsupported-file-type' | 'working-tree-busy',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'working-tree-busy' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export class NativeGitWorkingTreeReviewRepository implements WorkingTreeReviewFilePort {
  constructor(
    private readonly git: GitRepositoryService,
    private readonly pathPolicy: CollabPathPolicy,
  ) {}

  async listChanges(
    repositoryPath: string,
    baseOid: string,
    headOid: string,
    signal?: AbortSignal,
  ): Promise<readonly CollabChangedFile[]> {
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const changes = await this.git.withReadSession(
      repositoryPath,
      'working',
      async session => {
        const state = await session.getWorkingTreeState();
        if (state.branch.headOid !== headOid) {
          throw reviewError('working-tree-busy', 'working-tree-review-head-changed');
        }
        return session.listWorkingTreeChangedFiles(baseOid);
      },
    );
    const projected: CollabChangedFile[] = [];
    for (const change of changes) {
      this.assertPath(change.path);
      if (change.previousPath) this.assertPath(change.previousPath);
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const workingFile = change.kind === 'deleted'
        ? undefined
        : await this.readStableWorkingFile(
          repositoryPath,
          change.path,
          false,
          signal,
        );
      projected.push(changedFileForReview({
        kind: change.kind,
        ...(workingFile === undefined ? {} : { newBytes: workingFile.size }),
        path: change.path,
        ...(change.previousPath ? { previousPath: change.previousPath } : {}),
        ...(workingFile === undefined
          ? {}
          : { workingTreeContentHash: workingFile.contentHash }),
      }));
    }
    return projected;
  }

  async readFile(
    repositoryPath: string,
    request: CollabWorkingTreeReviewFileRequest,
    signal?: AbortSignal,
  ): Promise<CollabReviewFileContent> {
    this.assertPath(request.file.path);
    if (request.file.previousPath) this.assertPath(request.file.previousPath);
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });

    const oldPath = request.file.previousPath ?? request.file.path;
    const oldContents = request.file.kind === 'added'
      ? null
      : await this.git.withReadSession(repositoryPath, 'working', async session => (
        (await session.readBlobsAtPaths([{
          repositoryRelativePath: oldPath,
          treeish: request.baseOid,
        }]))[0] ?? null
      ));
    if (request.file.kind !== 'added' && oldContents === null) {
      throw reviewError('working-tree-busy', 'working-tree-review-old-file-missing');
    }
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });

    if (request.file.kind === 'deleted') {
      await this.assertWorkingFileAbsent(repositoryPath, request.file.path);
      return reviewFileContentFromBuffers(request.file, oldContents, null);
    }
    if (
      request.file.newBytes !== undefined
      && request.file.newBytes > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes
    ) {
      const workingFile = await this.readStableWorkingFile(
        repositoryPath,
        request.file.path,
        false,
        signal,
      );
      this.assertExpectedWorkingFile(request.file, workingFile);
      return {
        file: request.file,
        kind: request.file.binary ? 'binary' : 'large-text',
      };
    }
    const workingFile = await this.readStableWorkingFile(
      repositoryPath,
      request.file.path,
      true,
      signal,
    );
    this.assertExpectedWorkingFile(request.file, workingFile);
    const newContents = workingFile.contents;
    if (!newContents) {
      throw reviewError('working-tree-busy', 'working-tree-review-file-read-missing');
    }
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    return reviewFileContentFromBuffers(request.file, oldContents, newContents);
  }

  private assertPath(repositoryPath: string): void {
    const result = this.pathPolicy.validateRepositoryPath(repositoryPath);
    if (!result.ok) throw result.error;
  }

  private async assertWorkingFileAbsent(
    repositoryPath: string,
    repositoryRelativePath: string,
  ): Promise<void> {
    const absolutePath = path.resolve(repositoryPath, repositoryRelativePath);
    if (!isContainedPath(repositoryPath, absolutePath)) {
      throw reviewError('path-outside-project', 'working-tree-review-path-outside-project');
    }
    if (await lstat(absolutePath).catch(() => null)) {
      throw reviewError('working-tree-busy', 'working-tree-review-deleted-file-returned');
    }
  }

  private assertExpectedWorkingFile(
    expected: CollabChangedFile,
    actual: StableWorkingFile,
  ): void {
    if (
      expected.workingTreeContentHash === undefined
      || expected.workingTreeContentHash !== actual.contentHash
      || (expected.newBytes !== undefined && expected.newBytes !== actual.size)
    ) {
      throw reviewError('working-tree-busy', 'working-tree-review-file-content-changed');
    }
  }

  private async readStableWorkingFile(
    repositoryPath: string,
    repositoryRelativePath: string,
    includeContents: boolean,
    signal?: AbortSignal,
  ): Promise<StableWorkingFile> {
    const absolutePath = path.resolve(repositoryPath, repositoryRelativePath);
    if (!isContainedPath(repositoryPath, absolutePath)) {
      throw reviewError('path-outside-project', 'working-tree-review-path-outside-project');
    }
    const pathStat = await lstat(absolutePath).catch(() => null);
    if (!pathStat?.isFile() || pathStat.isSymbolicLink()) {
      throw reviewError('unsupported-file-type', 'working-tree-review-file-not-regular');
    }
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    const handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow).catch(error => {
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
      throw error;
    });
    try {
      const before = await handle.stat();
      if (
        !before.isFile()
        || before.dev !== pathStat.dev
        || before.ino !== pathStat.ino
        || before.mode !== pathStat.mode
      ) {
        throw reviewError('working-tree-busy', 'working-tree-review-file-changed');
      }
      if (includeContents && before.size > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes) {
        throw reviewError('working-tree-busy', 'working-tree-review-file-too-large');
      }
      const hash = createHash('sha256');
      let contents: Buffer | undefined;
      let bytesRead = 0;
      if (includeContents) {
        contents = await handle.readFile();
        bytesRead = contents.byteLength;
        hash.update(contents);
      } else {
        try {
          for await (const chunk of handle.createReadStream({
            autoClose: false,
            signal,
          })) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytesRead += bytes.byteLength;
            hash.update(bytes);
          }
        } catch (error) {
          if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
          throw error;
        }
      }
      const after = await handle.stat();
      if (
        !after.isFile()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.mode !== before.mode
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
        || bytesRead !== before.size
      ) {
        throw reviewError('working-tree-busy', 'working-tree-review-file-changed');
      }
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
      return {
        contentHash: hash.digest('hex'),
        ...(contents ? { contents } : {}),
        size: bytesRead,
      };
    } finally {
      await handle.close();
    }
  }
}

interface StableWorkingFile {
  readonly contentHash: string;
  readonly contents?: Buffer;
  readonly size: number;
}
