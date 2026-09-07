import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { MembershipAdminService } from '@/app/collab/authority/MembershipAdminService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { HostedProjectControlService } from '@/app/collab/lan/HostedProjectControlService';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { PendingMembershipService } from '@/app/collab/lan/PendingMembershipService';

const HOST_CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');
const MAIN_OID = 'a'.repeat(40);
const NOW = new Date('2026-08-08T00:00:00.000Z');

describe('Membership lifecycle', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let root = '';

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-membership-lifecycle-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('rejects a removed credential and rejoins as a new retained membership', async () => {
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    const projects = new ProjectAuthorityRepository();
    const authority = { database, events, idempotency, projects };
    await database.mutate(connection => projects.initialize(connection, {
      createdAt: NOW.toISOString(),
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: 'project-alpha',
    }));
    let nextMember = 0;
    let nextCredential = 1;
    const membership = new PendingMembershipService(authority, {
      createCredential: () => Buffer.alloc(32, nextCredential += 1).toString('base64url'),
      createId: kind => kind === 'member'
        ? `member-${nextMember += 1}`
        : 'invitation-current',
      getHostEndpoint: () => ({
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://127.0.0.1:54545',
      }),
      invitationCodec: new InvitationCodec({
        isAddressAllowed: address => address === '127.0.0.1',
        now: () => NOW,
      }),
      now: () => NOW,
      readMainOid: async () => MAIN_OID,
    });
    const administration = new MembershipAdminService(authority, { now: () => NOW });
    const invitation = await membership.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'invite-one',
      projectId: 'project-alpha',
    });
    const first = await membership.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-first',
      projectId: 'project-alpha',
    }, { remoteAddress: '127.0.0.2' });
    await membership.activateJoinAttempt(first.memberCredential, {
      idempotencyKey: 'activate-first',
      joinAttemptId: 'join-first',
      projectId: 'project-alpha',
    });

    await administration.removeMember('member-host', {
      idempotencyKey: 'remove-first',
      memberId: first.member.id,
      projectId: 'project-alpha',
    });
    await expect(membership.authenticateMemberCredential(
      first.memberCredential,
      ['active'],
    )).rejects.toMatchObject({ code: 'membership-revoked' });

    const second = await membership.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Member',
      joinAttemptId: 'join-second',
      projectId: 'project-alpha',
    }, { remoteAddress: '127.0.0.2' });
    await membership.activateJoinAttempt(second.memberCredential, {
      idempotencyKey: 'activate-second',
      joinAttemptId: 'join-second',
      projectId: 'project-alpha',
    });

    expect(second.member.id).not.toBe(first.member.id);
    expect(await database.read(connection => connection.all(
      `SELECT member_id, personal_ref, status
       FROM members
       WHERE member_id != 'member-host'
       ORDER BY created_at, member_id`,
    ))).toEqual([
      {
        member_id: first.member.id,
        personal_ref: `refs/heads/members/${first.member.id}`,
        status: 'revoked',
      },
      {
        member_id: second.member.id,
        personal_ref: `refs/heads/members/${second.member.id}`,
        status: 'active',
      },
    ]);
  });

  it('replays a committed Leave through real credential authentication', async () => {
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    const projects = new ProjectAuthorityRepository();
    const authority = { database, events, idempotency, projects };
    await database.mutate(connection => projects.initialize(connection, {
      createdAt: NOW.toISOString(),
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: 'project-alpha',
    }));
    const memberCredential = Buffer.alloc(32, 2).toString('base64url');
    const membership = new PendingMembershipService(authority, {
      createCredential: () => memberCredential,
      createId: kind => kind === 'member' ? 'member-one' : 'invitation-current',
      getHostEndpoint: () => ({
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://127.0.0.1:54545',
      }),
      invitationCodec: new InvitationCodec({
        isAddressAllowed: address => address === '127.0.0.1',
        now: () => NOW,
      }),
      now: () => NOW,
      readMainOid: async () => MAIN_OID,
    });
    const invitation = await membership.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'invite-leaver',
      projectId: 'project-alpha',
    });
    const joining = await membership.createJoinAttempt(invitation.invitationSecret, {
      displayName: 'Leaving Member',
      joinAttemptId: 'join-leaver',
      projectId: 'project-alpha',
    }, { remoteAddress: '127.0.0.2' });
    await membership.activateJoinAttempt(joining.memberCredential, {
      idempotencyKey: 'activate-leaver',
      joinAttemptId: joining.id,
      projectId: 'project-alpha',
    });
    const administration = new MembershipAdminService(authority, { now: () => NOW });
    const hosted = new HostedProjectControlService(
      membership,
      {} as never,
      administration,
      {} as never,
      {} as never,
    );
    const request = {
      expectedHostMemberId: 'member-host',
      expectedMemberId: joining.member.id,
      idempotencyKey: 'leave-leaver',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    };

    const committed = await hosted.routing.lifecycle.execute({
      credential: joining.memberCredential,
      operation: 'leaveProject',
      request,
    });
    await expect(hosted.routing.lifecycle.execute({
      credential: joining.memberCredential,
      operation: 'leaveProject',
      request,
    })).resolves.toEqual(committed);
    await expect(membership.authenticateMemberCredential(joining.memberCredential, ['active']))
      .rejects.toMatchObject({ code: 'membership-revoked' });
  });
});
