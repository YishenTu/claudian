import { COLLAB_PROJECT_RECOVERY_LIMITS } from '@claudian-collab/protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const denied = () => new CollabError({ code: 'authorization-denied' });

/** Owns portable credential lineage independently of individual link or claim mechanisms. */
export class MemberRecoveryCredentialRepository {
  readHashes(connection: AuthorityDatabaseConnection, memberId: string): readonly string[] {
    const hashes = new Set(connection.all('SELECT credential_sha256 FROM member_recovery_credentials WHERE member_id = ?', [memberId])
      .map(row => String(row.credential_sha256)));
    const current = connection.get('SELECT credential_hash FROM members WHERE member_id = ?', [memberId])?.credential_hash;
    if (current instanceof Uint8Array) hashes.add(Buffer.from(current).toString('hex'));
    if (hashes.size > COLLAB_PROJECT_RECOVERY_LIMITS.maxCredentialVerifiersPerMember) throw denied();
    return [...hashes].sort();
  }

  retainHashes(connection: AuthorityDatabaseConnection, memberId: string, hashes: readonly string[]): void {
    const retained = new Set([...this.readHashes(connection, memberId), ...hashes]);
    if (retained.size > COLLAB_PROJECT_RECOVERY_LIMITS.maxCredentialVerifiersPerMember) throw denied();
    for (const digest of retained) {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw denied();
      const owner = connection.get('SELECT member_id FROM member_recovery_credentials WHERE credential_sha256 = ?', [digest]);
      const bound = connection.get('SELECT member_id FROM members WHERE credential_hash = ?', [Buffer.from(digest, 'hex')]);
      if (owner && owner.member_id !== memberId || bound && bound.member_id !== memberId) throw denied();
      connection.run('INSERT OR IGNORE INTO member_recovery_credentials (member_id, credential_sha256) VALUES (?, ?)', [memberId, digest]);
    }
  }

}
