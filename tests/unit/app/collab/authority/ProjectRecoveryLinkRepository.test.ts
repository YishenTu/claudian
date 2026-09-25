import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { testTime } from '@test/helpers/testClock';
import initSqlJs from 'sql.js';

import { MemberRecoveryCredentialRepository } from '@/app/collab/authority/MemberRecoveryCredentialRepository';
import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { ProjectRecoveryLinkRepository } from '@/app/collab/authority/ProjectRecoveryLinkRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';

const NOW = testTime({ days: 18 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('ProjectRecoveryLinkRepository', () => {
  it('recovers independent members, preserves exact receipts across restart, and accepts another link for the same binding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-recovery-links-'));
    const sql = await initSqlJs();
    let database = new SqlJsProjectDatabase(root, { loadSqlJs: async () => sql });
    const links = new ProjectRecoveryLinkRepository();
    try {
      await database.open();
      await database.mutate(connection => {
        new ProjectAuthorityRepository().initialize(connection, { projectId: 'project-recovery', name: 'Recovery',
          hostMemberId: 'member-host', hostDisplayName: 'Host', hostCredentialHash: Buffer.from(hash('h'.repeat(43)), 'hex'), createdAt: NOW });
        for (const [memberId, credential] of [['member-one', 'a'.repeat(43)], ['member-two', 'b'.repeat(64)]]) {
          connection.run(`INSERT INTO members (member_id, display_name, personal_ref, role, status, access_state, credential_hash, created_at, activated_at)
            VALUES (?, ?, ?, 'member', 'active', 'unbound', NULL, ?, ?)`, [memberId, memberId, `refs/heads/members/${memberId}`, NOW, NOW]);
          new MemberRecoveryCredentialRepository().retainHashes(connection, memberId, [hash(credential)]);
        }
      });
      const create = { projectId: 'project-recovery', expectedAuthorityGeneration: 1, idempotencyKey: 'issue-one' };
      const issue = (key: string, at = NOW) => database.mutate(connection => links.create(connection, 'member-host', { ...create, idempotencyKey: key }, new Date(at))).then(result => result.value);
      const first = await issue('issue-one');
      const second = await issue('issue-two');
      expect(first.token).not.toBe(second.token);
      expect(await issue('issue-one')).toEqual(first);
      const request = { ...create, idempotencyKey: 'redeem-one', recoveryLinkId: first.recoveryLinkId, token: first.token,
        proofCredential: 'a'.repeat(43), targetCredentialHash: hash('c'.repeat(43)) };
      await expect(database.mutate(connection => links.redeem(connection, { ...request, proofCredential: 'z'.repeat(43) }, new Date(NOW)))).rejects.toBeDefined();
      await expect(database.mutate(connection => links.redeem(connection, { ...request, projectId: 'project-other' }, new Date(NOW)))).rejects.toBeDefined();
      const receipt = (await database.mutate(connection => links.redeem(connection, request, new Date(NOW)))).value;
      expect(receipt).toMatchObject({ memberId: 'member-one', personalRef: 'refs/heads/members/member-one', authorityGeneration: 1 });
      const secondRequest = { ...request, idempotencyKey: 'redeem-two', recoveryLinkId: second.recoveryLinkId, token: second.token,
        proofCredential: 'b'.repeat(64), targetCredentialHash: hash('d'.repeat(43)) };
      await expect(database.mutate(connection => links.redeem(connection, { ...secondRequest, targetCredentialHash: request.targetCredentialHash }, new Date(NOW)))).rejects.toBeDefined();
      expect((await database.mutate(connection => links.redeem(connection, secondRequest, new Date(NOW)))).value.memberId).toBe('member-two');
      const third = await issue('issue-three', testTime({ days: 18, minutes: 1 }));
      expect((await database.mutate(connection => links.redeem(connection, { ...request, idempotencyKey: 'redeem-three',
        recoveryLinkId: third.recoveryLinkId, token: third.token }, new Date(testTime({ days: 18, minutes: 2 }))))).value.memberId).toBe('member-one');
      await database.close();
      database = new SqlJsProjectDatabase(root, { loadSqlJs: async () => sql });
      await database.open();
      expect((await database.mutate(connection => links.redeem(connection, request, new Date(first.expiresAt)))).value).toEqual(receipt);
      await expect(database.mutate(connection => links.redeem(connection, { ...request, idempotencyKey: 'other-intent' }, new Date(NOW)))).rejects.toBeDefined();
      await expect(issue('issue-one', first.secretReplayExpiresAt)).rejects.toBeDefined();
      expect(await database.read(connection => new PendingMembershipRepository().listCredentialRecords(connection, ['active']).length)).toBe(3);
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
