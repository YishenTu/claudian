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
import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketRepository } from '@/app/collab/authority/TicketRepository';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

describe('Collab authority schema and base repositories', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  const projects = new ProjectAuthorityRepository();

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-authority-repositories-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, {
      createdAt: CREATED_AT,
      hostCredentialHash: new Uint8Array(32).fill(9),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: 'project-alpha',
    }));
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('enforces personal-ref, open-request, and terminal-request constraints', async () => {
    await database.mutate(connection => {
      insertMember(connection, 'member-second', 'refs/heads/members/member-second', 'member');
    });
    await expect(database.mutate(connection => {
      insertMember(connection, 'member-third', 'refs/heads/members/member-second', 'member');
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });

    await database.mutate(connection => {
      insertRequest(connection, 'request-one', 'member-second');
    });
    await expect(database.mutate(connection => {
      insertRequest(connection, 'request-two', 'member-second');
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });

    await database.mutate(connection => {
      connection.run(
        "UPDATE change_requests SET status = 'discarded', updated_at = ? WHERE request_id = ?",
        ['2026-08-08T00:01:00.000Z', 'request-one'],
      );
    });
    await expect(database.mutate(connection => {
      connection.run(
        'UPDATE change_requests SET latest_head_oid = ? WHERE request_id = ?',
        ['b'.repeat(40), 'request-one'],
      );
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('binds one imported active identity idempotently without accepting another hash', async () => {
    const memberships = new PendingMembershipRepository();
    const credentialHash = new Uint8Array(32).fill(6);
    await database.mutate(connection => connection.run(`
      INSERT INTO members (
        member_id, display_name, personal_ref, role, status, access_state,
        credential_hash, join_attempt_id, created_at, activated_at, revoked_at
      ) VALUES (
        'member-unbound', 'Unbound', 'refs/heads/members/member-unbound',
        'member', 'active', 'unbound', NULL, NULL, ?, ?, NULL
      )
    `, [CREATED_AT, CREATED_AT]));

    await expect(database.mutate(connection => memberships.bindImportedActive(
      connection,
      'member-unbound',
      credentialHash,
    ))).resolves.toMatchObject({ value: { status: 'bound' } });
    await expect(database.mutate(connection => memberships.bindImportedActive(
      connection,
      'member-unbound',
      credentialHash,
    ))).resolves.toMatchObject({ value: { status: 'existing' } });
    await expect(database.mutate(connection => memberships.bindImportedActive(
      connection,
      'member-unbound',
      new Uint8Array(32).fill(7),
    ))).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('stores redacted monotonic events and restores them in sequence order', async () => {
    const events = new AuthorityEventRepository();

    const first = await database.mutate(connection => events.append(connection, {
      actorMemberId: 'member-host',
      createdAt: CREATED_AT,
      kind: 'project.created',
      payload: {
        credential: 'must-not-persist',
        memberId: 'member-host',
        projectId: 'project-alpha',
        requestId: 'request-alpha',
        ticketId: 'ticket-alpha',
      },
    }));
    const second = await database.mutate(connection => events.append(connection, {
      actorMemberId: 'member-host',
      createdAt: '2026-08-08T00:01:00.000Z',
      kind: 'project.updated',
      payload: { name: 'Alpha two' },
    }));

    expect(first.value.sequence).toBe(1);
    expect(second.value.sequence).toBe(2);
    expect(await database.read(connection => events.listAfter(connection, 0, 50)))
      .toEqual([
        expect.objectContaining({
          kind: 'project.created',
          payload: {
            memberId: 'member-host',
            projectId: 'project-alpha',
            requestId: 'request-alpha',
            ticketId: 'ticket-alpha',
          },
          sequence: 1,
        }),
        expect.objectContaining({ kind: 'project.updated', sequence: 2 }),
      ]);
  });

  it('replays matching idempotency results and rejects key reuse with a new request', async () => {
    const idempotency = new AuthorityIdempotencyRepository();
    const input = {
      actorMemberId: 'member-host',
      createdAt: CREATED_AT,
      key: 'idempotency-create-alpha',
      operationKind: 'create-invitation',
      requestFingerprint: 'a'.repeat(64),
      response: { invitationId: 'invitation-alpha' },
    } as const;

    const stored = await database.mutate(connection => idempotency.store(connection, input));
    const replayed = await database.mutate(connection => idempotency.store(connection, input));

    expect(stored.value).toEqual({
      response: input.response,
      status: 'stored',
    });
    expect(replayed.value).toEqual({
      response: input.response,
      status: 'existing',
    });
    await expect(database.mutate(connection => idempotency.store(connection, {
      ...input,
      requestFingerprint: 'b'.repeat(64),
    }))).rejects.toMatchObject({ code: 'idempotency-conflict' });
  });

  it('enforces Ticket comments and accepted relation immutability', async () => {
    await database.mutate(connection => {
      insertMember(connection, 'member-second', 'refs/heads/members/member-second', 'member');
      insertRequest(connection, 'request-one', 'member-second');
      const tickets = new TicketRepository();
      tickets.create(connection, {
        authorMemberId: 'member-second',
        body: 'Body',
        createdAt: CREATED_AT,
        ticketId: 'ticket-one',
        title: 'Ticket one',
      });
      tickets.createComment(connection, {
        authorMemberId: 'member-second',
        body: 'Comment',
        commentId: 'ticket-comment-one',
        createdAt: CREATED_AT,
        ticketId: 'ticket-one',
      });
      new RequestTicketRelationRepository().replacePending(connection, {
        actorMemberId: 'member-second',
        commitOid: 'b'.repeat(40),
        relations: [{
          kind: 'references',
          relationId: 'relation-one',
          ticketId: 'ticket-one',
        }],
        requestId: 'request-one',
        updatedAt: CREATED_AT,
      });
    });

    await expect(database.mutate(connection => {
      connection.run(
        'UPDATE ticket_comments SET body = ? WHERE comment_id = ?',
        ['Changed', 'ticket-comment-one'],
      );
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });

    await database.mutate(connection => {
      new RequestTicketRelationRepository().acceptPending(connection, {
        acceptedAt: CREATED_AT,
        acceptedMergeOid: 'c'.repeat(40),
        requestId: 'request-one',
      });
      connection.run(
        "UPDATE change_requests SET status = 'merged', merged_oid = ? WHERE request_id = ?",
        ['c'.repeat(40), 'request-one'],
      );
    });
    await expect(database.mutate(connection => {
      connection.run(
        'DELETE FROM request_ticket_relations WHERE relation_id = ?',
        ['relation-one'],
      );
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });
});

function insertMember(
  connection: AuthorityDatabaseConnection,
  memberId: string,
  personalRef: string,
  role: 'manager' | 'member',
): void {
  connection.run(
    `INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)`,
    [
      memberId,
      memberId,
      personalRef,
      role,
      new Uint8Array(32).fill(3),
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

function insertRequest(
  connection: AuthorityDatabaseConnection,
  requestId: string,
  memberId: string,
): void {
  connection.run(
    `INSERT INTO change_requests (
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, created_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, NULL, ?, ?)`,
    [requestId, memberId, 'a'.repeat(40), 'b'.repeat(40), CREATED_AT, CREATED_AT],
  );
}
