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
  type RequestEnsureHeadPolicyPort,
  RequestEnsureService,
} from '@/app/collab/authority/RequestEnsureService';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketRepository } from '@/app/collab/authority/TicketRepository';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const MAIN = '1'.repeat(40);
const HEAD_A = '2'.repeat(40);
const HEAD_B = '3'.repeat(40);

class FakeHeadPolicy implements RequestEnsureHeadPolicyPort {
  calls: Array<{ expectedMainOid: string; headOid: string }> = [];
  error: CollabError | null = null;

  async validate(input: {
    expectedMainOid: string;
    headOid: string;
  }): Promise<{ mainOid: string }> {
    this.calls.push({
      expectedMainOid: input.expectedMainOid,
      headOid: input.headOid,
    });
    if (this.error) throw this.error;
    return { mainOid: MAIN };
  }
}

describe('RequestEnsureService', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  let headPolicy: FakeHeadPolicy;
  let requestIds: string[];
  let service: RequestEnsureService;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-request-ensure-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => new ProjectAuthorityRepository().initialize(connection, {
      createdAt: CREATED_AT,
      hostCredentialHash: new Uint8Array(32).fill(9),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: 'project-alpha',
    }));
    headPolicy = new FakeHeadPolicy();
    requestIds = ['request-one', 'request-two', 'request-three'];
    service = new RequestEnsureService(database, headPolicy, {
      createRelationId: (() => {
        let next = 1;
        return () => `relation-${next++}`;
      })(),
      createRequestId: () => requestIds.shift() ?? 'request-fallback',
      now: () => new Date(CREATED_AT),
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates one open request and atomically stores its event and idempotency result', async () => {
    const response = await service.ensure('member-host', input('key-create', HEAD_A));

    expect(response.mainOid).toBe(MAIN);
    expect(response.request).toEqual({
      commentCount: 0,
      createdAt: CREATED_AT,
      description: 'Describe the change',
      firstBaseOid: MAIN,
      id: 'request-one',
      latestHeadOid: HEAD_A,
      memberId: 'member-host',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: CREATED_AT,
    });
    expect(await counts(database)).toEqual({ events: 1, idempotency: 1, requests: 1 });
  });

  it('updates the exact head of the existing open request without creating another', async () => {
    const first = await service.ensure('member-host', input('key-first', HEAD_A));
    const second = await service.ensure('member-host', input('key-second', HEAD_B));

    expect(second.request).toMatchObject({
      firstBaseOid: MAIN,
      id: first.request.id,
      latestHeadOid: HEAD_B,
      status: 'open',
    });
    expect(await counts(database)).toEqual({ events: 2, idempotency: 2, requests: 1 });
  });

  it('derives references and resolves from description and self-assigns resolves', async () => {
    await database.mutate(connection => {
      const tickets = new TicketRepository();
      tickets.create(connection, {
        authorMemberId: 'member-host',
        body: 'Reference body',
        createdAt: CREATED_AT,
        ticketId: 'ticket-reference',
        title: 'Reference ticket',
      });
      tickets.create(connection, {
        authorMemberId: 'member-host',
        body: 'Resolve body',
        createdAt: CREATED_AT,
        ticketId: 'ticket-resolve',
        title: 'Resolve ticket',
      });
    });

    const response = await service.ensure('member-host', {
      ...input('key-relations', HEAD_A),
      description: 'Context #1\n\nResolves #2',
    });

    expect(response.request.ticketRelations).toEqual([
      expect.objectContaining({
        commitOid: HEAD_A,
        kind: 'references',
        ticketId: 'ticket-reference',
        ticketNumber: 1,
      }),
      expect.objectContaining({
        commitOid: HEAD_A,
        kind: 'resolves',
        ticketId: 'ticket-resolve',
        ticketNumber: 2,
      }),
    ]);
    expect(await database.read(connection => (
      new TicketRepository().find(connection, 'ticket-resolve')?.revision
    ))).toBe(1);

    const updated = await service.ensure('member-host', {
      ...input('key-relations-updated', HEAD_B),
      description: 'Context #1\n\nResolves #2',
    });
    expect(updated.request.ticketRelations).toEqual([
      expect.objectContaining({ commitOid: HEAD_B, ticketId: 'ticket-reference' }),
      expect.objectContaining({ commitOid: HEAD_B, ticketId: 'ticket-resolve' }),
    ]);
  });

  it('ignores unknown bare references and rejects unknown closing targets', async () => {
    await expect(service.ensure('member-host', {
      ...input('key-bare-unknown', HEAD_A),
      description: 'See #999',
    })).resolves.toMatchObject({ request: { ticketRelations: [] } });

    await expect(service.ensure('member-host', {
      ...input('key-resolve-unknown', HEAD_B),
      description: 'Resolves #999',
    })).rejects.toMatchObject({
      code: 'resolving-ticket-reference-not-found',
      safeContext: { ticketNumber: 999 },
    });
  });

  it('requires a non-blank description before Git validation', async () => {
    await expect(service.ensure('member-host', {
      ...input('key-blank', HEAD_A),
      description: ' \r\n ',
    })).rejects.toMatchObject({ code: 'description-required' });
    expect(headPolicy.calls).toEqual([]);
  });

  it('creates a new request after the prior request becomes terminal', async () => {
    const first = await service.ensure('member-host', input('key-first', HEAD_A));
    await database.mutate(connection => {
      connection.run(
        "UPDATE change_requests SET status = 'discarded', updated_at = ? WHERE request_id = ?",
        [CREATED_AT, first.request.id],
      );
    });

    const second = await service.ensure('member-host', input('key-second', HEAD_B));

    expect(second.request).toMatchObject({
      id: 'request-two',
      latestHeadOid: HEAD_B,
      status: 'open',
    });
    expect(await database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM change_requests',
    )?.count)).toBe(2);
  });

  it('replays before Git validation and rejects a reused key with a different head', async () => {
    const first = await service.ensure('member-host', input('stable-key', HEAD_A));
    headPolicy.error = new CollabError({ code: 'request-head-not-pushed' });

    await expect(service.ensure('member-host', input('stable-key', HEAD_A)))
      .resolves.toEqual(first);
    await expect(service.ensure('member-host', input('stable-key', HEAD_B)))
      .rejects.toMatchObject({ code: 'idempotency-conflict' });
    await expect(service.ensure(
      'member-host',
      input('stable-key', HEAD_A, '4'.repeat(40)),
    )).rejects.toMatchObject({ code: 'idempotency-conflict' });
    expect(headPolicy.calls).toEqual([{ expectedMainOid: MAIN, headOid: HEAD_A }]);
    expect(await counts(database)).toEqual({ events: 1, idempotency: 1, requests: 1 });
  });

  it('requires active membership before validating Git', async () => {
    await database.mutate(connection => insertInactiveMember(connection));

    await expect(service.ensure('member-inactive', input('inactive-key', HEAD_A)))
      .rejects.toMatchObject({ code: 'membership-revoked' });
    expect(headPolicy.calls).toEqual([]);
  });

  it('does not replay an idempotent response after membership is revoked', async () => {
    await database.mutate(connection => insertActiveMember(connection, 'member-a'));
    const request = input('member-key', HEAD_A);
    await service.ensure('member-a', request);
    await database.mutate(connection => {
      connection.run(
        "UPDATE members SET status = 'revoked', revoked_at = ? WHERE member_id = ?",
        [CREATED_AT, 'member-a'],
      );
    });

    await expect(service.ensure('member-a', request)).rejects.toMatchObject({
      code: 'membership-revoked',
    });
  });

  it('serializes concurrent ensure calls into one open request', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      service.ensure('member-host', input(`concurrent-${index}`, HEAD_A))
    )));

    expect(new Set(responses.map(response => response.request.id))).toEqual(
      new Set(['request-one']),
    );
    expect(await counts(database)).toEqual({ events: 1, idempotency: 20, requests: 1 });
  });

  it.each([HEAD_A, HEAD_B])(
    'does not mutate or replay an open request while its Accept is incomplete (%s)',
    async headOid => {
      const first = await service.ensure('member-host', input('key-first', HEAD_A));
      await database.mutate(connection => {
        connection.run(
          `INSERT INTO accept_operations (
            operation_id, request_id, expected_main_oid, expected_head_oid,
            completion_actor_member_id, result_commit_oid, state,
            idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'member-host', NULL, 'prepared', ?, ?, ?)`,
          [
            'accept-one',
            first.request.id,
            MAIN,
            HEAD_A,
            'accept-key',
            CREATED_AT,
            CREATED_AT,
          ],
        );
      });

      await expect(service.ensure('member-host', input('key-during-accept', headOid)))
        .rejects.toMatchObject({
          code: 'stale-request-head',
          safeContext: { reason: 'request-accept-in-progress' },
        });
      expect(await counts(database)).toEqual({ events: 1, idempotency: 1, requests: 1 });
    },
  );
});

function input(idempotencyKey: string, headOid: string, expectedMainOid = MAIN) {
  return {
    description: 'Describe the change',
    expectedMainOid,
    headOid,
    idempotencyKey,
    projectId: 'project-alpha',
  };
}

async function counts(database: SqlJsProjectDatabase) {
  return database.read(connection => ({
    events: connection.get('SELECT COUNT(*) AS count FROM events')?.count,
    idempotency: connection.get('SELECT COUNT(*) AS count FROM idempotency_results')?.count,
    requests: connection.get('SELECT COUNT(*) AS count FROM change_requests')?.count,
  }));
}

function insertInactiveMember(connection: AuthorityDatabaseConnection): void {
  connection.run(
    `INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (?, ?, ?, 'member', 'revoked', ?, NULL, ?, ?, ?)`,
    [
      'member-inactive',
      'Inactive',
      'refs/heads/members/member-inactive',
      new Uint8Array(32).fill(3),
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

function insertActiveMember(
  connection: AuthorityDatabaseConnection,
  memberId: string,
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
      new Uint8Array(32).fill(4),
      CREATED_AT,
      CREATED_AT,
    ],
  );
}
