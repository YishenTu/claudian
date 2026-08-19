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
        changedFiles: [{
          binary: false,
          kind: 'modified',
          largeForReview: false,
          path: 'README.md',
        }],
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

  it('returns authoritative request metadata, exact review OIDs, and immutable comments', async () => {
    await expect(service.read('member-host', 'project-alpha', 'request-one')).resolves.toEqual({
      changedFiles: [{
        binary: false,
        kind: 'modified',
        largeForReview: false,
        path: 'README.md',
      }],
      comments: [{
        authorMemberId: 'member-host',
        body: 'Looks good',
        createdAt: UPDATED_AT,
        id: 'comment-one',
        requestId: 'request-one',
      }],
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
        changedFiles: [],
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
