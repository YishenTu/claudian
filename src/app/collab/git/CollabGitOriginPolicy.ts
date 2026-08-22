import { isIP } from 'node:net';

import {
  collabStoppedHostRemoteUrl,
  type GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabGitOriginContext {
  readonly allowHostRemoteRepair: boolean;
  readonly projectId: string;
  readonly remoteUrl: string;
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

function originError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
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
  if (urls.length !== 1) throw originError('collab-origin-transition-mismatch');
  if (urls[0] === transition.newRemoteUrl) return;
  if (urls[0] !== transition.oldRemoteUrl) {
    throw originError('collab-origin-transition-mismatch');
  }
  await git.addRemote(transition.repositoryPath, 'origin', transition.newRemoteUrl);
  const updated = await git.listRemoteUrls(transition.repositoryPath, 'origin');
  if (updated.length !== 1 || updated[0] !== transition.newRemoteUrl) {
    throw originError('collab-origin-transition-failed');
  }
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
  if (urls.length !== 1) throw originError('collab-origin-transition-mismatch');
  if (urls[0] === transition.newRemoteUrl) return;
  if (urls[0] !== transition.oldRemoteUrl) {
    throw originError('collab-origin-transition-mismatch');
  }
  await git.addRemote(transition.repositoryPath, 'origin', transition.newRemoteUrl);
  const updated = await git.listRemoteUrls(transition.repositoryPath, 'origin');
  if (updated.length !== 1 || updated[0] !== transition.newRemoteUrl) {
    throw originError('collab-origin-transition-failed');
  }
}

export async function ensureTrustedCollabOrigin(
  git: Pick<GitRepositoryService, 'addRemote' | 'listRemoteUrls'>,
  context: CollabGitOriginContext,
  mismatchReason: string,
): Promise<void> {
  let urls = await git.listRemoteUrls(context.repositoryPath, 'origin');
  const currentUrl = urls[0];
  if (
    context.allowHostRemoteRepair
    && urls.length === 1
    && currentUrl !== undefined
    && (
      currentUrl === collabStoppedHostRemoteUrl(context.projectId)
      || isGeneratedLanHostRemoteUrl(currentUrl, context.projectId)
    )
  ) {
    await git.addRemote(context.repositoryPath, 'origin', context.remoteUrl);
    urls = await git.listRemoteUrls(context.repositoryPath, 'origin');
  }
  if (urls.length !== 1 || urls[0] !== context.remoteUrl) {
    throw originError(mismatchReason);
  }
}
