import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketService } from '@/app/collab/authority/TicketService';

const CREATED_AT = '2026-08-10T00:00:00.000Z';

describe('TicketService', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  let service: TicketService;
  let nextId: number;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-ticket-service-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(9),
        hostDisplayName: 'Manager',
        hostMemberId: 'member-manager',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      insertMember(connection, 'member-author', 'Alice Author');
      insertMember(connection, 'member-other', 'Other Member');
    });
    nextId = 1;
    service = new TicketService(database, {
      createId: kind => `${kind}-${nextId++}`,
      now: () => new Date(CREATED_AT),
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates Ticket detail and lists Open and Closed summaries', async () => {
    const created = await service.create('member-author', {
      body: 'Ticket body',
      idempotencyKey: 'create-one',
      projectId: 'project-alpha',
      title: 'First ticket',
    });

    expect(created.ticket).toMatchObject({
      authorMemberId: 'member-author',
      commentCount: 0,
      number: 1,
      revision: 1,
      status: 'open',
      title: 'First ticket',
    });
    expect(created.body).toBe('Ticket body');
    await expect(service.list('member-other', {
      projectId: 'project-alpha',
      status: 'open',
    })).resolves.toMatchObject({ tickets: [{ id: created.ticket.id }] });
    await expect(service.list('member-other', {
      projectId: 'project-alpha',
      status: 'closed',
    })).resolves.toEqual({ tickets: [] });
  });

  it('enforces author/Manager content editing and revision CAS', async () => {
    const created = await createTicket();
    await expect(service.updateContent('member-other', {
      body: 'Changed',
      expectedRevision: 1,
      idempotencyKey: 'edit-denied',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
      title: 'Changed',
    })).rejects.toMatchObject({ code: 'authorization-denied' });

    const updated = await service.updateContent('member-author', {
      body: 'Changed body',
      expectedRevision: 1,
      idempotencyKey: 'edit-ok',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
      title: 'Changed title',
    });
    expect(updated).toMatchObject({ revision: 2, title: 'Changed title' });
    const managerUpdated = await service.updateContent('member-manager', {
      body: 'Manager body',
      expectedRevision: 2,
      idempotencyKey: 'manager-edit-ok',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
      title: 'Manager title',
    });
    expect(managerUpdated).toMatchObject({ revision: 3, title: 'Manager title' });
    await expect(service.updateContent('member-author', {
      body: 'Stale body',
      expectedRevision: 1,
      idempotencyKey: 'edit-stale',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
      title: 'Stale title',
    })).rejects.toMatchObject({ code: 'stale-ticket' });
  });

  it('adds immutable comments and closes/reopens without a close reason', async () => {
    const created = await createTicket();
    const commented = await service.comment('member-other', {
      body: 'A useful note',
      idempotencyKey: 'comment-one',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
    });
    expect(commented.ticket).toMatchObject({ commentCount: 1, revision: 2 });

    const closed = await service.close('member-author', {
      expectedRevision: 2,
      idempotencyKey: 'close-one',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
    });
    expect(closed).toMatchObject({
      closedByMemberId: 'member-author',
      status: 'closed',
    });
    expect(closed).not.toHaveProperty('closeReason');

    const reopened = await service.reopen('member-manager', {
      expectedRevision: 3,
      idempotencyKey: 'reopen-one',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
    });
    expect(reopened).toMatchObject({ revision: 4, status: 'open' });
    expect(reopened).not.toHaveProperty('closedAt');
  });

  it('blocks resolving Ticket mutations while Accept is incomplete', async () => {
    const created = await createTicket();
    await database.mutate(connection => insertIncompleteAccept(
      connection,
      created.ticket.id,
      created.ticket.revision,
    ));

    const mutations = [
      service.updateContent('member-author', {
        body: 'Changed during Accept',
        expectedRevision: 1,
        idempotencyKey: 'locked-content',
        projectId: 'project-alpha',
        ticketId: created.ticket.id,
        title: 'Changed during Accept',
      }),
      service.comment('member-other', {
        body: 'Comment during Accept',
        idempotencyKey: 'locked-comment',
        projectId: 'project-alpha',
        ticketId: created.ticket.id,
      }),
      service.close('member-author', {
        expectedRevision: 1,
        idempotencyKey: 'locked-status',
        projectId: 'project-alpha',
        ticketId: created.ticket.id,
      }),
    ];

    const results = await Promise.allSettled(mutations);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toMatchObject({
        reason: { code: 'acceptance-recovery-required' },
        status: 'rejected',
      });
    }
    await expect(service.read('member-author', 'project-alpha', created.ticket.id))
      .resolves.toMatchObject({
        comments: [],
        ticket: { commentCount: 0, revision: 1, status: 'open' },
      });
  });

  it('records runtime-detected member mentions from descriptions and comments', async () => {
    const created = await service.create('member-author', {
      body: 'Ask @Other Member and ignore @Missing Member.',
      idempotencyKey: 'create-mentioned',
      projectId: 'project-alpha',
      title: 'Mentioned ticket',
    });
    await service.updateContent('member-author', {
      body: 'Now ask @Manager.',
      expectedRevision: 1,
      idempotencyKey: 'update-mentioned',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
      title: 'Mentioned ticket',
    });
    const commented = await service.comment('member-other', {
      body: 'Please review @Alice Author and @Alice Author.',
      idempotencyKey: 'comment-mentioned',
      projectId: 'project-alpha',
      ticketId: created.ticket.id,
    });

    await expect(database.read(connection => connection.all(
      `SELECT mentioned_member_id, source_kind, source_id
       FROM ticket_mentions
       WHERE ticket_id = ?
       ORDER BY source_kind, mentioned_member_id`,
      [created.ticket.id],
    ))).resolves.toEqual([{
      mentioned_member_id: 'member-author',
      source_id: commented.comment.id,
      source_kind: 'comment',
    }, {
      mentioned_member_id: 'member-manager',
      source_id: created.ticket.id,
      source_kind: 'description',
    }]);
  });

  it('does not bind an ambiguous active Member name', async () => {
    await database.mutate(connection => {
      insertMember(connection, 'member-shared-a', 'Shared Name');
      insertMember(connection, 'member-shared-b', 'Shared Name');
    });

    const created = await service.create('member-author', {
      body: 'Ask @Shared Name before publishing.',
      idempotencyKey: 'create-ambiguous-mention',
      projectId: 'project-alpha',
      title: 'Ambiguous mention',
    });

    await expect(database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM ticket_mentions WHERE ticket_id = ?',
      [created.ticket.id],
    )?.count)).resolves.toBe(0);
  });

  it('replays an idempotent create without creating another Ticket', async () => {
    const request = {
      body: 'Ticket body',
      idempotencyKey: 'stable-create',
      projectId: 'project-alpha',
      title: 'Stable ticket',
    };
    const first = await service.create('member-author', request);
    const second = await service.create('member-author', request);

    expect(second).toEqual(first);
    expect(await database.read(connection => (
      connection.get('SELECT COUNT(*) AS count FROM tickets')?.count
    ))).toBe(1);
  });

  async function createTicket() {
    return service.create('member-author', {
      body: 'Ticket body',
      idempotencyKey: 'create-ticket',
      projectId: 'project-alpha',
      title: 'Ticket title',
    });
  }
});

