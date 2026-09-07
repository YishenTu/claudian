import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ManagerResponsibilityService } from '@/app/collab/authority/ManagerResponsibilityService';
import { MembershipAdminService } from '@/app/collab/authority/MembershipAdminService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type { CollabManagerResponsibilityPurpose } from '@/core/collab';

const NOW = '2026-08-17T00:00:00.000Z';

describe('multi-Manager membership lifecycle', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let root = '';

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-multi-manager-lifecycle-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: NOW,
        hostCredentialHash: new Uint8Array(32).fill(1),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Three identities',
        projectId: 'project-three',
      });
      insertMember(connection, 'member-a', 2);
      insertMember(connection, 'member-b', 3);
      insertMember(connection, 'member-c', 4);
      insertMember(connection, 'member-d', 5);
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('supports equal administration, Host-independent demotion, removal, and succession', async () => {
    const authority = {
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    };
    let nextOfferId = 0;
    const responsibilities = new ManagerResponsibilityService({
      ...authority,
      presence: { hasAuthenticatedPresence: () => true },
    }, {
      createOfferId: () => `offer-integration-${++nextOfferId}`,
      now: () => new Date(NOW),
    });
    const durableNotifications: string[] = [];
    const administration = new MembershipAdminService(authority, {
      now: () => new Date(NOW),
      onMembershipTerminated: async result => {
        const status = await database.read(connection => connection.get(
          'SELECT status FROM members WHERE member_id = ?',
          [result.memberId],
        )?.status);
        durableNotifications.push(`${result.memberId}:${String(status)}`);
      },
      presence: { hasAuthenticatedPresence: () => true },
    });

    await promote(responsibilities, administration, {
      sourceMemberId: 'member-host',
      suffix: 'member-a',
      targetMemberId: 'member-a',
    });
    await promote(responsibilities, administration, {
      sourceMemberId: 'member-a',
      suffix: 'member-b',
      targetMemberId: 'member-b',
    });
    await administration.demoteManager('member-a', {
      idempotencyKey: 'demote-host-role',
      projectId: 'project-three',
      targetMemberId: 'member-host',
    });
    await administration.removeMember('member-b', {
      idempotencyKey: 'remove-manager-a',
      memberId: 'member-a',
      projectId: 'project-three',
    });

    const leaveOffer = await acknowledgedOffer(responsibilities, {
      purpose: 'manager-leave',
      sourceMemberId: 'member-b',
      suffix: 'member-b-leave',
      targetMemberId: 'member-host',
    });
    await administration.leaveProject('member-b', {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-b',
      idempotencyKey: 'leave-last-manager-b',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId: leaveOffer.offerId,
      projectId: 'project-three',
    });

    await expect(database.read(connection => ({
      events: connection.all(
        `SELECT event_kind FROM events
         WHERE event_kind IN (
           'membership.manager-promoted',
           'membership.manager-demoted',
           'membership.revoked',
           'membership.left'
         )
         ORDER BY sequence`,
      ).map(row => row.event_kind),
      generation: connection.get(
        'SELECT manager_set_generation FROM project WHERE singleton = 1',
      )?.manager_set_generation,
      host: connection.get('SELECT host_member_id FROM project WHERE singleton = 1')
        ?.host_member_id,
      members: connection.all(
        'SELECT member_id, role, status FROM members ORDER BY member_id',
      ),
    }))).resolves.toEqual({
      events: [
        'membership.manager-promoted',
        'membership.manager-promoted',
        'membership.manager-demoted',
        'membership.revoked',
        'membership.manager-promoted',
        'membership.left',
      ],
      generation: 5,
      host: 'member-host',
      members: [
        { member_id: 'member-a', role: 'member', status: 'revoked' },
        { member_id: 'member-b', role: 'member', status: 'left' },
        { member_id: 'member-c', role: 'member', status: 'active' },
        { member_id: 'member-d', role: 'member', status: 'active' },
        { member_id: 'member-host', role: 'manager', status: 'active' },
      ],
    });
    expect(durableNotifications).toEqual([
      'member-a:revoked',
      'member-b:left',
    ]);
  });

  it('consumes disjoint promotion offers across unrelated Manager-set changes', async () => {
    const authority = {
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    };
    let nextOfferId = 0;
    const responsibilities = new ManagerResponsibilityService({
      ...authority,
      presence: { hasAuthenticatedPresence: () => true },
    }, {
      createOfferId: () => `offer-disjoint-${++nextOfferId}`,
      now: () => new Date(NOW),
    });
    const administration = new MembershipAdminService(authority, {
      now: () => new Date(NOW),
      presence: { hasAuthenticatedPresence: () => true },
    });
    await promote(responsibilities, administration, {
      sourceMemberId: 'member-host',
      suffix: 'setup-a',
      targetMemberId: 'member-a',
    });
    await promote(responsibilities, administration, {
      sourceMemberId: 'member-host',
      suffix: 'setup-b',
      targetMemberId: 'member-b',
    });

    const first = await acknowledgedOffer(responsibilities, {
      purpose: 'manager-promotion',
      sourceMemberId: 'member-a',
      suffix: 'disjoint-c',
      targetMemberId: 'member-c',
    });
    const second = await acknowledgedOffer(responsibilities, {
      purpose: 'manager-promotion',
      sourceMemberId: 'member-b',
      suffix: 'disjoint-d',
      targetMemberId: 'member-d',
    });
    await administration.promoteManager('member-a', {
      idempotencyKey: 'promote-disjoint-c',
      managerResponsibilityOfferId: first.offerId,
      projectId: 'project-three',
      targetMemberId: 'member-c',
    });
    await administration.promoteManager('member-b', {
      idempotencyKey: 'promote-disjoint-d',
      managerResponsibilityOfferId: second.offerId,
      projectId: 'project-three',
      targetMemberId: 'member-d',
    });

    await expect(database.read(connection => connection.all(
      `SELECT member_id FROM members
       WHERE role = 'manager' AND status = 'active'
       ORDER BY member_id`,
    ))).resolves.toEqual([
      { member_id: 'member-a' },
      { member_id: 'member-b' },
      { member_id: 'member-c' },
      { member_id: 'member-d' },
      { member_id: 'member-host' },
    ]);
  });
});

