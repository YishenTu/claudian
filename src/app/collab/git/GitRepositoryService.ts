import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { type CollabFileChangeKind, collabMemberRef, isCollabGitOid, isCollabMemberId, isCollabProjectId } from '@claudian-collab/protocol';

import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import {
  COLLAB_MAIN_FETCH_REFSPEC,
  COLLAB_MEMBERS_FETCH_REFSPEC,
} from '@/app/collab/git/collabGitRefs';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import {
  type GitNetworkEnvironment,
  parseGitNulFields,
} from '@/app/collab/git/GitCommandRunner';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const SAFE_REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type GitStatusEntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked';

export interface GitStatusEntry {
  readonly indexStatus: string;
  readonly kind: GitStatusEntryKind;
  readonly originalPath?: string;
  readonly path: string;
  readonly worktreeStatus: string;
}

export interface GitWorkingTreeBranchState {
  readonly aheadBy: number | null;
  readonly behindBy: number | null;
  readonly headName: string | null;
  readonly headOid: string | null;
  readonly upstreamName: string | null;
}

export interface GitWorkingTreeState {
  readonly branch: GitWorkingTreeBranchState;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitChangedFile {
  readonly kind: CollabFileChangeKind;
  readonly path: string;
  readonly previousPath?: string;
}

export interface GitChangedBlob extends GitChangedFile {
  readonly newOid?: string;
  readonly newSize?: number;
  readonly oldOid?: string;
  readonly oldSize?: number;
}

export interface GitBlobPathRequest {
  readonly repositoryRelativePath: string;
  readonly treeish: string;
}

export interface GitBatchObjectMetadata {
  readonly oid: string;
  readonly size: number;
  readonly type: 'blob' | 'commit' | 'tag' | 'tree';
}

export interface GitDivergence {
  readonly leftOnly: number;
  readonly rightOnly: number;
}

export interface GitLocalRepositoryConfig {
  readonly memberId: string;
  readonly personalRef: string;
  readonly projectId: string;
  readonly userDisplayName: string;
}

export type GitLocalRepositoryIdentity = Pick<
  GitLocalRepositoryConfig,
  'memberId' | 'personalRef' | 'projectId'
>;

export interface GitCommitTreeInput {
  readonly identity?: {
    readonly email: string;
    readonly name: string;
  };
  readonly message: string;
  readonly parents: readonly string[];
  readonly treeOid: string;
}

export interface GitCommitFromIndexInput {
  readonly expectedRefOid: string | null;
  readonly message: string;
  readonly parents: readonly string[];
  readonly ref: string;
}

export interface GitRecursiveTreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
  readonly size: number | null;
  readonly type: 'blob' | 'commit' | 'tag' | 'tree';
}

export type GitMergeTreeResult =
  | { readonly kind: 'clean'; readonly treeOid: string }
  | { readonly kind: 'conflicting'; readonly treeOid: string | null };

export interface GitRefUpdateResult {
  readonly currentOid: string | null;
  readonly updated: boolean;
}

export interface GitCloneInput {
  readonly branch?: string;
  readonly directoryName: string;
  readonly network?: GitNetworkEnvironment;
  readonly parentDirectory: string;
  readonly remoteUrl: string;
  readonly signal?: AbortSignal;
}

interface InspectedRepository {
  readonly gitDirectory: string;
  readonly repositoryPath: string;
  readonly bare: boolean;
}

export type GitRepositoryKind = 'bare' | 'working';

export interface GitRepositoryReadSession {
  countDivergence(leftOid: string, rightOid: string): Promise<GitDivergence>;
  findMergeBase(leftOid: string, rightOid: string): Promise<string>;
  getWorkingTreeState(): Promise<GitWorkingTreeState>;
  getWorkingTreeStatus(): Promise<readonly GitStatusEntry[]>;
  isAncestor(ancestorOid: string, descendantOid: string): Promise<boolean>;
  listChangedBlobs(baseOid: string, headOid: string): Promise<readonly GitChangedBlob[]>;
  listChangedFiles(baseOid: string, headOid: string): Promise<readonly GitChangedFile[]>;
  listWorkingTreeChangedFiles(baseOid: string): Promise<readonly GitChangedFile[]>;
  listRemoteUrls(remote: string): Promise<readonly string[]>;
  listTreeRecursive(commitOid: string): Promise<readonly GitRecursiveTreeEntry[]>;
  mergeTree(acceptedOid: string, memberOid: string): Promise<GitMergeTreeResult>;
  readBlobsAtPaths(
    requests: readonly GitBlobPathRequest[],
  ): Promise<readonly (Buffer | null)[]>;
  resolveRef(ref: string): Promise<string | null>;
  resolveRefs(refs: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}

function repositoryError(
  code: 'path-invalid' | 'repository-invalid' | 'stale-main',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({
    code,
    safeContext: { reason, ...safeContext },
    recoveryActions: code === 'stale-main' ? ['retry'] : ['open-diagnostics'],
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function assertOid(oid: string): void {
  if (!isCollabGitOid(oid)) {
    throw repositoryError('repository-invalid', 'git-oid-invalid');
  }
}

function assertRef(ref: string): void {
  if (
    ref !== 'HEAD'
    && (
      !ref.startsWith('refs/')
      || ref.length > 255
      || ref.includes('..')
      || ref.includes('@{')
      || [...ref].some(character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x20 || '~^:?*\\['.includes(character);
      })
      || ref.endsWith('/')
      || ref.endsWith('.')
      || ref.endsWith('.lock')
      || ref.split('/').some(segment => segment.length === 0 || segment.startsWith('.'))
    )
  ) {
    throw repositoryError('repository-invalid', 'git-ref-invalid');
  }
}

function assertMessage(message: string): void {
  if (message.length === 0 || message.length > 1_000 || message.includes('\u0000')) {
    throw repositoryError('repository-invalid', 'git-message-invalid');
  }
}

function splitLeadingFields(
  record: string,
  fieldCount: number,
): { fields: readonly string[]; remainder: string } | null {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(' ', cursor);
    if (separator < 0) return null;
    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  if (cursor >= record.length) return null;
  return { fields, remainder: record.slice(cursor) };
}

function machineOutputError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    safeContext: { reason },
    recoveryActions: ['open-diagnostics'],
  });
}