function insertMember(
  connection: AuthorityDatabaseConnection,
  memberId: string,
  displayName: string,
): void {
  connection.run(
    `INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
    [
      memberId,
      displayName,
      `refs/heads/members/${memberId}`,
      new Uint8Array(32).fill(4),
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

function insertIncompleteAccept(
  connection: AuthorityDatabaseConnection,
  ticketId: string,
  ticketRevision: number,
): void {
  const mainOid = '1'.repeat(40);
  const headOid = '2'.repeat(40);
  connection.run(
    `INSERT INTO change_requests (
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, description, revision, created_at, updated_at
    ) VALUES ('request-one', 'member-author', 'open', ?, ?, NULL, 'Resolve Ticket', 1, ?, ?)`,
    [mainOid, headOid, CREATED_AT, CREATED_AT],
  );
  connection.run(
    `INSERT INTO request_ticket_relations (
      relation_id, request_id, ticket_id, commit_oid, kind, state,
      created_by_member_id, created_at, updated_at, accepted_at, accepted_merge_oid
    ) VALUES (
      'relation-one', 'request-one', ?, ?, 'resolves', 'pending',
      'member-author', ?, ?, NULL, NULL
    )`,
    [ticketId, headOid, CREATED_AT, CREATED_AT],
  );
  connection.run(
    `INSERT INTO accept_operations (
      operation_id, request_id, expected_main_oid, expected_head_oid,
      expected_request_revision, expected_resolving_tickets_json,
      completion_actor_member_id, result_commit_oid, state,
      idempotency_key, created_at, updated_at
    ) VALUES (
      'accept-one', 'request-one', ?, ?, 1, ?, 'member-manager', NULL, 'prepared',
      'accept-key', ?, ?
    )`,
    [
      mainOid,
      headOid,
      JSON.stringify([{ revision: ticketRevision, ticketId }]),
      CREATED_AT,
      CREATED_AT,
    ],
  );
}