async function promote(
  responsibilities: ManagerResponsibilityService,
  administration: MembershipAdminService,
  input: {
    readonly sourceMemberId: string;
    readonly suffix: string;
    readonly targetMemberId: string;
  },
): Promise<void> {
  const offer = await acknowledgedOffer(responsibilities, {
    ...input,
    purpose: 'manager-promotion',
  });
  await administration.promoteManager(input.sourceMemberId, {
    idempotencyKey: `promote-${input.suffix}`,
    managerResponsibilityOfferId: offer.offerId,
    projectId: 'project-three',
    targetMemberId: input.targetMemberId,
  });
}

async function acknowledgedOffer(
  responsibilities: ManagerResponsibilityService,
  input: {
    readonly purpose: CollabManagerResponsibilityPurpose;
    readonly sourceMemberId: string;
    readonly suffix: string;
    readonly targetMemberId: string;
  },
) {
  const offer = await responsibilities.create(input.sourceMemberId, {
    idempotencyKey: `create-${input.suffix}`,
    projectId: 'project-three',
    purpose: input.purpose,
    targetMemberId: input.targetMemberId,
  });
  return responsibilities.acknowledge(input.targetMemberId, {
    expectedTargetMemberId: input.targetMemberId,
    idempotencyKey: `ack-${input.suffix}`,
    offerId: offer.offerId,
    projectId: 'project-three',
  });
}

function insertMember(
  connection: AuthorityDatabaseConnection,
  memberId: string,
  credentialByte: number,
): void {
  connection.run(
    `INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
    [
      memberId,
      memberId,
      `refs/heads/members/${memberId}`,
      new Uint8Array(32).fill(credentialByte),
      NOW,
      NOW,
    ],
  );
}
