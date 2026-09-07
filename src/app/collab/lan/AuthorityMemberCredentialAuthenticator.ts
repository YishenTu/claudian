import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';

import type {
  CollabMember,
  CollabMemberStatus,
} from '@claudian-collab/protocol';

import {
  PendingMembershipRepository,
} from '@/app/collab/authority/PendingMembershipRepository';
import type {
  AuthorityDatabaseConnection,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface MemberCredentialDatabase {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
}

export interface AuthenticatedAuthorityMember {
  readonly member: CollabMember;
}

function authenticationError(
  code: 'authentication-failed' | 'authorization-denied' | 'membership-revoked',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: ['request-access'],
    safeContext: { reason },
  });
}

function credentialMatches(actualHash: Uint8Array, expectedHash: Uint8Array): boolean {
  return actualHash.byteLength === expectedHash.byteLength
    && timingSafeEqual(actualHash, expectedHash);
}

/** Authenticates one bound Project member without acquiring broader membership policy. */
export class AuthorityMemberCredentialAuthenticator {
  private readonly repository = new PendingMembershipRepository();

  constructor(private readonly database: MemberCredentialDatabase) {}

  authenticate(
    credential: string,
    statuses: readonly CollabMemberStatus[],
  ): Promise<AuthenticatedAuthorityMember> {
    return this.database.read((connection) => {
      if (!CREDENTIAL_PATTERN.test(credential)) {
        throw authenticationError('authentication-failed', 'member-credential-invalid');
      }
      const actualHash = createHash('sha256').update(credential, 'utf8').digest();
      let matched: AuthenticatedAuthorityMember | null = null;
      for (const record of this.repository.listCredentialRecords(connection, statuses)) {
        if (
          record.accessState === 'bound'
          && record.credentialHash !== null
          && credentialMatches(actualHash, record.credentialHash)
        ) matched = { member: record.member };
      }
      if (!matched) {
        const known = this.repository.listCredentialRecords(connection, [
          'pending',
          'active',
          'revoked',
          'left',
        ]).find(record => (
          record.accessState === 'bound'
          && record.credentialHash !== null
          && credentialMatches(actualHash, record.credentialHash)
        ));
        if (known?.member.status === 'revoked' || known?.member.status === 'left') {
          throw authenticationError('membership-revoked', 'membership-no-longer-active');
        }
        throw authenticationError(
          known ? 'authorization-denied' : 'authentication-failed',
          known ? 'membership-capability-denied' : 'member-credential-unrecognized',
        );
      }
      return matched;
    });
  }
}
