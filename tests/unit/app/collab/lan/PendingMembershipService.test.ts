import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import {
  AuthorityMemberCredentialAuthenticator,
} from '@/app/collab/lan/AuthorityMemberCredentialAuthenticator';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { PendingMembershipService } from '@/app/collab/lan/PendingMembershipService';

const HOST_CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');
const CA_FINGERPRINT = 'ab'.repeat(32);
const MAIN_OID = 'a'.repeat(40);
const PROJECT_ID = 'project-alpha';

describe('PendingMembershipService', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let now: Date;
  let root: string;
  let credentials: Buffer[];
  let ids: Record<'invitation' | 'member', number>;
  let expiredMembers: string[];
  let service: PendingMembershipService;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    now = new Date('2026-08-08T00:00:00.000Z');
    credentials = [Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4)];
    ids = { invitation: 0, member: 0 };
    expiredMembers = [];
    root = await mkdtemp(path.join(tmpdir(), 'claudian-pending-membership-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    const projects = new ProjectAuthorityRepository();
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    await database.mutate(connection => projects.initialize(connection, {
      createdAt: now.toISOString(),
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: PROJECT_ID,
    }));
    const invitationCodec = new InvitationCodec({
      isAddressAllowed: address => address === '127.0.0.1',
      now: () => now,
    });
    service = new PendingMembershipService({
      database,
      events,
      idempotency,
      projects,
    }, {
      createCredential: () => (credentials.shift() ?? Buffer.alloc(32, 9))
        .toString('base64url'),
      createId: kind => `${kind}-${++ids[kind]}`,
      getHostEndpoint: () => ({
        caFingerprint: CA_FINGERPRINT,
        endpoint: 'https://127.0.0.1:54545',
      }),
      invitationCodec,
      now: () => now,
      onPendingExpired: member => {
        expiredMembers.push(member.id);
      },
      readMainOid: async () => MAIN_OID,
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('authenticates a bound active Member through the narrow terminal boundary', async () => {
    const authenticator = new AuthorityMemberCredentialAuthenticator(database);

    await expect(authenticator.authenticate(HOST_CREDENTIAL, ['active']))
      .resolves.toMatchObject({ member: { id: 'member-host' } });
    await expect(authenticator.authenticate(Buffer.alloc(32, 8).toString('base64url'), [
      'active',
    ])).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('rotates and revokes invitations while persisting only their digest', async () => {
    const first = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const replay = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const rotated = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-2',
      projectId: PROJECT_ID,
    });

    expect(replay).toEqual(first);
    expect(rotated.invitationSecret).not.toBe(first.invitationSecret);
    const rows = await database.read(connection => connection.all(
      'SELECT token_hash, revoked_at FROM invitations ORDER BY created_at, invitation_id',
    ));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revoked_at).toBe(now.toISOString());
    expect(Buffer.from(rows[1]?.token_hash as Uint8Array).toString('utf8'))
      .not.toContain(rotated.invitationSecret);

    await service.revokeInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'revoke-invite-1',
      projectId: PROJECT_ID,
    });
    await service.revokeInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'revoke-invite-1',
      projectId: PROJECT_ID,
    });
    await expect(service.createJoinAttempt(rotated.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-revoked',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' })).rejects.toMatchObject({
      code: 'invitation-revoked',
    });
  });

  it('rejects an imported active Member until an exact credential is bound', async () => {
    await database.mutate(connection => connection.run(`
      INSERT INTO members (
        member_id, display_name, personal_ref, role, status, access_state,
        credential_hash, join_attempt_id, created_at, activated_at, revoked_at
      ) VALUES (
        'member-unbound', 'Unbound', 'refs/heads/members/member-unbound',
        'member', 'active', 'unbound', NULL, NULL, ?, ?, NULL
      )
    `, [now.toISOString(), now.toISOString()]));

    await expect(service.authenticateMemberCredential(
      Buffer.alloc(32, 8).toString('base64url'),
      ['active'],
    )).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('reuses one pending membership and rotates its credential on a retry', async () => {
    const invitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const first = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });
    const retried = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });

    expect(retried.member.id).toBe(first.member.id);
    expect(retried.memberCredential).not.toBe(first.memberCredential);
    expect(await database.read(connection => connection.get(
      "SELECT COUNT(*) AS count FROM members WHERE status = 'pending'",
    ))).toMatchObject({ count: 1 });
    await expect(service.activateJoinAttempt(first.memberCredential, {
      idempotencyKey: 'activate-alpha',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('accepts maximum opaque identities through invitation and join persistence', async () => {
    const opaqueId = `o${'a'.repeat(127)}`;
    const invitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: opaqueId,
      projectId: PROJECT_ID,
    });
    const pending = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: opaqueId,
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });

    await expect(service.activateJoinAttempt(pending.memberCredential, {
      idempotencyKey: opaqueId,
      joinAttemptId: opaqueId,
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({
      currentMember: { id: pending.member.id, status: 'active' },
    });
  });

  it('rejects oversized opaque and Project identities at the service boundary', async () => {
    await expect(service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: `o${'a'.repeat(128)}`,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'operation-failed' });

    await expect(service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'valid-key',
      projectId: `p${'a'.repeat(64)}`,
    })).rejects.toMatchObject({ code: 'operation-failed' });
  });

  it('activates idempotently and restricts snapshots to active members', async () => {
    const invitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const pending = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });

    await expect(service.readSnapshot(pending.memberCredential)).rejects.toMatchObject({
      code: 'authorization-denied',
    });
    const activated = await service.activateJoinAttempt(pending.memberCredential, {
      idempotencyKey: 'activate-alpha',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    });
    const replay = await service.activateJoinAttempt(pending.memberCredential, {
      idempotencyKey: 'activate-alpha',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    });

    expect(replay).toEqual(activated);
    expect(activated.project).toMatchObject({
      id: PROJECT_ID,
      mainOid: MAIN_OID,
      managerSetGeneration: 0,
    });
    expect(activated.project).not.toHaveProperty('managerMemberId');
    expect(activated.currentMember).toMatchObject({
      id: pending.member.id,
      status: 'active',
    });
    expect(activated.members.map(member => member.id)).toEqual([
      'member-host',
      pending.member.id,
    ]);
  });

  it('garbage-collects expired pending memberships without touching active members', async () => {
    const invitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const pending = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });
    now = new Date('2026-08-08T00:31:00.000Z');

    await expect(service.garbageCollectExpiredPending()).resolves.toEqual([
      expect.objectContaining({ id: pending.member.id, status: 'pending' }),
    ]);
    expect(expiredMembers).toEqual([pending.member.id]);
    await expect(service.readSnapshot(HOST_CREDENTIAL)).resolves.toMatchObject({
      currentMember: { id: 'member-host', status: 'active' },
    });
  });

  it('confirms endpoint refresh only for an active member and the current invitation', async () => {
    const invitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const pending = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });
    await service.activateJoinAttempt(pending.memberCredential, {
      idempotencyKey: 'activate-alpha',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    });

    await expect(service.refreshEndpoint(
      pending.memberCredential,
      invitation,
    )).resolves.toEqual({
      caFingerprint: CA_FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
    });
    await expect(service.refreshEndpoint(pending.memberCredential, {
      ...invitation,
      endpoint: 'https://127.0.0.1:54546',
    })).rejects.toMatchObject({ code: 'invitation-invalid' });
  });

  it('removes a stale pending retry before creating a fresh membership', async () => {
    const firstInvitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const stale = await service.createJoinAttempt(firstInvitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });
    now = new Date('2026-08-08T00:31:00.000Z');
    const freshInvitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-2',
      projectId: PROJECT_ID,
    });

    const fresh = await service.createJoinAttempt(freshInvitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });
    expect(fresh.member.id).not.toBe(stale.member.id);
    expect(expiredMembers).toEqual([stale.member.id]);
  });

  it('distinguishes a terminated membership from an unknown credential', async () => {
    const invitation = await service.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invite-1',
      projectId: PROJECT_ID,
    });
    const pending = await service.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' });
    await service.activateJoinAttempt(pending.memberCredential, {
      idempotencyKey: 'activate-alpha',
      joinAttemptId: 'join-alpha',
      projectId: PROJECT_ID,
    });
    await database.mutate(connection => {
      connection.run(
        "UPDATE members SET status = 'revoked', revoked_at = ? WHERE member_id = ?",
        [now.toISOString(), pending.member.id],
      );
    });

    await expect(service.readSnapshot(pending.memberCredential)).rejects.toMatchObject({
      code: 'membership-revoked',
    });
    await expect(service.readSnapshot(
      Buffer.alloc(32, 8).toString('base64url'),
    )).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('rate-limits repeated invalid invitation authentication by Project and IP', async () => {
    const invalidSecret = Buffer.alloc(32, 8).toString('base64url');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.createJoinAttempt(invalidSecret, {
        displayName: 'Member',
        joinAttemptId: `join-invalid-${attempt}`,
        projectId: PROJECT_ID,
      }, { remoteAddress: '127.0.0.2' })).rejects.toMatchObject({
        code: 'authentication-failed',
      });
    }

    await expect(service.createJoinAttempt(invalidSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-rate-limited',
      projectId: PROJECT_ID,
    }, { remoteAddress: '127.0.0.2' })).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'join-rate-limited' },
    });
  });
});
