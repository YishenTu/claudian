import { isIP } from 'node:net';

import { type GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabGitOriginContext {
  readonly projectId: string;
  readonly remoteUrl: string | null;
  readonly repositoryPath: string;
}

export interface CollabTrustedOriginTransition {
  readonly newRemoteUrl: string;
  readonly oldRemoteUrl: string;
  readonly projectId: string;
  readonly repositoryPath: string;
}

function isGeneratedLanHostRemoteUrl(remoteUrl: string, projectId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:'
    && parsed.username.length === 0
    && parsed.password.length === 0
    && parsed.search.length === 0
    && parsed.hash.length === 0
    && parsed.port.length > 0
    && isIP(parsed.hostname) === 4
    && parsed.pathname === `/v1/git/${projectId}/repository.git`;
}

function isRepairableLanHostRemoteUrl(remoteUrl: string, projectId: string): boolean {
  return remoteUrl === `https://127.0.0.1:1/claudian-collab/host-stopped/${projectId}`
    || isGeneratedLanHostRemoteUrl(remoteUrl, projectId);
}

function originError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

async function writeVerifiedOrigin(
  git: Pick<GitRepositoryService, 'addRemote' | 'listRemoteUrls'>,
  repositoryPath: string,
  remoteUrl: string,
): Promise<void> {
  await git.addRemote(repositoryPath, 'origin', remoteUrl);
  const updated = await git.listRemoteUrls(repositoryPath, 'origin');
  if (updated.length !== 1 || updated[0] !== remoteUrl) {
    throw originError('collab-origin-transition-failed');
  }
}

export async function rotateTrustedCollabOrigin(
  git: Pick<GitRepositoryService, 'addRemote' | 'listRemoteUrls'>,
  transition: CollabTrustedOriginTransition,
): Promise<void> {
  if (
    !isGeneratedLanHostRemoteUrl(transition.oldRemoteUrl, transition.projectId)
    || !isGeneratedLanHostRemoteUrl(transition.newRemoteUrl, transition.projectId)
  ) {
    throw originError('collab-origin-transition-invalid');
  }
  const urls = await git.listRemoteUrls(transition.repositoryPath, 'origin');
  if (urls.length === 0) {
    await writeVerifiedOrigin(git, transition.repositoryPath, transition.newRemoteUrl);
    return;
  }
  if (urls.length !== 1) throw originError('collab-origin-transition-mismatch');
  if (urls[0] === transition.newRemoteUrl) return;
  const currentUrl = urls[0];
  if (
    currentUrl === undefined
    || !isRepairableLanHostRemoteUrl(currentUrl, transition.projectId)
  ) {
    throw originError('collab-origin-transition-mismatch');
  }
  await writeVerifiedOrigin(git, transition.repositoryPath, transition.newRemoteUrl);
}

export async function rotateCloudBootstrapOrigin(
  git: Pick<GitRepositoryService, 'addRemote' | 'listRemoteUrls'>,
  transition: CollabTrustedOriginTransition,
): Promise<void> {
  let parsed: URL;
  let canonicalNewRemoteUrl: string;
  try {
    parsed = new URL(transition.newRemoteUrl);
    canonicalNewRemoteUrl = cloudProjectGitRemoteUrl(parsed.origin, transition.projectId);
  } catch {
    throw originError('collab-origin-transition-invalid');
  }
  if (
    !isGeneratedLanHostRemoteUrl(transition.oldRemoteUrl, transition.projectId)
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || transition.newRemoteUrl !== canonicalNewRemoteUrl
  ) {
    throw originError('collab-origin-transition-invalid');
  }
  const urls = await git.listRemoteUrls(transition.repositoryPath, 'origin');
  if (urls.length === 0) {
    await writeVerifiedOrigin(git, transition.repositoryPath, transition.newRemoteUrl);
    return;
  }
  if (urls.length !== 1) throw originError('collab-origin-transition-mismatch');
  if (urls[0] === transition.newRemoteUrl) return;
  const currentUrl = urls[0];
  if (
    currentUrl === undefined
    || !isRepairableLanHostRemoteUrl(currentUrl, transition.projectId)
  ) {
    throw originError('collab-origin-transition-mismatch');
  }
  await writeVerifiedOrigin(git, transition.repositoryPath, transition.newRemoteUrl);
}

export async function rotateAuthorityTransferOrigin(
  git: Pick<GitRepositoryService, 'addRemote' | 'listRemoteUrls'>,
  transition: CollabTrustedOriginTransition,
): Promise<void> {
  const sourceIsLan = isGeneratedLanHostRemoteUrl(
    transition.oldRemoteUrl,
    transition.projectId,
  );
  const targetIsLan = isGeneratedLanHostRemoteUrl(
    transition.newRemoteUrl,
    transition.projectId,
  );
  let sourceIsCloud: boolean;
  let targetIsCloud: boolean;
  try {
    sourceIsCloud = transition.oldRemoteUrl === cloudProjectGitRemoteUrl(
      new URL(transition.oldRemoteUrl).origin,
      transition.projectId,
    );
    targetIsCloud = transition.newRemoteUrl === cloudProjectGitRemoteUrl(
      new URL(transition.newRemoteUrl).origin,
      transition.projectId,
    );
  } catch {
    throw originError('collab-origin-transition-invalid');
  }
  if (
    (sourceIsLan === sourceIsCloud)
    || (targetIsLan === targetIsCloud)
    || sourceIsLan === targetIsLan
  ) {
    throw originError('collab-origin-transition-invalid');
  }
  const urls = await git.listRemoteUrls(transition.repositoryPath, 'origin');
  if (urls.length === 0) {
    await writeVerifiedOrigin(git, transition.repositoryPath, transition.newRemoteUrl);
    return;
  }
  if (urls.length !== 1) throw originError('collab-origin-transition-mismatch');
  if (urls[0] === transition.newRemoteUrl) return;
  const sourceWasFencedLanHost = sourceIsLan
    && urls[0] === `https://127.0.0.1:1/claudian-collab/host-stopped/${transition.projectId}`;
  if (urls[0] !== transition.oldRemoteUrl && !sourceWasFencedLanHost) {
    throw originError('collab-origin-transition-mismatch');
  }
  await writeVerifiedOrigin(git, transition.repositoryPath, transition.newRemoteUrl);
}

export async function ensureTrustedCollabOrigin(
  git: Pick<GitRepositoryService, 'addRemote' | 'listRemoteUrls'>,
  context: CollabGitOriginContext,
  mismatchReason: string,
): Promise<void> {
  const urls = await git.listRemoteUrls(context.repositoryPath, 'origin');
  if (urls.length === 0) {
    if (context.remoteUrl === null) return;
    await writeVerifiedOrigin(git, context.repositoryPath, context.remoteUrl);
    return;
  }
  if (context.remoteUrl === null || urls.length !== 1 || urls[0] !== context.remoteUrl) {
    throw originError(mismatchReason);
  }
}
