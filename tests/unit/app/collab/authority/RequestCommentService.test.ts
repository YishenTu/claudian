import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_LIMITS } from '@claudian/collab-protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { RequestCommentService } from '@/app/collab/authority/RequestCommentService';
import type { RequestEnsureDatabasePort } from '@/app/collab/authority/RequestEnsureService';
import {
  type AuthorityDatabaseConnection,
  type AuthoritySqlRow,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const COMMENTED_AT = '2026-08-08T00:01:00.000Z';
const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);

describe('RequestCommentService', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  let service: RequestCommentService;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-request-comment-'));
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
    service = new RequestCommentService(database, {
      createCommentId: () => 'comment-one',
      now: () => new Date(COMMENTED_AT),
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('stores a normalized immutable comment, request count, redacted event, and replay atomically', async () => {
    const request = input('comment-key', '  e\u0301\rline\r\ntwo  ');
    const first = await service.create('member-host', request);
    const replay = await service.create('member-host', request);

    expect(first).toEqual({
      comment: {
        authorMemberId: 'member-host',
        body: 'é\nline\ntwo',
        createdAt: COMMENTED_AT,
        id: 'comment-one',
        requestId: 'request-one',
      },
      request: expect.objectContaining({
        commentCount: 1,
        id: 'request-one',
        updatedAt: COMMENTED_AT,
      }),
    });
    expect(replay).toEqual(first);
    expect(await database.read(connection => ({
      comments: connection.get('SELECT COUNT(*) AS count FROM comments')?.count,
      events: connection.all('SELECT event_kind, payload_json FROM events'),
      idempotency: connection.get(
        "SELECT COUNT(*) AS count FROM idempotency_results WHERE operation_kind = 'comment'",
      )?.count,
    }))).toEqual({
      comments: 1,
      events: [{
        event_kind: 'comment.created',
        payload_json: JSON.stringify({ commentId: 'comment-one', requestId: 'request-one' }),
      }],
      idempotency: 1,
    });
  });

  it('rejects a reused idempotency key with a different normalized body', async () => {
    await service.create('member-host', input('stable-key', 'First'));

    await expect(service.create('member-host', input('stable-key', 'Second')))
      .rejects.toMatchObject({ code: 'idempotency-conflict' });
  });

  it.each([
    '',
    '   ',
    'contains\u0000nul',
    'contains\u001fcontrol',
    'x'.repeat(CLAUDIAN_COLLAB_LIMITS.maxCommentBytes + 1),
  ])('rejects invalid comment body %#', async body => {
    await expect(service.create('member-host', input('invalid-key', body)))
      .rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it('does not append comments to a terminal request', async () => {
    await database.mutate(connection => {
      connection.run(
        "UPDATE change_requests SET status = 'discarded' WHERE request_id = 'request-one'",
      );
    });

    await expect(service.create('member-host', input('terminal-key', 'No longer needed')))
      .rejects.toMatchObject({ code: 'request-not-open' });
    expect(await database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM comments',
    )?.count)).toBe(0);
  });

  it('blocks new comments while Accept recovery owns the request', async () => {
    const replayRequest = input('replay-before-accept', 'Existing comment');
    const replay = await service.create('member-host', replayRequest);
    await database.mutate(connection => {
      connection.run(
        `INSERT INTO accept_operations (
          operation_id, request_id, expected_main_oid, expected_head_oid,
          expected_request_revision, expected_resolving_tickets_json,
          completion_actor_member_id, result_commit_oid, state,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 2, '[]', 'member-host', NULL, 'prepared', ?, ?, ?)`,
        [
          'accept-one',
          'request-one',
          MAIN,
          HEAD,
          'accept-key',
          COMMENTED_AT,
          COMMENTED_AT,
        ],
      );
    });

    await expect(service.create('member-host', input('during-accept', 'Too late')))
      .rejects.toMatchObject({
        code: 'acceptance-recovery-required',
        safeContext: { reason: 'request-comment-accept-in-progress' },
      });
    await expect(service.create('member-host', replayRequest)).resolves.toEqual(replay);
    expect(await database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM comments',
    )?.count)).toBe(1);
  });

  it('keeps replay available at the shared Request comment limit but rejects a new comment', async () => {
    const replayRequest = input('replay-at-limit', 'Existing comment');
    const replay = await service.create('member-host', replayRequest);
    await database.mutate(connection => {
      for (let index = 1; index < COLLAB_LIMITS.maxRequestComments; index += 1) {
        connection.run(
          `INSERT INTO comments (
            comment_id, request_id, author_member_id, body, created_at
          ) VALUES (?, 'request-one', 'member-host', 'Existing comment', ?)`,
          [`comment-${index}`, COMMENTED_AT],
        );
      }
    });

    await expect(service.create('member-host', replayRequest)).resolves.toEqual(replay);
    await expect(service.create('member-host', input('over-limit', 'One too many')))
      .rejects.toMatchObject({
        code: 'quota-exceeded',
        safeContext: {
          limit: COLLAB_LIMITS.maxRequestComments,
          quota: 'maxRequestComments',
        },
      });
  });

  it('requires active membership before replaying an existing comment', async () => {
    const request = input('revoke-key', 'Please revise');
    await service.create('member-a', request);
    await database.mutate(connection => {
      connection.run(
        "UPDATE members SET status = 'revoked', revoked_at = ? WHERE member_id = 'member-a'",
        [COMMENTED_AT],
      );
    });

    await expect(service.create('member-a', request)).rejects.toMatchObject({
      code: 'membership-revoked',
    });
  });

  it('fails closed when a persisted idempotency response is malformed', async () => {
    const request = input('corrupt-key', 'Please revise');
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      body: request.body,
      projectId: request.projectId,
      requestId: request.requestId,
    })).digest('hex');
    const connection: AuthorityDatabaseConnection = {
      all: () => [],
      get: (sql): AuthoritySqlRow | null => {
        if (sql.includes('FROM project p')) {
          return {
          member_id: 'member-host',
          member_status: 'active',
          personal_ref: 'refs/heads/members/member-host',
          project_id: 'project-alpha',
          project_state: 'active',
          };
        }
        return {
          request_fingerprint: requestFingerprint,
          response_json: '{}',
        };
      },
      run: () => 0,
    };
    const malformedDatabase: RequestEnsureDatabasePort = {
      mutate: jest.fn(),
      read: async reader => reader(connection),
    };
    const malformedService = new RequestCommentService(malformedDatabase);

    await expect(malformedService.create('member-host', request)).rejects.toMatchObject({
      code: 'authority-integrity-error',
    });
  });
});

function input(idempotencyKey: string, body: string) {
  return {
    body,
    idempotencyKey,
    projectId: 'project-alpha',
    requestId: 'request-one',
  };
}

function insertOpenRequest(connection: AuthorityDatabaseConnection): void {
  connection.run(
    `INSERT INTO change_requests (
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, created_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, NULL, ?, ?)`,
    ['request-one', 'member-host', MAIN, HEAD, CREATED_AT, CREATED_AT],
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
