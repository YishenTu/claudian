import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  type CollabCheckpointArtifactFact,
  type CollabCheckpointGitRef,
  type CollabProjectCheckpointManifest,
  isCollabGitOid,
} from '@claudian-collab/protocol';

import { verifyAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferCheckpointGitInput {
  readonly bundlePath: string;
  readonly refs: readonly CollabCheckpointGitRef[];
  readonly repositoryPath: string;
  readonly signal?: AbortSignal;
}

export interface ImportAuthorityTransferCheckpointGitInput {
  readonly bundlePath: string;
  readonly manifest: CollabProjectCheckpointManifest;
  readonly signal?: AbortSignal;
  readonly targetRepositoryPath: string;
}

function gitError(
  reason: string,
  code: 'authority-integrity-error' | 'cancelled' | 'operation-failed' | 'quota-exceeded'
    = 'authority-integrity-error',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'cancelled' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertRefs(refs: readonly CollabCheckpointGitRef[]): void {
  if (
    refs.length === 0
    || refs[0]?.name !== COLLAB_MAIN_REF
    || refs.some((ref, index) => (
      !isCollabGitOid(ref.oid)
      || (ref.name !== COLLAB_MAIN_REF && !ref.name.startsWith(COLLAB_MEMBER_REF_PREFIX))
      || (index > 0 && refs[index - 1].name.localeCompare(ref.name, 'en-US') >= 0)
    ))
  ) throw gitError('checkpoint-git-refs-invalid');
}

function parseHeads(stdout: Buffer): readonly CollabCheckpointGitRef[] {
  const text = stdout.toString('utf8').trim();
  if (text.length === 0) throw gitError('checkpoint-git-bundle-empty');
  return text.split('\n').map((line) => {
    const separator = line.indexOf(' ');
    if (separator < 1) throw gitError('checkpoint-git-bundle-head-invalid');
    const oid = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (!isCollabGitOid(oid)) throw gitError('checkpoint-git-bundle-head-invalid');
    return { name, oid };
  });
}

function assertExactHeads(
  actual: readonly CollabCheckpointGitRef[],
  expected: readonly CollabCheckpointGitRef[],
): void {
  if (
    actual.length !== expected.length
    || actual.some((ref, index) => (
      ref.name !== expected[index]?.name || ref.oid !== expected[index]?.oid
    ))
  ) throw gitError('checkpoint-git-bundle-ref-mismatch');
}

function assertArtifactFact(
  actual: CollabCheckpointArtifactFact,
  expected: CollabCheckpointArtifactFact,
): void {
  if (
    actual.name !== expected.name
    || actual.byteCount !== expected.byteCount
    || actual.sha256 !== expected.sha256
  ) throw gitError('checkpoint-git-bundle-artifact-mismatch');
}

async function inspectBundle(
  bundlePath: string,
  signal?: AbortSignal,
): Promise<CollabCheckpointArtifactFact> {
  const info = await lstat(bundlePath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw gitError('checkpoint-git-bundle-file-invalid');
  }
  if (
    info.size < 1
    || info.size > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes
  ) throw gitError('checkpoint-git-bundle-size-invalid', 'quota-exceeded');
  const digest = createHash('sha256');
  let byteCount = 0;
  try {
    for await (const chunk of createReadStream(bundlePath)) {
      if (signal?.aborted) throw gitError('checkpoint-git-bundle-cancelled', 'cancelled');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bytes.byteLength;
      if (byteCount > COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes) {
        throw gitError('checkpoint-git-bundle-size-invalid', 'quota-exceeded');
      }
      digest.update(bytes);
    }
  } catch (error) {
    if (error instanceof CollabError) throw error;
    throw gitError('checkpoint-git-bundle-read-failed', 'operation-failed');
  }
  if (byteCount !== info.size) throw gitError('checkpoint-git-bundle-changed');
  return {
    byteCount,
    name: 'repository.bundle',
    sha256: digest.digest('hex'),
  };
}

export class AuthorityTransferCheckpointGit {
  constructor(private readonly runner: Pick<GitCommandRunner, 'run'>) {}

  async createBundle(
    input: AuthorityTransferCheckpointGitInput,
  ): Promise<CollabCheckpointArtifactFact> {
    assertRefs(input.refs);
    await this.assertRepositoryRefs(input.repositoryPath, input.refs, input.signal);
    await rm(input.bundlePath, { force: true }).catch(() => undefined);
    try {
      await this.runner.run({
        args: ['bundle', 'create', input.bundlePath, ...input.refs.map(ref => ref.name)],
        cwd: input.repositoryPath,
        maxStdoutBytes: 64 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      return await this.verifyBundle(input);
    } catch (error) {
      await rm(input.bundlePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async verifyBundle(
    input: AuthorityTransferCheckpointGitInput,
  ): Promise<CollabCheckpointArtifactFact> {
    assertRefs(input.refs);
    await this.runner.run({
      args: ['bundle', 'verify', input.bundlePath],
      cwd: input.repositoryPath,
      maxStdoutBytes: 1024 * 1024,
      signal: input.signal,
      suppressHooks: true,
    });
    const heads = await this.runner.run({
      args: ['bundle', 'list-heads', input.bundlePath],
      cwd: input.repositoryPath,
      maxStdoutBytes: 1024 * 1024,
      signal: input.signal,
      suppressHooks: true,
    });
    assertExactHeads(parseHeads(heads.stdout), input.refs);
    return inspectBundle(input.bundlePath, input.signal);
  }

  async importIntoEmptyBareRepository(
    input: ImportAuthorityTransferCheckpointGitInput,
  ): Promise<void> {
    const manifest = verifyAuthorityTransferCheckpointManifest(input.manifest);
    const refs = manifest.refs;
    assertRefs(refs);
    const expectedArtifact = manifest.artifacts.find(
      artifact => artifact.name === 'repository.bundle',
    );
    if (expectedArtifact === undefined) throw gitError('checkpoint-git-bundle-artifact-missing');
    assertArtifactFact(await inspectBundle(input.bundlePath, input.signal), expectedArtifact);
    if (!path.isAbsolute(input.targetRepositoryPath)) {
      throw gitError('checkpoint-git-target-path-invalid');
    }
    let created = false;
    try {
      try {
        await mkdir(input.targetRepositoryPath, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw gitError('checkpoint-git-target-not-empty');
        }
        throw gitError('checkpoint-git-target-create-failed', 'operation-failed');
      }
      await this.runner.run({
        args: [
          'init',
          '--bare',
          '--initial-branch=main',
          `--object-format=${manifest.gitObjectFormat}`,
          '.',
        ],
        cwd: input.targetRepositoryPath,
        maxStdoutBytes: 64 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      await this.assertRepositoryIdentity(
        input.targetRepositoryPath,
        manifest.gitObjectFormat,
        input.signal,
      );
      await this.runner.run({
        args: ['bundle', 'verify', input.bundlePath],
        cwd: input.targetRepositoryPath,
        maxStdoutBytes: 1024 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      const heads = await this.runner.run({
        args: ['bundle', 'list-heads', input.bundlePath],
        cwd: input.targetRepositoryPath,
        maxStdoutBytes: 1024 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      assertExactHeads(parseHeads(heads.stdout), refs);
      assertArtifactFact(await inspectBundle(input.bundlePath, input.signal), expectedArtifact);
      await this.runner.run({
        args: [
          'fetch',
          '--no-tags',
          input.bundlePath,
          ...refs.map(ref => `${ref.name}:${ref.name}`),
        ],
        cwd: input.targetRepositoryPath,
        maxStdoutBytes: 1024 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      await this.assertRepositoryRefs(
        input.targetRepositoryPath,
        refs,
        input.signal,
        true,
      );
      const integrity = await this.runner.run({
        args: ['fsck', '--strict', '--unreachable', '--no-reflogs', '--no-progress'],
        cwd: input.targetRepositoryPath,
        maxStdoutBytes: 1024 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      if (
        integrity.stdout.toString('utf8').trim().length > 0
        || integrity.stderr.trim().length > 0
      ) throw gitError('checkpoint-git-target-unreachable-object');
      assertArtifactFact(await inspectBundle(input.bundlePath, input.signal), expectedArtifact);
    } catch (error) {
      if (created) {
        await rm(input.targetRepositoryPath, { force: true, recursive: true })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async assertRepositoryIdentity(
    repositoryPath: string,
    objectFormat: 'sha1' | 'sha256',
    signal?: AbortSignal,
  ): Promise<void> {
    const [head, actualObjectFormat] = await Promise.all([
      this.runner.run({
        args: ['symbolic-ref', 'HEAD'],
        cwd: repositoryPath,
        maxStdoutBytes: 64 * 1024,
        signal,
        suppressHooks: true,
      }),
      this.runner.run({
        args: ['rev-parse', '--show-object-format'],
        cwd: repositoryPath,
        maxStdoutBytes: 64 * 1024,
        signal,
        suppressHooks: true,
      }),
    ]);
    if (
      head.stdout.toString('utf8').trim() !== COLLAB_MAIN_REF
      || actualObjectFormat.stdout.toString('utf8').trim() !== objectFormat
    ) throw gitError('checkpoint-git-target-identity-invalid');
  }

  private async assertRepositoryRefs(
    repositoryPath: string,
    refs: readonly CollabCheckpointGitRef[],
    signal?: AbortSignal,
    requireNoOtherHeads = false,
  ): Promise<void> {
    const result = await this.runner.run({
      args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/'],
      cwd: repositoryPath,
      maxStdoutBytes: 1024 * 1024,
      signal,
      suppressHooks: true,
    });
    const allHeads = result.stdout.toString('utf8').trim();
    const parsed = allHeads.length === 0 ? [] : parseHeads(result.stdout);
    const selected = parsed
      .filter(ref => refs.some(expected => expected.name === ref.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    assertExactHeads(selected, refs);
    if (requireNoOtherHeads && parsed.length !== refs.length) {
      throw gitError('checkpoint-git-target-extra-ref');
    }
  }
}
