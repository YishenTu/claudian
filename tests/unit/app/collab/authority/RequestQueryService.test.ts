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
import {
  type RequestQueryGitPort,
  RequestQueryService,
} from '@/app/collab/authority/RequestQueryService';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const UPDATED_AT = '2026-08-08T00:01:00.000Z';
const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);

describe('RequestQueryService', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  let git: RequestQueryGitPort;
  let service: RequestQueryService;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-request-query-'));
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
      insertActiveMember(connection, 'member-reader');
      insertRequestAndComment(connection);
    });
    git = {
      inspect: jest.fn().mockResolvedValue({
        currentMainOid: MAIN,
        reviewCondition: 'clean',
        reviewedHeadOid: HEAD,
      }),
    };
    service = new RequestQueryService(database, git);
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('returns authoritative request metadata, exact review OIDs, and the first comment page', async () => {
    await expect(service.read('member-host', 'project-alpha', 'request-one')).resolves.toEqual({
      comments: {
        comments: [{
          authorMemberId: 'member-host',
          body: 'Looks good',
          createdAt: UPDATED_AT,
          id: 'comment-one',
          requestId: 'request-one',
        }],
      },
      currentMainOid: MAIN,
      request: expect.objectContaining({
        commentCount: 1,
        id: 'request-one',
        latestHeadOid: HEAD,
      }),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    });
    expect(git.inspect).toHaveBeenCalledWith({
      firstBaseOid: MAIN,
      latestHeadOid: HEAD,
      personalRef: 'refs/heads/members/member-host',
      projectId: 'project-alpha',
    });
  });

  it('keeps terminal request detail readable as immutable history', async () => {
    await database.mutate(connection => {
      connection.run(
        "UPDATE change_requests SET status = 'merged', merged_oid = ?, updated_at = ?",
        [MAIN, UPDATED_AT],
      );
    });

    await expect(service.read('member-host', 'project-alpha', 'request-one'))
      .resolves.toMatchObject({ request: { id: 'request-one', status: 'merged' } });
  });

  it('fails closed when the request changes during Git inspection', async () => {
    git.inspect = jest.fn(async () => {
      await database.mutate(connection => {
        connection.run(
          "UPDATE change_requests SET latest_head_oid = ?, updated_at = ? WHERE request_id = 'request-one'",
          ['3'.repeat(40), UPDATED_AT],
        );
      });
      return {
        currentMainOid: MAIN,
        reviewCondition: 'clean' as const,
        reviewedHeadOid: HEAD,
      };
    });

    await expect(service.read('member-host', 'project-alpha', 'request-one'))
      .rejects.toMatchObject({ code: 'stale-request-head' });
  });

  it('rejects missing requests and inactive actors before Git inspection', async () => {
    await expect(service.read('member-reader', 'project-alpha', 'request-missing'))
      .rejects.toMatchObject({ code: 'request-not-open' });
    await database.mutate(connection => {
      connection.run(
        "UPDATE members SET status = 'revoked', revoked_at = ? WHERE member_id = 'member-reader'",
        [UPDATED_AT],
      );
    });
    await expect(service.read('member-reader', 'project-alpha', 'request-one'))
      .rejects.toMatchObject({ code: 'membership-revoked' });
    expect(git.inspect).not.toHaveBeenCalled();
  });

  it('pages request comments deterministically without loss or duplication', async () => {
    await database.mutate(connection => {
      for (let index = 2; index <= 5; index += 1) {
        connection.run(
          `INSERT INTO comments (
            comment_id, request_id, author_member_id, body, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            `comment-${index}`,
            'request-one',
            'member-host',
            `Body ${index}`,
            `2026-08-08T00:0${index}:00.000Z`,
          ],
        );
      }
    });

    const first = await service.readComments('member-host', 'project-alpha', 'request-one', {
      limit: 2,
    });
    expect(first.comments.map(comment => comment.id)).toEqual(['comment-one', 'comment-2']);
    expect(first.nextCursor).toBeDefined();
    const second = await service.readComments('member-host', 'project-alpha', 'request-one', {
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.comments.map(comment => comment.id)).toEqual(['comment-3', 'comment-4']);
    expect(second.nextCursor).toBeDefined();
    const third = await service.readComments('member-host', 'project-alpha', 'request-one', {
      cursor: second.nextCursor,
      limit: 2,
    });
    expect(third.comments.map(comment => comment.id)).toEqual(['comment-5']);
    expect(third.nextCursor).toBeUndefined();

    const all = [...first.comments, ...second.comments, ...third.comments];
    expect(new Set(all.map(comment => comment.id)).size).toBe(all.length);
  });

  it('bounds a comment page by serialized UTF-8 bytes', async () => {
    await database.mutate(connection => {
      for (let index = 2; index <= 4; index += 1) {
        connection.run(
          `INSERT INTO comments (
            comment_id, request_id, author_member_id, body, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            `comment-${index}`,
            'request-one',
            'member-host',
            '\u0001'.repeat(12 * 1024),
            `2026-08-08T00:0${index}:00.000Z`,
          ],
        );
      }
    });

    const page = await service.readComments('member-host', 'project-alpha', 'request-one', {
      limit: 100,
    });
    const serialized = JSON.stringify(page.comments);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      COLLAB_LIMITS.commentPageMaxUtf8Bytes,
    );
    expect(page.comments.length).toBeGreaterThan(0);
    expect(page.comments.length).toBeLessThan(4);
    expect(page.nextCursor).toBeDefined();

    const seen = new Set(page.comments.map(comment => comment.id));
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await service.readComments('member-host', 'project-alpha', 'request-one', {
        cursor,
        limit: 100,
      });
      for (const comment of next.comments) seen.add(comment.id);
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(new Set(['comment-one', 'comment-2', 'comment-3', 'comment-4']));
  });

  it('keeps a maximal request detail within the shared serialized detail budget', async () => {
    // Maximal JSON-escaped description, 32 Ticket relations, and six maximal
    // escaped comments force traversal beyond the embedded first page.
    const commentBody = '\u0001'.repeat(COLLAB_LIMITS.maxCommentBytes - 2);
    await database.mutate(connection => {
      connection.run(
        'UPDATE change_requests SET description = ? WHERE request_id = ?',
        ['\u0001'.repeat(COLLAB_LIMITS.maxRequestDescriptionBytes), 'request-one'],
      );
      for (let index = 1; index <= 32; index += 1) {
        connection.run(
          `INSERT INTO tickets (
            ticket_id, title, body, status, author_member_id, revision,
            created_at, updated_at
          ) VALUES (?, ?, 'Body', 'open', 'member-host', 1, ?, ?)`,
          [`ticket-${index}`, `Ticket ${index}`, CREATED_AT, CREATED_AT],
        );
        connection.run(
          `INSERT INTO request_ticket_relations (
            relation_id, request_id, ticket_id, commit_oid, kind, state,
            created_by_member_id, created_at, updated_at
          ) VALUES (?, 'request-one', ?, ?, 'references', 'pending', 'member-host', ?, ?)`,
          [`relation-${index}`, `ticket-${index}`, 'c'.repeat(40), CREATED_AT, CREATED_AT],
        );
      }
      for (let index = 1; index <= 6; index += 1) {
        connection.run(
          `INSERT INTO comments (
            comment_id, request_id, author_member_id, body, created_at
          ) VALUES (?, ?, 'member-host', ?, ?)`,
          [`comment-${index}`, 'request-one', `${index}-${commentBody}`,
            `2026-08-08T00:02:${String(index).padStart(2, '0')}.000Z`],
        );
      }
    });

    const detail = await service.read('member-host', 'project-alpha', 'request-one');
    expect(detail.request.ticketRelations.length).toBe(32);
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8'))
      .toBeLessThanOrEqual(COLLAB_LIMITS.detailMaxUtf8Bytes);
    expect(detail.comments.nextCursor).toBeDefined();

    const seen = [...detail.comments.comments];
    let cursor = detail.comments.nextCursor;
    while (cursor) {
      const page = await service.readComments('member-host', 'project-alpha', 'request-one', {
        cursor,
        limit: COLLAB_LIMITS.maxCommentPageSize,
      });
      seen.push(...page.comments);
      cursor = page.nextCursor;
    }
    expect(seen.map(comment => comment.id)).toEqual([
      'comment-one',
      'comment-1',
      'comment-2',
      'comment-3',
      'comment-4',
      'comment-5',
      'comment-6',
    ]);
    expect(new Set(seen.map(comment => comment.id)).size).toBe(7);
  });

  it('rejects an invalid comment cursor fail-closed', async () => {
    await expect(service.readComments('member-host', 'project-alpha', 'request-one', {
      cursor: 'not-a-cursor',
    })).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
    await expect(service.readComments('member-reader', 'project-alpha', 'request-missing', {}))
      .rejects.toMatchObject({ code: 'request-not-open' });
  });
});

function insertRequestAndComment(connection: AuthorityDatabaseConnection): void {
  connection.run(
    `INSERT INTO change_requests (
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, created_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, NULL, ?, ?)`,
    ['request-one', 'member-host', MAIN, HEAD, CREATED_AT, UPDATED_AT],
  );
  connection.run(
    `INSERT INTO comments (
      comment_id, request_id, author_member_id, body, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    ['comment-one', 'request-one', 'member-host', 'Looks good', UPDATED_AT],
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
