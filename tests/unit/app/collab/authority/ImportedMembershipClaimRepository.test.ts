import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { testTime } from '@test/helpers/testClock';
import initSqlJs from 'sql.js';

import { ImportedMembershipClaimRepository } from '@/app/collab/authority/ImportedMembershipClaimRepository';
import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SQLJSProjectDatabase } from '@/app/collab/authority/SQLJSProjectDatabase';

const PROJECT_ID = 'project-recovery';
const NOW = testTime({ days: 18 });
const HOST = 'member-host';
const MEMBER = 'member-offline';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('ImportedMembershipClaimRepository', () => {
  it('issues after source expiry, rotates the old claim, and binds the same Member atomically across restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-imported-claims-'));
    const sql = await initSqlJs();
    let database = new SQLJSProjectDatabase(root, { loadSqlJs: async () => sql });
    const claims = new ImportedMembershipClaimRepository();
    try {
      await database.open();
      const key = generateKeyPairSync('ed25519');
      await database.mutate(connection => {
        new ProjectAuthorityRepository().initialize(connection, {
          projectId: PROJECT_ID, name: 'Recovery', hostMemberId: HOST, hostDisplayName: 'Host',
          hostCredentialHash: Buffer.alloc(32, 1), createdAt: NOW,
        });
        connection.run('UPDATE authority_metadata SET authority_generation = 4');
        connection.run('UPDATE project SET manager_set_generation = 1');
        connection.run(`INSERT INTO members (member_id, display_name, personal_ref, role, status, access_state, credential_hash, created_at, activated_at)
          VALUES (?, 'Offline', ?, 'member', 'active', 'unbound', NULL, ?, ?)`, [MEMBER, `refs/heads/members/${MEMBER}`, NOW, NOW]);
        claims.initialize(connection, {
          projectId: PROJECT_ID, authorityGeneration: 4, transferId: 'transfer-return-to-lan',
          checkpointSha256: 'b'.repeat(64), sourceClaimsExpireAt: testTime({ days: 5 }),
          receiptPrivateKey: key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
          receiptKeyId: 'key-recovery',
        });
      });
      const firstRequest = {
        projectId: PROJECT_ID, memberId: MEMBER, expectedClaimGeneration: 0,
        expectedMembershipRevision: 1, expectedManagerSetGeneration: 1, idempotencyKey: 'issue-one',
      };
      const first = (await database.mutate(connection => claims.reissue(connection, HOST, firstRequest, new Date(NOW)))).value;
      expect((await database.mutate(connection => claims.reissue(connection, HOST, firstRequest, new Date(NOW)))).value).toEqual(first);
      await expect(database.mutate(connection => claims.reissue(connection, MEMBER, firstRequest, new Date(NOW)))).rejects.toBeDefined();
      const second = (await database.mutate(connection => claims.reissue(connection, HOST,
        { ...firstRequest, expectedClaimGeneration: 1, idempotencyKey: 'issue-two' }, new Date(NOW)))).value;
      expect(second.claim).not.toBe(first.claim);
      await expect(database.mutate(connection => claims.assertSourceClaimAllowed(connection, MEMBER))).rejects.toBeDefined();
      await expect(database.mutate(connection => claims.redeem(connection, {
        projectId: PROJECT_ID, transferId: first.transferId, claim: first.claim,
        credentialHash: hash('persisted-new-credential'), idempotencyKey: 'redeem',
      }, new Date(NOW)))).rejects.toMatchObject({ code: 'membership-claim-invalid' });
      const redeem = { projectId: PROJECT_ID, transferId: second.transferId, claim: second.claim,
        credentialHash: hash('persisted-new-credential'), idempotencyKey: 'redeem' };
      const receipt = (await database.mutate(connection => claims.redeem(connection, redeem, new Date(NOW)))).value;
      await database.close();
      database = new SQLJSProjectDatabase(root, { loadSqlJs: async () => sql });
      await database.open();
      expect((await database.mutate(connection => claims.redeem(connection, redeem, new Date(second.expiresAt)))).value).toEqual(receipt);
      expect((await database.read(connection => claims.list(connection, MEMBER, new Date(NOW)))).members
        .every(member => member.bindingState === 'hidden' && member.importedClaimState === 'hidden')).toBe(true);
      expect(await database.read(connection => new PendingMembershipRepository().listCredentialRecords(connection, ['active'])
        .find(member => member.member.id === MEMBER))).toMatchObject({
        member: { id: MEMBER, personalRef: `refs/heads/members/${MEMBER}` },
        accessState: 'bound', credentialHash: Buffer.from(hash('persisted-new-credential'), 'hex'),
      });
      await expect(database.mutate(connection => claims.redeem(connection,
        { ...redeem, credentialHash: hash('different-device') }, new Date(NOW)))).rejects.toBeDefined();
      await database.mutate(connection => {
        connection.run("UPDATE members SET status = 'revoked', revoked_at = ?, access_state = 'unbound', credential_hash = NULL WHERE member_id = ?", [NOW, MEMBER]);
      });
      await expect(database.mutate(connection => claims.redeem(connection, redeem, new Date(NOW)))).rejects.toBeDefined();

    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
