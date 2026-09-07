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
import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const OFFERED_AT = '2026-08-08T01:00:00.000Z';
const EXPIRED_AT = '2026-08-08T01:11:00.000Z';

describe('ManagerResponsibilityService', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let root = '';
  let connected: Set<string>;
  let now: Date;
  let nextId: number;
  let presence: ManagerResponsibilityPresencePort;
  let service: ManagerResponsibilityService;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-manager-responsibility-'));
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
      insertMember(connection, 'member-c', 6);
      insertMember(connection, 'member-d', 7);
    });
    connected = new Set([
      'member-a',
      'member-b',
      'member-c',
      'member-d',
      'member-host',
    ]);
    presence = {
      hasAuthenticatedPresence: (projectId, memberId) => (
        projectId === 'project-alpha' && connected.has(memberId)
      ),
    };
    now = new Date(OFFERED_AT);
    nextId = 0;
    service = new ManagerResponsibilityService({
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
      presence,
    }, {
      createOfferId: () => `offer-${++nextId}`,
      now: () => now,
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates one promotion offer from any active Manager and replays it exactly', async () => {
    await promoteForSetup(database, 'member-a');
    const request = {
      idempotencyKey: 'offer-create-one',
      projectId: 'project-alpha',
      purpose: 'manager-promotion' as const,
      targetMemberId: 'member-b',
    };

    const created = await service.create('member-a', request);
    const replay = await service.create('member-a', request);

    expect(created).toEqual({
      expiresAt: '2026-08-08T01:10:00.000Z',
      offeredAt: OFFERED_AT,
      offerId: 'offer-1',
      purpose: 'manager-promotion',
      sourceManagerMemberId: 'member-a',
      status: 'offered',
      targetMemberId: 'member-b',
    });
    expect(replay).toEqual(created);
    await expect(database.read(connection => ({
      events: connection.get(
        "SELECT COUNT(*) AS count FROM events WHERE event_kind = 'membership.manager-responsibility-changed'",
      )?.count,
      idempotency: connection.get(
        "SELECT COUNT(*) AS count FROM idempotency_results WHERE operation_kind = 'manager-responsibility'",
      )?.count,
    }))).resolves.toEqual({ events: 1, idempotency: 1 });
  });

  it('requires current Manager authority and authenticated target presence', async () => {
    connected.delete('member-a');
    await expect(service.create('member-host', {
      idempotencyKey: 'offer-offline-target',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-a',
    })).rejects.toMatchObject({
      code: 'manager-responsibility-pending',
      safeContext: { reason: 'manager-responsibility-target-offline' },
    });

    connected.add('member-a');
    await expect(service.create('member-a', {
      idempotencyKey: 'offer-not-manager',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-b',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('creates a Leave successor offer only for the current last Manager', async () => {
    await promoteForSetup(database, 'member-a');

    await expect(service.create('member-host', {
      idempotencyKey: 'offer-unneeded-successor',
      projectId: 'project-alpha',
      purpose: 'manager-leave',
      targetMemberId: 'member-b',
    })).rejects.toMatchObject({
      code: 'stale-project-selection',
      safeContext: { reason: 'manager-responsibility-successor-not-required' },
    });
    await expect(database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM manager_responsibility_offers',
    ))).resolves.toEqual({ count: 0 });
  });

  it('automatically acknowledges only as the target and replays a lost response', async () => {
    const offer = await createOffer(service, 'ack');
    const request = {
      expectedTargetMemberId: 'member-a',
      idempotencyKey: 'offer-acknowledge',
      offerId: offer.offerId,
      projectId: 'project-alpha',
    };

    const acknowledged = await service.acknowledge('member-a', request);
    await expect(service.acknowledge('member-a', request)).resolves.toEqual(acknowledged);
    expect(acknowledged).toEqual({
      ...offer,
      acknowledgedAt: OFFERED_AT,
      status: 'acknowledged',
    });
    await expect(service.acknowledge('member-b', {
      ...request,
      expectedTargetMemberId: 'member-b',
      idempotencyKey: 'offer-acknowledge-wrong-target',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('keeps a disjoint promotion valid after an unrelated Manager-set change', async () => {
    const offer = await createOffer(service, 'stale-generation');
    await promoteForSetup(database, 'member-b');

    await expect(service.acknowledge('member-a', {
      expectedTargetMemberId: 'member-a',
      idempotencyKey: 'offer-stale-generation-ack',
      offerId: offer.offerId,
      projectId: 'project-alpha',
    })).resolves.toMatchObject({ status: 'acknowledged' });
    await expect(database.read(connection => connection.get(
      'SELECT status FROM manager_responsibility_offers WHERE offer_id = ?',
      [offer.offerId],
    ))).resolves.toEqual({ status: 'acknowledged' });
  });

  it('allows disjoint Managers and targets to hold promotion offers concurrently', async () => {
    await promoteForSetup(database, 'member-a');
    await promoteForSetup(database, 'member-b');

    const first = await service.create('member-a', {
      idempotencyKey: 'offer-disjoint-a',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-c',
    });
    const second = await service.create('member-b', {
      idempotencyKey: 'offer-disjoint-b',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-d',
    });

    expect(first).toMatchObject({ sourceManagerMemberId: 'member-a', targetMemberId: 'member-c' });
    expect(second).toMatchObject({ sourceManagerMemberId: 'member-b', targetMemberId: 'member-d' });
    await expect(database.read(connection => connection.get(
      `SELECT COUNT(*) AS count FROM manager_responsibility_offers
       WHERE status IN ('offered', 'acknowledged')`,
    ))).resolves.toEqual({ count: 2 });
  });

  it('projects an offer only to its source and target', async () => {
    const offer = await service.create('member-host', {
      idempotencyKey: 'offer-read-scope',
      projectId: 'project-alpha',
      purpose: 'manager-leave',
      targetMemberId: 'member-a',
    });

    await expect(service.getCurrent('member-a', 'project-alpha')).resolves.toEqual(offer);
    await expect(service.getCurrent('member-host', 'project-alpha')).resolves.toEqual(offer);
    await expect(service.getCurrent('member-b', 'project-alpha')).resolves.toBeNull();
    await expect(service.getById('member-b', 'project-alpha', offer.offerId))
      .rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('declines as target and cancels as source without reviving terminal offers', async () => {
    const declinedOffer = await createOffer(service, 'decline');
    const declined = await service.decline('member-a', {
      expectedTargetMemberId: 'member-a',
      idempotencyKey: 'offer-decline',
      offerId: declinedOffer.offerId,
      projectId: 'project-alpha',
    });
    expect(declined.status).toBe('declined');

    const cancellable = await createOffer(service, 'cancel');
    const cancelled = await service.cancel('member-host', {
      idempotencyKey: 'offer-cancel',
      offerId: cancellable.offerId,
      projectId: 'project-alpha',
    });
    expect(cancelled.status).toBe('cancelled');
    await expect(service.cancel('member-a', {
      idempotencyKey: 'offer-cancel-wrong-source',
      offerId: cancellable.offerId,
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('replays create and cancel after the actor is demoted but rejects fresh intents', async () => {
    await promoteForSetup(database, 'member-a');
    const createRequest = {
      idempotencyKey: 'offer-role-loss-create',
      projectId: 'project-alpha',
      purpose: 'manager-promotion' as const,
      targetMemberId: 'member-b',
    };
    const offer = await service.create('member-a', createRequest);
    const cancelRequest = {
      idempotencyKey: 'offer-role-loss-cancel',
      offerId: offer.offerId,
      projectId: 'project-alpha',
    };
    const cancelled = await service.cancel('member-a', cancelRequest);
    await demoteForSetup(database, 'member-a');

    await expect(service.create('member-a', createRequest)).resolves.toEqual(offer);
    await expect(service.cancel('member-a', cancelRequest)).resolves.toEqual(cancelled);
    await expect(service.create('member-a', {
      ...createRequest,
      idempotencyKey: 'offer-role-loss-fresh-create',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(service.cancel('member-a', {
      ...cancelRequest,
      idempotencyKey: 'offer-role-loss-fresh-cancel',
    })).rejects.toMatchObject({ code: 'authorization-denied' });
  });

  it('expires after ten minutes and releases the single Project offer slot', async () => {
    const offer = await createOffer(service, 'expiry');
    now = new Date(EXPIRED_AT);

    await expect(service.getCurrent('member-a', 'project-alpha')).resolves.toBeNull();
    await expect(service.getById('member-a', 'project-alpha', offer.offerId))
      .resolves.toMatchObject({ status: 'expired' });
    await expect(service.create('member-host', {
      idempotencyKey: 'offer-after-expiry',
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-b',
    })).resolves.toMatchObject({ offerId: 'offer-2', targetMemberId: 'member-b' });
  });

  it('allows at most one nonterminal Project offer under concurrent creation', async () => {
    const outcomes = await Promise.allSettled([
      service.create('member-host', {
        idempotencyKey: 'offer-concurrent-a',
        projectId: 'project-alpha',
        purpose: 'manager-promotion',
        targetMemberId: 'member-a',
      }),
      service.create('member-host', {
        idempotencyKey: 'offer-concurrent-b',
        projectId: 'project-alpha',
        purpose: 'manager-promotion',
        targetMemberId: 'member-b',
      }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => (
      outcome.status === 'rejected'
      && outcome.reason?.code === 'manager-responsibility-pending'
    ))).toHaveLength(1);
    await expect(database.read(connection => connection.get(
      `SELECT COUNT(*) AS count FROM manager_responsibility_offers
       WHERE status IN ('offered', 'acknowledged')`,
    ))).resolves.toEqual({ count: 1 });
  });
});

async function createOffer(
  service: ManagerResponsibilityService,
  suffix: string,
) {
  return service.create('member-host', {
    idempotencyKey: `offer-create-${suffix}`,
    projectId: 'project-alpha',
    purpose: 'manager-promotion',
    targetMemberId: 'member-a',
  });
}

async function promoteForSetup(
  database: SqlJsProjectDatabase,
  memberId: string,
): Promise<void> {
  await database.mutate(connection => {
    const managerSet = new ManagerSetRepository();
    const current = managerSet.read(connection);
    managerSet.promote(connection, {
      expectedGeneration: current.generation,
      targetMemberId: memberId,
    });
  });
}

async function demoteForSetup(
  database: SqlJsProjectDatabase,
  memberId: string,
): Promise<void> {
  await database.mutate(connection => {
    const managerSet = new ManagerSetRepository();
    const current = managerSet.read(connection);
    managerSet.demote(connection, {
      expectedGeneration: current.generation,
      targetMemberId: memberId,
    });
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
      CREATED_AT,
      CREATED_AT,
    ],
  );
}
