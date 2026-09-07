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
import {
  type ManagerResponsibilityPresencePort,
  ManagerResponsibilityService,
} from '@/app/collab/authority/ManagerResponsibilityService';
import { MembershipAdminService } from '@/app/collab/authority/MembershipAdminService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type { CollabManagerResponsibilityPurpose } from '@/core/collab';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const MUTATED_AT = '2026-08-08T01:00:00.000Z';

describe('MembershipAdminService', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let root = '';
  let connected: Set<string>;
  let managerResponsibilities: ManagerResponsibilityService;
  let presence: ManagerResponsibilityPresencePort;
  let terminated: jest.Mock;
  let service: MembershipAdminService;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-membership-admin-'));
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
      insertMember(connection, 'member-a', 4);
      insertMember(connection, 'member-b', 5);
    });
    connected = new Set(['member-a', 'member-b', 'member-host']);
    presence = {
      hasAuthenticatedPresence: (projectId, memberId) => (
        projectId === 'project-alpha' && connected.has(memberId)
      ),
    };
    const authority = {
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    };
    managerResponsibilities = new ManagerResponsibilityService({
      ...authority,
      presence,
    }, {
      createOfferId: (() => {
        let nextId = 0;
        return () => `offer-membership-${++nextId}`;
      })(),
      now: () => new Date(MUTATED_AT),
    });
    terminated = jest.fn();
    service = new MembershipAdminService(authority, {
      now: () => new Date(MUTATED_AT),
      onMembershipTerminated: terminated,
      presence,
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('promotes a target while retaining the source Manager and replays exactly', async () => {
    const request = await promotionRequest('member-host', 'member-a', 'promote-one');

    const first = await service.promoteManager('member-host', request);
    const replay = await service.promoteManager('member-host', request);

    expect(first).toEqual({
      managerSetGeneration: 1,
      projectId: 'project-alpha',
      promotedMemberId: 'member-a',
    });
    expect(replay).toEqual(first);
    await expect(readManagerState(database)).resolves.toEqual({
      generation: 1,
      managers: ['member-a', 'member-host'],
    });
    await expect(database.read(connection => ({
      eventCount: connection.get(
        "SELECT COUNT(*) AS count FROM events WHERE event_kind = 'membership.manager-promoted'",
      )?.count,
      idempotencyCount: connection.get(
        "SELECT COUNT(*) AS count FROM idempotency_results WHERE operation_kind = 'promote-manager'",
      )?.count,
      offer: connection.get(
        'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
        [request.managerResponsibilityOfferId],
      ),
    }))).resolves.toEqual({
      eventCount: 1,
      idempotencyCount: 1,
      offer: { status: 'consumed' },
    });
  });

  it('demotes another Manager while preserving Host ownership', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'demote-host-setup',
    ));

    const result = await service.demoteManager('member-a', {
      idempotencyKey: 'demote-host',
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    });

    expect(result).toEqual({
      demotedMemberId: 'member-host',
      managerSetGeneration: 2,
      projectId: 'project-alpha',
    });
    await expect(database.read(connection => ({
      host: connection.get('SELECT host_member_id FROM project WHERE singleton = 1'),
      managers: connection.all(
        "SELECT member_id FROM members WHERE role = 'manager' AND status = 'active' ORDER BY member_id",
      ),
    }))).resolves.toEqual({
      host: { host_member_id: 'member-host' },
      managers: [{ member_id: 'member-a' }],
    });
    await expect(service.removeMember('member-a', {
      idempotencyKey: 'remove-host',
      memberId: 'member-host',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('cancels an unrelated acknowledged offer before a Manager-set mutation', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'stale-offer-manager-setup',
    ));
    const unrelated = await acknowledgeOffer({
      purpose: 'manager-promotion',
      sourceMemberId: 'member-host',
      suffix: 'stale-offer',
      targetMemberId: 'member-b',
    });

    await service.demoteManager('member-a', {
      idempotencyKey: 'stale-offer-demote-host',
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    });

    await expect(database.read(connection => connection.get(
      'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
      [unrelated.offerId],
    ))).resolves.toEqual({ status: 'cancelled' });
  });

  it('removes another Manager and preserves request, relation, mention, and revocation semantics', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'remove-manager-setup',
    ));
    await database.mutate(connection => {
      insertRequest(connection, 'member-a');
      insertTicketState(connection, 'member-a');
    });

    const result = await service.removeMember('member-host', {
      idempotencyKey: 'remove-manager',
      memberId: 'member-a',
      projectId: 'project-alpha',
    });

    expect(result).toMatchObject({
      discardedRequestId: 'request-member-a',
      memberId: 'member-a',
      status: 'revoked',
    });
    expect(terminated).toHaveBeenCalledWith(result);
    await expect(database.read(connection => ({
      managerState: {
        generation: connection.get(
          'SELECT manager_set_generation FROM project WHERE singleton = 1',
        )?.manager_set_generation,
        managers: connection.all(
          "SELECT member_id FROM members WHERE role = 'manager' AND status = 'active' ORDER BY member_id",
        ).map(row => row.member_id),
      },
      member: connection.get('SELECT role, status FROM members WHERE member_id = ?', ['member-a']),
      mentions: connection.get('SELECT COUNT(*) AS count FROM ticket_mentions')?.count,
      relations: connection.get('SELECT COUNT(*) AS count FROM request_ticket_relations')?.count,
      request: connection.get(
        'SELECT status FROM change_requests WHERE request_id = ?',
        ['request-member-a'],
      ),
    }))).resolves.toEqual({
      managerState: { generation: 2, managers: ['member-host'] },
      member: { role: 'member', status: 'revoked' },
      mentions: 0,
      relations: 0,
      request: { status: 'discarded' },
    });
  });

  it('rolls back Manager removal and offer cancellation while Accept recovery owns the request', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'accept-recovery-removal-setup',
    ));
    await database.mutate(connection => {
      insertRequest(connection, 'member-a');
      insertIncompleteAccept(connection, 'member-a');
    });
    const offer = await acknowledgeOffer({
      purpose: 'manager-promotion',
      sourceMemberId: 'member-host',
      suffix: 'accept-recovery-unrelated-offer',
      targetMemberId: 'member-b',
    });

    await expect(service.removeMember('member-host', {
      idempotencyKey: 'remove-manager-during-accept',
      memberId: 'member-a',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'acceptance-recovery-required' });
    await expect(database.read(connection => ({
      generation: connection.get(
        'SELECT manager_set_generation FROM project WHERE singleton = 1',
      )?.manager_set_generation,
      member: connection.get('SELECT role, status FROM members WHERE member_id = ?', ['member-a']),
      offer: connection.get(
        'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
        [offer.offerId],
      ),
      request: connection.get(
        'SELECT status FROM change_requests WHERE request_id = ?',
        ['request-member-a'],
      ),
    }))).resolves.toEqual({
      generation: 1,
      member: { role: 'manager', status: 'active' },
      offer: { status: 'acknowledged' },
      request: { status: 'open' },
    });
  });

  it('lets a non-last Manager leave directly without a successor offer', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'non-last-leave-setup',
    ));

    const result = await service.leaveProject('member-a', {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'non-last-leave',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    });

    expect(result).toMatchObject({ memberId: 'member-a', status: 'left' });
    await expect(readManagerState(database)).resolves.toEqual({
      generation: 2,
      managers: ['member-host'],
    });
  });

  it('atomically promotes a successor when the last Manager leaves', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'last-leave-promote',
    ));
    await service.demoteManager('member-a', {
      idempotencyKey: 'last-leave-demote-host',
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    });
    const offer = await acknowledgeOffer({
      purpose: 'manager-leave',
      sourceMemberId: 'member-a',
      suffix: 'last-leave',
      targetMemberId: 'member-b',
    });

    const result = await service.leaveProject('member-a', {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'last-manager-leave',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId: offer.offerId,
      projectId: 'project-alpha',
    });

    expect(result).toMatchObject({ memberId: 'member-a', status: 'left' });
    await expect(database.read(connection => ({
      managerState: {
        generation: connection.get(
          'SELECT manager_set_generation FROM project WHERE singleton = 1',
        )?.manager_set_generation,
        managers: connection.all(
          "SELECT member_id FROM members WHERE role = 'manager' AND status = 'active' ORDER BY member_id",
        ).map(row => row.member_id),
      },
      offer: connection.get(
        'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
        [offer.offerId],
      ),
    }))).resolves.toEqual({
      managerState: { generation: 3, managers: ['member-b'] },
      offer: { status: 'consumed' },
    });
  });

  it('requires a successor only for the current last Manager and blocks Host Leave independently', async () => {
    await expect(service.leaveProject('member-host', {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-host',
      idempotencyKey: 'host-leave',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'membership-host-transfer-required' },
    });

    await database.mutate(connection => {
      connection.run("UPDATE project SET host_member_id = 'member-a' WHERE singleton = 1");
    });
    await expect(service.leaveProject('member-host', {
      expectedHostMemberId: 'member-a',
      expectedMemberId: 'member-host',
      idempotencyKey: 'last-manager-without-offer',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'manager-responsibility-pending' });
  });

  it('replays promotion after actor demotion and rejects a fresh promotion', async () => {
    const request = await promotionRequest('member-host', 'member-a', 'replay-promote');
    const promoted = await service.promoteManager('member-host', request);
    await service.demoteManager('member-a', {
      idempotencyKey: 'demote-promotion-actor',
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    });

    await expect(service.promoteManager('member-host', request)).resolves.toEqual(promoted);
    await expect(service.promoteManager('member-host', {
      ...request,
      idempotencyKey: 'fresh-promote-after-demotion',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('replays demotion and removal after actor demotion but rejects fresh mutations', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'replay-admin-a',
    ));
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-b',
      'replay-admin-b',
    ));
    const demoteRequest = {
      idempotencyKey: 'replay-demotion',
      projectId: 'project-alpha',
      targetMemberId: 'member-b',
    };
    const demoted = await service.demoteManager('member-host', demoteRequest);
    const removeRequest = {
      idempotencyKey: 'replay-removal',
      memberId: 'member-b',
      projectId: 'project-alpha',
    };
    const removed = await service.removeMember('member-host', removeRequest);
    await service.demoteManager('member-a', {
      idempotencyKey: 'demote-admin-actor',
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    });

    await expect(service.demoteManager('member-host', demoteRequest)).resolves.toEqual(demoted);
    await expect(service.removeMember('member-host', removeRequest)).resolves.toEqual(removed);
    await expect(service.demoteManager('member-host', {
      ...demoteRequest,
      idempotencyKey: 'fresh-demotion-after-role-loss',
      targetMemberId: 'member-a',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.removeMember('member-host', {
      ...removeRequest,
      idempotencyKey: 'fresh-removal-after-role-loss',
      memberId: 'member-a',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('terminalizes an offer when acknowledgement races target removal', async () => {
    const offer = await managerResponsibilities.create('member-host', {
      idempotencyKey: 'race-offer-create',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-a',
    });

    await Promise.allSettled([
      managerResponsibilities.acknowledge('member-a', {
        expectedTargetMemberId: 'member-a',
        idempotencyKey: 'race-offer-ack',
        offerId: offer.offerId,
        projectId: 'project-alpha',
      }),
      service.removeMember('member-host', {
        idempotencyKey: 'race-offer-remove',
        memberId: 'member-a',
        projectId: 'project-alpha',
      }),
    ]);

    await expect(database.read(connection => ({
      nonterminal: connection.get(
        "SELECT COUNT(*) AS count FROM manager_responsibility_offers WHERE status IN ('offered', 'acknowledged')",
      )?.count,
      status: connection.get(
        'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
        [offer.offerId],
      )?.status,
    }))).resolves.toEqual({ nonterminal: 0, status: 'cancelled' });
  });

  it('settles promotion versus target Leave without wedging the offer slot', async () => {
    const offer = await acknowledgeOffer({
      purpose: 'manager-promotion',
      sourceMemberId: 'member-host',
      suffix: 'completion-leave-race',
      targetMemberId: 'member-a',
    });
    const promotionRequest = {
      idempotencyKey: 'completion-leave-race-promote',
      managerResponsibilityOfferId: offer.offerId,
      projectId: 'project-alpha',
      targetMemberId: 'member-a',
    };
    const leaveRequest = {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'completion-leave-race-leave',
      idempotencyManagerMemberId: null,
      projectId: 'project-alpha',
    };

    await Promise.allSettled([
      service.promoteManager('member-host', promotionRequest),
      service.leaveProject('member-a', leaveRequest),
    ]);

    await expect(service.leaveProject('member-a', leaveRequest)).resolves.toMatchObject({
      memberId: 'member-a',
      status: 'left',
    });
    await expect(database.read(connection => ({
      activeManagers: connection.get(
        "SELECT COUNT(*) AS count FROM members WHERE role = 'manager' AND status = 'active'",
      )?.count,
      nonterminal: connection.get(
        "SELECT COUNT(*) AS count FROM manager_responsibility_offers WHERE status IN ('offered', 'acknowledged')",
      )?.count,
      offerStatus: connection.get(
        'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
        [offer.offerId],
      )?.status,
    }))).resolves.toEqual(expect.objectContaining({
      activeManagers: 1,
      nonterminal: 0,
    }));
  });

  it('terminalizes an offer when acknowledgement races source removal', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-b',
      'source-removal-race-setup',
    ));
    await database.mutate(connection => {
      connection.run("UPDATE project SET host_member_id = 'member-b' WHERE singleton = 1");
    });
    const offer = await managerResponsibilities.create('member-host', {
      idempotencyKey: 'source-removal-race-create',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-a',
    });

    await Promise.allSettled([
      managerResponsibilities.acknowledge('member-a', {
        expectedTargetMemberId: 'member-a',
        idempotencyKey: 'source-removal-race-ack',
        offerId: offer.offerId,
        projectId: 'project-alpha',
      }),
      service.removeMember('member-b', {
        idempotencyKey: 'source-removal-race-remove',
        memberId: 'member-host',
        projectId: 'project-alpha',
      }),
    ]);

    await expect(database.read(connection => ({
      nonterminal: connection.get(
        "SELECT COUNT(*) AS count FROM manager_responsibility_offers WHERE status IN ('offered', 'acknowledged')",
      )?.count,
      status: connection.get(
        'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
        [offer.offerId],
      )?.status,
    }))).resolves.toEqual({ nonterminal: 0, status: 'cancelled' });
  });

  it('serializes concurrent Manager removals so the Project retains one Manager', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'zero-manager-race',
    ));
    await database.mutate(connection => {
      connection.run("UPDATE project SET host_member_id = 'member-b' WHERE singleton = 1");
    });

    const outcomes = await Promise.allSettled([
      service.removeMember('member-host', {
        idempotencyKey: 'remove-manager-a',
        memberId: 'member-a',
        projectId: 'project-alpha',
      }),
      service.removeMember('member-a', {
        idempotencyKey: 'remove-manager-host',
        memberId: 'member-host',
        projectId: 'project-alpha',
      }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    await expect(database.read(connection => connection.get(
      "SELECT COUNT(*) AS count FROM members WHERE role = 'manager' AND status = 'active'",
    ))).resolves.toEqual({ count: 1 });
  });

  it('rejects demotion and removal of the last active Manager', async () => {
    await database.mutate(connection => {
      connection.run("UPDATE project SET host_member_id = 'member-a' WHERE singleton = 1");
    });

    await expect(service.demoteManager('member-host', {
      idempotencyKey: 'last-manager-self-demotion',
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.removeMember('member-host', {
      idempotencyKey: 'last-manager-self-removal',
      memberId: 'member-host',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(readManagerState(database)).resolves.toEqual({
      generation: 0,
      managers: ['member-host'],
    });
  });

  it('replays committed Leave before requiring the actor to remain active', async () => {
    const request = {
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'leave-replay',
      idempotencyManagerMemberId: 'legacy-manager',
      projectId: 'project-alpha',
    };

    const first = await service.leaveProject('member-a', request);
    await expect(service.leaveProject('member-a', request)).resolves.toEqual(first);
  });

  it('replays post-commit resource revocation after Manager removal notification fails', async () => {
    await service.promoteManager('member-host', await promotionRequest(
      'member-host',
      'member-a',
      'manager-removal-recovery-setup',
    ));
    const callback = jest.fn()
      .mockRejectedValueOnce(new Error('socket close failed'))
      .mockResolvedValueOnce(undefined);
    const recovering = new MembershipAdminService({
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
    }, {
      now: () => new Date(MUTATED_AT),
      onMembershipTerminated: callback,
      presence,
    });
    const request = {
      idempotencyKey: 'remove-manager-recovery',
      memberId: 'member-a',
      projectId: 'project-alpha',
    };

    await expect(recovering.removeMember('member-host', request)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(recovering.removeMember('member-host', request)).resolves.toMatchObject({
      memberId: 'member-a',
      status: 'revoked',
    });
    expect(callback).toHaveBeenCalledTimes(2);
    await expect(database.read(connection => ({
      eventCount: connection.get(
        "SELECT COUNT(*) AS count FROM events WHERE event_kind = 'membership.revoked'",
      )?.count,
      member: connection.get(
        'SELECT role, status FROM members WHERE member_id = ?',
        ['member-a'],
      ),
    }))).resolves.toEqual({
      eventCount: 1,
      member: { role: 'member', status: 'revoked' },
    });
  });

  async function promotionRequest(
    sourceMemberId: string,
    targetMemberId: string,
    suffix: string,
  ) {
    const offer = await acknowledgeOffer({
      purpose: 'manager-promotion',
      sourceMemberId,
      suffix,
      targetMemberId,
    });
    return {
      idempotencyKey: `promote-${suffix}`,
      managerResponsibilityOfferId: offer.offerId,
      projectId: 'project-alpha',
      targetMemberId,
    };
  }

  async function acknowledgeOffer(input: {
    readonly purpose: CollabManagerResponsibilityPurpose;
    readonly sourceMemberId: string;
    readonly suffix: string;
    readonly targetMemberId: string;
  }) {
    const offer = await managerResponsibilities.create(input.sourceMemberId, {
      idempotencyKey: `create-${input.suffix}`,
      projectId: 'project-alpha',
      purpose: input.purpose,
      targetMemberId: input.targetMemberId,
    });
    return managerResponsibilities.acknowledge(input.targetMemberId, {
      expectedTargetMemberId: input.targetMemberId,
      idempotencyKey: `acknowledge-${input.suffix}`,
      offerId: offer.offerId,
      projectId: 'project-alpha',
    });
  }
});

async function readManagerState(database: SqlJsProjectDatabase) {
  return database.read(connection => ({
    generation: connection.get(
      'SELECT manager_set_generation FROM project WHERE singleton = 1',
    )?.manager_set_generation,
    managers: connection.all(
      "SELECT member_id FROM members WHERE role = 'manager' AND status = 'active' ORDER BY member_id",
    ).map(row => row.member_id),
  }));
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
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

function insertRequest(connection: AuthorityDatabaseConnection, memberId: string): void {
  connection.run(
    `INSERT INTO change_requests (
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, created_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, NULL, ?, ?)`,
    [
      `request-${memberId}`,
      memberId,
      '1'.repeat(40),
      '2'.repeat(40),
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

function insertIncompleteAccept(
  connection: AuthorityDatabaseConnection,
  memberId: string,
): void {
  connection.run(
    `INSERT INTO accept_operations (
      operation_id, request_id, expected_main_oid, expected_head_oid,
      result_commit_oid, state, idempotency_key, created_at, updated_at,
      expected_request_revision, expected_resolving_tickets_json,
      completion_actor_member_id
    ) VALUES (?, ?, ?, ?, NULL, 'prepared', ?, ?, ?, 0, '[]', 'member-host')`,
    [
      `accept-${memberId}`,
      `request-${memberId}`,
      '1'.repeat(40),
      '2'.repeat(40),
      `accept-key-${memberId}`,
      CREATED_AT,
      CREATED_AT,
    ],
  );
}

function insertTicketState(connection: AuthorityDatabaseConnection, memberId: string): void {
  connection.run(
    `INSERT INTO tickets (
      ticket_id, ticket_number, title, body, status, author_member_id,
      revision, comment_count, created_at, updated_at,
      closed_at, closed_by_member_id
    ) VALUES ('ticket-one', 1, 'Ticket', 'Ask @member-a', 'open', 'member-host',
      1, 0, ?, ?, NULL, NULL)`,
    [CREATED_AT, CREATED_AT],
  );
  connection.run(
    `INSERT INTO request_ticket_relations (
      relation_id, request_id, ticket_id, commit_oid, kind, state,
      created_by_member_id, created_at, updated_at, accepted_at, accepted_merge_oid
    ) VALUES ('relation-one', ?, 'ticket-one', ?, 'references', 'pending',
      'member-host', ?, ?, NULL, NULL)`,
    [`request-${memberId}`, '2'.repeat(40), CREATED_AT, CREATED_AT],
  );
  connection.run(
    `INSERT INTO ticket_mentions (
      ticket_id, source_kind, source_id, mentioned_member_id, created_at
    ) VALUES ('ticket-one', 'description', 'ticket-one', ?, ?)`,
    [memberId, CREATED_AT],
  );
}