function parseGitStatusRecords(records: readonly string[]): readonly GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.startsWith('1 ')) {
      const parsed = splitLeadingFields(record, 8);
      const xy = parsed?.fields[1];
      if (!parsed || !xy || xy.length !== 2) throw machineOutputError('git-status-malformed');
      entries.push({
        indexStatus: xy[0],
        kind: 'ordinary',
        path: parsed.remainder,
        worktreeStatus: xy[1],
      });
      continue;
    }
    if (record.startsWith('2 ')) {
      const parsed = splitLeadingFields(record, 9);
      const xy = parsed?.fields[1];
      const originalPath = records[index + 1];
      if (!parsed || !xy || xy.length !== 2 || originalPath === undefined) {
        throw machineOutputError('git-status-rename-malformed');
      }
      entries.push({
        indexStatus: xy[0],
        kind: 'renamed',
        originalPath,
        path: parsed.remainder,
        worktreeStatus: xy[1],
      });
      index += 1;
      continue;
    }
    if (record.startsWith('u ')) {
      const parsed = splitLeadingFields(record, 10);
      const xy = parsed?.fields[1];
      if (!parsed || !xy || xy.length !== 2) throw machineOutputError('git-status-unmerged-malformed');
      entries.push({
        indexStatus: xy[0],
        kind: 'unmerged',
        path: parsed.remainder,
        worktreeStatus: xy[1],
      });
      continue;
    }
    if (record.startsWith('? ')) {
      entries.push({
        indexStatus: '?',
        kind: 'untracked',
        path: record.slice(2),
        worktreeStatus: '?',
      });
      continue;
    }
    if (record.startsWith('! ')) continue;
    throw machineOutputError('git-status-malformed');
  }
  return entries;
}

export function parseGitWorkingTreeState(output: Uint8Array): GitWorkingTreeState {
  const records = parseGitNulFields(output);
  let recordIndex = 0;
  let headOid: string | null = null;
  let headName: string | null = null;
  let upstreamName: string | null = null;
  let aheadBy: number | null = null;
  let behindBy: number | null = null;
  const seen = new Set<string>();
  while ((records[recordIndex] ?? '').startsWith('# ')) {
    const record = records[recordIndex] ?? '';
    recordIndex += 1;
    const separator = record.indexOf(' ', 2);
    if (separator < 0) throw machineOutputError('git-status-branch-malformed');
    const field = record.slice(2, separator);
    const value = record.slice(separator + 1);
    if (!field.startsWith('branch.')) continue;
    if (seen.has(field)) throw machineOutputError('git-status-branch-duplicate');
    seen.add(field);
    switch (field) {
      case 'branch.oid':
        if (value !== '(initial)' && !isCollabGitOid(value)) {
          throw machineOutputError('git-status-branch-oid-malformed');
        }
        headOid = value === '(initial)' ? null : value;
        break;
      case 'branch.head':
        if (value.length === 0) throw machineOutputError('git-status-branch-head-malformed');
        headName = value === '(detached)' ? null : value;
        break;
      case 'branch.upstream':
        if (value.length === 0) {
          throw machineOutputError('git-status-branch-upstream-malformed');
        }
        upstreamName = value;
        break;
      case 'branch.ab': {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        const parsedAhead = Number(match?.[1]);
        const parsedBehind = Number(match?.[2]);
        if (
          !match
          || !Number.isSafeInteger(parsedAhead)
          || !Number.isSafeInteger(parsedBehind)
        ) {
          throw machineOutputError('git-status-branch-divergence-malformed');
        }
        aheadBy = parsedAhead;
        behindBy = parsedBehind;
        break;
      }
      default:
        break;
    }
  }
  return {
    branch: { aheadBy, behindBy, headName, headOid, upstreamName },
    entries: parseGitStatusRecords(records.slice(recordIndex)),
  };
}

function changeKind(status: string): CollabFileChangeKind | null {
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'C':
      return 'copied';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    case 'R':
      return 'renamed';
    case 'T':
      return 'type-changed';
    default:
      return null;
  }
}

export function parseGitNameStatus(output: Uint8Array): readonly GitChangedFile[] {
  const fields = parseGitNulFields(output);
  const changes: GitChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw machineOutputError('git-name-status-malformed');
    const kind = changeKind(status);
    if (!kind) throw machineOutputError('git-name-status-unknown');
    if (kind === 'renamed' || kind === 'copied') {
      const previousPath = fields[index++];
      const nextPath = fields[index++];
      if (previousPath === undefined || nextPath === undefined) {
        throw machineOutputError('git-name-status-rename-malformed');
      }
      changes.push({ kind, path: nextPath, previousPath });
      continue;
    }
    const changedPath = fields[index++];
    if (changedPath === undefined) throw machineOutputError('git-name-status-malformed');
    changes.push({ kind, path: changedPath });
  }
  return changes;
}

export function parseGitRawDiff(output: Uint8Array): readonly GitChangedBlob[] {
  const fields = parseGitNulFields(output);
  const changes: GitChangedBlob[] = [];
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index++];
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([A-Z][0-9]*)$/.exec(
      metadata ?? '',
    );
    if (!match) throw machineOutputError('git-raw-diff-malformed');
    const kind = changeKind(match[5]);
    if (!kind) throw machineOutputError('git-raw-diff-status-unknown');
    const oldOid = /^0+$/.test(match[3]) ? undefined : match[3];
    const newOid = /^0+$/.test(match[4]) ? undefined : match[4];
    if (kind === 'renamed' || kind === 'copied') {
      const previousPath = fields[index++];
      const nextPath = fields[index++];
      if (!previousPath || !nextPath || !oldOid || !newOid) {
        throw machineOutputError('git-raw-diff-rename-malformed');
      }
      changes.push({ kind, newOid, oldOid, path: nextPath, previousPath });
      continue;
    }
    const changedPath = fields[index++];
    if (!changedPath) throw machineOutputError('git-raw-diff-malformed');
    if ((kind === 'added') !== (oldOid === undefined)) {
      throw machineOutputError('git-raw-diff-object-mismatch');
    }
    if ((kind === 'deleted') !== (newOid === undefined)) {
      throw machineOutputError('git-raw-diff-object-mismatch');
    }
    changes.push({
      kind,
      ...(newOid ? { newOid } : {}),
      ...(oldOid ? { oldOid } : {}),
      path: changedPath,
    });
  }
  return changes;
}

export function parseGitBatchObjectMetadata(
  output: Uint8Array,
  expectedCount: number,
): readonly (GitBatchObjectMetadata | null)[] {
  const text = Buffer.from(output).toString('utf8');
  const lines = text.length === 0 ? [] : text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== expectedCount) {
    throw machineOutputError('git-batch-metadata-count-invalid');
  }
  return lines.map(line => {
    if (/^\S+ missing$/.test(line)) return null;
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|commit|tag|tree) (\d+)$/.exec(line);
    const size = Number(match?.[3]);
    if (!match || !Number.isSafeInteger(size) || size < 0) {
      throw machineOutputError('git-batch-metadata-malformed');
    }
    return {
      oid: match[1],
      size,
      type: match[2] as GitBatchObjectMetadata['type'],
    };
  });
}

