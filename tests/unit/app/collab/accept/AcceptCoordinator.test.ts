import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_LIMITS, COLLAB_MAIN_REF } from '@claudian-collab/protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import {
  AcceptCoordinator,
  type AcceptCoordinatorFailurePoint,
  type AcceptCoordinatorGitPort,
} from '@/app/collab/accept/AcceptCoordinator';
import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketService } from '@/app/collab/authority/TicketService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const ACCEPTED_AT = '2026-08-08T00:01:00.000Z';
const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const RESULT = '3'.repeat(40);
const UNEXPECTED = '4'.repeat(40);
const DETACHED = '6'.repeat(40);

describe('AcceptCoordinator', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  let git: FakeAcceptGit;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-accept-'));
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
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      insertActiveMember(connection, 'member-a');
      insertOpenRequest(connection);
    });
    git = new FakeAcceptGit();
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates a clean merge commit with main then request-head parents and finalizes atomically', async () => {
    const coordinator = createCoordinator();

    const response = await coordinator.accept('member-host', input());

    expect(git.commitTree).toHaveBeenCalledWith({
      identity: {
        email: 'collab@claudian.local',
        name: 'Claudian Collab',
      },
      message: 'Accept request request-one',
      parents: [MAIN, HEAD],
      treeOid: '5'.repeat(40),
    });
    expect(git.compareAndSwapRef).toHaveBeenCalledWith(
      COLLAB_MAIN_REF,
      RESULT,
      MAIN,
    );
    expect(response).toMatchObject({
      mainOid: RESULT,
      mergeCommitOid: RESULT,
      request: {
        id: 'request-one',
        mergedOid: RESULT,
        status: 'merged',
      },
    });
    expect(await authorityState()).toEqual({
      events: [{ event_kind: 'request.accepted', payload_json: JSON.stringify({
        requestId: 'request-one',
      }) }],
      idempotency: 1,
      operation: {
        completion_actor_member_id: 'member-host',
        result_commit_oid: RESULT,
        state: 'completed',
      },
      request: { merged_oid: RESULT, status: 'merged' },
    });
  });

  it('allows either active Manager to initiate an exact Accept', async () => {
    await promoteMember('member-manager');

    await expect(createCoordinator().accept('member-manager', input())).resolves.toMatchObject({
      mainOid: RESULT,
      request: { status: 'merged' },
    });
    await expect(database.read(connection => connection.get(
      'SELECT completion_actor_member_id FROM accept_operations WHERE operation_id = ?',
      ['accept-one'],
    ))).resolves.toEqual({ completion_actor_member_id: 'member-manager' });
  });

  it('requires the current Manager and exact main, request head, and personal ref', async () => {
    const coordinator = createCoordinator();

    await expect(coordinator.accept('member-a', input())).rejects.toMatchObject({
      code: 'authorization-denied',
    });
    await expect(coordinator.accept('member-host', {
      ...input(),
      expectedMainOid: UNEXPECTED,
    })).rejects.toMatchObject({ code: 'stale-main' });
    await expect(coordinator.accept('member-host', {
      ...input(),
      expectedHeadOid: UNEXPECTED,
    })).rejects.toMatchObject({ code: 'stale-request-head' });
    git.personalOid = UNEXPECTED;
    await expect(coordinator.accept('member-host', input())).rejects.toMatchObject({
      code: 'stale-request-head',
    });
    expect(await operationCount()).toBe(0);
  });

  it('reports a changed request head before metadata that changed with the same publish', async () => {
    await database.mutate(connection => {
      connection.run(
        'UPDATE change_requests SET latest_head_oid = ?, revision = 2 WHERE request_id = ?',
        [UNEXPECTED, 'request-one'],
      );
    });

    await expect(createCoordinator().accept('member-host', input())).rejects.toMatchObject({
      code: 'stale-request-head',
      safeContext: { reason: 'accept-expected-head-mismatch' },
    });
    expect(git.resolveRef).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('rejects a migrated open request until it has a description and positive revision', async () => {
    await database.mutate(connection => {
      connection.run(
        'UPDATE change_requests SET description = ?, revision = 0 WHERE request_id = ?',
        ['', 'request-one'],
      );
    });

    await expect(createCoordinator().accept('member-host', {
      ...input(),
      expectedRequestRevision: 0,
    })).rejects.toMatchObject({
      code: 'stale-request-metadata',
      safeContext: { reason: 'accept-request-description-required' },
    });
    expect(git.resolveRef).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('returns a stable conflict without changing Git or authority state', async () => {
    git.mergeResult = { kind: 'conflicting', treeOid: null };

    await expect(createCoordinator().accept('member-host', input()))
      .rejects.toMatchObject({ code: 'content-conflict' });
    expect(git.commitTree).not.toHaveBeenCalled();
    expect(git.compareAndSwapRef).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('rejects an invalid merged tree before preparing durable acceptance', async () => {
    git.validateTree.mockRejectedValueOnce(new CollabError({
      code: 'path-not-portable',
      safeContext: { reason: 'portability-collision' },
    }));

    await expect(createCoordinator().accept('member-host', input())).rejects.toMatchObject({
      code: 'path-not-portable',
    });
    expect(git.validateTree).toHaveBeenCalledWith('5'.repeat(40));
    expect(git.commitTree).not.toHaveBeenCalled();
    expect(git.compareAndSwapRef).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('marks an already-contained request merged without creating another commit', async () => {
    git.ancestor = true;

    const response = await createCoordinator().accept('member-host', input());

    expect(response).toMatchObject({ mainOid: MAIN, mergeCommitOid: MAIN });
    expect(git.mergeTree).not.toHaveBeenCalled();
    expect(git.commitTree).not.toHaveBeenCalled();
    expect(await authorityState()).toMatchObject({
      operation: { result_commit_oid: MAIN, state: 'completed' },
      request: { merged_oid: MAIN, status: 'merged' },
    });
  });

  it.each([
    ['main', UNEXPECTED],
    ['personal', UNEXPECTED],
  ] as const)(
    'rejects an already-contained request when the %s ref moves during ancestry checks',
    async (refKind, nextOid) => {
      git.isAncestor.mockImplementationOnce(async () => {
        if (refKind === 'main') git.mainOid = nextOid;
        else git.personalOid = nextOid;
        return true;
      });

      await expect(createCoordinator().accept('member-host', input()))
        .rejects.toMatchObject({
          code: refKind === 'main' ? 'stale-main' : 'stale-request-head',
        });
      expect(await operationCount()).toBe(0);
      expect(await authorityState()).toMatchObject({
        request: { merged_oid: null, status: 'open' },
      });
    },
  );

  it('accepts the Manager own published request through the same transaction', async () => {
    await database.mutate(connection => {
      connection.run('DELETE FROM change_requests WHERE request_id = ?', ['request-one']);
      connection.run(
        `INSERT INTO change_requests (
          request_id, member_id, status, first_base_oid, latest_head_oid,
          merged_oid, description, revision, created_at, updated_at
        ) VALUES (?, ?, 'open', ?, ?, NULL, ?, 1, ?, ?)`,
        ['request-one', 'member-host', MAIN, HEAD, 'Manager change', CREATED_AT, CREATED_AT],
      );
    });

    await expect(createCoordinator().accept('member-host', input())).resolves.toMatchObject({
      request: { memberId: 'member-host', status: 'merged' },
    });
    expect(git.compareAndSwapRef).toHaveBeenCalledWith(COLLAB_MAIN_REF, RESULT, MAIN);
  });

  it('accepts exact Ticket relations and closes the resolving Tickets atomically', async () => {
    await database.mutate(connection => insertTicketRelation(connection));

    const response = await createCoordinator().accept('member-host', {
      ...input(),
      expectedResolvingTickets: [{ revision: 1, ticketId: 'ticket-one' }],
    });

    expect(response.request.ticketRelations).toEqual([
      expect.objectContaining({
        commitOid: HEAD,
        kind: 'resolves',
        state: 'accepted',
        ticketId: 'ticket-one',
      }),
    ]);
    await expect(database.read(connection => ({
      relation: connection.get(
        `SELECT state, accepted_merge_oid FROM request_ticket_relations
         WHERE relation_id = 'relation-one'`,
      ),
      ticket: connection.get(
        `SELECT status, revision, closed_by_member_id FROM tickets
         WHERE ticket_id = 'ticket-one'`,
      ),
      ticketEvent: connection.get(
        `SELECT event_kind, payload_json FROM events
         WHERE event_kind = 'ticket.closed'`,
      ),
    }))).resolves.toEqual({
      relation: { accepted_merge_oid: RESULT, state: 'accepted' },
      ticket: { closed_by_member_id: 'member-host', revision: 2, status: 'closed' },
      ticketEvent: {
        event_kind: 'ticket.closed',
        payload_json: JSON.stringify({ requestId: 'request-one', ticketId: 'ticket-one' }),
      },
    });
  });

  it('rejects a Ticket accepted-relation overflow before touching Git', async () => {
    await database.mutate(connection => {
      insertTicketRelation(connection);
      for (let index = 0; index < COLLAB_LIMITS.maxTicketAcceptedRelations; index += 1) {
        const requestId = `accepted-request-${index}`;
        connection.run(
          `INSERT INTO change_requests (
            request_id, member_id, status, first_base_oid, latest_head_oid,
            merged_oid, description, revision, created_at, updated_at
          ) VALUES (?, 'member-a', 'merged', ?, ?, ?, 'Accepted', 1, ?, ?)`,
          [requestId, MAIN, HEAD, RESULT, CREATED_AT, CREATED_AT],
        );
        connection.run(
          `INSERT INTO request_ticket_relations (
            relation_id, request_id, ticket_id, commit_oid, kind, state,
            created_by_member_id, created_at, updated_at, accepted_at,
            accepted_merge_oid
          ) VALUES (?, ?, 'ticket-one', ?, 'references', 'accepted',
            'member-a', ?, ?, ?, ?)`,
          [
            `accepted-relation-${index}`,
            requestId,
            HEAD,
            CREATED_AT,
            CREATED_AT,
            CREATED_AT,
            RESULT,
          ],
        );
      }
    });

    await expect(createCoordinator().accept('member-host', {
      ...input(),
      expectedResolvingTickets: [{ revision: 1, ticketId: 'ticket-one' }],
    })).rejects.toMatchObject({
      code: 'quota-exceeded',
      safeContext: {
        limit: COLLAB_LIMITS.maxTicketAcceptedRelations,
        quota: 'maxTicketAcceptedRelations',
      },
    });
    expect(git.commitTree).not.toHaveBeenCalled();
    expect(git.compareAndSwapRef).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('rejects a stale resolving Ticket set or revision before touching Git', async () => {
    await database.mutate(connection => insertTicketRelation(connection));
    const coordinator = createCoordinator();

    await expect(coordinator.accept('member-host', input())).rejects.toMatchObject({
      code: 'stale-request-metadata',
    });
    await expect(coordinator.accept('member-host', {
      ...input(),
      expectedResolvingTickets: [{ revision: 2, ticketId: 'ticket-one' }],
      idempotencyKey: 'accept-ticket-revision',
    })).rejects.toMatchObject({ code: 'stale-ticket' });
    expect(git.mergeTree).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('rejects a relation whose bound commit is not contained in the reviewed head', async () => {
    await database.mutate(connection => insertTicketRelation(connection, DETACHED));

    await expect(createCoordinator().accept('member-host', {
      ...input(),
      expectedResolvingTickets: [{ revision: 1, ticketId: 'ticket-one' }],
    })).rejects.toMatchObject({ code: 'stale-request-metadata' });
    expect(git.mergeTree).not.toHaveBeenCalled();
    expect(await operationCount()).toBe(0);
  });

  it('replays a lost completed response before touching Git', async () => {
    const first = await createCoordinator().accept('member-host', input());
    jest.clearAllMocks();

    await expect(createCoordinator().accept('member-host', input())).resolves.toEqual(first);
    expect(git.resolveRef).not.toHaveBeenCalled();
    await expect(createCoordinator().accept('member-host', {
      ...input(),
      expectedHeadOid: UNEXPECTED,
    })).rejects.toMatchObject({ code: 'idempotency-conflict' });
  });

  it('replays an exact completed response after another Manager demotes the actor', async () => {
    await promoteMember('member-manager');
    const first = await createCoordinator().accept('member-manager', input());
    await database.mutate(connection => {
      const managers = new ManagerSetRepository();
      managers.demote(connection, {
        expectedGeneration: managers.read(connection).generation,
        targetMemberId: 'member-manager',
      });
    });
    jest.clearAllMocks();

    await expect(createCoordinator().accept('member-manager', input())).resolves.toEqual(first);
    expect(git.resolveRef).not.toHaveBeenCalled();
    await expect(createCoordinator().accept('member-manager', {
      ...input(),
      idempotencyKey: 'accept-fresh-after-demotion',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it.each(['demoted', 'left'] as const)(
    'recovers a prepared Accept with the persisted actor after that actor is %s',
    async actorState => {
      await promoteMember('member-manager');
      await database.mutate(connection => insertTicketRelation(connection));
      const acceptInput = {
        ...input(),
        expectedResolvingTickets: [{ revision: 1, ticketId: 'ticket-one' }],
      };
      await expect(createCoordinator('after-prepared').accept('member-manager', acceptInput))
        .rejects.toThrow('Injected after-prepared');

      await database.mutate(connection => {
        const managers = new ManagerSetRepository();
        const expectedGeneration = managers.read(connection).generation;
        if (actorState === 'demoted') {
          managers.demote(connection, {
            expectedGeneration,
            targetMemberId: 'member-manager',
          });
          return;
        }
        connection.run(
          `UPDATE members
           SET role = 'member', status = 'left', revoked_at = ?
           WHERE member_id = ? AND role = 'manager' AND status = 'active'`,
          [ACCEPTED_AT, 'member-manager'],
        );
        managers.advanceGeneration(connection, expectedGeneration);
      });

      await expect(createCoordinator().recover()).resolves.toBeUndefined();
      await expect(database.read(connection => ({
        event: connection.get(
          "SELECT actor_member_id FROM events WHERE event_kind = 'request.accepted'",
        ),
        idempotency: connection.get(
          "SELECT actor_member_id FROM idempotency_results WHERE operation_kind = 'accept'",
        ),
        operation: connection.get(
          'SELECT completion_actor_member_id, state FROM accept_operations',
        ),
        ticket: connection.get(
          "SELECT closed_by_member_id, status FROM tickets WHERE ticket_id = 'ticket-one'",
        ),
      }))).resolves.toEqual({
        event: { actor_member_id: 'member-manager' },
        idempotency: { actor_member_id: 'member-manager' },
        operation: {
          completion_actor_member_id: 'member-manager',
          state: 'completed',
        },
        ticket: { closed_by_member_id: 'member-manager', status: 'closed' },
      });
    },
  );

  it('serializes simultaneous Accept attempts from different Managers to one winner', async () => {
    await promoteMember('member-manager');
    const host = new AcceptCoordinator(database, git, {
      createOperationId: () => 'accept-host',
      now: () => new Date(ACCEPTED_AT),
    });
    const manager = new AcceptCoordinator(database, git, {
      createOperationId: () => 'accept-manager',
      now: () => new Date(ACCEPTED_AT),
    });

    const attempts = await Promise.allSettled([
      host.accept('member-host', input()),
      manager.accept('member-manager', {
        ...input(),
        idempotencyKey: 'accept-manager-key',
      }),
    ]);

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await operationCount()).toBe(1);
    expect(git.compareAndSwapRef).toHaveBeenCalledTimes(1);
  });

  it.each([
    'after-prepared',
    'after-result-persisted',
    'after-ref-updated',
    'after-completed',
  ] as const)('recovers a crash at %s without a second main transition', async failurePoint => {
    const crashing = createCoordinator(failurePoint);
    await expect(crashing.accept('member-host', input())).rejects.toThrow(
      `Injected ${failurePoint}`,
    );
    const casCalls = git.compareAndSwapRef.mock.calls.length;

    const recovered = createCoordinator();
    await recovered.recover();
    await expect(recovered.accept('member-host', input())).resolves.toMatchObject({
      mainOid: RESULT,
      request: { status: 'merged' },
    });
    expect(git.mainOid).toBe(RESULT);
    expect(git.compareAndSwapRef).toHaveBeenCalledTimes(
      failurePoint === 'after-prepared' || failurePoint === 'after-result-persisted'
        ? casCalls + 1
        : casCalls,
    );
    expect(await authorityState()).toMatchObject({
      idempotency: 1,
      operation: { result_commit_oid: RESULT, state: 'completed' },
      request: { merged_oid: RESULT, status: 'merged' },
    });
  });

  it.each([
    'after-prepared',
    'after-result-persisted',
    'after-ref-updated',
  ] as const)(
    'keeps resolving Tickets immutable while recovering a crash at %s',
    async failurePoint => {
      await database.mutate(connection => insertTicketRelation(connection));
      await expect(createCoordinator(failurePoint).accept('member-host', {
        ...input(),
        expectedResolvingTickets: [{ revision: 1, ticketId: 'ticket-one' }],
      })).rejects.toThrow(`Injected ${failurePoint}`);

      const tickets = new TicketService(database, {
        createId: () => 'comment-during-accept',
        now: () => new Date(ACCEPTED_AT),
      });
      await expect(tickets.comment('member-a', {
        body: 'Mutation during Accept recovery',
        idempotencyKey: `comment-${failurePoint}`,
        projectId: 'project-alpha',
        ticketId: 'ticket-one',
      })).rejects.toMatchObject({ code: 'acceptance-recovery-required' });

      await createCoordinator().recover();
      await expect(database.read(connection => connection.get(
        `SELECT status, revision, comment_count FROM tickets
         WHERE ticket_id = 'ticket-one'`,
      ))).resolves.toEqual({ comment_count: 0, revision: 2, status: 'closed' });
    },
  );

  it('blocks further acceptance when main is neither expected nor the prepared result', async () => {
    await expect(createCoordinator('after-result-persisted').accept(
      'member-host',
      input(),
    )).rejects.toThrow('Injected after-result-persisted');
    git.mainOid = UNEXPECTED;
    const recovered = createCoordinator();

    await expect(recovered.recover()).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    await expect(recovered.accept('member-host', input())).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    expect(git.compareAndSwapRef).not.toHaveBeenCalled();
  });

  it('leaves a CAS race recoverable and never rewrites the Member personal ref', async () => {
    git.casRaceOid = UNEXPECTED;
    const coordinator = createCoordinator();

    await expect(coordinator.accept('member-host', input())).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    expect(git.personalOid).toBe(HEAD);
    expect(await authorityState()).toMatchObject({
      operation: { result_commit_oid: RESULT, state: 'ref_updated' },
      request: { merged_oid: null, status: 'open' },
    });
  });

  it('rejects a request-head race before durable preparation', async () => {
    git.mergeTree.mockImplementationOnce(async () => {
      await database.mutate(connection => {
        connection.run(
          'UPDATE change_requests SET latest_head_oid = ? WHERE request_id = ?',
          [UNEXPECTED, 'request-one'],
        );
      });
      return git.mergeResult;
    });

    await expect(createCoordinator().accept('member-host', input())).rejects.toMatchObject({
      code: 'stale-request-head',
    });
    expect(await operationCount()).toBe(0);
    expect(git.mainOid).toBe(MAIN);
  });

  it('rejects a personal-ref race before durable preparation', async () => {
    git.mergeTree.mockImplementationOnce(async () => {
      git.personalOid = UNEXPECTED;
      return git.mergeResult;
    });

    await expect(createCoordinator().accept('member-host', input())).rejects.toMatchObject({
      code: 'stale-request-head',
    });
    expect(await operationCount()).toBe(0);
    expect(git.mainOid).toBe(MAIN);
  });

  it('recovers the reviewed head after preparation even when the personal ref advances', async () => {
    await expect(createCoordinator('after-prepared').accept('member-host', input()))
      .rejects.toThrow('Injected after-prepared');
    git.personalOid = UNEXPECTED;

    await expect(createCoordinator().recover()).resolves.toBeUndefined();

    expect(git.mainOid).toBe(RESULT);
    expect(git.personalOid).toBe(UNEXPECTED);
    expect(git.commitTree).toHaveBeenLastCalledWith(expect.objectContaining({
      parents: [MAIN, HEAD],
    }));
  });

  it('blocks Accept when authority request state diverges before recovery finalization', async () => {
    await expect(createCoordinator('after-result-persisted').accept(
      'member-host',
      input(),
    )).rejects.toThrow('Injected after-result-persisted');
    await database.mutate(connection => {
      connection.run(
        'UPDATE change_requests SET latest_head_oid = ? WHERE request_id = ?',
        [UNEXPECTED, 'request-one'],
      );
    });
    const recovered = createCoordinator();

    await expect(recovered.recover()).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    await expect(recovered.accept('member-host', input())).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    expect(git.mainOid).toBe(RESULT);
  });

  it('blocks Accept when a prepared request is no longer open', async () => {
    await expect(createCoordinator('after-prepared').accept('member-host', input()))
      .rejects.toThrow('Injected after-prepared');
    await database.mutate(connection => {
      connection.run(
        "UPDATE change_requests SET status = 'discarded' WHERE request_id = ?",
        ['request-one'],
      );
    });
    const recovered = createCoordinator();

    await expect(recovered.recover()).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    await expect(recovered.accept('member-host', input())).rejects.toMatchObject({
      code: 'acceptance-recovery-required',
    });
    expect(git.mainOid).toBe(MAIN);
  });

  function createCoordinator(
    failurePoint?: AcceptCoordinatorFailurePoint,
  ): AcceptCoordinator {
    return new AcceptCoordinator(database, git, {
      createOperationId: () => 'accept-one',
      failAfter: failurePoint
        ? point => {
          if (point === failurePoint) throw new Error(`Injected ${point}`);
        }
        : undefined,
      now: () => new Date(ACCEPTED_AT),
    });
  }

  async function operationCount(): Promise<number | undefined> {
    return database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM accept_operations',
    )?.count as number | undefined);
  }

  async function authorityState() {
    return database.read(connection => ({
      events: connection.all(
        "SELECT event_kind, payload_json FROM events WHERE event_kind = 'request.accepted'",
      ),
      idempotency: connection.get(
        "SELECT COUNT(*) AS count FROM idempotency_results WHERE operation_kind = 'accept'",
      )?.count,
      operation: connection.get(
        `SELECT state, result_commit_oid, completion_actor_member_id
         FROM accept_operations WHERE operation_id = ?`,
        ['accept-one'],
      ),
      request: connection.get(
        'SELECT status, merged_oid FROM change_requests WHERE request_id = ?',
        ['request-one'],
      ),
    }));
  }

  async function promoteMember(memberId: string): Promise<void> {
    await database.mutate(connection => {
      insertActiveMember(connection, memberId);
      const managers = new ManagerSetRepository();
      managers.promote(connection, {
        expectedGeneration: managers.read(connection).generation,
        targetMemberId: memberId,
      });
    });
  }
});

function input() {
  return {
    expectedHeadOid: HEAD,
    expectedMainOid: MAIN,
    expectedRequestRevision: 1,
    expectedResolvingTickets: [],
    idempotencyKey: 'accept-key',
    projectId: 'project-alpha',
    requestId: 'request-one',
  };
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

function insertOpenRequest(connection: AuthorityDatabaseConnection): void {
  connection.run(
    `INSERT INTO change_requests (
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, description, revision, created_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, NULL, ?, 1, ?, ?)`,
    ['request-one', 'member-a', MAIN, HEAD, 'Member change', CREATED_AT, CREATED_AT],
  );
}

function insertTicketRelation(
  connection: AuthorityDatabaseConnection,
  commitOid = HEAD,
): void {
  connection.run(
    `INSERT INTO tickets (
      ticket_id, title, body, status, author_member_id,
      revision, comment_count, created_at, updated_at, closed_at,
      closed_by_member_id
    ) VALUES (?, 'Fix it', 'Ticket body', 'open', ?, 1, 0, ?, ?, NULL, NULL)`,
    ['ticket-one', 'member-a', CREATED_AT, CREATED_AT],
  );
  connection.run(
    `INSERT INTO request_ticket_relations (
      relation_id, request_id, ticket_id, commit_oid, kind, state,
      created_by_member_id, created_at, updated_at, accepted_at,
      accepted_merge_oid
    ) VALUES (?, ?, ?, ?, 'resolves', 'pending', ?, ?, ?, NULL, NULL)`,
    [
      'relation-one',
      'request-one',
      'ticket-one',
      commitOid,
      'member-a',
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

class FakeAcceptGit implements AcceptCoordinatorGitPort {
  ancestor = false;
  casRaceOid: string | null = null;
  mainOid = MAIN;
  mergeResult:
    | { readonly kind: 'clean'; readonly treeOid: string }
    | { readonly kind: 'conflicting'; readonly treeOid: string | null } = {
      kind: 'clean',
      treeOid: '5'.repeat(40),
    };
  personalOid = HEAD;

  commitTree = jest.fn(async () => RESULT);
  compareAndSwapRef = jest.fn(async (
    _ref: string,
    nextOid: string,
    expectedOid: string,
  ) => {
    if (this.casRaceOid) {
      this.mainOid = this.casRaceOid;
      return { currentOid: this.mainOid, updated: false };
    }
    if (this.mainOid !== expectedOid) {
      return { currentOid: this.mainOid, updated: false };
    }
    this.mainOid = nextOid;
    return { currentOid: nextOid, updated: true };
  });
  isAncestor = jest.fn(async (ancestorOid: string, descendantOid: string) => (
    ancestorOid === descendantOid || this.ancestor
  ));
  mergeTree = jest.fn(async () => this.mergeResult);
  resolveRef = jest.fn(async (ref: string) => (
    ref === COLLAB_MAIN_REF ? this.mainOid : this.personalOid
  ));
  validateTree = jest.fn(async () => undefined);
}
