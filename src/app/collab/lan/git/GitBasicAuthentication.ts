import { TextDecoder } from 'node:util';

import { type CollabMemberStatus, isCollabMemberId } from '@claudian/collab-protocol';

import type { CollabGitService } from '@/app/collab/lan/git/GitHttpRoute';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface GitMembershipAuthenticator {
  authenticateMemberCredential(
    credential: string,
    statuses: readonly CollabMemberStatus[],
  ): Promise<{ readonly member: { readonly id: string } }>;
}

export interface AuthenticateGitBasicRequestInput {
  readonly authenticateMemberCredential:
    GitMembershipAuthenticator['authenticateMemberCredential'];
  readonly authorization: string | null;
  readonly service: CollabGitService;
}

export interface AuthenticatedGitMember {
  readonly memberId: string;
}

function authenticationError(reason: string): CollabError {
  return new CollabError({
    code: 'authentication-failed',
    recoveryActions: ['request-access'],
    safeContext: { reason },
  });
}

function decodeBasicAuthorization(authorization: string | null): {
  credential: string;
  memberId: string;
} {
  const match = authorization ? /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization) : null;
  if (!match || !BASE64_PATTERN.test(match[1]) || match[1].length % 4 !== 0) {
    throw authenticationError('git-basic-auth-invalid');
  }
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) {
    throw authenticationError('git-basic-auth-invalid');
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw authenticationError('git-basic-auth-invalid');
  }
  const separator = decoded.indexOf(':');
  if (separator < 1 || separator !== decoded.lastIndexOf(':')) {
    throw authenticationError('git-basic-auth-invalid');
  }
  const memberId = decoded.slice(0, separator);
  const credential = decoded.slice(separator + 1);
  if (!isCollabMemberId(memberId) || !CREDENTIAL_PATTERN.test(credential)) {
    throw authenticationError('git-basic-auth-invalid');
  }
  return { credential, memberId };
}

export async function authenticateGitBasicRequest(
  input: AuthenticateGitBasicRequestInput,
): Promise<AuthenticatedGitMember> {
  const parsed = decodeBasicAuthorization(input.authorization);
  const statuses: readonly CollabMemberStatus[] = input.service === 'git-upload-pack'
    ? ['pending', 'active']
    : ['active'];
  const authenticated = await input.authenticateMemberCredential(
    parsed.credential,
    statuses,
  );
  if (authenticated.member.id !== parsed.memberId) {
    throw authenticationError('git-basic-identity-mismatch');
  }
  return { memberId: parsed.memberId };
}