export function parseGitBatchBlobSequence(
  output: Uint8Array,
  expectedCount: number,
): readonly (Buffer | null)[] {
  const buffer = Buffer.from(output);
  const results: Array<Buffer | null> = [];
  let cursor = 0;
  for (let index = 0; index < expectedCount; index += 1) {
    const headerEnd = buffer.indexOf(0x0a, cursor);
    if (headerEnd < 0) throw machineOutputError('git-batch-header-malformed');
    const header = buffer.subarray(cursor, headerEnd).toString('ascii');
    cursor = headerEnd + 1;
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?:.+ missing$/.test(header)) {
      results.push(null);
      continue;
    }
    const objectMatch = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|commit|tag|tree) (\d+)$/.exec(
      header,
    );
    if (objectMatch && objectMatch[2] !== 'blob') {
      throw repositoryError('repository-invalid', 'git-tree-entry-invalid');
    }
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob (\d+)$/.exec(header);
    const size = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(size) || size < 0) {
      throw machineOutputError('git-batch-header-malformed');
    }
    if (size > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes) {
      throw new CollabError({
        code: 'quota-exceeded',
        safeContext: { limit: CLAUDIAN_COLLAB_LIMITS.maxBlobBytes, quota: 'maxBlobBytes' },
      });
    }
    const terminatorIndex = cursor + size;
    if (terminatorIndex >= buffer.byteLength || buffer[terminatorIndex] !== 0x0a) {
      throw machineOutputError('git-batch-body-malformed');
    }
    results.push(Buffer.from(buffer.subarray(cursor, terminatorIndex)));
    cursor = terminatorIndex + 1;
  }
  if (cursor !== buffer.byteLength) {
    throw machineOutputError('git-batch-body-malformed');
  }
  return results;
}

export function parseGitRecursiveTree(
  output: Uint8Array,
): readonly GitRecursiveTreeEntry[] {
  return parseGitNulFields(output).map(record => {
    const separator = record.indexOf('\t');
    const metadata = separator < 0 ? '' : record.slice(0, separator);
    const repositoryPath = separator < 0 ? '' : record.slice(separator + 1);
    const match = /^(\d{6}) (blob|commit|tag|tree) ([0-9a-f]{40}(?:[0-9a-f]{24})?) +(\d+|-)$/.exec(
      metadata,
    );
    if (!match || repositoryPath.length === 0) {
      throw machineOutputError('git-tree-listing-malformed');
    }
    const size = match[4] === '-' ? null : Number(match[4]);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw machineOutputError('git-tree-listing-size-invalid');
    }
    return {
      mode: match[1],
      oid: match[3],
      path: repositoryPath,
      size,
      type: match[2] as GitRecursiveTreeEntry['type'],
    };
  });
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function parseSingleOid(output: Buffer): string {
  const value = output.toString('utf8').trim();
  assertOid(value);
  return value;
}

export function parseGitBatchBlob(output: Uint8Array, expectedOid: string): Buffer {
  assertOid(expectedOid);
  const buffer = Buffer.from(output);
  const headerEnd = buffer.indexOf(0x0a);
  if (headerEnd < 0) throw machineOutputError('git-batch-header-malformed');
  const header = buffer.subarray(0, headerEnd).toString('ascii');
  const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob (\d+)$/.exec(header);
  if (!match || match[1] !== expectedOid) {
    throw machineOutputError('git-batch-header-malformed');
  }
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes) {
    throw new CollabError({
      code: 'quota-exceeded',
      safeContext: { limit: CLAUDIAN_COLLAB_LIMITS.maxBlobBytes, quota: 'maxBlobBytes' },
    });
  }
  const contentsStart = headerEnd + 1;
  const terminatorIndex = contentsStart + size;
  if (buffer.byteLength !== terminatorIndex + 1 || buffer[terminatorIndex] !== 0x0a) {
    throw machineOutputError('git-batch-body-malformed');
  }
  return Buffer.from(buffer.subarray(contentsStart, terminatorIndex));
}

function assertSafeIdentity(value: string, field: string): void {
  if (
    value.length === 0
    || value.length > 200
    || value.includes('\u0000')
    || value.includes('\r')
    || value.includes('\n')
  ) {
    throw repositoryError('repository-invalid', `${field}-invalid`);
  }
}

function assertRemoteName(remote: string): void {
  if (!SAFE_REMOTE_PATTERN.test(remote)) {
    throw repositoryError('repository-invalid', 'git-remote-name-invalid');
  }
}

function assertRemoteUrl(remoteUrl: string): void {
  if (path.isAbsolute(remoteUrl)) return;
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw repositoryError('repository-invalid', 'git-remote-url-invalid');
  }
  const loopbackHttp = parsed.protocol === 'http:' && (
    parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === 'localhost'
  );
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp)
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw repositoryError('repository-invalid', 'git-remote-url-invalid');
  }
}

function assertRefspec(refspec: string): void {
  const normalized = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  const parts = normalized.split(':');
  if (parts.length !== 2) throw repositoryError('repository-invalid', 'git-refspec-invalid');
  const [source, target] = parts;
  if (source === undefined || target === undefined) {
    throw repositoryError('repository-invalid', 'git-refspec-invalid');
  }
  const sourceWildcards = [...source].filter(character => character === '*').length;
  const targetWildcards = [...target].filter(character => character === '*').length;
  if (sourceWildcards !== targetWildcards || sourceWildcards > 1) {
    throw repositoryError('repository-invalid', 'git-refspec-invalid');
  }
  assertRef(source.replaceAll('*', 'wildcard'));
  assertRef(target.replaceAll('*', 'wildcard'));
}

export class GitRepositoryService {
  constructor(
    private readonly runner: GitCommandRunner,
    private readonly pathPolicy = new CollabPathPolicy(),
  ) {}

  async withReadSession<T>(
    repositoryPath: string,
    expectedKind: GitRepositoryKind,
    operation: (session: GitRepositoryReadSession) => Promise<T>,
  ): Promise<T> {
    const repository = await this.#inspectRepository(repositoryPath);
    if ((repository.bare ? 'bare' : 'working') !== expectedKind) {
      throw repositoryError(
        'repository-invalid',
        expectedKind === 'bare'
          ? 'git-read-session-repository-not-bare'
          : 'git-read-session-repository-not-working',
      );
    }
    let active = true;
    const ensureActive = (): void => {
      if (!active) throw repositoryError('repository-invalid', 'git-read-session-expired');
    };
    const session: GitRepositoryReadSession = {
      countDivergence: async (leftOid, rightOid) => {
        ensureActive();
        return this.#countDivergenceUnchecked(repository.repositoryPath, leftOid, rightOid);
      },
      findMergeBase: async (leftOid, rightOid) => {
        ensureActive();
        return this.#findMergeBaseUnchecked(repository.repositoryPath, leftOid, rightOid);
      },
      getWorkingTreeState: async () => {
        ensureActive();
        return this.#getWorkingTreeStateUnchecked(repository.repositoryPath);
      },
      getWorkingTreeStatus: async () => {
        ensureActive();
        return this.#getWorkingTreeStatusUnchecked(repository.repositoryPath);
      },
      isAncestor: async (ancestorOid, descendantOid) => {
        ensureActive();
        return this.#isAncestorUnchecked(repository.repositoryPath, ancestorOid, descendantOid);
      },
      listChangedBlobs: async (baseOid, headOid) => {
        ensureActive();
        return this.#listChangedBlobsUnchecked(repository.repositoryPath, baseOid, headOid);
      },
      listChangedFiles: async (baseOid, headOid) => {
        ensureActive();
        return this.#listChangedFilesUnchecked(repository.repositoryPath, baseOid, headOid);
      },
      listWorkingTreeChangedFiles: async baseOid => {
        ensureActive();
        return this.#listWorkingTreeChangedFilesUnchecked(
          repository.repositoryPath,
          baseOid,
        );
      },
      listRemoteUrls: async remote => {
        ensureActive();
        return this.#listRemoteUrlsUnchecked(repository.repositoryPath, remote);
      },
      listTreeRecursive: async commitOid => {
        ensureActive();
        return this.#listTreeRecursiveUnchecked(repository.repositoryPath, commitOid);
      },
      mergeTree: async (acceptedOid, memberOid) => {
        ensureActive();
        return this.#mergeTreeUnchecked(repository.repositoryPath, acceptedOid, memberOid);
      },
      readBlobsAtPaths: async requests => {
        ensureActive();
        return this.#readBlobsAtPathsUnchecked(repository.repositoryPath, requests);
      },
      resolveRef: async ref => {
        ensureActive();
        return this.#resolveRefUnchecked(repository.repositoryPath, ref);
      },
      resolveRefs: async refs => {
        ensureActive();
        return this.#resolveRefsUnchecked(repository.repositoryPath, refs);
      },
    };
    try {
      return await operation(session);
    } finally {
      active = false;
    }
  }

  async initializeWorkingRepository(repositoryPath: string): Promise<void> {
    await this.#assertInitializationTarget(repositoryPath);
    await this.runner.run({
      args: ['init', '--quiet', '--initial-branch=main'],
      cwd: repositoryPath,
    });
    const repository = await this.#inspectRepository(repositoryPath);
    if (repository.bare) throw repositoryError('repository-invalid', 'working-repository-is-bare');
  }

  async initializeBareRepository(repositoryPath: string): Promise<void> {
    await this.#assertInitializationTarget(repositoryPath);
    await this.runner.run({
      args: ['init', '--bare', '--quiet', '--initial-branch=main'],
      cwd: repositoryPath,
    });
    const repository = await this.#inspectRepository(repositoryPath);
    if (!repository.bare) throw repositoryError('repository-invalid', 'authority-repository-not-bare');
  }

  async configureLocalRepository(
    repositoryPath: string,
    config: GitLocalRepositoryConfig,
  ): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    if (!isCollabMemberId(config.memberId) || !isCollabProjectId(config.projectId)) {
      throw repositoryError('repository-invalid', 'collab-local-config-id-invalid');
    }
    assertRef(config.personalRef);
    if (config.personalRef !== collabMemberRef(config.memberId)) {
      throw repositoryError('repository-invalid', 'collab-personal-ref-mismatch');
    }
    assertSafeIdentity(config.userDisplayName, 'member-display-name');
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['claudian.projectId', config.projectId],
      ['claudian.memberId', config.memberId],
      ['claudian.personalRef', config.personalRef],
      ['user.name', config.userDisplayName],
      ['user.email', `${config.memberId}@members.claudian.local`],
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'true'],
      ['core.quotepath', 'false'],
      ['fetch.prune', 'true'],
    ];
    for (const [key, value] of entries) {
      await this.runner.run({
        args: ['config', '--local', '--replace-all', key, value],
        cwd: repositoryPath,
      });
    }
  }

  async assertLocalRepositoryIdentity(
    repositoryPath: string,
    expected: GitLocalRepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    const repository = await this.#inspectRepository(repositoryPath, signal);
    if (repository.bare) {
      throw repositoryError('repository-invalid', 'collab-local-repository-is-bare');
    }
    if (!isCollabMemberId(expected.memberId) || !isCollabProjectId(expected.projectId)) {
      throw repositoryError('repository-invalid', 'collab-local-config-id-invalid');
    }
    assertRef(expected.personalRef);
    if (expected.personalRef !== collabMemberRef(expected.memberId)) {
      throw repositoryError('repository-invalid', 'collab-personal-ref-mismatch');
    }
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['claudian.projectId', expected.projectId],
      ['claudian.memberId', expected.memberId],
      ['claudian.personalRef', expected.personalRef],
    ];
    for (const [key, value] of entries) {
      const result = await this.runner.run({
        acceptedExitCodes: [0, 1],
        args: ['config', '--local', '--get-all', key],
        cwd: repository.repositoryPath,
        maxStdoutBytes: 4_096,
        signal,
      });
      const values = result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      if (result.exitCode !== 0 || values.length !== 1 || values[0] !== value) {
        throw repositoryError('repository-invalid', 'collab-local-config-mismatch', {
          key,
        });
      }
    }
  }

  async configureHostedRepository(repositoryPath: string): Promise<void> {
    const repository = await this.#inspectRepository(repositoryPath);
    if (!repository.bare) {
      throw repositoryError('repository-invalid', 'hosted-repository-not-bare');
    }
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['receive.fsckObjects', 'true'],
      ['receive.denyDeletes', 'true'],
      ['receive.denyNonFastForwards', 'true'],
    ];
    for (const [key, value] of entries) {
      await this.runner.run({
        args: ['config', '--local', '--replace-all', key, value],
        cwd: repositoryPath,
      });
    }
  }

  async measureStorageBytes(repositoryPath: string): Promise<number> {
    const repository = await this.#inspectRepository(repositoryPath);
    if (!repository.bare) {
      throw repositoryError('repository-invalid', 'hosted-repository-not-bare');
    }
    const root = await realpath(repository.gitDirectory);
    let total = 0;
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        throw repositoryError('repository-invalid', 'git-storage-inspection-failed');
      }
      for (const name of names) {
        const candidate = path.join(directory, name);
        const candidateStat = await lstat(candidate).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw repositoryError('repository-invalid', 'git-storage-inspection-failed');
        });
        if (candidateStat === null) continue;
        if (candidateStat.isSymbolicLink()) {
          throw repositoryError('repository-invalid', 'git-storage-symlink-invalid');
        }
        if (candidateStat.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (!candidateStat.isFile()) {
          throw repositoryError('repository-invalid', 'git-storage-entry-invalid');
        }
        total += candidateStat.size;
        if (!Number.isSafeInteger(total)) {
          throw repositoryError('repository-invalid', 'git-storage-size-invalid');
        }
      }
    }
    return total;
  }

  async stageAll(repositoryPath: string, signal?: AbortSignal): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    await this.runner.run({ args: ['add', '-A', '--'], cwd: repositoryPath, signal });
  }

  async createCommitFromIndex(
    repositoryPath: string,
    input: GitCommitFromIndexInput,
  ): Promise<string> {
    await this.#inspectRepository(repositoryPath);
    assertRef(input.ref);
    input.parents.forEach(assertOid);
    if (input.expectedRefOid !== null) assertOid(input.expectedRefOid);
    const treeOid = parseSingleOid((await this.runner.run({
      args: ['write-tree'],
      cwd: repositoryPath,
    })).stdout);
    const commitOid = await this.#commitTreeUnchecked(repositoryPath, {
      message: input.message,
      parents: input.parents,
      treeOid,
    });
    const update = await this.#compareAndSwapRefUnchecked(
      repositoryPath,
      input.ref,
      commitOid,
      input.expectedRefOid,
    );
    if (!update.updated) throw repositoryError('stale-main', 'git-ref-cas-failed');
    return commitOid;
  }

  async getWorkingTreeStatus(repositoryPath: string): Promise<readonly GitStatusEntry[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#getWorkingTreeStatusUnchecked(repository.repositoryPath);
  }

   async #getWorkingTreeStatusUnchecked(
    repositoryPath: string,
  ): Promise<readonly GitStatusEntry[]> {
    return (await this.#getWorkingTreeStateUnchecked(repositoryPath)).entries;
  }

  async getWorkingTreeState(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<GitWorkingTreeState> {
    const repository = await this.#inspectRepository(repositoryPath, signal);
    return this.#getWorkingTreeStateUnchecked(repository.repositoryPath, signal);
  }

   async #getWorkingTreeStateUnchecked(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<GitWorkingTreeState> {
    const result = await this.runner.run({
      args: ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      cwd: repositoryPath,
      signal,
    });
    const state = parseGitWorkingTreeState(result.stdout);
    for (const entry of state.entries) {
      this.#requireRepositoryPath(entry.path);
      if (entry.originalPath) this.#requireRepositoryPath(entry.originalPath);
    }
    return state;
  }

  async resolveRef(
    repositoryPath: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const repository = await this.#inspectRepository(repositoryPath, signal);
    return this.#resolveRefUnchecked(repository.repositoryPath, ref, signal);
  }

  async resolveRefs(
    repositoryPath: string,
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string | null>> {
    const repository = await this.#inspectRepository(repositoryPath, signal);
    return this.#resolveRefsUnchecked(repository.repositoryPath, refs, signal);
  }

   async #resolveRefUnchecked(
    repositoryPath: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    assertRef(ref);
    const result = await this.runner.run({
      acceptedExitCodes: [0, 128],
      args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      cwd: repositoryPath,
      signal,
    });
    return result.exitCode === 0 ? parseSingleOid(result.stdout) : null;
  }

   async #resolveRefsUnchecked(
    repositoryPath: string,
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string | null>> {
    refs.forEach(assertRef);
    if (refs.length === 0) return new Map();
    if (refs.length > 128) throw repositoryError('repository-invalid', 'git-ref-batch-too-large');
    const result = await this.runner.run({
      args: ['cat-file', '--batch-check'],
      cwd: repositoryPath,
      maxStdoutBytes: refs.length * 192,
      signal,
      stdin: refs.map(ref => `${ref}^{commit}\n`).join(''),
    });
    const metadata = parseGitBatchObjectMetadata(result.stdout, refs.length);
    const resolved = new Map<string, string | null>();
    refs.forEach((ref, index) => {
      const object = metadata[index];
      if (object !== null && object?.type !== 'commit') {
        throw machineOutputError('git-ref-object-not-commit');
      }
      resolved.set(ref, object?.oid ?? null);
    });
    return resolved;
  }

  async createRef(repositoryPath: string, ref: string, oid: string): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    const result = await this.#compareAndSwapRefUnchecked(repositoryPath, ref, oid, null);
    if (!result.updated) throw repositoryError('stale-main', 'git-ref-already-exists');
  }

  async compareAndSwapRef(
    repositoryPath: string,
    ref: string,
    nextOid: string,
    expectedOid: string,
  ): Promise<GitRefUpdateResult> {
    await this.#inspectRepository(repositoryPath);
    return this.#compareAndSwapRefUnchecked(repositoryPath, ref, nextOid, expectedOid);
  }

  async deleteRefIfMatches(
    repositoryPath: string,
    ref: string,
    expectedOid: string,
  ): Promise<GitRefUpdateResult> {
    await this.#inspectRepository(repositoryPath);
    assertRef(ref);
    assertOid(expectedOid);
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1, 128],
      args: [
        'update-ref',
        '-m',
        'Claudian Collab delete',
        '-d',
        ref,
        expectedOid,
      ],
      cwd: repositoryPath,
    });
    if (result.exitCode === 0) return { currentOid: null, updated: true };
    return {
      currentOid: await this.resolveRef(repositoryPath, ref),
      updated: false,
    };
  }

  async isAncestor(
    repositoryPath: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#isAncestorUnchecked(repository.repositoryPath, ancestorOid, descendantOid);
  }

   async #isAncestorUnchecked(
    repositoryPath: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean> {
    assertOid(ancestorOid);
    assertOid(descendantOid);
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: ['merge-base', '--is-ancestor', ancestorOid, descendantOid],
      cwd: repositoryPath,
    });
    return result.exitCode === 0;
  }

  async findMergeBase(
    repositoryPath: string,
    leftOid: string,
    rightOid: string,
  ): Promise<string> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#findMergeBaseUnchecked(repository.repositoryPath, leftOid, rightOid);
  }

   async #findMergeBaseUnchecked(
    repositoryPath: string,
    leftOid: string,
    rightOid: string,
  ): Promise<string> {
    assertOid(leftOid);
    assertOid(rightOid);
    return parseSingleOid((await this.runner.run({
      args: ['merge-base', leftOid, rightOid],
      cwd: repositoryPath,
      maxStdoutBytes: 128,
    })).stdout);
  }

  async countDivergence(
    repositoryPath: string,
    leftOid: string,
    rightOid: string,
  ): Promise<GitDivergence> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#countDivergenceUnchecked(repository.repositoryPath, leftOid, rightOid);
  }

   async #countDivergenceUnchecked(
    repositoryPath: string,
    leftOid: string,
    rightOid: string,
  ): Promise<GitDivergence> {
    assertOid(leftOid);
    assertOid(rightOid);
    const result = await this.runner.run({
      args: ['rev-list', '--left-right', '--count', `${leftOid}...${rightOid}`],
      cwd: repositoryPath,
      maxStdoutBytes: 128,
    });
    const match = /^(\d+)\s+(\d+)\s*$/.exec(result.stdout.toString('utf8'));
    const leftOnly = Number(match?.[1]);
    const rightOnly = Number(match?.[2]);
    if (
      !match
      || !Number.isSafeInteger(leftOnly)
      || !Number.isSafeInteger(rightOnly)
    ) {
      throw machineOutputError('git-divergence-output-invalid');
    }
    return { leftOnly, rightOnly };
  }

  async listChangedFiles(
    repositoryPath: string,
    baseOid: string,
    headOid: string,
  ): Promise<readonly GitChangedFile[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#listChangedFilesUnchecked(repository.repositoryPath, baseOid, headOid);
  }

   async #listChangedFilesUnchecked(
    repositoryPath: string,
    baseOid: string,
    headOid: string,
  ): Promise<readonly GitChangedFile[]> {
    assertOid(baseOid);
    assertOid(headOid);
    const result = await this.runner.run({
      args: [
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-z',
        '-M',
        baseOid,
        headOid,
      ],
      cwd: repositoryPath,
    });
    const changes = parseGitNameStatus(result.stdout);
    for (const change of changes) {
      this.#requireRepositoryPath(change.path);
      if (change.previousPath) this.#requireRepositoryPath(change.previousPath);
    }
    return changes;
  }

  async listChangedBlobs(
    repositoryPath: string,
    baseOid: string,
    headOid: string,
  ): Promise<readonly GitChangedBlob[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#listChangedBlobsUnchecked(repository.repositoryPath, baseOid, headOid);
  }

  async listWorkingTreeChangedFiles(
    repositoryPath: string,
    baseOid: string,
  ): Promise<readonly GitChangedFile[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#listWorkingTreeChangedFilesUnchecked(repository.repositoryPath, baseOid);
  }

   async #listWorkingTreeChangedFilesUnchecked(
    repositoryPath: string,
    baseOid: string,
  ): Promise<readonly GitChangedFile[]> {
    assertOid(baseOid);
    const result = await this.runner.run({
      args: ['diff', '--name-status', '-z', '-M', baseOid, '--'],
      cwd: repositoryPath,
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    const changes = [...parseGitNameStatus(result.stdout)];
    const changedPaths = new Set(changes.map(change => change.path));
    const workingTree = await this.#getWorkingTreeStateUnchecked(repositoryPath);
    for (const entry of workingTree.entries) {
      if (entry.kind !== 'untracked' || changedPaths.has(entry.path)) continue;
      changes.push({ kind: 'added', path: entry.path });
      changedPaths.add(entry.path);
    }
    changes.sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ));
    for (const change of changes) {
      this.#requireRepositoryPath(change.path);
      if (change.previousPath) this.#requireRepositoryPath(change.previousPath);
    }
    return changes;
  }

   async #listChangedBlobsUnchecked(
    repositoryPath: string,
    baseOid: string,
    headOid: string,
  ): Promise<readonly GitChangedBlob[]> {
    assertOid(baseOid);
    assertOid(headOid);
    const result = await this.runner.run({
      args: [
        'diff-tree',
        '--no-commit-id',
        '--raw',
        '-r',
        '-z',
        '--full-index',
        '-M',
        baseOid,
        headOid,
      ],
      cwd: repositoryPath,
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    const changes = parseGitRawDiff(result.stdout);
    const uniqueOids = [...new Set(changes.flatMap(change => [
      ...(change.oldOid ? [change.oldOid] : []),
      ...(change.newOid ? [change.newOid] : []),
    ]))];
    const metadata = uniqueOids.length === 0
      ? []
      : parseGitBatchObjectMetadata((await this.runner.run({
        args: ['cat-file', '--batch-check'],
        cwd: repositoryPath,
        maxStdoutBytes: uniqueOids.length * 160,
        stdin: uniqueOids.map(oid => `${oid}\n`).join(''),
      })).stdout, uniqueOids.length);
    const sizes = new Map<string, number>();
    uniqueOids.forEach((oid, index) => {
      const object = metadata[index];
      if (!object || object.oid !== oid || object.type !== 'blob') {
        throw machineOutputError('git-changed-object-not-blob');
      }
      sizes.set(oid, object.size);
    });
    return changes.map(change => {
      this.#requireRepositoryPath(change.path);
      if (change.previousPath) this.#requireRepositoryPath(change.previousPath);
      return {
        ...change,
        ...(change.newOid ? { newSize: sizes.get(change.newOid)! } : {}),
        ...(change.oldOid ? { oldSize: sizes.get(change.oldOid)! } : {}),
      };
    });
  }

  async readBlobAtPath(
    repositoryPath: string,
    commitOid: string,
    repositoryRelativePath: string,
  ): Promise<Buffer | null> {
    const repository = await this.#inspectRepository(repositoryPath);
    assertOid(commitOid);
    this.#requireRepositoryPath(repositoryRelativePath);
    const treeResult = await this.runner.run({
      args: ['ls-tree', '-z', commitOid, '--', repositoryRelativePath],
      cwd: repository.repositoryPath,
    });
    const records = parseGitNulFields(treeResult.stdout);
    if (records.length === 0) return null;
    if (records.length !== 1) throw repositoryError('repository-invalid', 'git-tree-path-ambiguous');
    const match = /^(\d{6}) (blob|tree) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.*)$/.exec(records[0]);
    if (!match || match[2] !== 'blob' || match[4] !== repositoryRelativePath) {
      throw repositoryError('repository-invalid', 'git-tree-entry-invalid');
    }
    return this.#readBlobUnchecked(repository.repositoryPath, match[3]);
  }

  async readBlobsAtPaths(
    repositoryPath: string,
    requests: readonly GitBlobPathRequest[],
  ): Promise<readonly (Buffer | null)[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#readBlobsAtPathsUnchecked(repository.repositoryPath, requests);
  }

   async #readBlobsAtPathsUnchecked(
    repositoryPath: string,
    requests: readonly GitBlobPathRequest[],
  ): Promise<readonly (Buffer | null)[]> {
    if (requests.length === 0) return [];
    if (requests.length > 3) {
      throw repositoryError('repository-invalid', 'git-blob-path-batch-too-large');
    }
    for (const request of requests) {
      assertOid(request.treeish);
      this.#requireRepositoryPath(request.repositoryRelativePath);
    }
    const result = await this.runner.run({
      args: ['cat-file', '--batch'],
      cwd: repositoryPath,
      maxStdoutBytes: requests.length * (CLAUDIAN_COLLAB_LIMITS.maxBlobBytes + 256),
      stdin: requests.map(request => (
        `${request.treeish}:${request.repositoryRelativePath}\n`
      )).join(''),
    });
    return parseGitBatchBlobSequence(result.stdout, requests.length);
  }

  async listTreeRecursive(
    repositoryPath: string,
    commitOid: string,
  ): Promise<readonly GitRecursiveTreeEntry[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#listTreeRecursiveUnchecked(repository.repositoryPath, commitOid);
  }

   async #listTreeRecursiveUnchecked(
    repositoryPath: string,
    commitOid: string,
  ): Promise<readonly GitRecursiveTreeEntry[]> {
    assertOid(commitOid);
    const result = await this.runner.run({
      args: ['ls-tree', '-r', '-z', '-l', '--full-tree', commitOid],
      cwd: repositoryPath,
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    return parseGitRecursiveTree(result.stdout);
  }

  async commitTree(repositoryPath: string, input: GitCommitTreeInput): Promise<string> {
    await this.#inspectRepository(repositoryPath);
    return this.#commitTreeUnchecked(repositoryPath, input);
  }

  async mergeTree(
    repositoryPath: string,
    acceptedOid: string,
    memberOid: string,
  ): Promise<GitMergeTreeResult> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#mergeTreeUnchecked(repository.repositoryPath, acceptedOid, memberOid);
  }

   async #mergeTreeUnchecked(
    repositoryPath: string,
    acceptedOid: string,
    memberOid: string,
  ): Promise<GitMergeTreeResult> {
    assertOid(acceptedOid);
    assertOid(memberOid);
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: ['merge-tree', '--write-tree', acceptedOid, memberOid],
      cwd: repositoryPath,
      maxStdoutBytes: 4 * 1024 * 1024,
    });
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)(?:\r?\n|$)/.exec(
      result.stdout.toString('utf8'),
    );
    const treeOid = match?.[1] ?? null;
    if (result.exitCode === 0) {
      if (!treeOid) throw repositoryError('repository-invalid', 'git-merge-tree-output-invalid');
      return { kind: 'clean', treeOid };
    }
    return { kind: 'conflicting', treeOid };
  }

  async addRemote(
    repositoryPath: string,
    remote: string,
    remoteUrl: string,
  ): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    assertRemoteName(remote);
    assertRemoteUrl(remoteUrl);
    await this.runner.run({
      args: ['config', '--local', '--replace-all', `remote.${remote}.url`, remoteUrl],
      cwd: repositoryPath,
    });
  }

  async removeRemote(repositoryPath: string, remote: string): Promise<void> {
    const repository = await this.#inspectRepository(repositoryPath);
    assertRemoteName(remote);
    if ((await this.#listRemoteUrlsUnchecked(repository.repositoryPath, remote)).length === 0) {
      return;
    }
    await this.runner.run({
      args: ['remote', 'remove', remote],
      cwd: repository.repositoryPath,
    });
  }

  async configureOriginFetchRefspecs(repositoryPath: string): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    const key = 'remote.origin.fetch';
    await this.runner.run({
      args: [
        'config',
        '--local',
        '--replace-all',
        key,
        COLLAB_MAIN_FETCH_REFSPEC,
      ],
      cwd: repositoryPath,
    });
    await this.runner.run({
      args: [
        'config',
        '--local',
        '--add',
        key,
        COLLAB_MEMBERS_FETCH_REFSPEC,
      ],
      cwd: repositoryPath,
    });
  }

  async listRemoteUrls(
    repositoryPath: string,
    remote: string,
  ): Promise<readonly string[]> {
    const repository = await this.#inspectRepository(repositoryPath);
    return this.#listRemoteUrlsUnchecked(repository.repositoryPath, remote);
  }

   async #listRemoteUrlsUnchecked(
    repositoryPath: string,
    remote: string,
  ): Promise<readonly string[]> {
    assertRemoteName(remote);
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1],
      args: ['config', '-z', '--get-all', `remote.${remote}.url`],
      cwd: repositoryPath,
      maxStdoutBytes: 16 * 1024,
    });
    return result.exitCode === 0 ? parseGitNulFields(result.stdout) : [];
  }

  async fetch(
    repositoryPath: string,
    remote: string,
    refspecs: readonly string[],
    network?: GitNetworkEnvironment,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    assertRemoteName(remote);
    refspecs.forEach(assertRefspec);
    await this.runner.run({
      args: ['fetch', '--quiet', '--no-tags', remote, ...refspecs],
      cwd: repositoryPath,
      network,
      signal,
    });
  }

  async fetchFromUrl(
    repositoryPath: string,
    remoteUrl: string,
    refspecs: readonly string[],
    network?: GitNetworkEnvironment,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    assertRemoteUrl(remoteUrl);
    refspecs.forEach(assertRefspec);
    await this.runner.run({
      args: ['fetch', '--quiet', '--no-tags', remoteUrl, ...refspecs],
      cwd: repositoryPath,
      network,
      signal,
    });
  }

  async push(
    repositoryPath: string,
    remote: string,
    refspec: string,
    network?: GitNetworkEnvironment,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    assertRemoteName(remote);
    assertRefspec(refspec);
    await this.runner.run({
      args: ['push', '--porcelain', remote, refspec],
      cwd: repositoryPath,
      network,
      signal,
    });
  }

  async pushToUrl(
    repositoryPath: string,
    remoteUrl: string,
    refspec: string,
    network?: GitNetworkEnvironment,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    assertRemoteUrl(remoteUrl);
    assertRefspec(refspec);
    await this.runner.run({
      args: ['push', '--porcelain', remoteUrl, refspec],
      cwd: repositoryPath,
      network,
      signal,
    });
  }

  async cloneRepository(input: GitCloneInput): Promise<string> {
    assertRemoteUrl(input.remoteUrl);
    if (
      input.branch !== undefined
      && input.branch !== 'main'
      && (
        !input.branch.startsWith('members/')
        || !isCollabMemberId(input.branch.slice('members/'.length))
      )
    ) {
      throw repositoryError('repository-invalid', 'git-clone-branch-invalid');
    }
    const childResult = this.pathPolicy.validateRepositoryPath(input.directoryName);
    if (!childResult.ok || input.directoryName.includes('/')) {
      throw repositoryError('path-invalid', 'git-clone-directory-invalid');
    }
    const parentStat = await lstat(input.parentDirectory).catch(() => null);
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
      throw repositoryError('path-invalid', 'git-clone-parent-invalid');
    }
    const clonePath = path.join(input.parentDirectory, input.directoryName);
    if (await stat(clonePath).then(() => true, () => false)) {
      throw repositoryError('path-invalid', 'git-clone-destination-exists');
    }
    await this.runner.run({
      args: [
        'clone',
        '--quiet',
        '--no-tags',
        ...(input.branch ? ['--branch', input.branch, '--single-branch'] : []),
        input.remoteUrl,
        input.directoryName,
      ],
      cwd: input.parentDirectory,
      network: input.network,
      signal: input.signal,
    });
    await this.#inspectRepository(clonePath);
    await this.configureOriginFetchRefspecs(clonePath);
    return clonePath;
  }

  async installHook(
    repositoryPath: string,
    hookName: 'pre-receive',
    contents: string,
  ): Promise<string> {
    const repository = await this.#inspectRepository(repositoryPath);
    if (!contents.startsWith('#!') || contents.includes('\u0000')) {
      throw repositoryError('repository-invalid', 'git-hook-invalid');
    }
    const hooksDirectory = path.join(repository.gitDirectory, 'hooks');
    const canonicalGitDirectory = await realpath(repository.gitDirectory);
    const canonicalHooksDirectory = await realpath(hooksDirectory).catch(() => null);
    if (!canonicalHooksDirectory || !isContainedPath(canonicalGitDirectory, canonicalHooksDirectory)) {
      throw repositoryError('repository-invalid', 'git-hooks-boundary-invalid');
    }
    const hookPath = path.join(canonicalHooksDirectory, hookName);
    const existing = await lstat(hookPath).catch(() => null);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw repositoryError('repository-invalid', 'git-hook-boundary-invalid');
    }
    const tempPath = path.join(canonicalHooksDirectory, `.${hookName}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempPath, 'wx', 0o700);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      if (process.platform !== 'win32') await chmod(tempPath, 0o700);
      await rename(tempPath, hookPath);
      return hookPath;
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw repositoryError('repository-invalid', 'git-hook-write-failed');
    }
  }

  async assertHealthy(repositoryPath: string): Promise<void> {
    await this.#inspectRepository(repositoryPath);
    await this.runner.run({
      args: ['fsck', '--full', '--strict', '--no-dangling'],
      cwd: repositoryPath,
      maxStdoutBytes: 4 * 1024 * 1024,
    });
  }

   async #assertInitializationTarget(repositoryPath: string): Promise<void> {
    const targetStat = await lstat(repositoryPath).catch(() => null);
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
      throw repositoryError('path-invalid', 'git-initialization-target-invalid');
    }
  }

   async #inspectRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<InspectedRepository> {
    throwIfCancelled(signal);
    const rootStat = await lstat(repositoryPath).catch(() => null);
    throwIfCancelled(signal);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw repositoryError('repository-invalid', 'git-repository-root-invalid');
    }
    const canonicalRepositoryPath = await realpath(repositoryPath).catch(() => null);
    throwIfCancelled(signal);
    if (!canonicalRepositoryPath) {
      throw repositoryError('repository-invalid', 'git-repository-root-invalid');
    }
    const repositoryResult = await this.runner.run({
      acceptedExitCodes: [0, 128],
      args: [
        'rev-parse',
        '--absolute-git-dir',
        '--is-bare-repository',
        '--show-toplevel',
      ],
      cwd: canonicalRepositoryPath,
      maxStdoutBytes: 32 * 1024,
      signal,
    });
    const fields = repositoryResult.stdout.toString('utf8').trim().split(/\r?\n/);
    const gitDirectory = await realpath(fields[0] ?? '')
      .catch(() => null);
    throwIfCancelled(signal);
    if (!gitDirectory) throw repositoryError('repository-invalid', 'git-directory-invalid');
    const bareText = fields[1];
    if (bareText !== 'true' && bareText !== 'false') {
      throw repositoryError('repository-invalid', 'git-bare-output-invalid');
    }
    const bare = bareText === 'true';
    if (bare) {
      if (repositoryResult.exitCode !== 128 || fields.length !== 2) {
        throw repositoryError('repository-invalid', 'git-bare-output-invalid');
      }
      if (gitDirectory !== canonicalRepositoryPath) {
        throw repositoryError('repository-invalid', 'git-bare-boundary-invalid');
      }
    } else {
      if (repositoryResult.exitCode !== 0 || fields.length !== 3) {
        throw repositoryError('repository-invalid', 'git-working-output-invalid');
      }
      const topLevel = await realpath(fields[2] ?? '')
        .catch(() => null);
      throwIfCancelled(signal);
      if (
        topLevel !== canonicalRepositoryPath
        || !isContainedPath(canonicalRepositoryPath, gitDirectory)
      ) {
        throw repositoryError('repository-invalid', 'git-working-boundary-invalid');
      }
    }
    return {
      bare,
      gitDirectory,
      repositoryPath: canonicalRepositoryPath,
    };
  }

   async #commitTreeUnchecked(
    repositoryPath: string,
    input: GitCommitTreeInput,
  ): Promise<string> {
    assertOid(input.treeOid);
    input.parents.forEach(assertOid);
    assertMessage(input.message);
    const args: string[] = [];
    if (input.identity) {
      assertSafeIdentity(input.identity.name, 'commit-identity-name');
      assertSafeIdentity(input.identity.email, 'commit-identity-email');
    }
    args.push('commit-tree', input.treeOid);
    for (const parent of input.parents) args.push('-p', parent);
    return parseSingleOid((await this.runner.run({
      args,
      cwd: repositoryPath,
      identity: input.identity,
      stdin: `${input.message}\n`,
    })).stdout);
  }

   async #compareAndSwapRefUnchecked(
    repositoryPath: string,
    ref: string,
    nextOid: string,
    expectedOid: string | null,
  ): Promise<GitRefUpdateResult> {
    assertRef(ref);
    assertOid(nextOid);
    if (expectedOid !== null) assertOid(expectedOid);
    const zeroOid = '0'.repeat(nextOid.length);
    const result = await this.runner.run({
      acceptedExitCodes: [0, 1, 128],
      args: [
        'update-ref',
        '-m',
        'Claudian Collab update',
        ref,
        nextOid,
        expectedOid ?? zeroOid,
      ],
      cwd: repositoryPath,
    });
    if (result.exitCode === 0) return { currentOid: nextOid, updated: true };
    const currentOid = await this.resolveRef(repositoryPath, ref);
    return { currentOid, updated: false };
  }

   async #readBlobUnchecked(repositoryPath: string, oid: string): Promise<Buffer> {
    assertOid(oid);
    const result = await this.runner.run({
      args: ['cat-file', '--batch'],
      cwd: repositoryPath,
      maxStdoutBytes: CLAUDIAN_COLLAB_LIMITS.maxBlobBytes + 256,
      stdin: `${oid}\n`,
    });
    return parseGitBatchBlob(result.stdout, oid);
  }

   #requireRepositoryPath(repositoryPath: string): void {
    const result = this.pathPolicy.validateRepositoryPath(repositoryPath);
    if (!result.ok) throw result.error;
  }
}
